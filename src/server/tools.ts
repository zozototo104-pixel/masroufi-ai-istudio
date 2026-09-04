import { createHash } from 'crypto';
import { getDb, clearAllLocalUserData, type WriteResult } from './fakeDb';
import { adminDb as firebaseAdminDb } from './firebaseAdmin';
import { buildReportSnapshotRecord, matchesArabicCategory } from '../lib/reportUtils';
import { validateImportEnvelope } from '../lib/importEnvelope';
import { prepareImportedFinancialTransactions } from '../lib/importFinancialTransactions';
import { selectOpenCreditorDebt } from '../lib/debtSelection';
import {
  buildSavingsGoalPlan,
  buildSavingsGoalRecord,
  normalizeSavingsDueDate,
  selectSavingsGoalForContribution,
  monthKey,
  roundMoney,
} from '../lib/savingsCore';
import { parseAbsoluteFinancialAmount, parsePositiveFinancialAmount } from '../lib/amount';
import { normalizeHistoricalTransactionDate } from '../lib/historicalDate';
import { calculateBalances, calculateBreakdown, normalizeAccount, normalizeCreditorKey } from '../lib/balanceCalc';
export { normalizeAccount } from '../lib/balanceCalc';
import { GoogleGenAI } from '@google/genai';
import { runIdempotent } from './idempotency';
import { atomicAddTransaction, atomicDeleteTransaction, atomicPayDebt, atomicTransferMoney, atomicUpdateTransaction } from './atomicOps';
import {
  getCachedMarketResult,
  cacheMarketResult,
  isGazaSource,
  classifyMarketScope,
  normalizeCurrencyToIls,
  getFxConversionMetadata,
  refreshExchangeRatesToIls,
  computeNormalizedPriceRange,
  buildMarketComparison,
  extractPricesFromText,
  computePriceRange,
  shouldSearchMarket,
  isSmallDailyPurchase,
  type MarketResult,
  type MarketSearchResponse,
} from './marketIntelligence';
import {
  inferCategory,
  inferNecessityForGazaContext,
  normalizeArabicText,
  normalizeIncomeAllocations,
  needsIncomeAllocationQuestion,
  evaluateTreasurerRisk,
  buildTreasurerReport,
  TREASURER_CATEGORY_TAXONOMY,
} from './treasurerEngine';

const FIRESTORE_WRITE_BATCH_LIMIT = 500;
const IMPORT_REPLACE_ATOMIC_HEADROOM = 50;
const IMPORT_REPLACE_ATOMIC_MUTATION_LIMIT = FIRESTORE_WRITE_BATCH_LIMIT - IMPORT_REPLACE_ATOMIC_HEADROOM;

// Persistent notification center. Notifications are stored per-user so Cloud Run restarts do not erase them.
// The UI still renders short-lived toasts, but persistence is the source of truth.
export async function getNotifications(userId: string, token: string, limit: number = 50) {
  const adminDb = getDb(token);
  const snap = await adminDb.collection('users').doc(userId).collection('notifications').get();
  const allItems = snap.docs.map((d: any) => ({ id: d.id, ...d.data() }))
    .sort((a: any, b: any) => String(b.createdAt || '').localeCompare(String(a.createdAt || '')));
  const items = allItems.filter((n: any) => !n.delivered).slice(0, Math.max(1, Math.min(100, limit)));
  // V6 (MF-5): mark items as delivered in a SINGLE Firestore batch instead of N writes.
  // This reduces quota usage and prevents partial-write storms.
  if (items.length > 0) {
    const batch = adminDb.batch();
    const now = new Date().toISOString();
    for (const n of items) {
      batch.set(adminDb.collection('users').doc(userId).collection('notifications').doc(n.id), {
        ...n,
        delivered: true,
        deliveredAt: now,
      });
    }
    try {
      await batch.commit();
    } catch (batchErr) {
      // Best-effort delivery marking. Don't fail the GET if the batch write fails.
      console.warn('[notifications] delivery-marking batch failed:', batchErr);
    }
  }
  return { notifications: items, unreadCount: allItems.filter((n: any) => !n.read).length, partial: (snap as any).partial };
}

export async function markNotificationRead(args: any, userId: string, token: string) {
  if (!args?.id) return { success: false, error: 'Notification ID is required' };
  const adminDb = getDb(token);
  const ref = adminDb.collection('users').doc(userId).collection('notifications').doc(String(args.id));
  const snap = await ref.get();
  if (!snap.exists) return { success: false, error: 'Notification not found' };
  await ref.set({ ...snap.data(), read: true, readAt: new Date().toISOString() });
  return { success: true };
}

function stableDocId(value: string): string {
  return createHash('sha256').update(value).digest('hex').slice(0, 40);
}

async function addNotification(
  userId: string,
  message: string,
  type: string = 'success',
  adminDb?: any,
  options: { idempotencyKey?: string; transactionId?: string; operationId?: string; metadata?: any } = {}
) {
  if (!adminDb) return;
  try {
    const now = new Date().toISOString();
    const docId = options.idempotencyKey ? stableDocId(`${userId}|notification|${options.idempotencyKey}`) : undefined;
    const ref = docId
      ? adminDb.collection('users').doc(userId).collection('notifications').doc(docId)
      : adminDb.collection('users').doc(userId).collection('notifications').doc();
    const existing = docId ? await ref.get() : null;
    if (existing?.exists) {
      await ref.set({
        duplicateCount: Number(existing.data()?.duplicateCount || 0) + 1,
        lastDuplicateAt: now,
        delivered: existing.data()?.delivered ?? false,
      }, { merge: true });
      return;
    }
    await ref.set({
      message,
      type,
      read: false,
      delivered: false,
      createdAt: now,
      transactionId: options.transactionId || null,
      operationId: options.operationId || null,
      idempotencyKey: options.idempotencyKey || null,
      metadata: options.metadata || null,
      duplicateCount: 0,
    });
  } catch (e) {
    console.warn('Notification write failed after financial operation; financial commit remains valid:', e);
  }
}

export async function recordTransactionCommittedSideEffects(
  userId: string,
  transactionId: string,
  tx: any,
  db: any,
  options: { preUserBudgets?: Record<string, number>; preTxSnapshot?: any } = {}
) {
  const amount = parsePositiveFinancialAmount(tx?.amount);
  const type = String(tx?.type || 'expense');
  const account = String(tx?.account || 'cash');
  const category = String(tx?.category || '');
  const subcategory = String(tx?.subcategory || '');
  const merchant = String(tx?.merchant || '');
  const operationId = String(tx?.operationId || transactionId);

  let notificationMsg = `تم تسجيل ${type === 'expense' ? 'مصروف' : 'دخل'} بقيمة ${amount} ₪`;
  if (account === 'debt') {
    notificationMsg += " (دين)";
  } else if (account === 'palPay') {
    notificationMsg += " (PalPay)";
  }
  if (category && category !== 'غير مصنف') {
    notificationMsg += ` [${category}]`;
  }
  if (tx?.necessity) {
    notificationMsg += ` - ${tx.necessity}`;
  }

  await addNotification(userId, notificationMsg, 'success', db, {
    idempotencyKey: `transaction-success:${operationId}`,
    transactionId,
    operationId,
    metadata: { amount, type, account, category, subcategory, merchant, transactionType: tx?.transactionType }
  });

  // Budget threshold warning check (80% / 100%)
  if (type === 'expense' && category && category !== 'غير مصنف') {
    try {
      const userBudgets = options.preUserBudgets || await getUserBudgets(userId, db);
      const budgetLimit = userBudgets[category] || DEFAULT_BUDGETS[category] || 1000;

      const thisMonth = new Date().toISOString().slice(0, 7);
      const txSnapshot = options.preTxSnapshot || await db.collection('transactions').where('userId', '==', userId).get();
      const monthExpenses = txSnapshot.docs
        .map((d: any) => d.data())
        .filter((item: any) => item.type === 'expense' && (item.date || '').startsWith(thisMonth) && item.category === category);

      const totalSpentForCat = monthExpenses.reduce((sum: number, item: any) => sum + (Number(item.amount) || 0), 0);
      const ratio = totalSpentForCat / budgetLimit;

      if (ratio >= 1.0) {
        await addNotification(
          userId,
          `⚠️ تنبيه ميزانية: تجاوزت سقف ميزانية [${category}] لهذا الشهر (${totalSpentForCat} ₪ من ${budgetLimit} ₪).`,
          'warning', db
        );
      } else if (ratio >= 0.8) {
        await addNotification(
          userId,
          `⚠️ تنبيه ميزانية: اقتربت من سقف ميزانية [${category}] لهذا الشهر (وصلت ${Math.round(ratio * 100)}% - ${totalSpentForCat} ₪ من ${budgetLimit} ₪).`,
          'warning', db
        );
      }
    } catch (budgetErr) {
      console.error("Budget check error:", budgetErr);
    }
  }
}

// V5: unified financial context used by the assistant before consequential decisions.
// It is on-demand only: no timers/polling. The transaction snapshot is reused for all calculations.
// V6 (MF-1): exclude commitments with status='paid' from due30 to prevent double subtraction.
export async function getFinancialDecisionContext(args: any, userId: string, token: string) {
  const adminDb = getDb(token);
  const now = new Date();
  const txSnap = await adminDb.collection('transactions').where('userId', '==', userId).get();
  const txs = txSnap.docs.map((d: any) => ({ id: d.id, ...d.data() }));
  const balances = calculateBalancesFromDocs(txs);
  const budgets = await getUserBudgets(userId, adminDb);
  const commitmentSnap = await adminDb.collection('commitments').where('userId', '==', userId).get();
  const commitments = commitmentSnap.docs.map((d: any) => ({ id: d.id, ...d.data() }));
  const horizon90 = now.getTime() - 90 * 86400000;
  const recent = txs.filter((t: any) => {
    const d = new Date(t.date || t.createdAt || 0).getTime();
    return Number.isFinite(d) && d >= horizon90 && d <= now.getTime();
  });
  const expenseTxs = recent.filter((t: any) => t.type === 'expense');
  // V6: exclude CREDIT_PURCHASE from dailyExpense so projected forecast doesn't
  // double-count purchases that didn't actually deduct cash.
  const realExpenseTxs = expenseTxs.filter((t: any) => t.transactionType !== 'CREDIT_PURCHASE');
  const incomeTxs = recent.filter((t: any) => t.type === 'income' && t.transactionType !== 'DEBT_BORROWING');
  const firstTs = recent.length ? Math.min(...recent.map((t: any) => new Date(t.date || t.createdAt).getTime()).filter(Number.isFinite)) : now.getTime();
  const historyDays = recent.length ? Math.max(7, Math.min(90, Math.ceil((now.getTime() - firstTs) / 86400000) + 1)) : 7;
  const expenseTotal = realExpenseTxs.reduce((a: number, t: any) => a + parsePositiveFinancialAmount(t.amount), 0);
  const incomeTotal = incomeTxs.reduce((a: number, t: any) => a + parsePositiveFinancialAmount(t.amount), 0);
  const dailyExpense = expenseTotal / historyDays;
  const dailyIncome = incomeTotal / historyDays;
  const next30 = now.getTime() + 30 * 86400000;
  // V6 (MF-1): exclude paid/cancelled commitments from the forecast subtraction.
  const due30 = commitments.filter((c: any) => {
    if (c.status === 'paid' || c.status === 'cancelled') return false;
    const d = new Date(c.dueDate).getTime();
    return Number.isFinite(d) && d <= next30;
  }).reduce((a: number, c: any) => a + (Number(c.amount) || 0), 0);
  const projected30 = Math.round((balances.total || 0) + dailyIncome * 30 - dailyExpense * 30 - due30);
  const thisMonth = now.toISOString().slice(0,7);
  const monthExpenses = txs.filter((t:any) => t.type === 'expense' && String(t.date || '').startsWith(thisMonth));
  const budgetStatus = Object.entries(budgets).map(([category, limitRaw]) => {
    const limit = Number(limitRaw) || 0;
    const spent = monthExpenses.filter((t:any)=>t.category===category).reduce((a:number,t:any)=>a+parsePositiveFinancialAmount(t.amount),0);
    return { category, limit, spent, remaining: limit-spent, percentage: limit>0?Math.round(spent/limit*100):0 };
  });
  return {
    success: true,
    balances,
    dailyExpenseAverage: Math.round(dailyExpense * 100) / 100,
    dailyIncomeAverage: Math.round(dailyIncome * 100) / 100,
    projected30DayBalance: projected30,
    dueCommitments30Days: due30,
    historyDays,
    confidence: recent.length >= 30 ? 'good' : recent.length >= 10 ? 'medium' : 'initial',
    budgetStatus,
    commitments: commitments.filter((c:any)=>c.status!=='paid' && c.status!=='cancelled').map((c:any)=>({id:c.id,title:c.title,amount:c.amount,dueDate:c.dueDate,category:c.category,status:c.status||'pending'})),
    // V6: propagate partial flag so AI/UI refuses decisions on partial data.
    partial: Boolean((txSnap as any).partial || (commitmentSnap as any).partial)
  };
}

function normalizeMarketSearchText(value: any): string {
  return normalizeArabicText(value).replace(/[^\p{L}\p{N}\s]/gu, ' ').replace(/\s+/g, ' ').trim();
}

function marketOfferToResult(offer: any, item: string): MarketResult {
  const scope = classifyMarketScope(offer.seller || '', offer.sourceUrl || '', `${offer.location || ''} ${offer.address || ''}`);
  const normalized = normalizeCurrencyToIls(Number(offer.price || 0), offer.currency || 'ILS');
  const fxMetadata = normalized ? getFxConversionMetadata(offer.currency || 'ILS') : {};
  return {
    product: offer.product || item,
    brand: offer.brand || undefined,
    model: offer.model || undefined,
    variant: offer.variant || undefined,
    condition: offer.condition || 'unknown',
    seller: offer.seller || 'محل محفوظ في دفتر السوق',
    location: offer.location || offer.address || (scope === 'gaza' ? 'غزة' : scope === 'palestine' ? 'فلسطين' : scope === 'global' ? 'عالمي' : 'غير محدد'),
    price: Number(offer.price || 0),
    currency: offer.currency || 'ILS',
    originalPrice: Number(offer.price || 0),
    originalCurrency: offer.currency || 'ILS',
    normalizedPriceIls: normalized || undefined,
    ...fxMetadata,
    marketScope: scope,
    availability: offer.availability || 'unknown',
    source: offer.source || offer.seller || 'دفتر سوق مصروفي',
    sourceUrl: offer.sourceUrl || undefined,
    fetchedAt: offer.checkedAt || offer.createdAt || new Date().toISOString(),
    isLocalGaza: scope === 'gaza',
    confidence: offer.confidence || 'medium',
    notes: offer.notes || 'عرض محفوظ في دفتر السوق المحلي.'
  };
}

async function searchSavedMarketOffers(adminDb: any, userId: string, item: string, model?: string): Promise<MarketResult[]> {
  try {
    await refreshExchangeRatesToIls();
    const snap = await adminDb.collection('users').doc(userId).collection('marketDirectory').get();
    const q = normalizeMarketSearchText(`${item} ${model || ''}`);
    const terms = q.split(' ').filter(Boolean);
    return snap.docs
      .map((d: any) => ({ id: d.id, ...d.data() }))
      .filter((offer: any) => {
        const haystack = normalizeMarketSearchText(`${offer.product || ''} ${offer.brand || ''} ${offer.model || ''} ${offer.variant || ''} ${offer.seller || ''} ${offer.location || ''}`);
        if (!terms.length) return false;
        return terms.every(term => haystack.includes(term)) || haystack.includes(q) || q.includes(haystack);
      })
      .map((offer: any) => marketOfferToResult(offer, item))
      .filter((r: MarketResult) => Number(r.price) > 0)
      .sort((a: MarketResult, b: MarketResult) => {
        const scopeScore = (r: MarketResult) => r.marketScope === 'gaza' ? 0 : r.marketScope === 'palestine' ? 1 : r.marketScope === 'global' ? 2 : 3;
        const comparableIls = (r: MarketResult) => Number(r.normalizedPriceIls || (String(r.currency || 'ILS').toUpperCase() === 'ILS' ? r.price : Number.POSITIVE_INFINITY));
        return scopeScore(a) - scopeScore(b) || comparableIls(a) - comparableIls(b);
      })
      .slice(0, 20);
  } catch (e) {
    console.warn('Saved market directory search failed:', e);
    return [];
  }
}

export async function saveMarketOffer(args: any, userId: string, token: string) {
  const adminDb = getDb(token);
  const product = String(args.product || args.item || '').trim();
  const price = parsePositiveFinancialAmount(args.price);
  const seller = String(args.seller || args.store || args.shop || '').trim();
  if (!product) return { success: false, needsClarification: true, reason: 'MISSING_MARKET_PRODUCT', message: 'ما اسم السلعة التي تريد حفظ سعرها في دفتر السوق؟' };
  if (price <= 0) return { success: false, needsClarification: true, reason: 'INVALID_MARKET_PRICE', message: 'ما السعر الذي تريد حفظه؟' };
  await refreshExchangeRatesToIls();
  const now = new Date().toISOString();
  const scope = classifyMarketScope(seller, args.sourceUrl || '', `${args.location || ''} ${args.address || ''}`);
  const doc = {
    userId,
    product,
    brand: args.brand || '',
    model: args.model || '',
    variant: args.variant || '',
    condition: args.condition || 'unknown',
    seller,
    location: args.location || (scope === 'gaza' ? 'غزة' : ''),
    address: args.address || '',
    phone: args.phone || args.whatsapp || '',
    price,
    currency: args.currency || 'ILS',
    normalizedPriceIls: normalizeCurrencyToIls(price, args.currency || 'ILS') || undefined,
    availability: args.availability || 'unknown',
    source: args.source || 'إدخال المستخدم',
    sourceUrl: args.sourceUrl || '',
    confidence: args.confidence || (seller ? 'medium' : 'low'),
    marketScope: scope,
    notes: args.notes || '',
    checkedAt: args.checkedAt || now,
    createdAt: now,
    updatedAt: now,
    searchKey: normalizeMarketSearchText(`${product} ${args.brand || ''} ${args.model || ''} ${args.variant || ''} ${seller}`)
  };
  const ref = adminDb.collection('users').doc(userId).collection('marketDirectory').doc();
  await ref.set(doc);
  return { success: true, id: ref.id, offer: { id: ref.id, ...doc }, message: `حفظت سعر ${product} في دفتر سوق غزة/فلسطين للمقارنة القادمة.` };
}

export async function getMarketDirectory(args: any, userId: string, token: string) {
  const adminDb = getDb(token);
  const item = String(args.item || args.product || '').trim();
  const results = item ? await searchSavedMarketOffers(adminDb, userId, item, args.model) : [];
  if (item) return { success: true, item, results, count: results.length };
  const snap = await adminDb.collection('users').doc(userId).collection('marketDirectory').get();
  const offers = snap.docs.map((d: any) => ({ id: d.id, ...d.data() }))
    .sort((a: any, b: any) => String(b.checkedAt || b.createdAt || '').localeCompare(String(a.checkedAt || a.createdAt || '')))
    .slice(0, 100);
  return { success: true, offers, count: offers.length };
}

// V6.1: real local-market lookup with source-backed result model, freshness,
// Gaza priority, cache, and explicit MARKET_DATA_UNAVAILABLE on failure.
// Never invents prices. Returns structured MarketResult[] with sources + timestamps.
export async function searchLocalMarket(args: any, userId: string, token: string): Promise<MarketSearchResponse | any> {
  const item = String(args?.item || '').trim();
  const model = String(args?.model || '').trim();
  const condition = String(args?.condition || '').trim().toLowerCase();
  if (!item) return { success: false, needsClarification: true, message: 'ما السلعة التي تريد مقارنة سعرها؟' };

  // V6.1 (PHASE 31): refuse small daily purchases — no market search needed.
  if (isSmallDailyPurchase(item)) {
    return {
      success: false,
      marketUnavailable: true,
      message: 'هذه السلعة يومية ولا تحتاج مقارنة أسعار. سجّلها كمصروف مباشرة.',
    };
  }

  const adminDb = getDb(token);
  const savedResults = await searchSavedMarketOffers(adminDb, userId, item, model);

  // V6.1: check cache first (reduces API cost + latency), but blend the user's Gaza market directory first.
  const cached = getCachedMarketResult({ product: item, model, condition });
  if (cached) {
    const merged = [...savedResults, ...(cached.results || [])];
    const marketComparison = buildMarketComparison(merged, Number(args.offeredPrice || args.price || 0) || undefined);
    return { ...cached, results: merged, marketComparison, priceRange: computeNormalizedPriceRange(merged) || cached.priceRange, directoryMatches: savedResults.length };
  }

  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) {
    if (savedResults.length) {
      const marketComparison = buildMarketComparison(savedResults, Number(args.offeredPrice || args.price || 0) || undefined);
      return { success: true, item, model: model || undefined, results: savedResults, priceRange: computeNormalizedPriceRange(savedResults) || undefined, marketComparison, sources: [], searchQueries: [], summary: 'اعتمدت على دفتر سوق غزة/فلسطين المحفوظ لديك لأن البحث الحي غير متاح.', directoryMatches: savedResults.length };
    }
    return { success: false, marketUnavailable: true, message: 'البحث الحي في السوق غير متاح حالياً لأن مفتاح Gemini غير مهيأ على الخادم.' };
  }
  try {
    const ai = new GoogleGenAI({ apiKey });
    const q = `أنت باحث أسعار صارم لمستخدم من غزة. ابحث في الويب عن أسعار حديثة ومتاحة فعلياً للسلعة: ${item}${model ? `، الموديل: ${model}` : ''}${condition ? `، الحالة: ${condition}` : ''}.
رتّب البحث والنتيجة بهذا التسلسل الإلزامي:
1) سوق غزة وقطاع غزة أولاً: محلات، صفحات فيسبوك/إنستغرام/مواقع محلية، عناوين وأرقام إن وجدت.
2) السوق الفلسطيني الأوسع ثانياً: الضفة/رام الله/نابلس/الخليل/القدس كمرجع محلي فلسطيني.
3) السوق العالمي ثالثاً: أسعار عالمية مرجعية من مواقع موثوقة أو متاجر عالمية، مع توضيح أن الشحن/الجمارك/التوفر قد تغيّر المقارنة.
أعطِ فقط أسعاراً لها مصدر واضح. لا تخترع متجراً أو سعراً أو عنواناً. لكل سعر اذكر: النطاق (غزة/فلسطين/عالمي)، اسم البائع/المصدر، الموقع/العنوان إن وجد، السعر والعملة، حالة السلعة جديدة/مستعملة إن أمكن، وتاريخ/حداثة المعلومة. إن لم تجد غزة قل ذلك صراحة ولا تستبدلها بالعالمي دون تنبيه.`;
    const response: any = await ai.models.generateContent({ model: 'gemini-2.5-flash', contents: q, config: { tools: [{ googleSearch: {} }] } });
    const meta = response?.candidates?.[0]?.groundingMetadata;
    const groundingChunks = (meta?.groundingChunks || []).map((c: any) => c?.web).filter(Boolean);
    const sources = groundingChunks.map((w: any) => {
      const scope = classifyMarketScope(w.title || '', w.uri || '', '');
      return {
        title: w.title,
        uri: w.uri,
        isLocalGaza: isGazaSource(w.title || '', w.uri || '') || scope === 'gaza',
        marketScope: scope,
      };
    }).slice(0, 12);

    // V6.1: extract structured price results from Gemini's text response.
    const text = String(response.text || '');
    const extractedPrices = extractPricesFromText(text);
    const now = new Date().toISOString();
    const liveResults: MarketResult[] = extractedPrices.map((p, i) => {
      const scope = (sources[i] as any)?.marketScope || classifyMarketScope(sources[i]?.title || '', sources[i]?.uri || '', '');
      const normalized = normalizeCurrencyToIls(p.price, p.currency);
      const fxMetadata = normalized ? getFxConversionMetadata(p.currency) : {};
      return {
        product: item,
        model: model || undefined,
        condition: (condition as any) || 'unknown',
        // Try to associate a source with each price (best-effort).
        seller: sources[i]?.title || 'غير محدد',
        location: scope === 'gaza' ? 'غزة' : scope === 'palestine' ? 'فلسطين' : scope === 'global' ? 'عالمي (مرجعي)' : 'غير محدد',
        price: p.price,
        currency: p.currency,
        originalPrice: p.price,
        originalCurrency: p.currency,
        normalizedPriceIls: normalized || undefined,
        ...fxMetadata,
        marketScope: scope,
        availability: 'unknown',
        source: sources[i]?.title || 'Gemini + Google Search',
        sourceUrl: sources[i]?.uri,
        fetchedAt: now,
        isLocalGaza: sources[i]?.isLocalGaza ?? scope === 'gaza',
        confidence: scope === 'gaza' ? 'high' : scope === 'palestine' ? 'medium' : 'low',
        notes: `Raw: "${p.raw}"`,
      };
    });
    const results: MarketResult[] = [...savedResults, ...liveResults];

    const priceRange = computeNormalizedPriceRange(results) || computePriceRange(results);
    const marketComparison = buildMarketComparison(results, Number(args.offeredPrice || args.price || 0) || undefined);

    const searchResponse: MarketSearchResponse = {
      success: true,
      item,
      model: model || undefined,
      results,
      priceRange: priceRange || undefined,
      marketComparison,
      sources,
      searchQueries: meta?.webSearchQueries || [],
      summary: text,
      partial: results.length === 0,  // partial = we got text but couldn't extract structured prices
      directoryMatches: savedResults.length,
    } as any;

    // Cache the result.
    cacheMarketResult({ product: item, model, condition }, searchResponse);

    return searchResponse;
  } catch (e: any) {
    return { success: false, marketUnavailable: true, message: 'تعذر التحقق من أسعار السوق المحلي الآن، لذلك لن أقدم سعراً غير موثوق.', error: String(e?.message || e) };
  }
}

export async function assessPurchase(args: any, userId: string, token: string) {
  const price = parsePositiveFinancialAmount(args?.price);
  if (!price) return { success:false, needsClarification:true, message:'كم السعر المعروض عليك؟' };
  const ctx:any = await getFinancialDecisionContext({}, userId, token);
  const account = normalizeAccount(args?.paymentMethod || 'cash');
  const available = account === 'palPay' ? Number(ctx.balances.palPay||0) : account === 'cash' ? Number(ctx.balances.cash||0) : Number(ctx.balances.total||0);
  const after = available - price;
  const projectedAfter = Number(ctx.projected30DayBalance||0) - (account === 'debt' ? 0 : price);
  const daysCoverage = ctx.dailyExpenseAverage > 0 ? Math.floor(Math.max(0, after) / ctx.dailyExpenseAverage) : null;
  const categoryBudget = (ctx.budgetStatus||[]).find((b:any)=>b.category===args?.category);
  const projectedBudgetPct = categoryBudget?.limit > 0 ? Math.round((categoryBudget.spent + price)/categoryBudget.limit*100) : null;
  const warnings:string[]=[];
  if (account !== 'debt' && after < 0) warnings.push(`الرصيد في الحساب لا يكفي؛ العجز الفوري ${Math.abs(after)} ₪.`);
  if (projectedAfter < 0) warnings.push(`بعد هذا الشراء يُتوقع عجز خلال 30 يوماً بحوالي ${Math.abs(projectedAfter)} ₪ وفق نمط الصرف والالتزامات الحالية.`);
  if (projectedBudgetPct !== null && projectedBudgetPct >= 100) warnings.push(`الشراء سيرفع بند ${args.category} إلى نحو ${projectedBudgetPct}% من سقفه الشهري.`);
  if (String(args?.necessity||'') === 'كمالي' && daysCoverage !== null && daysCoverage < 14) warnings.push(`بعد الشراء يغطي الرصيد المتبقي قرابة ${daysCoverage} يوماً فقط وفق متوسط صرفك الحالي.`);
  return { success:true, decision:warnings.length?'CAUTION':'OK', warnings, price, paymentMethod:account, availableBefore:available, availableAfter:after, projected30DayBalanceAfterPurchase:projectedAfter, dailyExpenseAverage:ctx.dailyExpenseAverage, daysCoverage, categoryBudget, projectedBudgetPercentage:projectedBudgetPct, confidence:ctx.confidence };
}

export const DEFAULT_BUDGETS: Record<string, number> = {
  'الأبناء': 1500,
  'طعام ومشتريات منزل': 2000,
  'زيارات وضيافة': 600,
  'مواصلات': 500,
  'فواتير والتزامات': 800,
  'صحة وعلاج': 600,
  'تعليم وتدريب': 800,
  'أخرى': 500
};

export async function getUserCustomBudgetDocs(userId: string, adminDb: any): Promise<Array<{ id: string; category: string; limit: number; data: any }>> {
  const snapshot = await adminDb.collection('users').doc(userId).collection('budgets').get();
  return snapshot.docs.map((d: any) => {
    const data = d.data() || {};
    return { id: d.id, category: data.category || d.id, limit: Number(data.limit) || 0, data };
  });
}

export async function getUserBudgets(userId: string, adminDb: any): Promise<Record<string, number>> {
  // V6 (HF-6): NEVER silently swallow errors and return DEFAULT_BUDGETS.
  // On Firestore error / quota / network, propagate the error so callers can
  // mark the response as `partial` and refuse to issue budget warnings on stale data.
  const customDocs = await getUserCustomBudgetDocs(userId, adminDb);
  const mergedBudgets: Record<string, number> = { ...DEFAULT_BUDGETS };
  customDocs.forEach((b) => {
    if (b.limit) mergedBudgets[b.category || b.id] = Number(b.limit);
  });
  return mergedBudgets;
}

export async function addTransaction(args: any, userId: string, token: string) {
  const adminDb = getDb(token);
  console.log("TOOL CALL: addTransaction", args);
  
  const amount = parseAbsoluteFinancialAmount(args.amount);

  const textToCheck = `${args.type || ''} ${args.category || ''} ${args.subcategory || ''} ${args.notes || ''}`.toLowerCase();

  if (args.fromAccount && args.toAccount) {
    return await transferMoney(args, userId, token);
  }

  let type = String(args.type || 'expense').toLowerCase();
  if (type.includes('صرف') || type.includes('مصروف') || type.includes('دفع') || type.includes('شراء')) type = 'expense';
  if (type.includes('دخل') || type.includes('قبض') || type.includes('راتب') || type.includes('إيداع') || type.includes('ايداع') || type.includes('مرحل') || type.includes('تحويل لي') || type.includes('income')) type = 'income';
  if (type !== 'income' && type !== 'expense') type = 'expense';

  const paymentWasProvided = Boolean(args.paymentMethod || args.account);
  let account = normalizeAccount(args.paymentMethod || args.account || 'cash');
  let category = String(args.category || '').trim();
  let subcategory = String(args.subcategory || '').trim();
  const merchant = String(args.merchant || '').trim();
  const notes = String(args.notes || '').trim();
  let necessity = String(args.necessity || '').trim();
  const explicitNecessityProvided = Boolean(necessity);
  const explicitCategoryProvided = Boolean(String(args.category || '').trim());
  const explicitSubcategoryProvided = Boolean(String(args.subcategory || '').trim());
  const explicitPurchaseItem = String(args.item || args.description || args.purchaseItem || args.what || '').trim();
  const beneficiary = String(args.beneficiary || args.forWhom || args.forWho || args.person || '').trim();
  const categorySuggestion = inferCategory({ type, category, subcategory, notes, merchant, item: explicitPurchaseItem });
  category = category || categorySuggestion.category;
  subcategory = subcategory || categorySuggestion.subcategory;
  if (type === 'income' && (!args.category || category === 'أخرى')) {
    category = 'دخل';
    subcategory = /راتب|salary|قبض/i.test(`${notes} ${args.category || ''}`) ? 'راتب' : 'دخل عام';
  }
  const originalExpenseText = String(args.userText || '').trim();
  const expenseIdentitySource = originalExpenseText || `${explicitPurchaseItem} ${beneficiary} ${notes}`;
  const normalizedExpenseIdentitySource = normalizeArabicText(expenseIdentitySource);
  const beneficiaryPurposeRegex = /(للاولاد|للأولاد|للابناء|للأبناء|للعيال|للاطفال|للأطفال|للبنات|للبيت|للدار|للمنزل|للعيله|للعيلة|للعائله|للعائلة|للزوجة|لزوجتي|للزوج|لزوجي|للام|للأم|لامي|لأمي|للاب|للأب|لابوي|لأبوي|للعمل|للمدرسه|للمدرسة|للجامعه|للجامعة|للعلاج|للدواء|للضيافه|للضيافة|للضيف|للضيوف|للزياره|للزيارة|لنفسى|لنفسي|الي|إلي|الاولاد|الأولاد|الابناء|الأبناء|العيال|الاطفال|الأطفال|البنات|البيت|الدار|المنزل|العيله|العيلة|العائله|العائلة|زوجتي|زوجي|امي|أمي|ابوي|أبوي|العمل|المدرسه|المدرسة|الجامعه|الجامعة|العلاج|الدواء|الضيافه|الضيافة|الضيف|الضيوف|الزياره|الزيارة)/;
  const cleanedExpenseIdentity = normalizedExpenseIdentitySource
    .replace(normalizeArabicText(merchant), ' ')
    .replace(/شراء|اشتريت|شريت|اشتري|اخذت|اخدت|مصروف|دفعت|دفع|سجل|سجلي|تسجيل|قيد|مبلغ|قيمه|قيمة|شيكل|ش|₪|كاش|نقد|محفظه|محفظة|بال باي|palpay|pal pay|دين|بالدين|من|عند|على|ب|بـ/g, ' ')
    .replace(/\d+(\.\d+)?/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  const cleanedPurchaseItemIdentity = normalizedExpenseIdentitySource
    .replace(normalizeArabicText(merchant), ' ')
    .replace(beneficiaryPurposeRegex, ' ')
    .replace(/شراء|اشتريت|شريت|اشتري|اخذت|اخدت|مصروف|دفعت|دفع|سجل|سجلي|تسجيل|قيد|مبلغ|قيمه|قيمة|شيكل|ش|₪|كاش|نقد|محفظه|محفظة|بال باي|palpay|pal pay|دين|بالدين|من|عند|على|ب|بـ|لأجل|لاجل|عشان|علشان/g, ' ')
    .replace(/\d+(\.\d+)?/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  const userProvidedBeneficiaryPurpose = beneficiaryPurposeRegex.test(normalizedExpenseIdentitySource);
  const purchaseItemForRecord = explicitPurchaseItem || cleanedPurchaseItemIdentity || cleanedExpenseIdentity;
  const beneficiaryForRecord = beneficiary || (userProvidedBeneficiaryPurpose ? (normalizedExpenseIdentitySource.match(beneficiaryPurposeRegex)?.[0] || '') : '');

  const necessitySuggestion = type === 'expense'
    ? inferNecessityForGazaContext({ category, subcategory, notes, merchant, item: purchaseItemForRecord, amount })
    : null;
  if (type === 'expense' && !necessity && necessitySuggestion && necessitySuggestion.necessity !== 'محتاج تأكيد' && necessitySuggestion.confidence !== 'low') {
    necessity = necessitySuggestion.necessity;
  }

  // Treasurer Mode: income must not be silently dumped into cash.
  // Salary/income needs an explicit destination or a split between cash and PalPay.
  if (type === 'income') {
    const allocations = normalizeIncomeAllocations(args);
    if (allocations.length > 0) {
      const totalAllocated = allocations.reduce((s, a) => s + a.amount, 0);
      if (Math.abs(totalAllocated - amount) > 0.01) {
        return {
          success: false,
          needsClarification: true,
          reason: 'INCOME_SPLIT_MISMATCH',
          message: `مجموع توزيع الدخل (${totalAllocated} ₪) لا يساوي المبلغ الكلي (${amount} ₪). قل لي كم نقدي وكم PalPay بالضبط.`
        };
      }
      const results: any[] = [];
      for (const alloc of allocations) {
        const r = await addTransaction({ ...args, amount: alloc.amount, account: alloc.account, paymentMethod: alloc.account, incomeDestinationConfirmed: true, destinationConfirmed: true, allocations: [], split: [], incomeSplit: [], notes: [notes, alloc.note].filter(Boolean).join(' - ') }, userId, token);
        results.push(r);
        if (!r?.success) return r;
      }
      return { success: true, splitIncome: true, results, message: `تم توزيع الدخل: ${allocations.map(a => `${a.amount} ₪ ${a.account === 'palPay' ? 'PalPay' : 'كاش'}`).join('، ')}.` };
    }
    // Live tool calls do not carry a transcript/userText; in that path the model's
    // structured income fields are the only available evidence. Text chat still
    // prefers the user's original words when they are available.
    const originalUserIncomeText = normalizeArabicText(args.userText || args.currentUserText || '');
    const toolIncomeText = normalizeArabicText(`${category} ${subcategory} ${notes} ${args.source || ''} ${args.description || ''}`);
    const explicitIncomeDestination = paymentWasProvided && (account === 'cash' || account === 'palPay');
    // Nature must be explicit from the user's words, not inferred by the model's generated category/notes.
    // Example: "مبلغ من الغذاء العالمي بال باي" is NOT enough; ask if it is aid/grant/loan.
    const userStatedIncomeNature = [
      'راتب', 'مساعده', 'مساعدة', 'هديه', 'هدية', 'منحه', 'منحة', 'مكافاه', 'مكافأة',
      'عمل اضافي', 'دخل اضافي', 'بيع', 'ربح', 'تحويل وارد', 'ايداع', 'إيداع', 'دعم'
    ].some(word => originalUserIncomeText.includes(normalizeArabicText(word)));
    const userStatedLoanNature = ['سلفه', 'سلفة', 'قرض', 'دين', 'استدنت', 'اقترضت'].some(word => originalUserIncomeText.includes(normalizeArabicText(word)));
    if (userStatedLoanNature && !userStatedIncomeNature) {
      return {
        success: false,
        needsClarification: true,
        reason: 'POSSIBLE_LOAN_NOT_INCOME',
        message: 'هذا يبدو قرضاً/سلفة وليس دخلاً. هل استلمت مالاً يجب تسجيله كدين، أم هو منحة/مساعدة لا تُرد؟'
      };
    }
    const userStatedNonReturnAid = ['لا ترد', 'لا يرد', 'غير مسترده', 'غير مستردة', 'بدون رد', 'مش سلفه', 'مش سلفة', 'مش قرض'].some(word => originalUserIncomeText.includes(normalizeArabicText(word)));
    const incomeDestinationConfirmed = Boolean(args.incomeDestinationConfirmed || args.destinationConfirmed || args.confirmedDestination || args.allocationConfirmed || explicitIncomeDestination);
    const incomeNatureConfirmed = originalUserIncomeText
      ? Boolean(userStatedIncomeNature || userStatedNonReturnAid)
      : Boolean(
          args.incomeNatureConfirmed || args.sourceConfirmed || args.natureConfirmed ||
          /راتب|salary|قبض|مساعده|مساعدة|منحه|منحة|هديه|هدية|مكافاه|مكافأة|دخل اضافي|عمل اضافي|بيع|ربح|تحويل وارد|ايداع|إيداع|دعم/i.test(toolIncomeText)
        );
    if (!incomeNatureConfirmed) {
      return {
        success: false,
        needsClarification: true,
        reason: 'MISSING_INCOME_NATURE_CONFIRMATION',
        message: 'قبل تسجيل الدخل: هل هو راتب، مساعدة/هدية، دخل عمل إضافي، بيع، أم سلفة/دين؟ إذا كان سلفة لا أسجلها كدخل.'
      };
    }
    if (!incomeDestinationConfirmed) {
      return {
        success: false,
        needsClarification: true,
        reason: 'MISSING_INCOME_DESTINATION_CONFIRMATION',
        message: 'تمام، وطبيعة الدخل واضحة. الآن أكد لي أين دخل فعلياً: كاش أم PalPay؟ وإن كان موزعاً قل كم كاش وكم PalPay.'
      };
    }
    // Income must not be committed from model-invented metadata. For non-salary
    // income, identify the real source/person/organization before writing.
    const incomeSource = String(args.source || merchant || '').trim();
    const isSalaryIncome = /راتب|salary|قبض/i.test(`${originalUserIncomeText} ${toolIncomeText}`);
    if (!isSalaryIncome && !incomeSource) {
      return {
        success: false,
        needsClarification: true,
        reason: 'MISSING_INCOME_SOURCE',
        message: 'قبل ما أسجل الدخل: من مين أو من أي جهة وصلك المبلغ؟'
      };
    }
  }

  // Financial writes must never silently invent missing accounting dimensions.
  // The AI is expected to collect these slots conversationally; the backend remains the final guard.
  if (amount <= 0) return { success: false, needsClarification: true, reason: 'INVALID_AMOUNT', message: 'ما قيمة العملية بالضبط؟' };
  if (type === 'expense' && !paymentWasProvided) return { success: false, needsClarification: true, reason: 'MISSING_PAYMENT_METHOD', message: 'هل دفعت كاش أم من محفظة PalPay أم سجلتها ديناً؟' };
  if (type === 'expense') {
    const hasOriginalUserContext = Boolean(originalExpenseText);
    const userProvidedPurchaseIdentity = cleanedPurchaseItemIdentity.length >= 3;
    const userProvidedPurposeIdentity = userProvidedBeneficiaryPurpose || Boolean(beneficiary);
    const voiceOrApiProvidedIdentity = !hasOriginalUserContext && Boolean(explicitPurchaseItem || notes);
    const voiceOrApiProvidedPurpose = !hasOriginalUserContext && Boolean(beneficiary);
    if (!userProvidedPurchaseIdentity && !voiceOrApiProvidedIdentity) {
      return {
        success: false,
        needsClarification: true,
        reason: 'MISSING_PURCHASE_ITEM',
        message: 'قبل تسجيل أي مصروف لازم أعرف شو اشتريت بالضبط. قل لي مثلاً: خبز، دواء، ملابس، تموين... بعدها أحدد أنا البند وهل هو ضروري أو كمالي وفق واقع غزة.'
      };
    }
    if (!userProvidedPurposeIdentity && !voiceOrApiProvidedPurpose) {
      return {
        success: false,
        needsClarification: true,
        reason: 'MISSING_PURCHASE_BENEFICIARY_OR_PURPOSE',
        message: 'ولمين أو لأي غرض هذا المصروف؟ للبيت، للأولاد، لزوجتك، للعلاج، للضيافة، للعمل، أو لنفسك؟ لا أسجل القيد بدون الغرض.'
      };
    }
  }
  if (!category) return { success: false, needsClarification: true, reason: 'MISSING_CATEGORY', message: 'ما بند العملية الرئيسي؟' };
  if (type === 'expense' && !subcategory) return { success: false, needsClarification: true, reason: 'MISSING_SUBCATEGORY', message: 'ما البند الفرعي لهذا المصروف؟' };
  if (type === 'expense' && !necessity) return {
    success: false,
    needsClarification: true,
    reason: 'MISSING_NECESSITY_CONTEXT',
    message: `لم أستطع تصنيف هذا المصروف كضروري أو كمالي وفق واقع غزة من الوصف الحالي. ${necessitySuggestion?.reason || ''} قل لي باختصار: ما الحاجة من هذا الشراء؟`
  };
  if (type === 'expense' && account === 'debt' && !merchant) return { success: false, needsClarification: true, reason: 'MISSING_CREDITOR', message: 'لمن سُجّل هذا الدين أو من أي محل/شخص اشتريت بالدين؟' };

  if (
    textToCheck.includes('دفع دين') || 
    textToCheck.includes('دفعت دين') || 
    (type === 'expense' && category.includes('سداد')) || 
    ((textToCheck.includes('سداد') || textToCheck.includes('سدد') || textToCheck.includes('تسديد')) && (textToCheck.includes('دين') || textToCheck.includes('الديون') || textToCheck.includes('لشخص') || textToCheck.includes('لصديق'))) ||
    (account === 'debt' && type === 'expense' && (textToCheck.includes('سداد') || textToCheck.includes('تسديد') || textToCheck.includes('سدد') || textToCheck.includes('دفع') || category.includes('سداد')))
  ) {
    let fromAcc = normalizeAccount(args.paymentMethod || args.fromAccount || 'cash');
    if (fromAcc === 'debt') fromAcc = 'cash'; 
    return await payDebt({ amount, paymentMethod: fromAcc, creditor: args.merchant || args.subcategory || 'سداد دين', notes: args.notes }, userId, token);
  }

  if ((textToCheck.includes('تحويل') && (textToCheck.includes('من') || textToCheck.includes('إلى') || textToCheck.includes('لبال') || textToCheck.includes('كاش'))) || args.category === 'تحويل' || args.category === 'تحويل داخلي') {
    const fromAcc = normalizeAccount(args.fromAccount || args.account || (textToCheck.includes('من بال') ? 'palPay' : 'cash'));
    const toAcc = normalizeAccount(args.toAccount || (textToCheck.includes('إلى بال') || textToCheck.includes('لبال') ? 'palPay' : 'cash'));
    return await transferMoney({ amount, fromAccount: fromAcc, toAccount: toAcc, notes: args.notes }, userId, token);
  }

  // V5 pre-execution guard: the same budget/transaction reads that used to happen after the write
  // are performed before it so the assistant can warn before damage, then reused below (no duplicate polling/read loop).
  let preTxSnapshot: any = null;
  let preUserBudgets: Record<string, number> | null = null;

  if (type === 'income') {
    try {
      preTxSnapshot = await adminDb.collection('transactions').where('userId', '==', userId).get();
      if ((preTxSnapshot as any).partial === true) {
        return {
          success: false,
          retryable: true,
          reason: 'PARTIAL_STATE_UNSAFE',
          message: 'لا أستطيع تسجيل دخل الآن لأن حالة السحابة غير مؤكدة. لن أسجل راتباً قد يتكرر أو يضيع حتى يرجع Firestore مؤكداً.',
        };
      }
      const existingIncome = preTxSnapshot.docs.map((d:any)=>({ id: d.id, ...d.data() }));
      const nowTime = Date.now();
      const isSalaryLike = /راتب|salary|قبض/i.test(`${category} ${subcategory} ${notes}`);
      const sameIncome = existingIncome
        .filter((t:any) => t.type === 'income' && Math.abs(parsePositiveFinancialAmount(t.amount) - amount) < 0.01 && t.account === account)
        .filter((t:any) => {
          const ts = new Date(t.date || t.createdAt || 0).getTime();
          if (!Number.isFinite(ts)) return false;
          const sameDay = new Date(ts).toISOString().slice(0, 10) === new Date().toISOString().slice(0, 10);
          const sameMonth = new Date(ts).toISOString().slice(0, 7) === new Date().toISOString().slice(0, 7);
          return (nowTime - ts <= 30 * 60 * 1000) || (isSalaryLike && sameMonth) || sameDay;
        });
      if (sameIncome.length > 0 && !args.duplicateConfirmed) {
        return {
          success: false,
          needsConfirmation: true,
          reason: 'POSSIBLE_DUPLICATE_INCOME',
          message: `انتبه يا كبير: يوجد دخل/راتب بنفس المبلغ ${amount} ₪ على نفس الحساب مسجل قريباً. لن أكرره حتى تؤكد أنه دخل آخر وليس تكراراً.`,
          duplicateOf: sameIncome[0]?.id,
          matches: sameIncome.slice(0, 3).map((t:any) => ({ id: t.id, amount: t.amount, account: t.account, date: t.date, category: t.category, subcategory: t.subcategory }))
        };
      }
    } catch (incomePreErr) {
      console.error('Income duplicate guard unavailable:', incomePreErr);
      return {
        success: false,
        retryable: true,
        reason: 'INCOME_DUPLICATE_GUARD_UNAVAILABLE',
        message: 'لم أستطع التحقق من عدم تكرار الدخل في السحابة، لذلك لن أسجل الراتب حتى لا يتضاعف الرصيد.'
      };
    }
  }

  if (type === 'expense' && !args.deferBalanceCheckToAtomicBatch) {
    try {
      [preUserBudgets, preTxSnapshot] = await Promise.all([
        getUserBudgets(userId, adminDb),
        adminDb.collection('transactions').where('userId', '==', userId).get()
      ]);
      // V6.2 (FINDING-07): if the snapshot is partial (Firestore quota/network failure),
      // we MUST NOT issue a balance-sensitive mutation on incomplete state.
      // The operation becomes pending (client-side queue) or rejected.
      if ((preTxSnapshot as any).partial === true) {
        return {
          success: false,
          retryable: true,
          reason: 'PARTIAL_STATE_UNSAFE',
          message: 'تعذّر التحقق من رصيدك الحالي بدقة (البيانات الجزئية). لا يمكن تنفيذ عملية مالية حساسة الآن. حاول مرة أخرى عند استعادة الاتصال الكامل.',
          operationId: String(args.operationId || `tx_${Date.now()}_${Math.random().toString(36).slice(2,10)}`),
        };
      }
      const existing = preTxSnapshot.docs.map((d:any)=>d.data());
      const balances = calculateBalancesFromDocs(existing);
      // V6 (HF-7): for debt purchases, available is no longer Infinity. We compute
      // projected debt-to-income ratio and require confirmation if it exceeds a threshold.
      if (account !== 'debt') {
        const available = account === 'cash' ? Number(balances.cash||0) : account === 'palPay' ? Number(balances.palPay||0) : 0;
        if (amount > available + 0.0001) {
          return { success:false, needsClarification:true, reason:'INSUFFICIENT_FUNDS', message:`المبلغ ${amount} ₪ أكبر من رصيد ${account === 'palPay' ? 'PalPay' : 'الكاش'} المتاح (${available} ₪). لن أنفذ العملية قبل أن تحدد طريقة دفع أخرى أو تعدل المبلغ.` };
        }
      } else {
        // Debt purchase guard.
        // A credit purchase is one expense on account=debt. We must not block a later real purchase
        // just because it has the same creditor and amount; real shops can sell two separate items
        // for the same price. Duplicate prevention belongs to operationId/idempotency only.
        const projectedDebt = Number(balances.debt || 0) + amount;
        const monthlyIncome90d = existing
          .filter((t:any) => t.type === 'income' && t.transactionType !== 'DEBT_BORROWING')
          .reduce((s:number, t:any) => s + parsePositiveFinancialAmount(t.amount), 0);
        const debtToIncomeRatio = monthlyIncome90d > 0 ? projectedDebt / monthlyIncome90d : Infinity;
        if (!args.riskConfirmed && (debtToIncomeRatio > 1.0 || amount > 5000)) {
          return {
            success:false,
            needsConfirmation:true,
            reason:'DEBT_PURCHASE_RISK',
            message:`هذا الشراء بالدين سيرفع إجمالي ديونك إلى ${projectedDebt} ₪ (نسبة الدين للدخل ${(debtToIncomeRatio * 100).toFixed(0)}%). هل تريد المتابعة رغم هذا الوضع؟`,
            financialImpact: {
              currentDebt: balances.debt,
              purchaseAmount: amount,
              projectedDebt,
              debtToIncomeRatio: Number.isFinite(debtToIncomeRatio) ? Math.round(debtToIncomeRatio * 100) / 100 : null,
            },
          };
        }
      }
      const thisMonth = new Date().toISOString().slice(0,7);
      const spent = existing.filter((t:any)=>t.type==='expense' && String(t.date||'').startsWith(thisMonth) && t.category===category).reduce((a:number,t:any)=>a+parsePositiveFinancialAmount(t.amount),0);
      const limit = Number((preUserBudgets as any)?.[category] || DEFAULT_BUDGETS[category] || 0);
      const projected = spent + amount;
      const recentExpenses = existing.filter((t:any) => t.type === 'expense' && new Date(t.date || t.createdAt || 0).getTime() >= Date.now() - 30 * 86400000);
      const dailyExpenseAverage = recentExpenses.reduce((a:number,t:any)=>a+parsePositiveFinancialAmount(t.amount),0) / 30;
      let profileReserveTarget = Number(args.savingsReserveTarget || 0);
      try {
        const profileSnap = await adminDb.collection('users').doc(userId).collection('treasurer').doc('profile').get();
        if (profileSnap.exists) profileReserveTarget = Math.max(profileReserveTarget, Number(profileSnap.data()?.cashReserveTarget || 0));
      } catch (profileErr) {
        console.warn('Treasurer profile unavailable for risk gate:', profileErr);
      }
      const risk = evaluateTreasurerRisk({
        amount,
        type,
        account,
        category,
        subcategory,
        necessity,
        merchant,
        balances,
        budgetLimit: limit,
        categorySpent: spent,
        dailyExpenseAverage,
        projected30DayBalance: Number(balances.total || 0) - dailyExpenseAverage * 30,
        savingsReserveTarget: profileReserveTarget,
        riskConfirmed: Boolean(args.riskConfirmed),
      });
      if (risk.needsConfirmation) {
        return {
          success:false,
          needsConfirmation:true,
          reason:'TREASURER_RISK_REVIEW_REQUIRED',
          message:`أمين الصندوق يعترض قبل التسجيل: ${risk.warnings.join(' ')} هل تصر على تنفيذ العملية؟`,
          financialImpact:risk,
        };
      }
      if (limit > 0 && projected >= limit && !args.riskConfirmed) {
        return { success:false, needsConfirmation:true, reason:'BUDGET_WILL_BE_EXCEEDED', message:`هذه العملية سترفع مصروف بند [${category}] إلى ${projected} ₪ مقابل سقف ${limit} ₪. هل تريد المتابعة رغم التجاوز؟`, financialImpact:{spent,amount,projected,limit,percentage:Math.round(projected/limit*100)} };
      }
    } catch (preErr) {
      console.error('V5 preflight warning check unavailable:', preErr);
      // Do not fabricate a warning when data is unavailable. Existing write/fallback behavior remains intact.
    }
  }

  const transactionNow = new Date();
  const dateResult = normalizeHistoricalTransactionDate({
    date: args.date,
    historicalMonth: args.historicalMonth || args.monthContext || args.entryMonth,
    day: args.day || args.transactionDay,
    now: transactionNow,
  });
  if (dateResult.ok === false) {
    return {
      success: false,
      needsClarification: true,
      reason: dateResult.reason,
      message: dateResult.message,
    };
  }

  const operationId = String(args.operationId || `tx_${Date.now()}_${Math.random().toString(36).slice(2,10)}`);
  const tx = {
    userId,
    amount,
    type,
    account,
    category,
    subcategory,
    purchaseItem: type === 'expense' ? purchaseItemForRecord : explicitPurchaseItem,
    beneficiary: type === 'expense' ? beneficiaryForRecord : beneficiary,
    merchant,
    notes,
    necessity: type === 'expense' ? necessity : '',
    necessitySource: type === 'expense' && explicitNecessityProvided ? 'user' : (type === 'expense' ? 'gaza_context_classifier' : ''),
    necessityReason: type === 'expense' ? (necessitySuggestion?.reason || '') : '',
    transactionType: type === 'expense' && account === 'debt' ? 'CREDIT_PURCHASE' : (type === 'income' ? 'INCOME' : 'EXPENSE'),
    creditor: type === 'expense' && account === 'debt' ? merchant : '',
    creditorKey: type === 'expense' && account === 'debt' ? normalizeCreditorName(merchant) : '',
    operationId,
    date: dateResult.date,
    dateSource: dateResult.source,
    createdAt: transactionNow.toISOString()
  };

  // V6.1+ (CONC-01..CONC-05): every real add_transaction write goes through
  // atomicAddTransaction. Balance-sensitive ops keep projected-balance checks;
  // non-sensitive adds skip the balance check but still require a confirmed
  // Firestore transaction commit, so FakeDb/local pending fallback cannot create
  // an apparent success that never appears in the client.
  const isBalanceSensitive = (type === 'expense' && (account === 'cash' || account === 'palPay'))
                          || (type === 'transfer' && (account === 'cash' || account === 'palPay'));

  // Validation-only mode is used by multi-line receipt recording. It executes the
  // exact same domain validation and transaction construction as addTransaction,
  // but deliberately stops before any persistence or side effect. The caller then
  // commits all prepared rows atomically as one receipt operation.
  if (args.validateOnly === true) {
    return {
      success: true,
      validationOnly: true,
      preparedTransaction: tx,
      operationId,
      isBalanceSensitive,
    };
  }

  let writeResult: WriteResult | null = null;
  let actualTxId = '';
  let atomicResult: Awaited<ReturnType<typeof atomicAddTransaction>>;
  try {
    atomicResult = await atomicAddTransaction(userId, tx, {
      skipBalanceCheck: !isBalanceSensitive,
      riskConfirmed: Boolean(args.riskConfirmed),
    });
  } catch (e: any) {
    return {
      success: false,
      retryable: true,
      reason: 'CLOUD_WRITE_FAILED',
      message: `لم يتم حفظ العملية في Firestore. لم أسجل أي قيد. السبب: ${e?.message || 'فشل غير معروف في التخزين السحابي'}`,
      error: e?.message || String(e),
    };
  }
  if (!atomicResult.ok) {
    const failReason = (atomicResult as any).reason as string;
    const failAvailable = (atomicResult as any).available as number | undefined;
    if (failReason === 'INSUFFICIENT_FUNDS_ATOMIC') {
      return {
        success: false,
        needsClarification: true,
        reason: 'INSUFFICIENT_FUNDS',
        message: `المبلغ ${amount} ₪ أكبر من الرصيد المتاح (${failAvailable} ₪). العملية مرفوضة لمنع تجاوز الرصيد.`,
      };
    }
    return { success: false, error: failReason };
  }
  actualTxId = atomicResult.docId;
  writeResult = { durability: 'committed', synced: true, pending: false };
  
  // The ledger write above is already durably committed. Secondary effects
  // (notifications/budget warnings) must never turn that committed write into
  // an apparent tool failure, otherwise Live may tell the user to retry and
  // create a duplicate while the original transaction already exists.
  try {
    await recordTransactionCommittedSideEffects(userId, actualTxId, tx, adminDb, {
      preUserBudgets,
      preTxSnapshot,
    });
  } catch (sideEffectErr) {
    console.warn('Post-commit financial side effect failed; preserving committed transaction success:', sideEffectErr);
  }
  
  // A post-commit balance refresh is informational only. The transaction has
  // already committed atomically above, so a transient read failure must not
  // turn a durable write into a failed Live tool call.
  let balances: any = { balances: undefined, partial: true };
  try {
    balances = await getBalance({}, userId, token);
  } catch (balanceErr) {
    console.warn('Post-commit balance refresh failed; preserving committed transaction success:', balanceErr);
  }
  return {
    success: true,
    transactionId: actualTxId,
    operationId,
    transaction: { id: actualTxId, ...tx },
    currentBalances: balances.balances,
    // V6: explicit durability flag. UI/AI MUST inspect this.
    // Important: do NOT conflate a partial balance read with a pending write.
    // A transaction can be safely committed to Firestore while the follow-up balance read is partial.
    durability: writeResult!.durability,
    pending: writeResult!.pending,
    partial: writeResult!.pending,
    balanceReadPartial: Boolean(balances.partial),
    cloudStorageConfirmed: writeResult!.durability === 'committed',
    cloudStoragePending: writeResult!.pending,
    message: writeResult!.durability === 'committed'
      ? `تم حفظ القيد في السحابة بقيمة ${amount} ₪.`
      : undefined,
    balanceWarning: balances.partial && writeResult!.durability === 'committed'
      ? 'تم حفظ القيد سحابياً، لكن قراءة الرصيد بعد الحفظ كانت جزئية؛ حدّث الصفحة إذا لم يظهر الرصيد فوراً.'
      : undefined,
    pendingReason: writeResult!.pending ? 'CLOUD_STORAGE_NOT_CONFIRMED' : undefined,
    pendingError: writeResult!.pending ? writeResult!.error : undefined,
    userFacingPendingMessage: writeResult!.pending
      ? 'الخادم يعمل، لكن Firestore لم يؤكد حفظ العملية سحابياً بعد. هذه ليست بالضرورة مشكلة إنترنت عندك؛ افحص إعدادات Firebase/Firestore أو أعد المحاولة.'
      : undefined,
  };
}

export async function prepareAddTransaction(args: any, userId: string, token: string) {
  // Receipt recording needs the canonical add_transaction validation/preparation
  // authority, but must not pass validateOnly through toolHandlers because that
  // wrapper records idempotency outcomes for operations that have not written yet.
  return addTransaction({ ...args, validateOnly: true }, userId, token);
}

export async function sendPalPayPayment(args: any, userId: string, token: string) {
  const adminDb = getDb(token);
  console.log("TOOL CALL: sendPalPayPayment", args);

  // V6 (HF-3): full validation mirroring addTransaction guards.
  const amount = parseAbsoluteFinancialAmount(args.amount);
  if (amount <= 0) {
    return { success: false, needsClarification: true, reason: 'INVALID_AMOUNT', message: 'المبلغ يجب أن يكون رقماً موجباً.' };
  }
  const recipientName = String(args.recipientName || '').trim();
  const phoneNumber = String(args.phoneNumber || '').trim();
  const description = String(args.description || '').trim();
  if (!recipientName) return { success: false, needsClarification: true, reason: 'MISSING_RECIPIENT', message: 'إلى من ترسل المبلغ؟' };
  if (!phoneNumber) return { success: false, needsClarification: true, reason: 'MISSING_PHONE', message: 'ما رقم جوال المستلم؟' };
  // Palestinian phone format: +970/+972 or 05xxxxxxxx. Loose validation.
  const normalizedPhone = phoneNumber.replace(/[\s-]/g, '');
  if (!/^(\+9(70|72)|0)?5\d{8}$/.test(normalizedPhone)) {
    return { success: false, needsClarification: true, reason: 'INVALID_PHONE', message: `رقم الجوال ${phoneNumber} غير صالح. يجب أن يبدأ بـ 05 أو +9705 أو +9725.` };
  }

  // Check PalPay balance BEFORE writing.
  const balanceCheck = await getBalance({}, userId, token);
  const palPayAvailable = Number(balanceCheck?.balances?.palPay || 0);
  if (amount > palPayAvailable + 0.0001) {
    return { success: false, needsClarification: true, reason: 'INSUFFICIENT_FUNDS', message: `رصيد PalPay المتاح هو ${palPayAvailable} ₪ فقط. لا يمكن تحويل ${amount} ₪.` };
  }

  const operationId = String(args.operationId || `palpay_${Date.now()}_${Math.random().toString(36).slice(2,10)}`);
  const txRef = adminDb.collection('transactions').doc();
  const tx = {
    userId,
    amount,
    type: 'expense',
    account: 'palPay',
    // V6 (LF-14): use a category that exists in DEFAULT_BUDGETS so budget tracking fires.
    category: 'تحويلات PalPay',
    subcategory: `تحويل إلى ${recipientName}`,
    merchant: 'PalPay',
    notes: description || `تحويل ${amount} ₪ إلى ${recipientName} (${phoneNumber})`,
    transactionType: 'PALPAY_TRANSFER',
    operationId,
    necessity: 'ضروري',
    date: new Date().toISOString(),
    createdAt: new Date().toISOString(),
    // Preserve recipient metadata for audit trail.
    palpayRecipient: recipientName,
    palpayPhone: normalizedPhone,
  };

  // Add PalPay category to DEFAULT_BUDGETS lazily if not present (so budget tracking works).
  if (!DEFAULT_BUDGETS['تحويلات PalPay']) {
    DEFAULT_BUDGETS['تحويلات PalPay'] = 1000;
  }

  const writeResult = await txRef.set(tx);

  await addNotification(userId, `تم تحويل ${amount} ₪ إلى ${recipientName} (${normalizedPhone}) عبر PalPay بنجاح.`, 'success', adminDb);

  const balances = await getBalance({}, userId, token);
  return {
    success: true,
    transactionId: txRef.id,
    operationId,
    currentBalances: balances.balances,
    durability: writeResult.durability,
    pending: writeResult.pending,
    partial: balances.partial || writeResult.pending,
  };
}

export async function generateReport(args: any, userId: string, token: string) {
  const adminDb = getDb(token);
  console.log("TOOL CALL: generateReport", args);
  
  // Fetch transactions based on user
  const txSnapshot = await adminDb.collection('transactions').where('userId', '==', userId).get();
  const allUserTxs = txSnapshot.docs.map(d => ({ id: d.id, ...d.data() }));
  
  const now = new Date();
  const timeframe = args.timeframe || 'all';
  const categoryQuery = args.category && args.category !== 'all' && args.category !== 'الكل' && args.category !== 'كافة البنود' ? args.category : '';

  // 1. First attempt: filter by category and timeframe
  let filtered = allUserTxs.filter((t: any) => {
    if (categoryQuery && !matchesArabicCategory(t, categoryQuery)) {
      return false;
    }
    
    if (timeframe === 'today') {
      const today = now.toISOString().split('T')[0];
      return (t.date || t.createdAt || '').startsWith(today);
    } else if (timeframe === 'week') {
      const weekAgo = new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000);
      return new Date(t.date || t.createdAt || now) >= weekAgo;
    } else if (timeframe === 'month') {
      const thisMonth = now.toISOString().slice(0, 7);
      return (t.date || t.createdAt || '').startsWith(thisMonth);
    }
    return true;
  });

  // 2. V6 (LF-18, MF-25): if no transactions match the timeframe, return EMPTY — do NOT
  // silently fall back to ALL time. The report title says "الشهر الحالي" so the data
  // MUST be this month. An empty period report is the honest answer.
  // (The previous fallback misled users into thinking old data was current.)
  // We still keep the category-only fallback if a category was requested AND timeframe
  // was 'all' (which is the default and means no time constraint).

  // 3. If STILL zero transactions and title provides a hint, search by title — but ONLY
  // when timeframe is 'all'. Otherwise we'd be mixing timeframes silently.
  if (filtered.length === 0 && args.title && timeframe === 'all') {
    filtered = allUserTxs.filter((t: any) => matchesArabicCategory(t, args.title));
  }

  // Sort descending by date
  filtered.sort((a: any, b: any) => new Date(b.date || b.createdAt || 0).getTime() - new Date(a.date || a.createdAt || 0).getTime());
  
  const defaultTitle = args.title || (
    timeframe === 'today' ? 'تقرير مصروفات اليوم التفصيلي' :
    timeframe === 'month' ? 'التقرير المالي الشهري الشامل' :
    categoryQuery ? `تقرير تفصيلي لبند (${categoryQuery})` :
    'التقرير المالي الهيكلي الشامل لكافة البنود'
  );

  const reportRef = adminDb.collection('reports').doc();
  const report = buildReportSnapshotRecord({
    userId,
    title: defaultTitle,
    timeframe,
    category: categoryQuery || 'كافة البنود',
    transactions: filtered,
  });
  
  await reportRef.set(report);

  await addNotification(userId, `تم إنجاز ${defaultTitle} بنجاح (${filtered.length} عملية)! تجده في حافظة المهام.`, 'success', adminDb);

  return { 
    success: true, 
    reportId: reportRef.id, 
    transactionsCount: filtered.length, 
    message: `Report generated with ${filtered.length} transactions and saved to inbox.` 
  };
}

export async function getReports(args: any, userId: string, token: string) {
  const adminDb = getDb(token);
  const snapshot = await adminDb.collection('reports').where('userId', '==', userId).orderBy('createdAt', 'desc').get();
  return { reports: snapshot.docs.map(doc => ({ id: doc.id, ...doc.data() })), partial: (snapshot as any).partial };
}

export async function deleteReport(args: { id: string }, userId: string, token: string) {
  const adminDb = getDb(token);
  console.log("TOOL CALL: deleteReport", args);
  if (!args.id) throw new Error("Report id is required");
  
  const reportRef = adminDb.collection('reports').doc(args.id);
  const doc = await reportRef.get();
  if (doc.exists && doc.data()?.userId === userId) {
    await reportRef.delete();
    return { success: true, message: "تم حذف التقرير بنجاح." };
  }
  return { success: false, message: "التقرير غير موجود أو تم حذفه مسبقاً." };
}

export async function clearAllReports(args: any, userId: string, token: string) {
  const adminDb = getDb(token);
  console.log("TOOL CALL: clearAllReports for user", userId);
  const snapshot = await adminDb.collection('reports').where('userId', '==', userId).get();
  
  if (snapshot.docs.length > 0) {
    const batch = adminDb.batch();
    for (const d of snapshot.docs) {
      batch.delete(adminDb.collection('reports').doc(d.id));
    }
    await batch.commit();
  }
  return { success: true, count: snapshot.docs.length, message: `تم حذف كافة التقارير (${snapshot.docs.length} تقرير).` };
}

export async function memorySave(args: any, userId: string, token: string) {
  const adminDb = getDb(token);
  console.log("TOOL CALL: memorySave", args);
  // Just use debts collection or user profile for memory for now, let's store in a 'memory' subcollection of user
  await adminDb.collection('users').doc(userId).collection('memory').doc(args.key).set({ value: args.value, updatedAt: new Date().toISOString() });
  return { success: true, message: `Saved ${args.key} to memory.` };
}

export async function memorySearch(args: any, userId: string, token: string) {
  const adminDb = getDb(token);
  console.log("TOOL CALL: memorySearch", args);
  // V6 (MF-2): actually filter by args.query while keeping memory lookup bounded.
  // A substring search still happens in-process, but only over a small recent
  // slice so long-running historical entry sessions do not exhaust Firestore quota.
  const limit = Math.max(1, Math.min(80, Number(args.limit) || 40));
  const snapshot = await adminDb.collection('users').doc(userId).collection('memory').limit(limit).get();
  const query = String(args.query || '').trim().toLowerCase();
  const allEntries: { key: string; value: string }[] = [];
  snapshot.docs.forEach(doc => {
    const data = doc.data();
    if (data && data.value) {
      allEntries.push({ key: doc.id, value: String(data.value) });
    }
  });
  if (!query) {
    return { memory: Object.fromEntries(allEntries.slice(0, 20).map(e => [e.key, e.value])), bounded: true, limit };
  }
  const matched = allEntries.filter(e =>
    e.key.toLowerCase().includes(query) || e.value.toLowerCase().includes(query)
  );
  const top = matched.slice(0, 10);
  return { memory: Object.fromEntries(top.map(e => [e.key, e.value])), bounded: true, limit };
}

export async function deleteMemoryKey(args: { key: string }, userId: string, token: string) {
  const adminDb = getDb(token);
  console.log("TOOL CALL: deleteMemoryKey", args);
  if (!args.key) return { error: "Key is required" };
  await adminDb.collection('users').doc(userId).collection('memory').doc(args.key).delete();
  return { success: true, message: `Deleted ${args.key} from memory.` };
}

export async function createRecurringItem(args: any, userId: string, token: string) {
  const adminDb = getDb(token);
  console.log("TOOL CALL: createRecurringItem", args);
  const docRef = adminDb.collection('debts').doc();
  await docRef.set({
    userId,
    type: 'subscription',
    personOrService: args.name,
    amount: args.amount,
    dueDate: args.next_date || new Date().toISOString(),
    status: 'active',
    createdAt: new Date().toISOString()
  });
  return { success: true, message: "Recurring item created." };
}

export async function exportUserData(userId: string, token: string) {
  const adminDb = getDb(token);
  console.log("TOOL CALL: exportUserData for", userId);
  
  // 1. Fetch transactions
  const txSnapshot = await adminDb.collection('transactions').where('userId', '==', userId).get();
  const transactions = txSnapshot.docs.map(d => ({ id: d.id, ...d.data() }));

  // 2. Fetch custom budgets
  const budgetsSnapshot = await adminDb.collection('users').doc(userId).collection('budgets').get();
  const budgets: Record<string, number> = {};
  budgetsSnapshot.docs.forEach((d: any) => {
    const data = d.data();
    if (data && data.limit !== undefined) {
      budgets[d.id] = Number(data.limit);
    }
  });

  // 3. Fetch commitments
  const commitmentsSnapshot = await adminDb.collection('commitments').where('userId', '==', userId).get();
  const commitments = commitmentsSnapshot.docs.map(d => ({ id: d.id, ...d.data() }));

  // 4. Fetch reports
  const reportsSnapshot = await adminDb.collection('reports').where('userId', '==', userId).get();
  const reports = reportsSnapshot.docs.map(d => ({ id: d.id, ...d.data() }));

  // 5. Fetch memory
  const memorySnapshot = await adminDb.collection('users').doc(userId).collection('memory').get();
  const memory: Record<string, string> = {};
  memorySnapshot.docs.forEach(d => {
    const data = d.data();
    if (data && data.value) memory[d.id] = data.value;
  });

  return {
    version: "1.0",
    exportDate: new Date().toISOString(),
    app: "Masrofi AI",
    userId,
    counts: {
      transactions: transactions.length,
      budgets: Object.keys(budgets).length,
      commitments: commitments.length,
      reports: reports.length,
      memoryKeys: Object.keys(memory).length
    },
    transactions,
    budgets,
    commitments,
    reports,
    memory
  };
}

type PreparedImportedNamedRecord = { sourceId: string; docData: any };

type ImportSectionValidationFailure = {
  section: string;
  index: string | number;
  code: string;
  message: string;
};

function isPlainBackupObject(value: any): boolean {
  return Boolean(value && typeof value === 'object' && !Array.isArray(value));
}

function isSafeBackupDocId(value: string): boolean {
  return Boolean(value && !value.includes('/'));
}

function prepareImportedBudgets(rawBudgets: any): {
  ok: true;
  entries: PreparedImportedNamedRecord[];
} | {
  ok: false;
  failures: ImportSectionValidationFailure[];
} {
  if (rawBudgets === undefined || rawBudgets === null) return { ok: true, entries: [] };
  if (!isPlainBackupObject(rawBudgets)) {
    return { ok: false, failures: [{ section: 'budgets', index: '*', code: 'INVALID_BUDGETS_SECTION', message: 'قسم الموازنات في النسخة الاحتياطية يجب أن يكون كائناً.' }] };
  }
  const entries: PreparedImportedNamedRecord[] = [];
  const failures: ImportSectionValidationFailure[] = [];
  for (const [rawCategory, rawLimit] of Object.entries(rawBudgets)) {
    const category = String(rawCategory || '').trim();
    const limit = typeof rawLimit === 'string' ? Number(rawLimit.trim()) : Number(rawLimit);
    if (!isSafeBackupDocId(category)) {
      failures.push({ section: 'budgets', index: rawCategory, code: 'INVALID_BUDGET_CATEGORY', message: 'اسم بند الموازنة غير صالح للاستعادة.' });
      continue;
    }
    if (!Number.isFinite(limit) || limit <= 0) {
      failures.push({ section: 'budgets', index: rawCategory, code: 'INVALID_BUDGET_LIMIT', message: 'حد الموازنة المستورد يجب أن يكون رقماً موجباً.' });
      continue;
    }
    entries.push({ sourceId: category, docData: { category, limit, updatedAt: new Date().toISOString() } });
  }
  if (failures.length > 0) return { ok: false, failures };
  return { ok: true, entries };
}

function prepareImportedCommitments(rawCommitments: unknown, userId: string): {
  ok: true;
  entries: PreparedImportedNamedRecord[];
} | {
  ok: false;
  failures: ImportSectionValidationFailure[];
} {
  if (rawCommitments === undefined || rawCommitments === null) return { ok: true, entries: [] };
  if (!Array.isArray(rawCommitments)) {
    return { ok: false, failures: [{ section: 'commitments', index: '*', code: 'INVALID_COMMITMENTS_SECTION', message: 'قسم الالتزامات في النسخة الاحتياطية يجب أن يكون مصفوفة.' }] };
  }
  const entries: PreparedImportedNamedRecord[] = [];
  const failures: ImportSectionValidationFailure[] = [];
  const seenIds = new Set<string>();
  for (const [index, rawCommitment] of rawCommitments.entries()) {
    if (!rawCommitment || typeof rawCommitment !== 'object' || Array.isArray(rawCommitment)) {
      failures.push({ section: 'commitments', index, code: 'INVALID_COMMITMENT_OBJECT', message: 'سجل الالتزام ليس كائناً صالحاً.' });
      continue;
    }
    const c = rawCommitment as Record<string, unknown>;
    const sourceId = String(c.id || '').trim();
    if (sourceId) {
      if (!isSafeBackupDocId(sourceId)) {
        failures.push({ section: 'commitments', index, code: 'INVALID_COMMITMENT_ID', message: 'معرف الالتزام غير صالح للاستعادة.' });
        continue;
      }
      if (seenIds.has(sourceId)) {
        failures.push({ section: 'commitments', index, code: 'DUPLICATE_COMMITMENT_ID', message: `معرف الالتزام مكرر داخل النسخة الاحتياطية: ${sourceId}` });
        continue;
      }
      seenIds.add(sourceId);
    }
    const title = String(c.title || '').trim();
    const amount = typeof c.amount === 'string' ? Number(c.amount.trim()) : Number(c.amount);
    if (!title) {
      failures.push({ section: 'commitments', index, code: 'MISSING_COMMITMENT_TITLE', message: 'كل التزام مستورد يجب أن يحتوي عنواناً.' });
      continue;
    }
    if (!Number.isFinite(amount) || amount <= 0) {
      failures.push({ section: 'commitments', index, code: 'INVALID_COMMITMENT_AMOUNT', message: 'كل التزام مستورد يجب أن يحتوي مبلغاً موجباً صالحاً.' });
      continue;
    }
    entries.push({
      sourceId,
      docData: {
        ...c,
        userId,
        title,
        amount: Math.abs(amount),
        dueDate: c.dueDate || new Date().toISOString(),
        category: c.category || 'أقساط والتزامات',
        notes: c.notes || '',
        createdAt: c.createdAt || new Date().toISOString(),
      }
    });
  }
  if (failures.length > 0) return { ok: false, failures };
  return { ok: true, entries };
}

function prepareImportedReports(rawReports: unknown, userId: string): {
  ok: true;
  entries: PreparedImportedNamedRecord[];
} | {
  ok: false;
  failures: ImportSectionValidationFailure[];
} {
  if (rawReports === undefined || rawReports === null) return { ok: true, entries: [] };
  if (!Array.isArray(rawReports)) {
    return { ok: false, failures: [{ section: 'reports', index: '*', code: 'INVALID_REPORTS_SECTION', message: 'قسم التقارير في النسخة الاحتياطية يجب أن يكون مصفوفة.' }] };
  }
  const entries: PreparedImportedNamedRecord[] = [];
  const failures: ImportSectionValidationFailure[] = [];
  const seenIds = new Set<string>();
  for (const [index, rawReport] of rawReports.entries()) {
    if (!rawReport || typeof rawReport !== 'object' || Array.isArray(rawReport)) {
      failures.push({ section: 'reports', index, code: 'INVALID_REPORT_OBJECT', message: 'سجل التقرير ليس كائناً صالحاً.' });
      continue;
    }
    const r = rawReport as Record<string, unknown>;
    const sourceId = String(r.id || '').trim();
    if (sourceId) {
      if (!isSafeBackupDocId(sourceId)) {
        failures.push({ section: 'reports', index, code: 'INVALID_REPORT_ID', message: 'معرف التقرير غير صالح للاستعادة.' });
        continue;
      }
      if (seenIds.has(sourceId)) {
        failures.push({ section: 'reports', index, code: 'DUPLICATE_REPORT_ID', message: `معرف التقرير مكرر داخل النسخة الاحتياطية: ${sourceId}` });
        continue;
      }
      seenIds.add(sourceId);
    }
    const title = String(r.title || '').trim();
    if (!title) {
      failures.push({ section: 'reports', index, code: 'MISSING_REPORT_TITLE', message: 'كل تقرير مستورد يجب أن يحتوي عنواناً.' });
      continue;
    }
    entries.push({
      sourceId,
      docData: {
        ...r,
        userId,
        title,
        category: r.category || 'all',
        date: r.date || r.generatedAt || new Date().toISOString(),
        createdAt: r.createdAt || new Date().toISOString(),
        transactions: Array.isArray(r.transactions) ? r.transactions : [],
      }
    });
  }
  if (failures.length > 0) return { ok: false, failures };
  return { ok: true, entries };
}

function prepareImportedMemory(rawMemory: any): {
  ok: true;
  entries: PreparedImportedNamedRecord[];
} | {
  ok: false;
  failures: ImportSectionValidationFailure[];
} {
  if (rawMemory === undefined || rawMemory === null) return { ok: true, entries: [] };
  if (!isPlainBackupObject(rawMemory)) {
    return { ok: false, failures: [{ section: 'memory', index: '*', code: 'INVALID_MEMORY_SECTION', message: 'قسم الذاكرة في النسخة الاحتياطية يجب أن يكون كائناً.' }] };
  }
  const entries: PreparedImportedNamedRecord[] = [];
  const failures: ImportSectionValidationFailure[] = [];
  for (const [rawKey, rawValue] of Object.entries(rawMemory)) {
    const key = String(rawKey || '').trim();
    if (!isSafeBackupDocId(key)) {
      failures.push({ section: 'memory', index: rawKey, code: 'INVALID_MEMORY_KEY', message: 'مفتاح الذاكرة غير صالح للاستعادة.' });
      continue;
    }
    if (typeof rawValue !== 'string' || !rawValue.trim()) {
      failures.push({ section: 'memory', index: rawKey, code: 'INVALID_MEMORY_VALUE', message: 'قيمة الذاكرة المستوردة يجب أن تكون نصاً غير فارغ.' });
      continue;
    }
    entries.push({ sourceId: key, docData: { value: rawValue, updatedAt: new Date().toISOString() } });
  }
  if (failures.length > 0) return { ok: false, failures };
  return { ok: true, entries };
}

export async function importUserData(payload: any, userId: string, token: string, mode: 'merge' | 'replace' = 'merge') {
  console.log(`TOOL CALL: importUserData for ${userId} with mode=${mode}`);

  const envelope = validateImportEnvelope(payload);
  if (!envelope.ok) return { success: false, ...envelope };

  const adminDb = getDb(token);

  // Handle case where user directly imports an array of transactions or full backup object
  const transactionsToImport: any[] = envelope.isTransactionArrayImport
    ? payload
    : Array.isArray(envelope.backupObject.transactions)
      ? envelope.backupObject.transactions
      : [];

  const rawBudgetsToImport = envelope.isTransactionArrayImport ? undefined : envelope.backupObject.budgets;
  const rawCommitmentsToImport = envelope.isTransactionArrayImport ? undefined : envelope.backupObject.commitments;
  const rawReportsToImport = envelope.isTransactionArrayImport ? undefined : envelope.backupObject.reports;
  const rawMemoryToImport = envelope.isTransactionArrayImport ? undefined : envelope.backupObject.memory;

  // Preflight the entire backup BEFORE any import mutation. Restore/import is a
  // historical-state operation, so we validate and normalize without replaying
  // notifications or other financial side effects during preparation.
  const preparedTransactions = prepareImportedFinancialTransactions(transactionsToImport, userId);
  const preparedBudgets = prepareImportedBudgets(rawBudgetsToImport);
  const preparedCommitments = prepareImportedCommitments(rawCommitmentsToImport, userId);
  const preparedReports = prepareImportedReports(rawReportsToImport, userId);
  const preparedMemory = prepareImportedMemory(rawMemoryToImport);
  const validationFailures = [
    ...('failures' in preparedTransactions ? preparedTransactions.failures : []),
    ...('failures' in preparedBudgets ? preparedBudgets.failures : []),
    ...('failures' in preparedCommitments ? preparedCommitments.failures : []),
    ...('failures' in preparedReports ? preparedReports.failures : []),
    ...('failures' in preparedMemory ? preparedMemory.failures : []),
  ];
  if (validationFailures.length > 0) {
    return {
      success: false,
      reason: 'IMPORT_BACKUP_VALIDATION_FAILED',
      message: 'لم يتم استيراد النسخة لأن بعض سجلات النسخة الاحتياطية غير صالحة. لم يتم حذف أو تغيير البيانات الحالية.',
      validationFailures,
    };
  }

  const transactionEntries = (preparedTransactions as { ok: true; entries: Array<{ sourceId: string; docData: any }> }).entries;
  const budgetEntries = (preparedBudgets as { ok: true; entries: PreparedImportedNamedRecord[] }).entries;
  const commitmentEntries = (preparedCommitments as { ok: true; entries: PreparedImportedNamedRecord[] }).entries;
  const reportEntries = (preparedReports as { ok: true; entries: PreparedImportedNamedRecord[] }).entries;
  const memoryEntries = (preparedMemory as { ok: true; entries: PreparedImportedNamedRecord[] }).entries;

  // Replace mode is all-or-nothing. Build the full mutation plan before changing
  // user state, then commit it in one real Firestore batch.
  if (mode === 'replace') {
    const [oldTx, oldComm, oldRep, oldBudgets, oldMemory] = await Promise.all([
      firebaseAdminDb.collection('transactions').where('userId', '==', userId).get(),
      firebaseAdminDb.collection('commitments').where('userId', '==', userId).get(),
      firebaseAdminDb.collection('reports').where('userId', '==', userId).get(),
      firebaseAdminDb.collection('users').doc(userId).collection('budgets').get(),
      firebaseAdminDb.collection('users').doc(userId).collection('memory').get(),
    ]);

    const deleteCount = oldTx.size + oldComm.size + oldRep.size + oldBudgets.size + oldMemory.size;
    const writeCount = transactionEntries.length + budgetEntries.length + commitmentEntries.length + reportEntries.length + memoryEntries.length;
    const mutationCount = deleteCount + writeCount;

    // Firestore WriteBatch commits are atomic but capped. Keep explicit headroom
    // and fail before mutation rather than chunking a replace into partially committed pieces.
    if (mutationCount > IMPORT_REPLACE_ATOMIC_MUTATION_LIMIT) {
      return {
        success: false,
        retryable: false,
        reason: 'IMPORT_REPLACE_TOO_LARGE_FOR_ATOMIC_COMMIT',
        message: 'النسخة الاحتياطية كبيرة جداً للاستعادة الذرية الآمنة. لم يتم تغيير أي بيانات حالية.',
        mutationCount,
      };
    }

    const batch = firebaseAdminDb.batch();
    oldTx.docs.forEach((d: any) => batch.delete(d.ref));
    oldComm.docs.forEach((d: any) => batch.delete(d.ref));
    oldRep.docs.forEach((d: any) => batch.delete(d.ref));
    oldBudgets.docs.forEach((d: any) => batch.delete(d.ref));
    oldMemory.docs.forEach((d: any) => batch.delete(d.ref));

    for (const prepared of transactionEntries) {
      const ref = prepared.sourceId
        ? firebaseAdminDb.collection('transactions').doc(prepared.sourceId)
        : firebaseAdminDb.collection('transactions').doc();
      batch.set(ref, { ...prepared.docData, sourceId: prepared.sourceId || undefined }, { merge: true });
    }
    for (const prepared of budgetEntries) {
      batch.set(
        firebaseAdminDb.collection('users').doc(userId).collection('budgets').doc(prepared.sourceId),
        prepared.docData,
        { merge: true }
      );
    }
    for (const prepared of commitmentEntries) {
      const ref = prepared.sourceId ? firebaseAdminDb.collection('commitments').doc(prepared.sourceId) : firebaseAdminDb.collection('commitments').doc();
      batch.set(ref, { ...prepared.docData, id: ref.id }, { merge: true });
    }
    for (const prepared of reportEntries) {
      const ref = prepared.sourceId ? firebaseAdminDb.collection('reports').doc(prepared.sourceId) : firebaseAdminDb.collection('reports').doc();
      batch.set(ref, { ...prepared.docData, id: ref.id }, { merge: true });
    }
    for (const prepared of memoryEntries) {
      batch.set(
        firebaseAdminDb.collection('users').doc(userId).collection('memory').doc(prepared.sourceId),
        prepared.docData,
        { merge: true }
      );
    }

    try {
      await batch.commit();
    } catch (e: any) {
      return {
        success: false,
        retryable: true,
        reason: 'IMPORT_REPLACE_ATOMIC_COMMIT_FAILED',
        message: 'فشلت الاستعادة الذرية ولم يتم تطبيق استعادة جزئية.',
        error: e?.message || 'Firestore atomic restore failed',
      };
    }

    clearAllLocalUserData(userId);
    return {
      success: true,
      mode,
      atomic: true,
      importedTransactions: transactionEntries.length,
      importedBudgets: budgetEntries.length,
      importedCommitments: commitmentEntries.length,
      importedReports: reportEntries.length,
      importedMemory: memoryEntries.length,
    };
  }

  // Merge mode: write only records that passed the full preflight validator.
  let importedTxCount = 0;
  for (const prepared of transactionEntries) {
    const docRef = prepared.sourceId ? adminDb.collection('transactions').doc(prepared.sourceId) : adminDb.collection('transactions').doc();
    const writeResult = await docRef.set({ ...prepared.docData, sourceId: prepared.sourceId || undefined });
    if (writeResult?.pending || writeResult?.synced === false) {
      return {
        success: false,
        retryable: true,
        reason: 'IMPORT_NOT_DURABLY_COMMITTED',
        message: 'توقف الاستيراد لأن إحدى العمليات لم تُحفظ في السحابة بشكل مؤكد.',
        importedBeforeFailure: importedTxCount,
        error: writeResult?.error,
      };
    }
    importedTxCount++;
  }

  // 2. Write custom budgets
  let importedBudgetsCount = 0;
  for (const prepared of budgetEntries) {
    await adminDb.collection('users').doc(userId).collection('budgets').doc(prepared.sourceId).set(prepared.docData);
    importedBudgetsCount++;
  }

  // 3. Write commitments
  let importedCommitmentsCount = 0;
  for (const prepared of commitmentEntries) {
    const docRef = prepared.sourceId ? adminDb.collection('commitments').doc(prepared.sourceId) : adminDb.collection('commitments').doc();
    await docRef.set({ ...prepared.docData, id: docRef.id });
    importedCommitmentsCount++;
  }

  // 4. Write reports
  let importedReportsCount = 0;
  for (const prepared of reportEntries) {
    const docRef = prepared.sourceId ? adminDb.collection('reports').doc(prepared.sourceId) : adminDb.collection('reports').doc();
    await docRef.set({ ...prepared.docData, id: docRef.id });
    importedReportsCount++;
  }

  // 5. Write memory
  let importedMemoryCount = 0;
  for (const prepared of memoryEntries) {
    await adminDb.collection('users').doc(userId).collection('memory').doc(prepared.sourceId).set(prepared.docData);
    importedMemoryCount++;
  }

  await addNotification(userId, `تم استيراد ${importedTxCount} عملية مالية و ${importedBudgetsCount} موازنة بنجاح.`, 'success', adminDb);

  return {
    success: true,
    mode,
    counts: {
      transactions: importedTxCount,
      budgets: importedBudgetsCount,
      commitments: importedCommitmentsCount,
      reports: importedReportsCount,
      memory: importedMemoryCount
    },
    message: `تم بنجاح استيراد ${importedTxCount} عملية مالية، ${importedBudgetsCount} موازنة، و ${importedCommitmentsCount} التزام.`
  };
}

/**
 * V6 (HF-1): REMOVED searchMarketInformation — the hardcoded fake-price tool.
 * AI must use only `search_local_market` which uses real Google Search grounding.
 * If a real search fails, the response says so explicitly; no fabricated prices.
 */
export async function searchMarketInformation(args: any, userId: string, token: string) {
  // Kept as a stub that always refuses, to prevent any prompt that still references
  // this tool from accidentally executing it. The function declaration is removed below.
  return {
    success: false,
    deprecated: true,
    message: 'تم إيقاف هذه الأداة المزيّفة. استخدم search_local_market للحصول على أسعار حقيقية موثقة.',
    useInstead: 'search_local_market',
  };
}

export async function getBalance(args:any,userId:string,token:string){
  // Financial reads use Firestore as the single source of truth. FakeDb remains
  // available elsewhere for offline display/cache behavior, but it must not be
  // used to certify a financial balance or a just-committed transaction.
  try {
    const snap = await firebaseAdminDb.collection('transactions').where('userId','==',userId).get();
    const balances = calculateBalancesFromDocs(snap.docs);
    return {
      balances,
      total: balances.cash + balances.palPay,
      partial: false,
      cloudStorageConfirmed: true,
      source: 'firestore',
    };
  } catch (e: any) {
    // Offline/read-failure fallback is display-only: return the last local view
    // if available, explicitly marked partial. Never manufacture zero balances.
    const localDb = getDb(token);
    const cachedSnap = await localDb.collection('transactions').where('userId','==',userId).get();
    const cachedBalances = calculateBalancesFromDocs(cachedSnap.docs);
    return {
      balances: cachedBalances,
      total: cachedBalances.cash + cachedBalances.palPay,
      partial: true,
      cloudStorageConfirmed: false,
      source: 'offline-cache',
      error: e?.message || 'Firestore balance read failed',
    };
  }
}

export async function transferMoney(args: any, userId: string, token: string) {
  const adminDb = getDb(token);
  console.log("TOOL CALL: transferMoney", args);
  
  const amount = parseAbsoluteFinancialAmount(args.amount);
  if (amount <= 0) {
    return { error: "Amount must be greater than 0" };
  }

  const fromAccount = normalizeAccount(args.fromAccount || 'cash');
  if (fromAccount === 'debt' && !args.toAccount) {
    return { success: false, needsClarification: true, reason: 'MISSING_BORROW_DESTINATION', message: 'استلمت المبلغ نقدي (كاش) أم في محفظة PalPay؟' };
  }
  let toAccount = normalizeAccount(args.toAccount || (fromAccount === 'cash' ? 'palPay' : 'cash'));
  
  if (fromAccount === toAccount) {
    toAccount = fromAccount === 'cash' ? 'palPay' : 'cash';
  }

  const fromName = fromAccount === 'palPay' ? 'PalPay' : fromAccount === 'debt' ? 'الديون' : 'النقدي';
  const toName = toAccount === 'palPay' ? 'PalPay' : toAccount === 'debt' ? 'الديون' : 'النقدي';
  const creditor = String(args.creditor || args.person || args.merchant || '').trim();

  // Borrowing money (debt -> cash/PalPay) must identify the creditor; otherwise later repayment cannot be resolved safely.
  if (fromAccount === 'debt' && !creditor) {
    return { success: false, needsClarification: true, reason: 'MISSING_CREDITOR', message: 'ممن استدنت هذا المبلغ؟' };
  }

  // Internal wallet transfers cannot create money by driving the source wallet below zero.
  if (fromAccount !== 'debt' && toAccount !== 'debt') {
    const current = await getBalance({}, userId, token);
    // V6.2 (FINDING-07): refuse balance-sensitive transfer on partial state.
    if (current.partial === true) {
      return {
        success: false,
        retryable: true,
        reason: 'PARTIAL_STATE_UNSAFE',
        message: 'تعذّر التحقق من رصيدك الحالي بدقة. لا يمكن تنفيذ التحويل الآن. حاول مرة أخرى عند استعادة الاتصال.',
        operationId: String(args.operationId || `transfer_${Date.now()}_${Math.random().toString(36).slice(2,10)}`),
      };
    }
    const available = Number(current?.balances?.[fromAccount] || 0);
    if (amount > available + 0.0001) {
      return { success: false, needsClarification: true, reason: 'INSUFFICIENT_FUNDS', message: `الرصيد المتاح في ${fromName} هو ${available} ₪ فقط. هل تريد مبلغاً آخر؟` };
    }
  }

  // Create ONE single transaction of type 'transfer'
  const txRef = adminDb.collection('transactions').doc();
  const tx = {
    userId,
    amount,
    type: 'transfer',
    account: fromAccount,
    fromAccount,
    toAccount,
    category: 'تحويل داخلي',
    subcategory: `تحويل من ${fromName} إلى ${toName}`,
    notes: args.notes || `تحويل مبلغ ${amount} ₪ من ${fromName} إلى ${toName}`,
    merchant: fromAccount === 'debt' ? creditor : 'تحويل بين المحافظ',
    creditor: fromAccount === 'debt' ? creditor : '',
    creditorKey: fromAccount === 'debt' ? normalizeCreditorName(creditor) : '',
    transactionType: fromAccount === 'debt' ? 'DEBT_BORROWING' : 'INTERNAL_TRANSFER',
    operationId: String(args.operationId || `transfer_${Date.now()}_${Math.random().toString(36).slice(2,10)}`),
    necessity: '',
    date: new Date().toISOString(),
    createdAt: new Date().toISOString()
  };

  // V6.2 (FINDING-02): atomic balance-sensitive transfer.
  // No more TOCTOU: the balance check + write happen inside a single
  // Firestore runTransaction. Atomic failure NEVER downgrades to direct write.
  let actualTxId = txRef.id;
  let writeResult: WriteResult | { durability: 'committed'; synced: true; pending: false };
  try {
    const atomicResult = await atomicTransferMoney(userId, tx, { riskConfirmed: Boolean(args.riskConfirmed) });
    if (!atomicResult.ok) {
      const failReason = (atomicResult as any).reason as string;
      const failAvailable = (atomicResult as any).available as number | undefined;
      if (failReason === 'INSUFFICIENT_FUNDS_ATOMIC') {
        return {
          success: false,
          needsClarification: true,
          reason: 'INSUFFICIENT_FUNDS',
          message: `الرصيد المتاح في ${fromName} هو ${failAvailable} ₪ فقط. التحويل مرفوض لمنع تجاوز الرصيد.`,
        };
      }
      return { success: false, error: failReason };
    }
    actualTxId = atomicResult.docId;
    writeResult = { durability: 'committed', synced: true, pending: false };
  } catch (atomicErr: any) {
    // V6.2 (FINDING-04): NO direct write fallback. Surface as FAILED.
    console.error('[transferMoney] atomic transaction FAILED — refusing direct write fallback:', atomicErr?.message);
    const isRetryable = atomicErr?.code === 8 || /RESOURCE_EXHAUSTED|quota|contention|aborted/i.test(String(atomicErr?.message || ''));
    return {
      success: false,
      retryable: isRetryable,
      reason: isRetryable ? 'ATOMIC_FAILED_RETRYABLE' : 'ATOMIC_FAILED',
      message: isRetryable
        ? 'تعذّر تنفيذ التحويل الآن بسبب ضغط مؤقت على قاعدة البيانات. حاول مرة أخرى خلال لحظات.'
        : `تعذّر تنفيذ التحويل بشكل آمن: ${atomicErr?.message || 'unknown error'}`,
      operationId: tx.operationId,
    };
  }

  await addNotification(userId, `تم تحويل ${amount} ₪ من ${fromName} إلى ${toName} بنجاح.`, 'success', adminDb, {
    idempotencyKey: `transfer-success:${tx.operationId}`,
    transactionId: actualTxId,
    operationId: tx.operationId,
    metadata: { amount, fromAccount, toAccount }
  });

  const balances = await getBalance({}, userId, token);
  return {
    success: true,
    transactionId: actualTxId,
    operationId: tx.operationId,
    message: `تم تحويل ${amount} ₪ من ${fromName} إلى ${toName} بنجاح. التحويل لا يؤثر على الدخل أو المصروف العام.`,
    currentBalances: balances.balances,
    durability: writeResult.durability,
    pending: writeResult.pending,
    partial: balances.partial || writeResult.pending,
  };
}

function normalizeCreditorName(value: any): string {
  return normalizeCreditorKey(value);
}

// Compatibility export for existing callers/tests. The financial rule itself now
// lives in the shared domain core; this adapter only unwraps Firestore snapshots.
export function calculateBalancesFromDocs(docs: any[]) {
  const transactions = (docs || []).map((doc: any) => typeof doc?.data === 'function' ? doc.data() : doc);
  return calculateBalances(transactions);
}

function calculateOpenCreditorDebts(docs: any[]) {
  const transactions = (docs || []).map((doc: any) => typeof doc?.data === 'function' ? doc.data() : doc);
  const creditorDebts = calculateBreakdown(transactions).creditorDebts;
  const ignoredKeys = new Set([normalizeCreditorName('سداد دين'), normalizeCreditorName('تحويل بين المحافظ')]);
  const creditorNames = new Map<string, string>();
  for (const tx of transactions) {
    const creditor = String(tx?.creditor || tx?.merchant || '').trim();
    const key = normalizeCreditorName(creditor);
    if (!key || ignoredKeys.has(key) || creditorNames.has(key)) continue;
    creditorNames.set(key, creditor);
  }
  return Object.entries(creditorDebts)
    .filter(([key, remaining]) => !ignoredKeys.has(key) && Number(remaining) > 0.0001)
    .map(([key, remaining]) => ({
      key,
      creditor: creditorNames.get(key) || key,
      remaining: Math.round(Number(remaining) * 100) / 100,
    }));
}

export async function payDebt(args:any,userId:string,token:string){
 const adminDb=getDb(token), amount=parsePositiveFinancialAmount(args.amount); if(amount<=0)return{success:false,error:'المبلغ يجب أن يكون أكبر من صفر'}; let fromAccount=normalizeAccount(args.paymentMethod||args.fromAccount||'cash');if(fromAccount==='debt')fromAccount='cash';const fromName=fromAccount==='palPay'?'محفظة PalPay':'النقدي (كاش)';
 const snap=await adminDb.collection('transactions').where('userId','==',userId).get();
 // V6.2 (FINDING-07): refuse debt payment on partial state — could produce wrong creditor/debt math.
 if ((snap as any).partial === true) {
   return { success:false, retryable:true, reason:'PARTIAL_STATE_UNSAFE', message:'تعذّر التحقق من ديونك الحالية بدقة. لا يمكن تنفيذ السداد الآن.' };
 }
 const debts=calculateOpenCreditorDebts(snap.docs);
 const selection=selectOpenCreditorDebt({ debts, requestedCreditor: args.creditor||args.person||args.merchant, amount });
 if(selection.ok === false)return{success:false,needsClarification:true,reason:selection.reason,options:selection.options,message:selection.message};
 const selected=selection.selected;
 if(amount>selected.remaining+0.0001)return{success:false,needsClarification:true,reason:'OVERPAYMENT',creditor:selected.creditor,remaining:selected.remaining,message:`المتبقي لـ ${selected.creditor} هو ${selected.remaining} ₪ فقط.`};
 const beforeBalances=calculateBalancesFromDocs(snap.docs); const available=Number(beforeBalances[fromAccount]||0); if(amount>available+0.0001)return{success:false,needsClarification:true,reason:'INSUFFICIENT_FUNDS',available,message:`الرصيد المتاح في ${fromName} هو ${available} ₪ فقط. لا يمكن تنفيذ سداد ${amount} ₪.`};
 const operationId=String(args.operationId||`debtpay_${Date.now()}_${Math.random().toString(36).slice(2,10)}`), txRef=adminDb.collection('transactions').doc(); const tx={userId,operationId,amount,type:'transfer',account:fromAccount,fromAccount,toAccount:'debt',transactionType:'DEBT_PAYMENT',creditor:selected.creditor,creditorKey:selected.key,category:'سداد ديون والتزامات',subcategory:`سداد دين - ${selected.creditor}`,notes:args.notes||`سداد دين بقيمة ${amount} ₪ من ${fromName} لصالح ${selected.creditor}`,merchant:selected.creditor,necessity:'ضروري',date:new Date().toISOString(),createdAt:new Date().toISOString()};
 // V6.1 (CONC-03): atomic debt payment prevents concurrent payments from exceeding the creditor's remaining debt.
 // V6.2 (FINDING-01): ATOMIC FAILURE MUST NEVER DOWNGRADE TO NON-ATOMIC WRITE.
 // If atomicPayDebt fails (contention/network/quota/transaction failure), we MUST NOT
 // fall back to direct txRef.set(). The operation becomes FAILED, and the client can
 // retry or queue it offline. A direct write would bypass the financial validation
 // engine and could create a debt that exceeds the creditor's remaining balance.
 let atomicResult: { ok: true; docId: string } | { ok: false; reason: string; remaining?: number; available?: number };
 try {
   atomicResult = await atomicPayDebt(userId, tx, selected.key, { riskConfirmed: Boolean(args.riskConfirmed) });
 } catch (atomicErr: any) {
   // V6.2: NO direct write fallback. Surface as FAILED with retryable status.
   console.error('[payDebt] atomic transaction FAILED — refusing direct write fallback:', atomicErr?.message);
   const isRetryable = atomicErr?.code === 8 || /RESOURCE_EXHAUSTED|quota|contention|aborted/i.test(String(atomicErr?.message || ''));
   return {
     success: false,
     needsClarification: !isRetryable,
     retryable: isRetryable,
     reason: isRetryable ? 'ATOMIC_FAILED_RETRYABLE' : 'ATOMIC_FAILED',
     message: isRetryable
       ? 'تعذّر تنفيذ سداد الدين الآن بسبب ضغط مؤقت على قاعدة البيانات. حاول مرة أخرى خلال لحظات.'
       : `تعذّر تنفيذ سداد الدين بشكل آمن: ${atomicErr?.message || 'unknown error'}`,
     operationId,
   };
 }
 if (!atomicResult.ok) {
   const failReason = (atomicResult as any).reason as string;
   const failRemaining = (atomicResult as any).remaining as number | undefined;
   const failAvailable = (atomicResult as any).available as number | undefined;
   if (failReason === 'OVERPAYMENT_ATOMIC') {
     return { success: false, needsClarification: true, reason: 'OVERPAYMENT', creditor: selected.creditor, remaining: failRemaining, message: `المتبقي لـ ${selected.creditor} هو ${failRemaining} ₪ فقط (تم رصد محاولة سداد متزامنة).` };
   }
   if (failReason === 'INSUFFICIENT_FUNDS_ATOMIC') {
     return { success: false, needsClarification: true, reason: 'INSUFFICIENT_FUNDS', available: failAvailable, message: `الرصيد المتاح في ${fromName} هو ${failAvailable} ₪ فقط.` };
   }
   return { success: false, error: failReason };
 }
 const finalTxId = atomicResult.docId;
 await addNotification(userId,`تم سداد ${amount} ₪ من دين ${selected.creditor} من ${fromName}.`, 'success', adminDb); const balances=calculateBalancesFromDocs([...snap.docs,tx]); return{success:true,transactionId:finalTxId,operationId,creditor:selected.creditor,remainingDebtForCreditor:Math.max(0,Math.round((selected.remaining-amount)*100)/100),message:`تم سداد ${amount} ₪ من دين ${selected.creditor} بنجاح من ${fromName}.`,currentBalances:balances};
}

export async function getRecentTransactions(args: any, userId: string, token: string) {
  const adminDb = getDb(token);
  const snapshot = await adminDb.collection('transactions').where('userId', '==', userId).orderBy('createdAt', 'desc').limit(10).get();
  return { transactions: snapshot.docs.map(d => ({ id: d.id, ...d.data() })) };
}

function auditLedgerFingerprint(t: any): string {
  const amount = Math.round(parsePositiveFinancialAmount(t.amount) * 100) / 100;
  const purpose = normalizeArabicText(`${t.purchaseItem || ''} ${t.beneficiary || ''} ${t.notes || ''} ${t.category || ''} ${t.subcategory || ''}`)
    .replace(/\d+(\.\d+)?/g, ' ')
    .replace(/\s+/g, ' ')
    .trim() || 'unspecified';
  return [t.type || '', t.account || '', amount, normalizeArabicText(t.merchant || t.creditor || ''), purpose].join('|');
}

export async function auditFinancialDuplicates(args: any, userId: string, token: string) {
  const adminDb = getDb(token);
  const txSnap = await adminDb.collection('transactions').where('userId', '==', userId).get();
  const transactions = txSnap.docs.map((d: any) => ({ id: d.id, ...d.data() }));
  const notifSnap = await adminDb.collection('users').doc(userId).collection('notifications').get();
  const notifications = notifSnap.docs.map((d: any) => ({ id: d.id, ...d.data() }));

  const group = (items: any[], keyFn: (x: any) => string) => {
    const m = new Map<string, any[]>();
    for (const item of items) {
      const key = keyFn(item);
      if (!key) continue;
      const arr = m.get(key) || [];
      arr.push(item);
      m.set(key, arr);
    }
    return Array.from(m.entries()).filter(([, arr]) => arr.length > 1).map(([key, arr]) => ({ key, count: arr.length, items: arr }));
  };

  const duplicateOperationIds = group(transactions.filter((t: any) => t.operationId), (t: any) => String(t.operationId));
  const duplicateLedgerFingerprints = group(transactions, auditLedgerFingerprint);
  const orphanSuccessNotifications = notifications.filter((n: any) => n.type === 'success' && /تم تسجيل|تم تحويل|تم سداد/.test(String(n.message || '')) && !n.transactionId);
  const notificationsByTransaction = group(notifications.filter((n: any) => n.transactionId), (n: any) => String(n.transactionId));

  return {
    success: true,
    counts: { transactions: transactions.length, notifications: notifications.length },
    duplicateOperationIds: duplicateOperationIds.map(g => ({ key: g.key, count: g.count, transactionIds: g.items.map((t: any) => t.id), amounts: g.items.map((t: any) => t.amount) })),
    duplicateLedgerFingerprints: duplicateLedgerFingerprints.map(g => ({ key: g.key, count: g.count, transactionIds: g.items.map((t: any) => t.id), sample: g.items.map((t: any) => ({ id: t.id, amount: t.amount, account: t.account, merchant: t.merchant, purchaseItem: t.purchaseItem, beneficiary: t.beneficiary, category: t.category, subcategory: t.subcategory, createdAt: t.createdAt })) })),
    successNotificationsWithoutTransactionId: orphanSuccessNotifications.map((n: any) => ({ id: n.id, message: n.message, createdAt: n.createdAt })),
    multipleNotificationsForSameTransaction: notificationsByTransaction.map(g => ({ transactionId: g.key, count: g.count, notificationIds: g.items.map((n: any) => n.id), messages: g.items.map((n: any) => n.message) })),
    partial: (txSnap as any).partial || (notifSnap as any).partial
  };
}

export async function updateTransaction(args: any, userId: string, token: string) {
  const adminDb = getDb(token);
  console.log("TOOL CALL: updateTransaction", args);
  const txRef = adminDb.collection('transactions').doc(args.id);
  const doc = await txRef.get();
  if (!doc.exists || doc.data()?.userId !== userId) return { error: "Transaction not found" };
  const existing = doc.data() as any;

  // V6 (CF-4): re-validate financial invariants on update.
  // Build the projected post-update document and run addTransaction-style guards.

  const updates: any = {};
  if (args.amount !== undefined) {
    updates.amount = parsePositiveFinancialAmount(args.amount);
    if (updates.amount <= 0) {
      return { success: false, needsClarification: true, reason: 'INVALID_AMOUNT', message: 'المبلغ الجديد غير صالح (يجب أن يكون رقماً محدداً موجباً).' };
    }
  }
  if (args.type) updates.type = String(args.type).toLowerCase();
  if (args.account) updates.account = normalizeAccount(args.account);
  if (args.fromAccount) updates.fromAccount = normalizeAccount(args.fromAccount);
  if (args.toAccount) updates.toAccount = normalizeAccount(args.toAccount);
  if (args.category !== undefined) updates.category = String(args.category);
  if (args.subcategory !== undefined) updates.subcategory = String(args.subcategory);
  if (args.merchant !== undefined) updates.merchant = String(args.merchant);
  if (args.notes !== undefined) updates.notes = String(args.notes);
  if (args.necessity !== undefined) updates.necessity = String(args.necessity);
  if (args.date !== undefined) updates.date = String(args.date);
  updates.updatedAt = new Date().toISOString();

  // 3. Compute projected state.
  const projected: any = { ...existing, ...updates };
  // If account changed, recompute derived fields (creditor/creditorKey/transactionType).
  if (updates.account !== undefined || updates.type !== undefined) {
    const t = (projected.type || 'expense').toLowerCase();
    const a = normalizeAccount(projected.account);
    projected.account = a;
    projected.transactionType = (t === 'expense' && a === 'debt')
      ? 'CREDIT_PURCHASE'
      : (t === 'income' ? 'INCOME' : (t === 'transfer' ? (projected.transactionType || 'INTERNAL_TRANSFER') : 'EXPENSE'));
    // If transitioning to a debt-expense, ensure creditor is set.
    if (t === 'expense' && a === 'debt') {
      const cred = String(projected.merchant || projected.creditor || '').trim();
      if (!cred) {
        return { success: false, needsClarification: true, reason: 'MISSING_CREDITOR', message: 'عند تحويل العملية إلى دين، يجب تحديد الدائن.' };
      }
      projected.creditor = cred;
      projected.creditorKey = normalizeCreditorName(cred);
    } else if (updates.account !== undefined) {
      // Moving away from debt — clear creditor fields.
      projected.creditor = '';
      projected.creditorKey = '';
    }
  }

  // 4. Re-derive subcategory/necessity consistency for expenses.
  if ((projected.type || 'expense') === 'expense') {
    if (updates.category !== undefined && !projected.category) {
      return { success: false, needsClarification: true, reason: 'MISSING_CATEGORY', message: 'ما بند العملية الرئيسي؟' };
    }
  }

  // 5. Snapshot all transactions (excluding the doc being updated) to compute resulting balance.
  const snap = await adminDb.collection('transactions').where('userId', '==', userId).get();
  if ((snap as any).partial === true) {
    return {
      success: false,
      retryable: true,
      reason: 'PARTIAL_STATE_UNSAFE',
      message: 'لا يمكن تعديل العملية الآن لأن قراءة السحابة جزئية، ولا أستطيع ضمان الرصيد الناتج بأمان.'
    };
  }
  const otherDocs = snap.docs.filter((d: any) => d.id !== args.id);
  // Apply projected doc to the set.
  const projectedDoc = { id: args.id, data: () => projected };
  const combinedDocs = [...otherDocs, projectedDoc as any];
  const resultingBalances = calculateBalancesFromDocs(combinedDocs);

  // 6. If the resulting cash or palPay would go negative (excluding debt), block unless riskConfirmed.
  if (!args.riskConfirmed) {
    if (resultingBalances.cash < -0.0001) {
      return { success: false, needsConfirmation: true, reason: 'NEGATIVE_CASH_RESULT', message: `هذا التعديل سيجعل رصيد الكاش سالباً (${resultingBalances.cash} ₪). هل تريد المتابعة؟`, financialImpact: { cashAfter: resultingBalances.cash } };
    }
    if (resultingBalances.palPay < -0.0001) {
      return { success: false, needsConfirmation: true, reason: 'NEGATIVE_PALPAY_RESULT', message: `هذا التعديل سيجعل رصيد PalPay سالباً (${resultingBalances.palPay} ₪). هل تريد المتابعة؟`, financialImpact: { palPayAfter: resultingBalances.palPay } };
    }
  }

  // 7. If amount/category changed for an expense, re-check budget ceiling.
  if (projected.type === 'expense' && (updates.amount !== undefined || updates.category !== undefined)) {
    try {
      const userBudgets = await getUserBudgets(userId, adminDb);
      const thisMonth = new Date().toISOString().slice(0, 7);
      const sameCategoryThisMonth = combinedDocs
        .map((d: any) => typeof d.data === 'function' ? d.data() : d)
        .filter((t: any) => t.type === 'expense' && String(t.date || '').startsWith(thisMonth) && t.category === projected.category);
      const spent = sameCategoryThisMonth.reduce((s: number, t: any) => s + parsePositiveFinancialAmount(t.amount), 0);
      const limit = Number(userBudgets?.[projected.category] || DEFAULT_BUDGETS[projected.category] || 0);
      if (limit > 0 && spent >= limit && !args.riskConfirmed) {
        return { success: false, needsConfirmation: true, reason: 'BUDGET_WILL_BE_EXCEEDED', message: `التعديل سيرفع بند [${projected.category}] إلى ${spent} ₪ مقابل سقف ${limit} ₪. هل تريد المتابعة؟` };
      }
    } catch (e) {
      // Preflight failures are non-fatal — we don't want to block updates when budget check is unavailable.
      console.error('update_transaction preflight budget check failed:', e);
    }
  }

  // 8. Apply the update with the recomputed derived fields.
  const finalUpdates: any = { ...updates };
  if (updates.account !== undefined || updates.type !== undefined) {
    finalUpdates.transactionType = projected.transactionType;
    finalUpdates.creditor = projected.creditor;
    finalUpdates.creditorKey = projected.creditorKey;
  }

  // Re-run the balance-sensitive invariant and the write in one Firestore transaction.
  // The earlier projection remains useful for clarification/budget UX, but it is not
  // trusted as the final concurrency guard.
  const atomicResult = await atomicUpdateTransaction(userId, args.id, finalUpdates, { riskConfirmed: !!args.riskConfirmed });
  if ('reason' in atomicResult) {
    if (atomicResult.reason === 'NEGATIVE_CASH_RESULT') {
      return { success: false, needsConfirmation: true, reason: atomicResult.reason, message: `هذا التعديل سيجعل رصيد الكاش سالباً (${atomicResult.balances?.cash} ₪). هل تريد المتابعة؟`, financialImpact: { cashAfter: atomicResult.balances?.cash } };
    }
    if (atomicResult.reason === 'NEGATIVE_PALPAY_RESULT') {
      return { success: false, needsConfirmation: true, reason: atomicResult.reason, message: `هذا التعديل سيجعل رصيد PalPay سالباً (${atomicResult.balances?.palPay} ₪). هل تريد المتابعة؟`, financialImpact: { palPayAfter: atomicResult.balances?.palPay } };
    }
    return { success: false, reason: atomicResult.reason, message: 'تعذر تعديل العملية بأمان لأنها تغيرت أو لم تعد موجودة.' };
  }
  return {
    success: true,
    currentBalances: atomicResult.balances,
    durability: 'cloud',
    pending: false,
    partial: false,
  };
}

export async function deleteTransaction(args: any, userId: string, token: string) {
  const adminDb = getDb(token);
  console.log("TOOL CALL: deleteTransaction", args);
  
  // 1. Direct ID deletion if a valid ID was passed
  if (args.id && typeof args.id === 'string' && args.id.length > 5) {
    const txRef = adminDb.collection('transactions').doc(args.id);
    const doc = await txRef.get();
    if (doc.exists && doc.data()?.userId === userId) {
      const atomicResult = await atomicDeleteTransaction(userId, args.id, { riskConfirmed: !!args.riskConfirmed });
      if ('reason' in atomicResult) {
        if (atomicResult.reason === 'NEGATIVE_CASH_RESULT' || atomicResult.reason === 'NEGATIVE_PALPAY_RESULT') {
          return {
            success: false,
            needsConfirmation: true,
            reason: atomicResult.reason,
            message: 'حذف هذه العملية سيجعل أحد الأرصدة سالباً. هل تريد المتابعة رغم الأثر المالي؟',
            financialImpact: atomicResult.balances,
          };
        }
        return { success: false, reason: atomicResult.reason, message: 'تعذر حذف العملية بأمان لأنها تغيرت أو لم تعد موجودة.' };
      }
      const data = atomicResult.deleted;
      const accName = data?.account === 'palPay' ? 'PalPay' : data?.account === 'debt' ? 'الديون' : 'النقدي';
      await addNotification(userId, `تم حذف عملية (${data?.notes || data?.category || ''} بقيمة ${data?.amount} ₪ من ${accName}) بنجاح.`, 'success', adminDb);
      const balances = await getBalance({}, userId, token);
      return { success: true, message: "تم حذف العملية بنجاح.", currentBalances: balances.balances };
    }
  }

  // 2. Smart deletion by criteria (account, amount, category, or most recent)
  const targetAccount = (args.account || args.fromAccount) ? normalizeAccount(args.account || args.fromAccount) : null;
  const targetAmount = args.amount ? parsePositiveFinancialAmount(args.amount) : null;

  const snapshot = await adminDb.collection('transactions').where('userId', '==', userId).get();
  let userTxs = snapshot.docs.map(d => ({ id: d.id, ...d.data() }));

  // Sort descending by date/createdAt
  userTxs.sort((a: any, b: any) => new Date(b.createdAt || b.date || 0).getTime() - new Date(a.createdAt || a.date || 0).getTime());

  if (targetAccount) {
    userTxs = userTxs.filter((t: any) => normalizeAccount(t.account) === targetAccount || normalizeAccount(t.fromAccount) === targetAccount || normalizeAccount(t.toAccount) === targetAccount);
  }

  if (targetAmount) {
    userTxs = userTxs.filter((t: any) => Math.abs(parsePositiveFinancialAmount(t.amount) - targetAmount) < 0.01);
  }

  if (args.category) {
    userTxs = userTxs.filter((t: any) => matchesArabicCategory(t, args.category));
  }

  if (userTxs.length > 1 && !args.id) {
    return {
      success: false,
      needsClarification: true,
      reason: 'AMBIGUOUS_DELETE',
      message: `وجدت ${userTxs.length} عمليات مطابقة. حدد العملية أو أعطني تفاصيل إضافية قبل الحذف.`,
      candidates: userTxs.slice(0, 5).map((t:any) => ({ id:t.id, amount:t.amount, category:t.category, subcategory:t.subcategory, merchant:t.merchant, date:t.date, account:t.account, notes:t.notes }))
    };
  }

  // V6 (MF-6): smart-delete with a single candidate must STILL request confirmation.
  // Silent destructive mutations based on AI guessing are not acceptable.
  if (userTxs.length === 1 && !args.id) {
    const toDelete = userTxs[0];
    return {
      success: false,
      needsClarification: true,
      reason: 'CONFIRM_SINGLE_SMART_DELETE',
      message: `وجدت عملية واحدة مطابقة. هل تقصد حذفها؟`,
      candidate: { id: toDelete.id, amount: toDelete.amount, category: toDelete.category, subcategory: toDelete.subcategory, merchant: toDelete.merchant, date: toDelete.date, account: toDelete.account, notes: toDelete.notes }
    };
  }

  if (userTxs.length === 1 && (args.id || args.confirmed)) {
    const toDelete = userTxs[0];
    // Revalidate ownership, ledger balances, and delete atomically. The smart-search
    // candidate may be stale by the time the user confirms it.
    const atomicResult = await atomicDeleteTransaction(userId, toDelete.id, { riskConfirmed: !!args.riskConfirmed });
    if ('reason' in atomicResult) {
      if (atomicResult.reason === 'NEGATIVE_CASH_RESULT' || atomicResult.reason === 'NEGATIVE_PALPAY_RESULT') {
        return {
          success: false,
          needsConfirmation: true,
          reason: atomicResult.reason,
          message: 'حذف هذه العملية سيجعل أحد الأرصدة سالباً. هل تريد المتابعة رغم الأثر المالي؟',
          financialImpact: atomicResult.balances,
        };
      }
      return { success: false, reason: atomicResult.reason, message: 'تعذر حذف العملية بأمان لأنها تغيرت أو لم تعد موجودة.' };
    }
    const deletedData = atomicResult.deleted;
    const accName = deletedData.account === 'palPay' ? 'PalPay' : deletedData.account === 'debt' ? 'الديون' : 'النقدي';
    await addNotification(userId, `تم حذف عملية (${toDelete.notes || toDelete.category || ''} بقيمة ${toDelete.amount} ₪ من حساب ${accName}) بنجاح.`, 'success', adminDb);
    
    const balances = await getBalance({}, userId, token);
    return { 
      success: true, 
      deletedTransaction: toDelete, 
      message: `تم حذف عملية بقيمة ${toDelete.amount} ₪ من حساب ${accName} بنجاح.`,
      currentBalances: balances.balances 
    };
  }

  return { success: false, message: "لم يتم العثور على عملية مطابقة لحذفها. يرجى تحديد المبلغ أو اسم الحساب." };
}

export async function repairDuplicateIncome(args: any, userId: string, token: string) {
  const adminDb = getDb(token);
  console.log('TOOL CALL: repairDuplicateIncome', args);
  const targetAmount = args.amount !== undefined ? parsePositiveFinancialAmount(args.amount) : null;
  const targetDate = String(args.date || '').slice(0, 10);
  const targetMonth = String(args.month || '').slice(0, 7);
  const snap = await adminDb.collection('transactions').where('userId', '==', userId).get();
  if ((snap as any).partial === true) {
    return { success: false, retryable: true, reason: 'PARTIAL_STATE_UNSAFE', message: 'لا يمكن إصلاح التكرار الآن لأن قراءة السحابة جزئية وغير آمنة.' };
  }
  const incomes = snap.docs
    .map((d: any) => ({ id: d.id, ...d.data() }))
    .filter((t: any) => t.type === 'income')
    .filter((t: any) => targetAmount === null || Math.abs(parsePositiveFinancialAmount(t.amount) - targetAmount) < 0.01)
    .filter((t: any) => {
      const dateStr = String(t.date || t.createdAt || '');
      if (targetDate) return dateStr.startsWith(targetDate);
      if (targetMonth) return dateStr.startsWith(targetMonth);
      return true;
    });

  const groups = new Map<string, any[]>();
  for (const t of incomes) {
    const day = String(t.date || t.createdAt || '').slice(0, 10);
    const key = [day, parsePositiveFinancialAmount(t.amount).toFixed(2), t.account || 'cash', t.category || '', t.subcategory || ''].join('|');
    const arr = groups.get(key) || [];
    arr.push(t);
    groups.set(key, arr);
  }

  const deleted: any[] = [];
  for (const group of groups.values()) {
    if (group.length <= 1) continue;
    group.sort((a: any, b: any) => String(a.createdAt || a.date || '').localeCompare(String(b.createdAt || b.date || '')));
    const keep = group[0];
    for (const dup of group.slice(1)) {
      await adminDb.collection('transactions').doc(dup.id).delete();
      deleted.push({ id: dup.id, amount: dup.amount, account: dup.account, date: dup.date, keptId: keep.id });
    }
  }

  const balances = await getBalance({}, userId, token);
  return {
    success: true,
    deletedCount: deleted.length,
    deleted,
    message: deleted.length ? `حذفت ${deleted.length} قيد دخل مكرر وأبقيت النسخة الأصلية.` : 'لم أجد تكرار دخل مطابقاً للمعايير.',
    currentBalances: balances.balances
  };
}

export async function repairDuplicateCreditPurchase(args: any, userId: string, token: string) {
  const adminDb = getDb(token);
  console.log('TOOL CALL: repairDuplicateCreditPurchase', args);
  const targetAmount = args.amount !== undefined ? parsePositiveFinancialAmount(args.amount) : null;
  const targetCreditor = normalizeCreditorName(args.creditor || args.merchant || args.seller || '');
  const targetDate = String(args.date || '').slice(0, 10);
  const targetMonth = String(args.month || '').slice(0, 7);
  const snap = await adminDb.collection('transactions').where('userId', '==', userId).get();
  if ((snap as any).partial === true) {
    return { success: false, retryable: true, reason: 'PARTIAL_STATE_UNSAFE', message: 'لا يمكن إصلاح تكرار الشراء بالدين الآن لأن قراءة السحابة جزئية وغير آمنة.' };
  }
  const purchases = snap.docs
    .map((d: any) => ({ id: d.id, ...d.data() }))
    .filter((t: any) => t.type === 'expense' && (t.account === 'debt' || t.transactionType === 'CREDIT_PURCHASE'))
    .filter((t: any) => targetAmount === null || Math.abs(parsePositiveFinancialAmount(t.amount) - targetAmount) < 0.01)
    .filter((t: any) => !targetCreditor || normalizeCreditorName(t.creditor || t.merchant || '') === targetCreditor)
    .filter((t: any) => {
      const dateStr = String(t.date || t.createdAt || '');
      if (targetDate) return dateStr.startsWith(targetDate);
      if (targetMonth) return dateStr.startsWith(targetMonth);
      return true;
    });

  const groups = new Map<string, any[]>();
  for (const t of purchases) {
    const day = String(t.date || t.createdAt || '').slice(0, 10);
    const creditor = normalizeCreditorName(t.creditor || t.merchant || 'غير محدد');
    const key = [day, parsePositiveFinancialAmount(t.amount).toFixed(2), creditor, t.category || '', t.subcategory || ''].join('|');
    const arr = groups.get(key) || [];
    arr.push(t);
    groups.set(key, arr);
  }

  const deleted: any[] = [];
  for (const group of groups.values()) {
    if (group.length <= 1) continue;
    group.sort((a: any, b: any) => String(a.createdAt || a.date || '').localeCompare(String(b.createdAt || b.date || '')));
    const keep = group[0];
    for (const dup of group.slice(1)) {
      await adminDb.collection('transactions').doc(dup.id).delete();
      deleted.push({ id: dup.id, amount: dup.amount, creditor: dup.creditor, merchant: dup.merchant, date: dup.date, keptId: keep.id });
    }
  }

  const balances = await getBalance({}, userId, token);
  return {
    success: true,
    deletedCount: deleted.length,
    deleted,
    message: deleted.length ? `حذفت ${deleted.length} قيد شراء بالدين مكرر وأبقيت النسخة الأصلية.` : 'لم أجد تكرار شراء بالدين مطابقاً للمعايير.',
    currentBalances: balances.balances
  };
}

export async function setCategoryBudget(args: any, userId: string, token: string) {
  const adminDb = getDb(token);
  console.log("TOOL CALL: setCategoryBudget", args);
  const category = args.category;
  const limit = parsePositiveFinancialAmount(args.limit) || 500;
  
  if (!category) return { error: "Category is required" };
  
  await adminDb.collection('users').doc(userId).collection('budgets').doc(category).set({
    category,
    limit,
    updatedAt: new Date().toISOString()
  });

  await addNotification(userId, `تم ضبط ميزانية بند [${category}] لتكون ${limit} ₪ شهرياً.`, 'success', adminDb);
  return { success: true, category, limit, message: `Budget for ${category} set to ${limit} ILS.` };
}

export async function getBudgetsOverview(args: any, userId: string, token: string) {
  const adminDb = getDb(token);
  const customBudgetDocs = await getUserCustomBudgetDocs(userId, adminDb);
  // Reuse the documents already fetched above. Calling getUserBudgets() here
  // would read the same Firestore budget subcollection a second time on every
  // dashboard refresh.
  const userBudgets: Record<string, number> = { ...DEFAULT_BUDGETS };
  customBudgetDocs.forEach((b) => {
    if (b.limit) userBudgets[b.category || b.id] = Number(b.limit);
  });
  
  const thisMonth = new Date().toISOString().slice(0, 7);
  const txSnapshot = await adminDb.collection('transactions').where('userId', '==', userId).get();
  const monthExpenses = txSnapshot.docs
    .map((d: any) => ({ id: d.id, ...d.data() }))
    .filter((t: any) => t.type === 'expense' && (t.date || '').startsWith(thisMonth));

  const categories = Object.keys(userBudgets);
  const budgets = categories.map(cat => {
    const limit = userBudgets[cat];
    const catExpenses = monthExpenses.filter(t => t.category === cat);
    const spent = catExpenses.reduce((sum, t) => sum + parsePositiveFinancialAmount(t.amount), 0);
    const ratio = limit > 0 ? spent / limit : 0;
    const percentage = Math.round(ratio * 100);
    const status = ratio >= 1.0 ? 'exceeded' : ratio >= 0.8 ? 'warning' : 'safe';
    return {
      category: cat,
      limit,
      spent,
      remaining: Math.max(0, limit - spent),
      percentage,
      status
    };
  });

  const totalBudget = Object.values(userBudgets).reduce((a, b) => a + b, 0);
  const totalSpent = monthExpenses.reduce((sum, t) => sum + parsePositiveFinancialAmount(t.amount), 0);

  return {
    budgets,
    totalBudget,
    totalSpent,
    month: thisMonth,
    customBudgetCount: customBudgetDocs.length,
    defaultBudgetCount: Object.keys(DEFAULT_BUDGETS).length,
    partial: (txSnapshot as any).partial
  };
}

export async function checkBudgetStatus(args: any, userId: string, token: string) {
  const adminDb = getDb(token);
  console.log("TOOL CALL: checkBudgetStatus", args);
  
  const userBudgets = await getUserBudgets(userId, adminDb);
  const thisMonth = new Date().toISOString().slice(0, 7);
  const txSnapshot = await adminDb.collection('transactions').where('userId', '==', userId).get();
  const expenses = txSnapshot.docs.map(d => d.data()).filter(t => t.type === 'expense' && (t.date || '').startsWith(thisMonth));
  
  if (args.category) {
    const categoryExpenses = expenses.filter(t => t.category === args.category);
    const spent = categoryExpenses.reduce((sum, t) => sum + parsePositiveFinancialAmount(t.amount), 0);
    const limit = userBudgets[args.category] || DEFAULT_BUDGETS[args.category] || 1000;
    const percentage = Math.round((spent / limit) * 100);
    
    let warning = "الوضع ممتاز وفي نطاق الميزانية";
    if (spent >= limit) {
      warning = `انتبه يا صديقي، لقد تجاوزت سقف ميزانية ${args.category} لهذا الشهر (${spent} ₪ من أصل ${limit} ₪)!`;
    } else if (spent >= limit * 0.8) {
      warning = `انتبه يا صديقي، اقتربت من إقفال ميزانية ${args.category} لهذا الشهر (وصلت إلى ${percentage}% - ${spent} ₪ من أصل ${limit} ₪).`;
    }
    
    return { 
      category: args.category, 
      spent, 
      limit, 
      remaining: Math.max(0, limit - spent),
      percentage, 
      warning 
    };
  }
  
  const totalSpent = expenses.reduce((sum, t) => sum + parsePositiveFinancialAmount(t.amount), 0);
  const totalLimit = Object.values(userBudgets).reduce((a, b) => a + b, 0);
  const totalPercentage = Math.round((totalSpent / (totalLimit || 1)) * 100);
  
  let totalWarning = "الميزانية الشهرية العامة في وضع آمن ومستقر";
  if (totalSpent >= totalLimit) {
    totalWarning = `تحذير: إجمالي مصروفاتك للشهر تجاوز السقف المحدد للميزانية (${totalSpent} ₪ من ${totalLimit} ₪).`;
  } else if (totalSpent >= totalLimit * 0.8) {
    totalWarning = `تنبيه: اقتربت من إقفال الميزانية الإجمالية لهذا الشهر بنسبة ${totalPercentage}% (${totalSpent} ₪ من ${totalLimit} ₪).`;
  }

  return { 
    totalSpent, 
    totalLimit, 
    totalPercentage, 
    warning: totalWarning 
  };
}

export async function getCommitments(args: any, userId: string, token: string) {
  const adminDb = getDb(token);
  const snapshot = await adminDb.collection('commitments').where('userId', '==', userId).get();
  const commitments = snapshot.docs.map(d => ({ id: d.id, ...d.data() }));
  
  const now = new Date();
  const enriched = commitments.map((c: any) => {
    const due = new Date(c.dueDate);
    const diffMs = due.getTime() - now.getTime();
    const daysRemaining = Math.ceil(diffMs / (1000 * 60 * 60 * 24));
    // V6: paid/cancelled commitments keep their explicit status — don't override with isOverdue.
    const explicitStatus = c.status && ['pending', 'paid', 'cancelled'].includes(c.status) ? c.status : null;
    const isDueSoon = explicitStatus === 'pending' && daysRemaining >= 0 && daysRemaining <= 3;
    const isOverdue = explicitStatus === 'pending' && daysRemaining < 0;
    return {
      ...c,
      daysRemaining,
      isDueSoon,
      isOverdue,
      status: explicitStatus || (isOverdue ? 'overdue' : isDueSoon ? 'due_soon' : 'upcoming')
    };
  });

  enriched.sort((a, b) => new Date(a.dueDate).getTime() - new Date(b.dueDate).getTime());
  return { commitments: enriched, partial: (snapshot as any).partial };
}

export async function createCommitment(args: any, userId: string, token: string) {
  const adminDb = getDb(token);
  const docRef = adminDb.collection('commitments').doc();
  const commitment = {
    userId,
    title: args.title || 'التزام مجدول',
    amount: parsePositiveFinancialAmount(args.amount),
    dueDate: args.dueDate || new Date(Date.now() + 7 * 24 * 60 * 60 * 1000).toISOString(),
    category: args.category || 'أقساط والتزامات',
    notes: args.notes || '',
    // V6 (MF-1): explicit lifecycle status. Values: 'pending' | 'paid' | 'cancelled'.
    status: 'pending',
    createdAt: new Date().toISOString()
  };
  await docRef.set(commitment);
  await addNotification(userId, `تمت جدولة التزام "${commitment.title}" بقيمة ${commitment.amount} ₪ في موعد ${commitment.dueDate.slice(0, 10)}.`, 'success', adminDb);
  return { success: true, id: docRef.id, commitment };
}

/**
 * V6 (MF-1): update commitment lifecycle status.
 * Used to mark a commitment as paid (excludes from forecast) or cancelled.
 */
export async function updateCommitmentStatus(args: any, userId: string, token: string) {
  const adminDb = getDb(token);
  if (!args.id) return { success: false, error: 'Commitment ID is required' };
  const status = String(args.status || '').toLowerCase();
  if (!['pending', 'paid', 'cancelled'].includes(status)) {
    return { success: false, error: "status must be 'pending', 'paid', or 'cancelled'" };
  }
  const ref = adminDb.collection('commitments').doc(args.id);
  const snap = await ref.get();
  if (!snap.exists) return { success: false, error: 'الالتزام غير موجود.' };
  if (snap.data()?.userId !== userId) return { success: false, error: 'غير مصرح.' };
  await ref.update({ status, statusUpdatedAt: new Date().toISOString() });
  await addNotification(userId, `تم تحديث حالة التزام "${snap.data()?.title || args.id}" إلى ${status}.`, 'success', adminDb);
  return { success: true, status };
}

export async function deleteCommitment(args: any, userId: string, token: string) {
  const adminDb = getDb(token);
  if (!args.id) return { success: false, error: "Commitment ID is required" };
  const ref = adminDb.collection('commitments').doc(args.id);
  const snap = await ref.get();
  if (!snap.exists) return { success: false, error: "الالتزام غير موجود." };
  if (snap.data()?.userId !== userId) return { success: false, error: "غير مصرح بحذف هذا الالتزام." };
  await ref.delete();
  await addNotification(userId, "تم حذف الالتزام المجدول.", 'success', adminDb);
  return { success: true };
}

export async function getTreasurerProfile(args: any, userId: string, token: string) {
  const adminDb = getDb(token);
  const ref = adminDb.collection('users').doc(userId).collection('treasurer').doc('profile');
  const snap = await ref.get();
  const profile = snap.exists ? snap.data() : {
    monthlySalary: 0,
    salaryDay: null,
    cashReserveTarget: 0,
    savingsRateTarget: 10,
    strictness: 'balanced',
    currency: 'ILS',
    locale: 'Gaza/Palestine',
    createdAt: null,
    updatedAt: null
  };
  return { success: true, profile };
}

export async function updateTreasurerProfile(args: any, userId: string, token: string) {
  const adminDb = getDb(token);
  const ref = adminDb.collection('users').doc(userId).collection('treasurer').doc('profile');
  const patch: any = { updatedAt: new Date().toISOString() };
  if (args.monthlySalary !== undefined) patch.monthlySalary = parsePositiveFinancialAmount(args.monthlySalary);
  if (args.salaryDay !== undefined) patch.salaryDay = args.salaryDay ? Number(args.salaryDay) : null;
  if (args.cashReserveTarget !== undefined || args.reserveTarget !== undefined) patch.cashReserveTarget = parsePositiveFinancialAmount(args.cashReserveTarget ?? args.reserveTarget);
  if (args.savingsRateTarget !== undefined) patch.savingsRateTarget = Math.max(0, Math.min(80, Number(args.savingsRateTarget) || 0));
  if (args.strictness !== undefined) patch.strictness = String(args.strictness || 'balanced');
  if (args.locale !== undefined) patch.locale = String(args.locale || 'Gaza/Palestine');
  if (args.notes !== undefined) patch.notes = String(args.notes || '');
  const snap = await ref.get();
  if (!snap.exists) patch.createdAt = new Date().toISOString();
  await ref.set({ ...(snap.exists ? snap.data() : {}), ...patch });
  return { success: true, profile: { ...(snap.exists ? snap.data() : {}), ...patch } };
}

export async function getSavingsGoals(args: any, userId: string, token: string) {
  const adminDb = firebaseAdminDb;
  const [snap, txSnap] = await Promise.all([
    adminDb.collection('users').doc(userId).collection('savingsGoals').get(),
    adminDb.collection('transactions').where('userId', '==', userId).get().catch(() => ({ docs: [], partial: true }))
  ]);
  const now = args?.now ? new Date(String(args.now)) : new Date();
  const txs = (txSnap as any).docs.map((d: any) => ({ id: d.id, ...d.data() }));
  const rawGoals = snap.docs.map((d: any) => ({ id: d.id, ...d.data() }))
    .sort((a: any, b: any) => String(a.dueDate || '').localeCompare(String(b.dueDate || '')));

  const goals = [];
  for (const goal of rawGoals) {
    let contributions: any[] = [];
    try {
      const contributionSnap = await adminDb.collection('users').doc(userId).collection('savingsGoals').doc(goal.id).collection('contributions').get();
      contributions = contributionSnap.docs.map((d: any) => ({ id: d.id, ...d.data() }));
    } catch {}
    const plan = buildSavingsGoalPlan({ goal, transactions: txs, contributions, now });
    goals.push(plan);
    if (plan.alertLevel === 'critical') {
      await addNotification(userId, plan.alertMessage, 'danger', adminDb, {
        idempotencyKey: `savings-critical:${goal.id}:${monthKey(now)}`,
        metadata: { goalId: goal.id, monthlyRequired: plan.monthlyRequired, monthlyNetAvailable: plan.monthlyNetAvailable }
      });
    }
  }

  return { success: true, goals, partial: (snap as any).partial || (txSnap as any).partial };
}

export async function createSavingsGoal(args: any, userId: string, token: string) {
  const adminDb = firebaseAdminDb;
  const name = String(args.name || args.title || '').trim();
  const built = buildSavingsGoalRecord({
    userId,
    name,
    targetAmount: args.targetAmount || args.amount,
    savedAmount: args.savedAmount || args.initialAmount,
    dueDate: args.dueDate,
    durationMonths: args.durationMonths || args.months,
    priority: args.priority,
    notes: args.notes,
  });
  if (built.ok === false) return { success: false, needsClarification: true, reason: built.reason, message: built.message };
  const goal = built.goal as any;
  const docRef = adminDb.collection('users').doc(userId).collection('savingsGoals').doc();
  await docRef.set(goal);
  await addNotification(userId, `تم إنشاء هدف ادخار "${name}" بمبلغ ${goal.targetAmount} ₪. المطلوب شهرياً: ${goal.monthlyRequired || 0} ₪.`, 'success', adminDb);
  return { success: true, id: docRef.id, goal: { id: docRef.id, ...goal } };
}

export async function addSavingsContribution(args: any, userId: string, token: string) {
  const adminDb = firebaseAdminDb;
  const amount = parsePositiveFinancialAmount(args.amount);
  if (amount <= 0) return { success: false, needsClarification: true, reason: 'INVALID_SAVINGS_AMOUNT', message: 'كم المبلغ الذي تريد ادخاره؟' };
  const snap = await adminDb.collection('users').doc(userId).collection('savingsGoals').get();
  const goals = snap.docs.map((d: any) => ({ id: d.id, ...d.data() }));
  const explicitId = String(args.id || args.goalId || '').trim();
  const selection = explicitId
    ? selectSavingsGoalForContribution(goals.filter((g: any) => String(g.id) === explicitId), String(args.goalName || args.name || ''))
    : selectSavingsGoalForContribution(goals, args.goalName || args.name || args.title);
  if (selection.ok === false) {
    return { success: false, needsClarification: true, reason: selection.reason, options: selection.options, message: selection.message };
  }
  const id = String(selection.selected.id || explicitId);
  const cloudRef = firebaseAdminDb.collection('users').doc(userId).collection('savingsGoals').doc(id);
  const contributionRef = cloudRef.collection('contributions').doc();
  const now = new Date().toISOString();
  const txResult = await firebaseAdminDb.runTransaction(async (tx: any) => {
    const currentSnap = await tx.get(cloudRef as any);
    if (!currentSnap.exists) return { ok: false as const, reason: 'SAVINGS_GOAL_NOT_FOUND' };
    const current = currentSnap.data() || {};
    const targetAmount = parsePositiveFinancialAmount(current.targetAmount);
    const savedAmount = roundMoney(parsePositiveFinancialAmount(current.savedAmount) + amount);
    const status = savedAmount >= targetAmount ? 'completed' : (current.status || 'active');
    tx.set(contributionRef as any, { userId, goalId: id, amount, createdAt: now, notes: String(args.notes || '') });
    tx.update(cloudRef as any, { savedAmount, status, lastContributionAt: now, updatedAt: now });
    return { ok: true as const, goalName: String(current.name || 'هدف ادخار'), targetAmount, savedAmount, status };
  });
  if (!txResult.ok) return { success: false, error: 'هدف الادخار غير موجود.' };
  await addNotification(userId, `تمت إضافة ${amount} ₪ إلى هدف ادخار "${txResult.goalName}". المجموع الآن ${txResult.savedAmount} ₪.`, 'success', adminDb, {
    idempotencyKey: `savings-contribution:${id}:${amount}:${now}`,
    metadata: { goalId: id, amount }
  });
  return { success: true, id, savedAmount: txResult.savedAmount, status: txResult.status, remaining: Math.max(0, txResult.targetAmount - txResult.savedAmount) };
}

export async function updateSavingsGoal(args: any, userId: string, token: string) {
  const adminDb = firebaseAdminDb;
  const id = String(args.id || args.goalId || '').trim();
  if (!id) return { success: false, error: 'Savings goal id is required' };
  const ref = adminDb.collection('users').doc(userId).collection('savingsGoals').doc(id);
  const snap = await ref.get();
  if (!snap.exists) return { success: false, error: 'هدف الادخار غير موجود.' };
  const patch: any = { updatedAt: new Date().toISOString() };
  if (args.name || args.title) patch.name = String(args.name || args.title).trim();
  if (args.targetAmount !== undefined || args.amount !== undefined) patch.targetAmount = parsePositiveFinancialAmount(args.targetAmount || args.amount);
  if (args.savedAmount !== undefined) patch.savedAmount = parsePositiveFinancialAmount(args.savedAmount);
  if (args.dueDate !== undefined) patch.dueDate = args.dueDate || '';
  if (args.durationMonths !== undefined || args.months !== undefined) {
    const months = parsePositiveFinancialAmount(args.durationMonths ?? args.months);
    patch.durationMonths = months || null;
    patch.dueDate = months > 0 ? normalizeSavingsDueDate({ durationMonths: months }) : patch.dueDate || '';
  }
  if (args.priority !== undefined) patch.priority = args.priority;
  if (args.notes !== undefined) patch.notes = args.notes;
  if (args.status !== undefined) patch.status = args.status;
  const projected = { ...(snap.data() || {}), ...patch };
  patch.monthlyRequired = buildSavingsGoalPlan({ goal: projected }).monthlyRequired;
  await ref.update(patch);
  return { success: true, id, updated: patch };
}

export async function queryTransactions(args: any, userId: string, token: string) {
  console.log("TOOL CALL: queryTransactions", args);
  // Historical entry can create many documents quickly. Do not read the full
  // user ledger on every assistant turn; bounded Firestore reads prevent quota
  // exhaustion that leaves the UI stuck on "thinking".
  const now = new Date();
  const limit = Math.max(1, Math.min(300, Number(args.limit) || 120));
  const period = String(args.period || '').trim();
  let startIso = '';
  let endIso = '';

  if (period === 'today') {
    const today = now.toISOString().split('T')[0];
    startIso = `${today}T00:00:00.000Z`;
    endIso = `${today}T23:59:59.999Z`;
  } else if (period === 'this_week') {
    startIso = new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000).toISOString();
  } else if (period === 'this_month') {
    const thisMonth = now.toISOString().slice(0, 7);
    startIso = `${thisMonth}-01T00:00:00.000Z`;
  } else if (args.startDate || args.endDate) {
    if (args.startDate) startIso = new Date(args.startDate).toISOString();
    if (args.endDate) {
      const end = new Date(args.endDate);
      if (/^\d{4}-\d{2}-\d{2}$/.test(String(args.endDate))) end.setUTCHours(23, 59, 59, 999);
      endIso = end.toISOString();
    }
  }

  let snapshot: any;
  let boundedFallback = false;
  try {
    let q: any = firebaseAdminDb.collection('transactions').where('userId', '==', userId);
    if (startIso) q = q.where('date', '>=', startIso);
    if (endIso) q = q.where('date', '<=', endIso);
    if (startIso || endIso) q = q.orderBy('date', 'desc');
    q = q.limit(limit);
    const cloudSnap = await q.get();
    snapshot = { docs: cloudSnap.docs, partial: false };
  } catch (cloudErr: any) {
    try {
      // If a date-range query needs a composite index, keep the app responsive by
      // falling back to a small bounded read. Never fall back to the full ledger.
      const fallbackSnap = await firebaseAdminDb.collection('transactions')
        .where('userId', '==', userId)
        .limit(limit)
        .get();
      snapshot = {
        docs: fallbackSnap.docs,
        partial: true,
        error: cloudErr?.message || 'Firestore bounded transaction read failed',
      };
      boundedFallback = true;
    } catch (fallbackErr: any) {
      const localDb = getDb(token);
      const cachedSnapshot: any = await localDb.collection('transactions').where('userId', '==', userId).limit(limit).get();
      snapshot = {
        docs: cachedSnapshot.docs || [],
        partial: true,
        error: fallbackErr?.message || cloudErr?.message || 'Firestore transaction read failed',
      };
      boundedFallback = true;
    }
  }

  let filtered = snapshot.docs.map((d: any) => ({ id: d.id, ...d.data() }));
  
  if (args.type) {
    filtered = filtered.filter((t: any) => t.type === args.type);
  }

  if (args.category && args.category !== 'all' && args.category !== 'الكل' && args.category !== 'كافة البنود') {
    filtered = filtered.filter((t: any) => matchesArabicCategory(t, args.category));
  }

  if (args.account) {
    filtered = filtered.filter((t: any) => t.account === args.account);
  }

  if (args.necessity) {
    filtered = filtered.filter((t: any) => t.necessity === args.necessity);
  }

  if (startIso) filtered = filtered.filter((t: any) => String(t.date || t.createdAt || '') >= startIso);
  if (endIso) filtered = filtered.filter((t: any) => String(t.date || t.createdAt || '') <= endIso);

  filtered.sort((a: any, b: any) => new Date(b.date || b.createdAt || 0).getTime() - new Date(a.date || a.createdAt || 0).getTime());

  const total = filtered.reduce((sum, t: any) => sum + parsePositiveFinancialAmount(t.amount), 0);
  
  return { 
    success: true, 
    count: filtered.length,
    totalAmount: total,
    transactions: filtered,
    partial: (snapshot as any).partial,
    bounded: true,
    limit,
    boundedFallback
  };
}

export async function wipeAllUserData(userId: string, token: string) {
  const adminDb = getDb(token);
  
  // 1. Delete all transactions
  try {
    const txSnap = await adminDb.collection('transactions').where('userId', '==', userId).get();
    for (const d of txSnap.docs) {
      await adminDb.collection('transactions').doc(d.id).delete();
    }
  } catch (e) {}

  // 2. Delete all commitments
  try {
    const commSnap = await adminDb.collection('commitments').where('userId', '==', userId).get();
    for (const d of commSnap.docs) {
      await adminDb.collection('commitments').doc(d.id).delete();
    }
  } catch (e) {}

  // 3. Delete all reports
  try {
    const repSnap = await adminDb.collection('reports').where('userId', '==', userId).get();
    for (const d of repSnap.docs) {
      await adminDb.collection('reports').doc(d.id).delete();
    }
  } catch (e) {}

  // 4. Delete all user memories from the same canonical path used by memory_save/search/delete.
  try {
    const memSnap = await adminDb.collection('users').doc(userId).collection('memory').get();
    for (const d of memSnap.docs) {
      await adminDb.collection('users').doc(userId).collection('memory').doc(d.id).delete();
    }
  } catch (e) {}

  // 5. Delete all custom budgets
  try {
    const budgetSnap = await adminDb.collection('users').doc(userId).collection('budgets').get();
    for (const d of budgetSnap.docs) {
      await adminDb.collection('users').doc(userId).collection('budgets').doc(d.id).delete();
    }
  } catch (e) {}

  // 6. Delete all savings goals
  try {
    const savingsSnap = await adminDb.collection('users').doc(userId).collection('savingsGoals').get();
    for (const d of savingsSnap.docs) {
      await adminDb.collection('users').doc(userId).collection('savingsGoals').doc(d.id).delete();
    }
  } catch (e) {}

  // 7. Delete all saved market directory offers
  try {
    const marketSnap = await adminDb.collection('users').doc(userId).collection('marketDirectory').get();
    for (const d of marketSnap.docs) {
      await adminDb.collection('users').doc(userId).collection('marketDirectory').doc(d.id).delete();
    }
  } catch (e) {}

  // 8. Wipe local disk & memoryStore cache so zero residual data exists
  clearAllLocalUserData(userId);

  return {
    success: true,
    message: "تم مسح وتصفير كافة البيانات من النظام والذاكرة والسحابة بنجاح."
  };
}

export async function generateTreasurerReport(args: any, userId: string, token: string) {
  const adminDb = getDb(token);
  console.log('TOOL CALL: generateTreasurerReport', args);
  const [txSnapshot, budgets, savingsSnap] = await Promise.all([
    adminDb.collection('transactions').where('userId', '==', userId).get(),
    getUserBudgets(userId, adminDb),
    adminDb.collection('users').doc(userId).collection('savingsGoals').get().catch(() => ({ docs: [] }))
  ]);
  if ((txSnapshot as any).partial === true) {
    return { success: false, partial: true, retryable: true, reason: 'PARTIAL_STATE_UNSAFE', message: 'لا أستطيع إصدار تقرير أمين صندوق دقيق الآن لأن بيانات العمليات جزئية. حاول عند استقرار الاتصال.' };
  }
  const txs = txSnapshot.docs.map((d: any) => ({ id: d.id, ...d.data() }));
  const savingsGoals = (savingsSnap as any).docs.map((d: any) => ({ id: d.id, ...d.data() }));
  const report = buildTreasurerReport(args, txs, budgets, savingsGoals);
  if (args?.save !== false) {
    const reportRef = adminDb.collection('reports').doc();
    await reportRef.set({
      userId,
      type: 'treasurer',
      title: report.title,
      content: JSON.stringify(report, null, 2),
      data: report,
      createdAt: new Date().toISOString()
    });
    return { success: true, reportId: reportRef.id, report };
  }
  return { success: true, report };
}

// In-memory cache to guard against rapid duplicate tool calls
const recentMutations = new Map<string, { result: any; timestamp: number }>();

function getMutationKey(name: string, args: any, userId: string): string {
  const cleanArgs: any = {};
  for (const k of Object.keys(args || {}).sort()) {
    // Ignore internal fields or timestamps if any
    if (k === 'date' || k === 'createdAt') continue;
    if (args[k] !== undefined && args[k] !== null && args[k] !== '') {
      cleanArgs[k] = typeof args[k] === 'number' ? Math.round(args[k] * 100) / 100 : String(args[k]).trim().toLowerCase();
    }
  }
  // For money transfers or debts or transactions, ensure amount and accounts create a strong deduplication key
  return `${userId}:${name}:${JSON.stringify(cleanArgs)}`;
}

function wrapWithDeduplication(name: string, fn: (args: any, userId: string, token: string) => Promise<any>) {
  const mutatingTools = ['add_transaction', 'transfer_money', 'pay_debt', 'send_palpay_payment', 'create_commitment', 'delete_transaction', 'update_transaction', 'repair_duplicate_income', 'repair_duplicate_credit_purchase', 'update_treasurer_profile', 'create_savings_goal', 'add_savings_contribution', 'update_savings_goal', 'save_market_offer'];
  if (!mutatingTools.includes(name)) return fn;

  return async (args: any, userId: string, token: string) => {
    // V6 (CF-6): persistent idempotency via Firestore. The args may carry an
    // explicit operationId (preferred). If absent, derive one from args hash
    // so duplicate identical calls within a short window still dedupe.
    const operationId = args?.operationId
      || `${name}_${getMutationKey(name, args, userId)}`;
    return runIdempotent(userId, operationId, () => fn(args, userId, token)).then(outcome => {
      if (outcome.kind === 'cache_hit') return outcome.cachedResult;
      return outcome.result;
    });
  };
}

const rawToolHandlers: Record<string, (args: any, userId: string, token: string) => Promise<any>> = {
  add_transaction: addTransaction,
  update_transaction: updateTransaction,
  delete_transaction: deleteTransaction,
  repair_duplicate_income: repairDuplicateIncome,
  repair_duplicate_credit_purchase: repairDuplicateCreditPurchase,
  get_balance: getBalance,
  get_financial_decision_context: getFinancialDecisionContext,
  assess_purchase: assessPurchase,
  search_local_market: searchLocalMarket,
  get_market_directory: getMarketDirectory,
  save_market_offer: saveMarketOffer,
  transfer_money: transferMoney,
  pay_debt: payDebt,
  get_recent_transactions: getRecentTransactions,
  audit_financial_duplicates: auditFinancialDuplicates,
  check_budget_status: checkBudgetStatus,
  set_category_budget: setCategoryBudget,
  get_budgets_overview: getBudgetsOverview,
  get_commitments: getCommitments,
  create_commitment: createCommitment,
  update_commitment_status: updateCommitmentStatus,
  delete_commitment: deleteCommitment,
  get_treasurer_profile: getTreasurerProfile,
  update_treasurer_profile: updateTreasurerProfile,
  get_savings_goals: getSavingsGoals,
  create_savings_goal: createSavingsGoal,
  add_savings_contribution: addSavingsContribution,
  update_savings_goal: updateSavingsGoal,
  query_transactions: queryTransactions,
  memory_save: memorySave,
  memory_search: memorySearch,
  create_recurring_item: createRecurringItem,
  search_market_information: searchMarketInformation,
  send_palpay_payment: sendPalPayPayment,
  generate_report: generateReport,
  generate_treasurer_report: generateTreasurerReport,
  delete_report: deleteReport,
  clear_all_reports: clearAllReports
};

export const toolHandlers: Record<string, (args: any, userId: string, token: string) => Promise<any>> = Object.fromEntries(
  Object.entries(rawToolHandlers).map(([name, fn]) => [name, wrapWithDeduplication(name, fn)])
);

export const functionDeclarations = [
  {
    name: "pay_debt",
    description: "يسدد ديناً قائماً لدائن محدد. إذا كان لدى المستخدم أكثر من دائن ولم يحدد لمن السداد، لا تخمن ولا تنفذ: اسأل لمن يريد السداد. اسأل أيضاً عن حساب الدفع إن لم يذكره. لا تستخدم add_transaction لسداد الديون.",
    parameters: {
      type: "object",
      properties: {
        amount: { type: "number", description: "المبلغ المسدد بالشيكل" },
        paymentMethod: { type: "string", description: "طريقة السداد والحساب المدفوع منه: 'cash' (نقداً/كاش) أو 'palPay' (محفظة بال باي)" },
        creditor: { type: "string", description: "اسم الدائن كما ذكره المستخدم؛ لا تخمن الاسم عند وجود أكثر من دائن." },
        operationId: { type: "string", description: "معرف ثابت اختياري للعملية عند إعادة المحاولة أو المزامنة" },
        notes: { type: "string", description: "ملاحظات إضافية عن سداد الدين" }
      },
      required: ["amount", "paymentMethod"]
    }
  },
  {
    name: "delete_report",
    description: "يحذف تقريراً مالياً محفوظاً من حافظة المهام للمستخدم لتجنب تراكم وتكدس التقارير.",
    parameters: {
      type: "object",
      properties: {
        id: { type: "string", description: "معرف التقرير المراد حذفه" }
      },
      required: ["id"]
    }
  },
  {
    name: "clear_all_reports",
    description: "يمسح ويحذف كافة التقارير المحفوظة في حافظة المهام دفعة واحدة لمنع تكدسها.",
    parameters: {
      type: "object",
      properties: {}
    }
  },
  {
    name: "set_category_budget",
    description: "يحدد أو يعدل سقف الميزانية الشهرية لبند رئيسي معين (مثال: الأبناء 1500 شيكل، طعام ومشتريات 2000 شيكل).",
    parameters: {
      type: "object",
      properties: {
        category: { type: "string", description: "اسم البند الرئيسي (مثال: 'الأبناء', 'طعام ومشتريات منزل', 'زيارات وضيافة', 'مواصلات')" },
        limit: { type: "number", description: "سقف الميزانية الشهري بالشيكل" }
      },
      required: ["category", "limit"]
    }
  },
  {
    name: "create_commitment",
    description: "يجدول موعد استحقاق التزام مالي أو دين أو قسط أو رسوم جامعية أو فاتورة دورية لتذكير المستخدم بها.",
    parameters: {
      type: "object",
      properties: {
        title: { type: "string", description: "اسم الالتزام أو القسط (مثال: قسط جامعة، إيجار البيت، دين تاجر)" },
        amount: { type: "number", description: "المبلغ المطلوب سداده بالشيكل" },
        dueDate: { type: "string", description: "تاريخ الاستحقاق بصيغة YYYY-MM-DD" },
        category: { type: "string", description: "التصنيف" }
      },
      required: ["title", "amount", "dueDate"]
    }
  },
  {
    name: "update_commitment_status",
    description: "V6: يحدّث حالة التزام (pending/paid/cancelled). الالتزامات المدفوعة لا تُخصم مرة أخرى من توقع 30 يوماً. استخدمها بعد تنفيذ سداد الالتزام فعلياً.",
    parameters: {
      type: "object",
      properties: {
        id: { type: "string", description: "معرف الالتزام" },
        status: { type: "string", description: "'pending' أو 'paid' أو 'cancelled'" }
      },
      required: ["id", "status"]
    }
  },
  {
    name: "send_palpay_payment",
    description: "يقوم بتحويل مبلغ مالي لشخص عبر رقم الهاتف باستخدام محفظة PalPay. (مهم: اسأل عن رقم الهاتف قبل التحويل إن لم يذكره).",
    parameters: {
      type: "object",
      properties: {
        amount: { type: "number", description: "المبلغ المراد تحويله" },
        recipientName: { type: "string", description: "اسم المستلم" },
        phoneNumber: { type: "string", description: "رقم جوال المستلم (مطلوب)" },
        description: { type: "string", description: "سبب التحويل (مثال: شراء خضار وفواكه)" }
      },
      required: ["amount", "recipientName", "phoneNumber", "description"]
    }
  },
  {
    name: "get_treasurer_profile",
    description: "يجلب الملف المالي الشخصي لأمين الصندوق: الراتب، يوم الراتب، هدف الاحتياطي، نسبة الادخار المستهدفة، ومستوى الصرامة.",
    parameters: { type: "object", properties: {} }
  },
  {
    name: "update_treasurer_profile",
    description: "يحدث ملف أمين الصندوق الشخصي. استخدمه في onboarding أو عندما يقول المستخدم راتبي كذا، يوم الراتب كذا، بدي احتياطي أمان، أو بدي صرامة أعلى.",
    parameters: {
      type: "object",
      properties: {
        monthlySalary: { type: "number", description: "الراتب الشهري المتوقع" },
        salaryDay: { type: "number", description: "يوم نزول الراتب من 1 إلى 31" },
        cashReserveTarget: { type: "number", description: "حد الأمان/الاحتياطي النقدي المطلوب" },
        savingsRateTarget: { type: "number", description: "نسبة الادخار المستهدفة من الدخل" },
        strictness: { type: "string", description: "gentle, balanced, strict" },
        locale: { type: "string", description: "المنطقة/السوق المحلي، الافتراضي غزة/فلسطين" },
        notes: { type: "string", description: "ملاحظات شخصية مالية" }
      }
    }
  },
  {
    name: "get_savings_goals",
    description: "يعرض أهداف الادخار الحالية ومقدار المحفوظ والمتبقي لكل هدف.",
    parameters: { type: "object", properties: {} }
  },
  {
    name: "create_savings_goal",
    description: "ينشئ هدف ادخار مثل احتياطي طوارئ أو شراء آيفون أو تعليم الأبناء. إذا قال المستخدم: هدفي أصل إلى 5000 خلال سنة، استخدم targetAmount=5000 وdurationMonths=12. احسب له المطلوب شهرياً ولا تسجلها كمصروف.",
    parameters: {
      type: "object",
      properties: {
        name: { type: "string", description: "اسم هدف الادخار" },
        targetAmount: { type: "number", description: "المبلغ المستهدف بالشيكل" },
        savedAmount: { type: "number", description: "المبلغ المحفوظ حالياً إن وجد" },
        dueDate: { type: "string", description: "موعد مستهدف اختياري YYYY-MM-DD" },
        durationMonths: { type: "number", description: "مدة الهدف بالشهور عند قول المستخدم خلال سنة/6 شهور/شهرين" },
        priority: { type: "string", description: "low, medium, high" },
        notes: { type: "string", description: "ملاحظات" }
      },
      required: ["name", "targetAmount"]
    }
  },
  {
    name: "add_savings_contribution",
    description: "يضيف مبلغاً إلى هدف ادخار موجود. إذا كان للمستخدم هدف نشط واحد فقط فاختره تلقائياً. إذا تعددت الأهداف ولم يحدد الاسم، اسأل أي هدف. لا تعتبر المساهمة مصروفاً إلا إذا طلب المستخدم نقلها من حساب مالي؛ هي تحديث لهدف الادخار.",
    parameters: {
      type: "object",
      properties: {
        id: { type: "string", description: "معرف هدف الادخار إن كان معروفاً" },
        goalId: { type: "string", description: "معرف هدف الادخار البديل" },
        goalName: { type: "string", description: "اسم الهدف إذا قال: ادخر 200 لهدف الطوارئ" },
        amount: { type: "number", description: "المبلغ المضاف للادخار" },
        notes: { type: "string", description: "ملاحظات اختيارية" }
      },
      required: ["amount"]
    }
  },
  {
    name: "update_savings_goal",
    description: "يعدل هدف ادخار: الاسم، المبلغ المستهدف، المحفوظ، الموعد، الأولوية أو الحالة.",
    parameters: {
      type: "object",
      properties: {
        id: { type: "string", description: "معرف هدف الادخار" },
        name: { type: "string" },
        targetAmount: { type: "number" },
        savedAmount: { type: "number" },
        dueDate: { type: "string" },
        durationMonths: { type: "number", description: "مدة جديدة بالشهور لإعادة حساب الموعد والمطلوب شهرياً" },
        priority: { type: "string" },
        status: { type: "string" },
        notes: { type: "string" }
      },
      required: ["id"]
    }
  },
  {
    name: "generate_report",
    description: "يستخرج وينشئ تقريراً مالياً هيكلياً مفصلاً جداً يحتوي على بند الصرف الرئيسي وتحته بنود الصرف الفرعية وكل بند فرعي تحته تفصيل الدفع (اليوم والتاريخ، المبلغ، البيان/شو اشترى، المتجر، طريقة الدفع كاش/PalPay/دين، هل ضروري أو كمالي)، ويحفظه في حافظة المهام للمستخدم ليتمكن من طباعته أو تصديره لـ Word/PDF.",
    parameters: {
      type: "object",
      properties: {
        title: { type: "string", description: "عنوان التقرير (مثال: 'التقرير المالي التفصيلي الشامل', 'تقرير مصروفات الأبناء', 'تقرير زيارات وضيافة')" },
        timeframe: { type: "string", description: "الفترة: 'all' لكافة العمليات, 'month' للشهر الحالي, 'today' لليوم, 'week' للأسبوع" },
        category: { type: "string", description: "التصنيف إن كان التقرير مخصصاً لتصنيف محدد مثل 'الأبناء' أو 'زيارات' (اختياري، اتركه فارغاً للتقرير الشامل لكافة البنود)" }
      },
      required: ["title"]
    }
  },
  {
    name: "generate_treasurer_report",
    description: "ينشئ تقرير أمين الصندوق المتقدم: شهري/ربعي/سنوي/مخصص، مع تفصيل كل شهر، البنود الرئيسية والفرعية، المتاجر، طرق الدفع، الضروري والكمالي، أعلى المصروفات، التجاوزات، مؤشرات الادخار، وبيانات جاهزة للرسم البياني. استخدمه لأي سؤال تقريري عميق مثل: كم صرفت على الأبناء في شهر كذا؟ أو تقرير سنوي مفصل.",
    parameters: {
      type: "object",
      properties: {
        title: { type: "string", description: "عنوان التقرير" },
        period: { type: "string", description: "today, week, month, quarter, year, all أو custom" },
        year: { type: "number", description: "السنة عند التقرير السنوي أو الربعي أو شهر محدد" },
        quarter: { type: "number", description: "رقم الربع 1-4" },
        month: { type: "number", description: "رقم الشهر 1-12" },
        startDate: { type: "string", description: "بداية فترة مخصصة YYYY-MM-DD" },
        endDate: { type: "string", description: "نهاية فترة مخصصة YYYY-MM-DD" },
        category: { type: "string", description: "بند رئيسي أو فرعي مثل الأبناء، الزيارات، الطعام" },
        type: { type: "string", description: "expense أو income أو transfer" },
        necessity: { type: "string", description: "ضروري أو كمالي" },
        save: { type: "boolean", description: "احفظ التقرير في حافظة التقارير، الافتراضي true" }
      }
    }
  },
  {
    name: "get_financial_decision_context",
    description: "يجلب سياقاً مالياً موحداً لاتخاذ القرار: الأرصدة، متوسط الصرف اليومي، توقع 30 يوماً، الالتزامات والموازنات. استخدمه عند المناقشة المالية المهمة، وليس مع كل سؤال بسيط.",
    parameters: { type: "object", properties: {} }
  },
  {
    name: "assess_purchase",
    description: "يقيّم شراءً قبل تنفيذه مقابل الرصيد، معدل الصرف، الالتزامات والموازنة. لا يسجل أي عملية.",
    parameters: { type:"object", properties:{
      price:{type:"number",description:"السعر المقترح"}, item:{type:"string",description:"السلعة"}, model:{type:"string",description:"الموديل إن وجد"}, paymentMethod:{type:"string",description:"cash أو palPay أو debt"}, category:{type:"string",description:"البند الرئيسي"}, necessity:{type:"string",description:"ضروري أو كمالي"}
    }, required:["price"] }
  },
  {
    name: "search_local_market",
    description: "يبحث ويقارن الأسعار بترتيب صارم: غزة أولاً، فلسطين ثانياً، السوق العالمي ثالثاً. يدمج دفتر سوق غزة المحفوظ مع بحث Google Search grounding، ويرجع نطاقات غزة/فلسطين/العالمي وتحذيرات إذا السعر المعروض مرتفع أو أقل بشكل مريب. لا يخترع أسعاراً ولا يستخدم للمشتريات اليومية الصغيرة.",
    parameters: { type:"object", properties:{
      item:{type:"string",description:"اسم السلعة"},
      model:{type:"string",description:"الموديل/المواصفات الدقيقة (مثال: iPhone 15 Pro 256GB)"},
      condition:{type:"string",description:"حالة السلعة: 'new' (جديد) أو 'used' (مستعمل) أو 'unknown'"},
      offeredPrice:{type:"number",description:"السعر المعروض على المستخدم للمقارنة والاعتراض إذا كان مبالغاً"}
    }, required:["item"] }
  },
  {
    name: "get_market_directory",
    description: "يعرض أو يبحث في دفتر سوق غزة/فلسطين المحفوظ لدى المستخدم: محلات، عناوين، أسعار، أرقام، مصادر، وتاريخ آخر تحديث.",
    parameters: { type:"object", properties:{
      item:{type:"string",description:"اسم السلعة للبحث داخل دفتر السوق"},
      model:{type:"string",description:"موديل أو مواصفة اختيارية"}
    } }
  },
  {
    name: "save_market_offer",
    description: "يحفظ عرض سعر موثق في دفتر سوق غزة/فلسطين أو العالمي. استخدمه عندما يعطيك المستخدم اسم محل/سعر/عنوان أو عندما تريد بناء ذاكرة سوق محلية تدريجياً.",
    parameters: { type:"object", properties:{
      product:{type:"string",description:"اسم السلعة"},
      brand:{type:"string",description:"العلامة التجارية"},
      model:{type:"string",description:"الموديل"},
      variant:{type:"string",description:"المواصفة/السعة/اللون"},
      condition:{type:"string",description:"new أو used أو unknown"},
      seller:{type:"string",description:"اسم المحل أو البائع"},
      location:{type:"string",description:"المدينة/المنطقة مثل غزة، الرمال، خان يونس"},
      address:{type:"string",description:"العنوان التفصيلي إن وجد"},
      phone:{type:"string",description:"رقم الهاتف أو واتساب"},
      price:{type:"number",description:"السعر"},
      currency:{type:"string",description:"ILS أو USD أو JOD"},
      sourceUrl:{type:"string",description:"رابط المصدر إن وجد"},
      notes:{type:"string",description:"ملاحظات عن العرض أو الضمان أو التوفر"}
    }, required:["product","price"] }
  },
  {
    name: "add_transaction",
    description: "يسجل عملية مالية بدقة (مصروف أو دخل). ❌ممنوع استخدام هذه الأداة لسداد الديون❌ لسداد الديون استخدم أداة pay_debt حصراً.",
    parameters: {
      type: "object",
      properties: {
        amount: { type: "number", description: "المبلغ بالشيكل (مثال: 120)" },
        type: { type: "string", description: "نوع العملية: 'expense' (مصروف) أو 'income' (دخل)" },
        account: { type: "string", description: "اسم الحساب: 'cash', 'palPay', أو 'debt'" },
        category: { type: "string", description: "بند الصرف الرئيسي (مثال: 'الأبناء', 'زيارات وضيافة', 'طعام ومشتريات منزل', 'مواصلات', 'فواتير والتزامات', 'صحة وعلاج', 'تعليم')" },
        subcategory: { type: "string", description: "بند الصرف الفرعي (مثال تحت الأبناء: 'مصروف', 'ملابس', 'رسوم جامعة ومدرسة', 'دورة رسم', 'مستلزمات مدرسية', 'علاج' / وتحت زيارات: 'هدايا', 'مواصلات زيارة', 'ضيافة')" },
        purchaseItem: { type: "string", description: "ما الذي تم شراؤه تحديداً؟ مثال: ملابس، علاج، تموين، حذاء، مستلزمات مدرسة. مهم لبناء id القيد ومنع التكرار الصحيح." },
        beneficiary: { type: "string", description: "لمن/لأي غرض؟ مثال: الأولاد، الزوجة، البيت، العمل، علاج. مهم لتمييز قيدين بنفس المبلغ ونفس المتجر." },
        merchant: { type: "string", description: "اسم المتجر أو الجهة أو الشخص (مثال: 'مكتبة النور', 'سوبرماركت البركة', 'محل ملابس')" },
        notes: { type: "string", description: "البيان وتفصيل شو اشترى أو ملاحظات إضافية" },
        paymentMethod: { type: "string", description: "طريقة الدفع: 'cash' (نقدي/كاش), 'palPay' (محفظة), أو 'debt' (دين/آجل)." },
        date: { type: "string", description: "تاريخ العملية إذا كانت قديمة أو محددة. استخدم YYYY-MM-DD مثل 2026-06-15. إذا ذكر المستخدم التاريخ لكل بند فمرره هنا." },
        historicalMonth: { type: "string", description: "شهر إدخال تاريخي بصيغة YYYY-MM أو M/YYYY عند قول المستخدم: أسجل مصروفات شهر 6/2026. لا تستخدمه وحده بدون day." },
        day: { type: "number", description: "يوم العملية داخل historicalMonth. إذا لم يذكر اليوم في إدخال تاريخي، اسأل عنه ولا تخترع تاريخاً." },
        necessity: { type: "string", description: "اختياري. تصنيف الأهمية: 'ضروري' أو 'كمالي'. لا تطلبه من المستخدم إذا كان وصف الشراء واضحاً؛ اتركه فارغاً ليصنفه النظام وفق واقع غزة." },
        riskConfirmed: { type: "boolean", description: "true فقط إذا حذر النظام المستخدم من تجاوز/خطر مالي ووافق صراحة على المتابعة." },
        duplicateConfirmed: { type: "boolean", description: "true فقط إذا أخبر النظام المستخدم بوجود عملية سابقة قريبة وسأله هل هذه عملية جديدة مستقلة، ثم أكد المستخدم صراحة أنها جديدة. لا تستخدمها من نفسك." },
        confirmedNewTransaction: { type: "boolean", description: "مرادف duplicateConfirmed للتأكيد الصريح أن القيد الجديد مستقل عن القيد السابق." }
      },
      required: ["amount", "type", "category", "subcategory", "paymentMethod"]
    }
  },
  {
    name: "get_balance",
    description: "يجلب رصيد الحسابات الحالي (نقدي، PalPay، والإجمالي).",
    parameters: {
      type: "object",
      properties: {}
    }
  },
  {
    name: "transfer_money",
    description: "يحول مبلغاً بين الحسابات والمحافظ (مثلاً: من الكاش إلى بال باي PalPay أو العكس). التحويل الداخلي لا يعتبر دخلاً ولا مصروفاً بل ينقل الرصيد بدقة.",
    parameters: {
      type: "object",
      properties: {
        amount: { type: "number", description: "المبلغ المحول بالشيكل" },
        fromAccount: { type: "string", description: "الحساب المحول منه: 'cash' (نقدي) أو 'palPay' (بال باي) أو 'debt' (دين)" },
        toAccount: { type: "string", description: "الحساب المحول إليه: 'palPay' (بال باي) أو 'cash' (نقدي) أو 'debt' (دين)" },
        creditor: { type: "string", description: "اسم الدائن. مطلوب عند استدانة مال من debt إلى cash/PalPay حتى يبقى الدين مربوطاً بصاحبه." },
        notes: { type: "string", description: "ملاحظات إضافية عن التحويل" }
      },
      required: ["amount", "fromAccount", "toAccount"]
    }
  },
  {
    name: "get_recent_transactions",
    description: "يجلب أحدث العمليات المالية. مفيد لمعرفة الـ id لتعديل أو حذف عملية.",
    parameters: {
      type: "object",
      properties: {}
    }
  },
  {
    name: "audit_financial_duplicates",
    description: "يفحص قاعدة البيانات بحثاً عن عمليات مالية مكررة أو إشعارات نجاح غير مربوطة بعملية، ويعيد تقرير تدقيق يوضح هل المشكلة تكرار عرض إشعار فقط أم وجود قيود مالية مكررة فعلاً.",
    parameters: {
      type: "object",
      properties: {}
    }
  },
  {
    name: "update_transaction",
    description: "يعدل عملية مالية سابقة باستخدام الـ id الخاص بها.",
    parameters: {
      type: "object",
      properties: {
        id: { type: "string", description: "معرف العملية (id)" },
        amount: { type: "number", description: "المبلغ الجديد (اختياري)" },
        type: { type: "string", description: "النوع (اختياري)" },
        account: { type: "string", description: "الحساب (اختياري)" },
        category: { type: "string", description: "التصنيف الرئيسي (اختياري)" },
        subcategory: { type: "string", description: "التصنيف الفرعي (اختياري)" },
        merchant: { type: "string", description: "المتجر/الجهة (اختياري)" },
        notes: { type: "string", description: "التفاصيل (اختياري)" },
        necessity: { type: "string", description: "ضروري أو كمالي حسب ظروف المستخدم (اختياري)" },
        date: { type: "string", description: "تاريخ العملية ISO أو YYYY-MM-DD (اختياري)" }
      },
      required: ["id"]
    }
  },
  {
    name: "delete_transaction",
    description: "يحذف عملية مالية سابقة. يمكن استخدام id صريح، أو البحث بـ account/amount/category. عند تطابق عملية واحدة فقط، يجب تمرير confirmed=true بعد عرض العملية على المستخدم. لا تحذف أبداً بصمت.",
    parameters: {
      type: "object",
      properties: {
        id: { type: "string", description: "معرف العملية (id) إن كان متوفراً" },
        account: { type: "string", description: "الحساب: 'palPay' (بال باي), 'cash' (نقدي), أو 'debt' (دين)" },
        amount: { type: "number", description: "مبلغ العملية المراد حذفها" },
        category: { type: "string", description: "تصنيف العملية المراد حذفها" },
        confirmed: { type: "boolean", description: "true فقط بعد عرض المرشح الواحد على المستخدم وتأكيده." }
      }
    }
  },
  {
    name: "repair_duplicate_income",
    description: "يصلح تكرار الراتب/الدخل: يبحث عن قيود دخل مكررة بنفس المبلغ والحساب واليوم، ويحذف النسخ الزائدة ويبقي الأصلية. استخدمه عندما يقول المستخدم إن الراتب أو الدخل تسجل مرتين.",
    parameters: {
      type: "object",
      properties: {
        amount: { type: "number", description: "مبلغ الدخل المكرر مثل 3350" },
        date: { type: "string", description: "تاريخ يوم محدد YYYY-MM-DD اختياري" },
        month: { type: "string", description: "شهر محدد YYYY-MM اختياري" }
      }
    }
  },
  {
    name: "repair_duplicate_credit_purchase",
    description: "يصلح تكرار شراء بالدين: يحذف النسخ الزائدة من نفس قيد الشراء بالدين ويبقي نسخة واحدة. استخدمه عندما يقول المستخدم إن شراء دين بقيمة معينة تسجل مرتين وزاد الدين للضعف.",
    parameters: {
      type: "object",
      properties: {
        amount: { type: "number", description: "مبلغ الشراء بالدين المكرر مثل 50" },
        creditor: { type: "string", description: "اسم الدائن/المحل مثل فلان" },
        merchant: { type: "string", description: "اسم المحل إن ذكر" },
        date: { type: "string", description: "تاريخ يوم محدد YYYY-MM-DD اختياري" },
        month: { type: "string", description: "شهر محدد YYYY-MM اختياري" }
      }
    }
  },
  {
    name: "check_budget_status",
    description: "يفحص وضع الميزانية الحالي لمعرفة هل هناك تجاوز أو اقتراب من الحد المسموح، سواء لتصنيف معين أو للمجموع الكلي.",
    parameters: {
      type: "object",
      properties: {
        category: { type: "string", description: "التصنيف المراد فحص ميزانيته (اختياري)" }
      }
    }
  },
  {
    name: "query_transactions",
    description: "يجلب ويحلل العمليات المالية لإنشاء تقارير، والإجابة عن أسئلة مثل: كم صرفت اليوم؟ كم صرفت على الأولاد هذا الشهر؟ ما هي مصروفات الكماليات هذا الأسبوع؟",
    parameters: {
      type: "object",
      properties: {
        period: { type: "string", description: "الفترة الزمنية. القيم المسموحة: 'today', 'this_week', 'this_month', 'custom'" },
        startDate: { type: "string", description: "تاريخ البداية بصيغة YYYY-MM-DD (يستخدم فقط إذا كانت الفترة custom)" },
        endDate: { type: "string", description: "تاريخ النهاية بصيغة YYYY-MM-DD (يستخدم فقط إذا كانت الفترة custom)" },
        category: { type: "string", description: "التصنيف المراد البحث عنه مثل: أولاد، سيارة، كماليات (اختياري)" },
        type: { type: "string", description: "نوع العملية: 'expense' أو 'income' (الافتراضي عادة expense إن سأل عن الصرف)" },
        account: { type: "string", description: "الحساب: 'cash', 'palPay', 'debt' (لمعرفة الديون مثلاً)" },
        necessity: { type: "string", description: "الضرورة: 'ضروري' أو 'كمالي'" }
      }
    }
  },
  {
    name: "memory_save",
    description: "يحفظ معلومة طويلة الأمد (مثل راتب، قرار مالي، التزام) للرجوع إليها لاحقاً.",
    parameters: {
      type: "object",
      properties: {
        key: { type: "string", description: "اسم أو مفتاح المعلومة (مثال: salary_amount)" },
        value: { type: "string", description: "القيمة المراد حفظها" }
      },
      required: ["key", "value"]
    }
  },
  {
    name: "memory_search",
    description: "يبحث في الذاكرة طويلة الأمد لاسترجاع قرارات أو التزامات سابقة.",
    parameters: {
      type: "object",
      properties: {
        query: { type: "string", description: "الكلمة المفتاحية للبحث" }
      },
      required: ["query"]
    }
  },
  {
    name: "create_recurring_item",
    description: "ينشئ عملية مالية دورية أو راتب شهري لتذكير المستخدم به.",
    parameters: {
      type: "object",
      properties: {
        name: { type: "string", description: "اسم العملية الدورية (مثال: الراتب)" },
        amount: { type: "number", description: "المبلغ المتوقع" },
        type: { type: "string", description: "'expense' أو 'income'" },
        next_date: { type: "string", description: "تاريخ الاستحقاق القادم" }
      },
      required: ["name", "amount", "type"]
    }
  }
  // V6 (HF-1): search_market_information declaration REMOVED. The fake-price tool
  // is no longer registered with the AI. The handler remains as a defensive stub
  // (returns deprecation message) so any lingering prompt reference is harmless.
];

export async function syncOfflineData(args: any, userId: string, token: string) {
  // V6 (CF-2): NEVER trust client-supplied userId or document IDs.
  // - userId is force-overwritten with the authenticated UID.
  // - For each incoming document, we verify ownership of any existing doc with the same ID.
  //   If the doc exists and is owned by a different user, the sync item is rejected (403).
  // - Deleted-flagged items also require ownership check before deletion.
  const adminDb = getDb(token);
  let count = 0;
  const rejected: { id: string; reason: string }[] = [];

  if (args.transactions && args.transactions.length > 0) {
    // Financial transactions must NEVER be written by generic sync. They must go through
    // /api/command -> dispatchFinancialCommand -> toolHandlers -> runIdempotent -> validation.
    // Allowing doc.set() here is a financial backdoor and can create local+cloud duplicates.
    for (const tx of args.transactions) {
      rejected.push({ id: String(tx?.id || tx?.operationId || '(unknown)'), reason: 'transactions must sync through /api/command, not /api/sync' });
    }
  }

  if (args.reports && args.reports.length > 0) {
    for (const rep of args.reports) {
      const safeId = String(rep.id || '').trim();
      if (!safeId) { rejected.push({ id: '(empty)', reason: 'missing id' }); continue; }
      try {
        const existingSnap = await adminDb.collection('reports').doc(safeId).get();
        if (existingSnap.exists) {
          const existingData = existingSnap.data() as any;
          if (existingData?.userId && existingData.userId !== userId) {
            rejected.push({ id: safeId, reason: 'cross-user ownership violation' });
            continue;
          }
        }
      } catch (e: any) {
        rejected.push({ id: safeId, reason: `ownership check failed: ${e?.message || 'unknown'}` });
        continue;
      }
      const doc = adminDb.collection('reports').doc(safeId);
      if (rep.deleted) {
        await doc.delete();
      } else {
        const { _unsynced, userId: _dropUid, ...data } = rep;
        await doc.set({ ...data, userId });
      }
      count++;
    }
  }

  if (args.commitments && args.commitments.length > 0) {
    for (const com of args.commitments) {
      const safeId = String(com.id || '').trim();
      if (!safeId) { rejected.push({ id: '(empty)', reason: 'missing id' }); continue; }
      try {
        const existingSnap = await adminDb.collection('commitments').doc(safeId).get();
        if (existingSnap.exists) {
          const existingData = existingSnap.data() as any;
          if (existingData?.userId && existingData.userId !== userId) {
            rejected.push({ id: safeId, reason: 'cross-user ownership violation' });
            continue;
          }
        }
      } catch (e: any) {
        rejected.push({ id: safeId, reason: `ownership check failed: ${e?.message || 'unknown'}` });
        continue;
      }
      const doc = adminDb.collection('commitments').doc(safeId);
      if (com.deleted) {
        await doc.delete();
      } else {
        const { _unsynced, userId: _dropUid, ...data } = com;
        await doc.set({ ...data, userId });
      }
      count++;
    }
  }

  return { success: true, count, rejected };
}
