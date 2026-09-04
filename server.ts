import fs from 'fs';
import { createHash } from 'node:crypto';
import express from "express";
import path from "path";
import { createServer as createViteServer } from "vite";
import { WebSocketServer, WebSocket } from "ws";
import { GoogleGenAI, LiveServerMessage, Modality, FunctionCall } from "@google/genai";
import dotenv from "dotenv";
import { functionDeclarations, toolHandlers } from "./src/server/tools";
import { atomicAddTransactions } from "./src/server/atomicOps";
import { adminAuth, adminDb } from "./src/server/firebaseAdmin";
import {
  authMiddleware,
  verifyBearer,
  type WSAuthState,
} from "./src/server/auth";
import { dispatchFinancialCommand, isValidFinancialCommandType } from "./src/server/financialEngine";
import { createCustomVoiceClone, deleteCustomVoice, getCustomVoiceProfile } from "./src/server/customVoice";
import { normalizeAiExpenseItems, parseExpenseImportFile, type ExpenseImportPreview } from "./src/lib/expenseImport";
import { normalizeHistoricalTransactionDate } from "./src/lib/historicalDate";

dotenv.config();

function normalizeArabicForIntent(value: any): string {
  return String(value || '')
    .toLowerCase()
    .replace(/[أإآ]/g, 'ا')
    .replace(/ى/g, 'ي')
    .replace(/ة/g, 'ه')
    .replace(/[ـًٌٍَُِّْ]/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

function getExpenseImportModelFallbacks(): string[] {
  const configured = String(process.env.GEMINI_EXPENSE_IMPORT_MODELS || '')
    .split(',')
    .map(model => model.trim())
    .filter(Boolean);
  const defaults = [
    'gemini-3.7-flash',
    'gemini-3.6-flash',
    'gemini-3.5-flash',
    'gemini-2.5-flash',
    'gemini-2.5-flash-lite',
  ];
  return Array.from(new Set([...configured, ...defaults]));
}

function isGeminiRetryableModelError(error: any): boolean {
  const raw = `${error?.status || ''} ${error?.code || ''} ${error?.message || ''}`;
  return raw.includes('503')
    || raw.includes('UNAVAILABLE')
    || raw.includes('high demand')
    || raw.includes('429')
    || raw.includes('RESOURCE_EXHAUSTED')
    || raw.includes('Quota exceeded')
    || raw.includes('NOT_FOUND')
    || raw.includes('not found')
    || raw.includes('not supported')
    || raw.includes('INVALID_ARGUMENT')
    || raw.includes('not available');
}

function isGeminiTemporaryCapacityError(error: any): boolean {
  const raw = `${error?.status || ''} ${error?.code || ''} ${error?.message || ''}`;
  return raw.includes('503')
    || raw.includes('UNAVAILABLE')
    || raw.includes('high demand')
    || raw.includes('429')
    || raw.includes('RESOURCE_EXHAUSTED')
    || raw.includes('Quota exceeded');
}

function parseJsonObjectFromModelText(text: string): any {
  const raw = String(text || '').trim();
  if (!raw) throw new Error('GEMINI_EMPTY_RESPONSE');
  const fenced = raw.match(/```(?:json)?\s*([\s\S]*?)```/i)?.[1]?.trim();
  const candidate = fenced || raw;
  try {
    return JSON.parse(candidate);
  } catch {
    const start = candidate.indexOf('{');
    const end = candidate.lastIndexOf('}');
    if (start >= 0 && end > start) return JSON.parse(candidate.slice(start, end + 1));
    throw new Error('GEMINI_RETURNED_NON_JSON');
  }
}

async function generateExpenseImportJsonWithFallback(ai: GoogleGenAI, input: {
  payloadBase64: string;
  mimeType: string;
  prompt: string;
}): Promise<{ text: string; model: string; fallbackUsed: boolean }> {
  const models = getExpenseImportModelFallbacks();
  const errors: string[] = [];
  for (let index = 0; index < models.length; index++) {
    const model = models[index];
    try {
      const response = await ai.models.generateContent({
        model,
        contents: [
          {
            role: 'user',
            parts: [
              { inlineData: { data: input.payloadBase64, mimeType: input.mimeType } },
              { text: input.prompt }
            ]
          }
        ],
        config: {
          responseMimeType: "application/json"
        }
      });
      const text = response.text;
      if (!text) throw new Error('No response text');
      return { text, model, fallbackUsed: index > 0 };
    } catch (error: any) {
      errors.push(`${model}: ${error?.message || error}`);
      const retryable = isGeminiRetryableModelError(error);
      if (!retryable || index === models.length - 1) {
        const temporary = errors.some(msg => isGeminiTemporaryCapacityError({ message: msg })) || isGeminiTemporaryCapacityError(error);
        const wrapped = new Error(temporary
          ? 'GEMINI_TEMPORARILY_UNAVAILABLE'
          : (error?.message || 'Gemini expense import failed')) as any;
        wrapped.reason = temporary ? 'GEMINI_TEMPORARILY_UNAVAILABLE' : 'GEMINI_EXPENSE_IMPORT_FAILED';
        wrapped.statusCode = temporary ? 503 : 500;
        wrapped.modelErrors = errors;
        throw wrapped;
      }
      console.warn('[expense-import] model failed, trying fallback', { model, error: error?.code || error?.message || error });
    }
  }
  throw new Error('GEMINI_EXPENSE_IMPORT_FAILED');
}

function normalizeVisibleImportDate(value: unknown): string | undefined {
  const result = normalizeHistoricalTransactionDate({ date: value, now: new Date() });
  return result.ok ? result.date : undefined;
}

function applyExpenseImportDateMap(preview: Extract<ExpenseImportPreview, { ok: true }>, parsed: any): Extract<ExpenseImportPreview, { ok: true }> {
  const patches = Array.isArray(parsed?.dateMap) ? parsed.dateMap : [];
  if (patches.length === 0) return preview;
  const nextItems = preview.items.map(item => ({ ...item }));
  const repairedIndexes: number[] = [];
  for (const patch of patches) {
    const oneBasedRow = Number(patch?.rowNumber ?? patch?.index ?? patch?.row);
    const index = Number.isInteger(oneBasedRow) && oneBasedRow > 0 ? oneBasedRow - 1 : -1;
    if (index < 0 || index >= nextItems.length || nextItems[index].date) continue;
    const normalizedDate = normalizeVisibleImportDate(patch?.date);
    if (!normalizedDate) continue;
    nextItems[index] = {
      ...nextItems[index],
      date: normalizedDate,
      dateSource: String(patch?.dateSource || 'visible-date-map'),
      confidence: Math.max(Number(nextItems[index].confidence) || 0.7, 0.9),
    };
    repairedIndexes.push(index + 1);
  }
  if (repairedIndexes.length === 0) return { ...preview, items: nextItems };
  const remainingWarnings = preview.warnings.filter((warning: string) => !repairedIndexes.some(index => warning.startsWith(`السطر ${index}:`)));
  return {
    ...preview,
    items: nextItems,
    warnings: [...remainingWarnings, `تم استخراج التاريخ من عمود/صف مرئي للبنود: ${repairedIndexes.join(', ')}.`],
  };
}

async function repairMissingExpenseImportDates(ai: GoogleGenAI, input: {
  payloadBase64: string;
  mimeType: string;
  preview: Extract<ExpenseImportPreview, { ok: true }>;
}): Promise<Extract<ExpenseImportPreview, { ok: true }>> {
  const missing = input.preview.items
    .map((item, index) => ({ index, item }))
    .filter(({ item }) => !item.date);
  if (missing.length === 0) return input.preview;

  const prompt = `أعد فحص الصورة/الملف لاستخراج تواريخ البنود الناقصة فقط.
المشكلة السابقة: بعض التواريخ تكون في عمود مستقل في جدول عربي من اليمين لليسار، أو في خلية/مجموعة بجانب عدة صفوف، وليست داخل نص البند نفسه.
اربط التاريخ المرئي بالصف حسب موضعه البصري، رقم السطر، وصف البند، والمبلغ.
لا تستخدم تاريخ اليوم أو تاريخ رفع الصورة. لا تخمن. إذا لم ترَ التاريخ بوضوح لهذا البند فاتركه فارغاً.
البنود الناقصة المراد إصلاحها:
${JSON.stringify(missing.map(({ index, item }) => ({ index, name: item.notes, amount: item.amount, category: item.category, subcategory: item.subcategory })), null, 2)}
أرجع JSON فقط بهذا الشكل:
{
  "datePatches": [
    { "index": 0, "date": "YYYY-MM-DD", "dateSource": "visible-date-column", "confidence": 0.0 }
  ]
}
ضع date فارغاً إذا لم يكن التاريخ ظاهراً بوضوح.`;

  const generated = await generateExpenseImportJsonWithFallback(ai, {
    payloadBase64: input.payloadBase64,
    mimeType: input.mimeType,
    prompt,
  });
  const parsed = parseJsonObjectFromModelText(generated.text);
  const patches = Array.isArray(parsed?.datePatches) ? parsed.datePatches : [];
  if (patches.length === 0) return input.preview;

  const nextItems = input.preview.items.map(item => ({ ...item }));
  for (const patch of patches) {
    const index = Number(patch?.index);
    if (!Number.isInteger(index) || index < 0 || index >= nextItems.length) continue;
    if (nextItems[index].date) continue;
    const normalizedDate = normalizeVisibleImportDate(patch?.date);
    if (!normalizedDate) continue;
    const confidence = Number(patch?.confidence);
    if (Number.isFinite(confidence) && confidence < 0.55) continue;
    nextItems[index] = {
      ...nextItems[index],
      date: normalizedDate,
      dateSource: String(patch?.dateSource || 'ai-visible-date-repair'),
      confidence: Math.max(Number(nextItems[index].confidence) || 0.7, Number.isFinite(confidence) ? confidence : 0.85),
    };
  }
  const repairedIndexes = nextItems.reduce<number[]>((indexes, item, index) => {
    if (item.date && !input.preview.items[index].date) indexes.push(index + 1);
    return indexes;
  }, []);
  const remainingWarnings = input.preview.warnings.filter((warning: string) => !repairedIndexes.some(index => warning.startsWith(`السطر ${index}:`)));
  return {
    ...input.preview,
    items: nextItems,
    warnings: repairedIndexes.length > 0
      ? [...remainingWarnings, `تمت إعادة قراءة التاريخ من الصورة للبنود: ${repairedIndexes.join(', ')}.`]
      : input.preview.warnings,
  };
}

function isTrustedImportedDateSource(source: unknown): boolean {
  const normalized = normalizeArabicForIntent(source);
  return normalized === 'user-confirmed-date'
    || normalized.includes('visible')
    || normalized.includes('مرئي')
    || normalized.includes('عمود')
    || normalized.includes('صف')
    || normalized.includes('مجموعة')
    || normalized.includes('ai-visible-date-repair');
}

function stableShortFingerprint(value: unknown): string {
  return createHash('sha256').update(JSON.stringify(value) ?? 'null').digest('hex').slice(0, 24);
}

function classifyDebtIntent(message: string): 'credit_purchase' | 'cash_borrowing' | 'unknown' {
  const text = normalizeArabicForIntent(message);
  // Do not use \b with Arabic; JS word boundaries are unreliable for Arabic text.
  const hasDebt = ['دين', 'بالدين', 'دينا', 'سلف', 'سلفه', 'سلفة', 'استدن', 'اقترض'].some(w => text.includes(normalizeArabicForIntent(w)));
  if (!hasDebt) return 'unknown';
  const purchaseWords = ['اشتريت', 'شريت', 'اشتري', 'شراء', 'بعتني', 'فاتوره', 'فاتورة', 'من محل', 'من عند', 'اخذت من محل', 'اخدت من محل'];
  const borrowWords = ['اخدت دين نقدي', 'اخذت دين نقدي', 'دين نقدي', 'استدنت', 'اقترضت', 'اخدت سلفه', 'اخذت سلفه', 'سلفني', 'سلفت من'];
  if (borrowWords.some(w => text.includes(normalizeArabicForIntent(w)))) return 'cash_borrowing';
  if (purchaseWords.some(w => text.includes(normalizeArabicForIntent(w)))) return 'credit_purchase';
  return 'unknown';
}

function normalizeToolAccount(value: any): string {
  const v = normalizeArabicForIntent(value);
  if (v.includes('pal') || v.includes('بال باي') || v.includes('محفظ')) return 'palPay';
  if (v.includes('دين') || v === 'debt') return 'debt';
  if (v.includes('كاش') || v.includes('نقد') || v === 'cash') return 'cash';
  return String(value || '').trim();
}

function isDebtPurchaseToolCall(call: FunctionCall): boolean {
  const args: any = call.args || {};
  return call.name === 'add_transaction'
    && String(args.type || '').toLowerCase() === 'expense'
    && normalizeToolAccount(args.paymentMethod || args.account) === 'debt';
}

function isCashBorrowingToolCall(call: FunctionCall): boolean {
  const args: any = call.args || {};
  return call.name === 'transfer_money'
    && normalizeToolAccount(args.fromAccount || args.account) === 'debt'
    && (normalizeToolAccount(args.toAccount) === 'cash' || normalizeToolAccount(args.toAccount) === 'palPay');
}

function ledgerEntryFingerprint(args: any): string {
  const raw = [
    args.item,
    args.purchaseItem,
    args.what,
    args.description,
    args.notes,
    args.beneficiary,
    args.forWhom,
    args.forWho,
    args.person,
    args.category,
    args.subcategory,
  ].filter(v => v !== undefined && v !== null).join(' ');

  const normalized = normalizeArabicForIntent(raw)
    .replace(/\b(add|expense|income|transaction)\b/g, ' ')
    .replace(/مصروف|شراء|اشتريت|شريت|سجل|سجلي|دين|بالدين|شيكل|ش|₪/g, ' ')
    .replace(/\d+(\.\d+)?/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();

  return normalized || 'unspecified-ledger-purpose';
}

function financialOperationCoreKey(call: FunctionCall): string {
  const args: any = call.args || {};
  const amount = Math.round((Number(args.amount) || 0) * 100) / 100;
  if (call.name === 'add_transaction') {
    return [
      call.name,
      String(args.type || '').toLowerCase(),
      normalizeToolAccount(args.paymentMethod || args.account),
      amount,
      normalizeArabicForIntent(args.merchant || args.creditor || '') || 'none',
      ledgerEntryFingerprint(args),
    ].join('|');
  }
  if (call.name === 'transfer_money') {
    return [
      call.name,
      normalizeToolAccount(args.fromAccount || args.account),
      normalizeToolAccount(args.toAccount),
      amount,
      normalizeArabicForIntent(args.creditor || args.lender || args.person || args.merchant || '') || 'none',
      ledgerEntryFingerprint(args),
    ].join('|');
  }
  if (call.name === 'pay_debt') {
    return [
      call.name,
      normalizeToolAccount(args.paymentMethod || args.fromAccount),
      amount,
      normalizeArabicForIntent(args.creditor || args.person || args.merchant || '') || 'none',
      ledgerEntryFingerprint(args),
    ].join('|');
  }
  return `${call.name}|${JSON.stringify(args)}`;
}

function semanticToolKey(call: FunctionCall): string {
  return financialOperationCoreKey(call);
}

function sameToolAmount(a: FunctionCall, b: FunctionCall): boolean {
  const aa = Math.round((Number((a.args as any)?.amount) || 0) * 100) / 100;
  const bb = Math.round((Number((b.args as any)?.amount) || 0) * 100) / 100;
  return aa > 0 && Math.abs(aa - bb) < 0.01;
}

function isFinancialToolName(name: string): boolean {
  return ['add_transaction', 'transfer_money', 'pay_debt', 'send_palpay_payment', 'delete_transaction', 'update_transaction', 'repair_duplicate_income', 'repair_duplicate_credit_purchase'].includes(name);
}

function looksLikeFinancialIntent(text: string): boolean {
  const t = normalizeArabicForIntent(text);
  return /(سجل|سجلي|ضيف|ضيفي|اضف|أضف|دخل|راتب|مصروف|اشتريت|شريت|دفعت|دفع|دين|سلف|سلفة|سلفه|حول|حوّل|سدد|سداد)/.test(t);
}

function looksLikeCommittedClaim(text: string): boolean {
  const t = normalizeArabicForIntent(text);
  return /(تم|سجلت|سجلتها|ضفت|اضفت|حفظت|انضاف|تمت الاضافه|تمت الإضافة|صار عندك|تم تسجيل|تم حفظ|تم اضافه|تم إضافة)/.test(t)
    && /(سجل|اضاف|إضاف|حفظ|دخل|راتب|مصروف|دين|رصيد|محفظ|كاش)/.test(t);
}

function buildDeterministicFinancialReply(functionResponses: Array<{ name: string; response: any }>): string | null {
  const financial = functionResponses.filter(r => isFinancialToolName(r.name));
  if (financial.length === 0) return null;
  const thrownError = financial.find(r => r.response?.error && r.response?.success !== true);
  if (thrownError) {
    return `لم أسجل العملية فعلياً بسبب خطأ داخلي: ${thrownError.response.error}`;
  }
  const hardError = financial.find(r => r.response?.success === false && !r.response?.needsClarification && !r.response?.needsConfirmation && !r.response?.retryable && !r.response?.inFlight);
  if (hardError) {
    return hardError.response?.message || hardError.response?.error || 'تعذر تنفيذ العملية المالية ولم أسجلها.';
  }
  const clarification = financial.find(r => r.response?.needsClarification || r.response?.needsConfirmation);
  if (clarification) {
    return clarification.response?.message || 'أحتاج توضيحاً قبل تسجيل العملية.';
  }
  const retryable = financial.find(r => r.response?.retryable || r.response?.inFlight);
  if (retryable) {
    return retryable.response?.message || 'العملية لم تُسجّل الآن لأن حالة الحفظ غير مؤكدة، أعد المحاولة لاحقاً.';
  }
  const committed = financial.filter(r => r.response?.success === true && (r.response?.cloudStorageConfirmed === true || r.response?.durability === 'committed' || r.response?.transactionId || r.response?.updated || r.response?.deletedCount !== undefined));
  if (committed.length > 0) {
    const first = committed[0].response || {};
    const amountText = first.amount ? ` بقيمة ${first.amount} ₪` : '';
    const txText = first.transactionId ? `\nرقم القيد: ${first.transactionId}` : '';
    const warn = first.balanceWarning ? `\nتنبيه: ${first.balanceWarning}` : '';
    return first.message || `تم تنفيذ العملية المالية${amountText} وحفظها في السحابة.${txText}${warn}`;
  }
  const skippedOnly = financial.every(r => r.response?.skipped === true || r.response?.deduped === true);
  if (skippedOnly) return 'لم أكرر التسجيل؛ هذه العملية عولجت قبل لحظات بنفس معرّف القيد.';
  return null;
}

function liveFinancialCommitKey(call: FunctionCall, userId: string | null | undefined): string | null {
  if (!userId) return null;
  const args: any = call.args || {};
  const amount = Math.round((Number(args.amount) || 0) * 100) / 100;
  if (!amount) return null;
  // Keep a short recent-operation key for add_transaction too. A second matching
  // entry must be confirmed as a genuinely new transaction before it is written;
  // operationId/idempotency still protects retries of the same execution.
  if (['add_transaction', 'transfer_money', 'pay_debt'].includes(call.name)) {
    return `${userId}|${financialOperationCoreKey(call)}`;
  }
  return null;
}

const recentLiveFinancialCommits = new Map<string, { timestamp: number; result: any }>();
const LIVE_FINANCIAL_DEDUPE_MS = 15_000;

function getRecentLiveFinancialCommit(key: string | null): any | null {
  if (!key) return null;
  const hit = recentLiveFinancialCommits.get(key);
  if (!hit) return null;
  if (Date.now() - hit.timestamp > LIVE_FINANCIAL_DEDUPE_MS) {
    recentLiveFinancialCommits.delete(key);
    return null;
  }
  return hit.result;
}

function rememberLiveFinancialCommit(key: string | null, result: any) {
  if (!key) return;
  if (result?.success === true && !result?.needsClarification && !result?.needsConfirmation && !result?.skipped) {
    recentLiveFinancialCommits.set(key, { timestamp: Date.now(), result });
  }
}

function buildStableOperationIdForToolCall(call: FunctionCall, clientMessageId: string): string | null {
  if (!clientMessageId) return null;
  const args: any = call.args || {};
  const amount = Math.round((Number(args.amount) || 0) * 100) / 100;
  if (!amount && ['add_transaction', 'transfer_money', 'pay_debt', 'send_palpay_payment'].includes(call.name)) return null;
  if (['add_transaction', 'transfer_money', 'pay_debt'].includes(call.name)) {
    return `chat:${clientMessageId}:${financialOperationCoreKey(call)}`;
  }
  if (call.name === 'send_palpay_payment') {
    return `chat:${clientMessageId}:send_palpay_payment:${amount}:${normalizeArabicForIntent(args.phoneNumber || args.recipientName || '') || 'none'}:${ledgerEntryFingerprint(args)}`;
  }
  return null;
}

function normalizeArabicDigits(value: string): string {
  return String(value || '')
    .replace(/[٠-٩]/g, d => String('٠١٢٣٤٥٦٧٨٩'.indexOf(d)))
    .replace(/[۰-۹]/g, d => String('۰۱۲۳۴۵۶۷۸۹'.indexOf(d)));
}

function extractAmountFromFinancialText(text: string): number | null {
  const normalized = normalizeArabicDigits(normalizeArabicForIntent(text));
  const matches = Array.from(normalized.matchAll(/(?:^|\s)(\d+(?:[\.,]\d+)?)(?=\s*(?:ش|شيكل|₪|دولار|دينار|ils|nis|$|\s))/g));
  if (matches.length === 0) return null;
  const amount = Number(String(matches[matches.length - 1][1]).replace(',', '.'));
  return Number.isFinite(amount) && amount > 0 ? amount : null;
}

function accountFromFinancialText(text: string): 'cash' | 'palPay' | 'debt' | null {
  const t = normalizeArabicForIntent(text);
  if (/palpay|pal pay|بال باي|بالباي|محفظ|المحفظ/.test(t)) return 'palPay';
  if (/كاش|نقد|نقدي/.test(t)) return 'cash';
  if (/دين|بالدين/.test(t)) return 'debt';
  return null;
}

function inferFallbackExpenseCategory(text: string): { category: string; subcategory: string; purchaseItem: string; beneficiary: string } {
  const t = normalizeArabicForIntent(text);
  const beneficiary =
    /اولاد|الأولاد|الاولاد|عيال|ابناء|أبناء|اطفال|أطفال/.test(t) ? 'الأبناء' :
    /زوجتي|للزوجه|للزوجة|الزوجه|الزوجة/.test(t) ? 'الزوجة' :
    /بيت|البيت|دار|الدار|منزل|المنزل/.test(t) ? 'البيت' :
    /علاج|دواء|دكتور|طبيب|صيدل/.test(t) ? 'العلاج' :
    /عمل|شغل/.test(t) ? 'العمل' :
    /ضيف|ضياف|زيار/.test(t) ? 'الضيافة' : '';
  if (/خبز|طحين|دقيق|رز|سكر|زيت|تموين|خضار|بقال|غاز|ماء|مياه/.test(t)) return { category: 'طعام ومشتريات منزل', subcategory: 'تموين', purchaseItem: 'تموين/طعام', beneficiary: beneficiary || 'البيت' };
  if (/دواء|صيدل|علاج|دكتور|طبيب|تحاليل/.test(t)) return { category: 'صحة وعلاج', subcategory: 'علاج', purchaseItem: 'علاج/دواء', beneficiary: beneficiary || 'العلاج' };
  if (/ملابس|لبس|اواعي|أواعي|حذاء|كندره|كندرة|جزمه|جزمة/.test(t)) return { category: beneficiary === 'الأبناء' ? 'الأبناء' : 'ملابس', subcategory: 'ملابس', purchaseItem: 'ملابس/أحذية', beneficiary };
  if (/مواصلات|تاكسي|اجره|أجرة|بنزين|سولار/.test(t)) return { category: 'مواصلات', subcategory: 'مواصلات', purchaseItem: 'مواصلات', beneficiary: beneficiary || 'تنقل' };
  return { category: 'أخرى', subcategory: 'متفرقات', purchaseItem: '', beneficiary };
}

function extractMerchantFromFinancialText(text: string): string {
  const raw = String(text || '').trim();
  const m = raw.match(/(?:من\s+(?:عند\s+)?|عند\s+)([^\d،,.]+?)(?=\s+(?:ب|بـ|بمبلغ|بقيمة|ل|لل|لاجل|عشان|دين|كاش|بال|على)|$)/i);
  return m?.[1]?.trim() || '';
}

function buildFallbackFinancialToolCall(userText: string, clientMessageId: string): FunctionCall | null {
  const text = normalizeArabicForIntent(userText);
  const amount = extractAmountFromFinancialText(userText);
  if (!amount) return null;
  const account = accountFromFinancialText(userText);
  const isPurchase = /(اشتريت|شريت|شراء|دفعت|دفع|مصروف)/.test(text);
  const isIncome = /(دخل|راتب|مساعده|مساعدة|منحه|منحة|هديه|هدية|الغذاء العالمي|الغذا العالمي|استلمت|وصلني)/.test(text) && !isPurchase;
  const isBorrowing = /(دين نقدي|سلفه|سلفة|استدنت|اقترضت|سلفني)/.test(text);

  if (isBorrowing) {
    const creditor = extractMerchantFromFinancialText(userText) || 'غير محدد';
    return { name: 'transfer_money', args: { amount, fromAccount: 'debt', toAccount: 'cash', creditor, notes: userText } } as any;
  }

  if (isIncome) {
    if (!account || account === 'debt') return null;
    const isSalary = /راتب/.test(text);
    return { name: 'add_transaction', args: {
      amount,
      type: 'income',
      paymentMethod: account,
      account,
      category: 'دخل',
      subcategory: isSalary ? 'راتب' : 'دخل عام',
      notes: userText,
      incomeDestinationConfirmed: true,
      destinationConfirmed: true,
    }} as any;
  }

  if (isPurchase) {
    if (!account) return null;
    const merchant = extractMerchantFromFinancialText(userText);
    const inferred = inferFallbackExpenseCategory(userText);
    return { name: 'add_transaction', args: {
      amount,
      type: 'expense',
      paymentMethod: account,
      account,
      category: inferred.category,
      subcategory: inferred.subcategory,
      purchaseItem: inferred.purchaseItem,
      beneficiary: inferred.beneficiary,
      merchant,
      notes: userText,
    }} as any;
  }

  return null;
}

function shouldSkipFinancialToolCallForIntent(call: FunctionCall, userMessage: string, seenKeys: Set<string>, batchCalls: FunctionCall[] = []): { skip: boolean; reason?: string } {
  const key = semanticToolKey(call);
  if (seenKeys.has(key)) return { skip: true, reason: 'DUPLICATE_TOOL_CALL_IN_SAME_TURN' };
  seenKeys.add(key);
  const intent = classifyDebtIntent(userMessage);
  const sameBatchDebtPurchase = batchCalls.some(c => c !== call && isDebtPurchaseToolCall(c) && sameToolAmount(c, call));
  const sameBatchCashBorrowing = batchCalls.some(c => c !== call && isCashBorrowingToolCall(c) && sameToolAmount(c, call));
  if (intent === 'credit_purchase' && isCashBorrowingToolCall(call)) {
    return { skip: true, reason: 'CREDIT_PURCHASE_MUST_NOT_CREATE_CASH_BORROWING' };
  }
  if (intent !== 'cash_borrowing' && isCashBorrowingToolCall(call) && sameBatchDebtPurchase) {
    return { skip: true, reason: 'DEBT_PURCHASE_AND_CASH_BORROWING_SAME_AMOUNT_IN_SAME_BATCH' };
  }
  if (isDebtPurchaseToolCall(call)) {
    const sameDebtPurchaseBatchKey = `__ONE_DEBT_PURCHASE_ADD_TRANSACTION_IN_BATCH__|${financialOperationCoreKey(call)}`;
    if (seenKeys.has(sameDebtPurchaseBatchKey)) {
      return { skip: true, reason: 'DUPLICATE_SAME_LEDGER_ENTRY_IN_SAME_BATCH' };
    }
    seenKeys.add(sameDebtPurchaseBatchKey);
  }
  if (intent === 'credit_purchase' && isDebtPurchaseToolCall(call)) {
    // One ledger entry fingerprint = one write. Different beneficiaries/purposes in the same conversation
    // get different fingerprints and must be allowed as separate entries.
    const debtPurchaseTurnKey = `__CREDIT_PURCHASE_ENTRY__|${financialOperationCoreKey(call)}`;
    if (seenKeys.has(debtPurchaseTurnKey)) return { skip: true, reason: 'DUPLICATE_SAME_CREDIT_PURCHASE_ENTRY' };
    seenKeys.add(debtPurchaseTurnKey);
  }
  if (intent === 'cash_borrowing' && isDebtPurchaseToolCall(call)) {
    return { skip: true, reason: 'CASH_BORROWING_MUST_NOT_CREATE_DEBT_PURCHASE' };
  }
  if (intent === 'unknown' && isDebtPurchaseToolCall(call) && sameBatchCashBorrowing) {
    // Ambiguous live/tool batch: if both actions are emitted for the same amount, prefer the explicit purchase record
    // and drop the borrowing record to avoid turning one 50 ₪ credit purchase into 100 ₪ debt. The guard is per
    // ledger-entry fingerprint, so two different purposes/beneficiaries remain valid separate entries.
    const debtPurchaseTurnKey = `__AMBIGUOUS_DEBT_PURCHASE_ENTRY__|${financialOperationCoreKey(call)}`;
    if (seenKeys.has(debtPurchaseTurnKey)) return { skip: true, reason: 'DUPLICATE_AMBIGUOUS_DEBT_PURCHASE_ENTRY' };
    seenKeys.add(debtPurchaseTurnKey);
  }
  return { skip: false };
}

async function startServer() {
  const app = express();
  app.set("trust proxy", 1);

  const PORT = Number(process.env.PORT || 3000);

  // HTTP server — Render injects PORT and requires binding on 0.0.0.0.
  const server = app.listen(PORT, "0.0.0.0", () => {
    console.log(`Server running on port ${PORT}`);
  });

  const shutdown = (signal: string) => {
    console.log(`${signal} received, closing HTTP/WebSocket server...`);
    server.close(() => {
      console.log("Server closed cleanly.");
      process.exit(0);
    });
    setTimeout(() => process.exit(1), 25_000).unref();
  };
  process.once("SIGTERM", () => shutdown("SIGTERM"));
  process.once("SIGINT", () => shutdown("SIGINT"));

  // WebSocket Server for Live API
  const wss = new WebSocketServer({ server, path: '/live' });

  // Add Gemini Live setup here
  setupLiveApi(wss);

  app.use(express.json({ limit: '10mb' }));

  // API routes FIRST
  app.get("/api/health", (req, res) => {
    res.json({
      status: "ok",
      service: 'masroufi-ai',
      commit: process.env.RENDER_GIT_COMMIT || process.env.COMMIT_SHA || null,
      environment: process.env.NODE_ENV || null,
    });
  });

  let cachedCloudHealth: any = null;
  app.get("/api/cloud-health", async (req, res) => {
    const nowMs = Date.now();
    if (cachedCloudHealth && nowMs - cachedCloudHealth.cachedAtMs < 60_000) {
      return res.json({ ...cachedCloudHealth.body, cached: true });
    }
    try {
      const { adminDb, firebaseAdminDiagnostics } = await import('./src/server/firebaseAdmin');
      const ref = adminDb.collection('__health').doc('firestore');
      const checkedAt = new Date().toISOString();
      await ref.set({ checkedAt, service: 'masroufi-ai' }, { merge: true });
      const snap = await ref.get();
      const body = {
        status: snap.exists ? 'ok' : 'degraded',
        firestore: snap.exists ? 'read-write-ok' : 'write-not-visible',
        checkedAt,
        service: 'masroufi-ai',
        commit: process.env.RENDER_GIT_COMMIT || process.env.COMMIT_SHA || null,
        environment: process.env.NODE_ENV || null,
        diagnostics: firebaseAdminDiagnostics,
      };
      if (body.firestore === 'read-write-ok') cachedCloudHealth = { cachedAtMs: nowMs, body };
      res.json(body);
    } catch (e: any) {
      if (cachedCloudHealth && nowMs - cachedCloudHealth.cachedAtMs < 5 * 60_000) {
        return res.json({ ...cachedCloudHealth.body, cached: true, staleDueTo: e?.code || e?.message || 'cloud-health probe failed' });
      }
      res.status(503).json({
        status: 'degraded',
        firestore: 'read-write-failed',
        error: e?.message || 'Firestore unavailable',
        code: e?.code || null,
        details: e?.details || null,
      });
    }
  });

  // Legacy Safari email-only token minting is permanently disabled.
  // Identity proof must happen through Firebase Auth providers (Google redirect on Safari/mobile),
  // never by accepting an email claim and minting a trusted token for it.
  app.post("/api/auth/safari-token", async (_req: any, res: any) => {
    res.status(410).json({
      error: 'EMAIL_ONLY_DIRECT_LOGIN_DISABLED',
      message: 'استخدم تسجيل الدخول الآمن بواسطة Google.'
    });
  });

  app.get("/api/custom-voice", authMiddleware, async (req: any, res: any) => {
    try {
      const profile = await getCustomVoiceProfile(req.user.uid);
      res.json({ configured: profile.configured, provider: profile.provider, createdAt: profile.createdAt, updatedAt: profile.updatedAt });
    } catch (error: any) {
      console.warn('[custom-voice] status unavailable; falling back to built-in voices', error?.code || error?.message || error);
      res.json({ configured: false, unavailable: true, fallbackVoice: 'Zephyr' });
    }
  });

  app.post("/api/custom-voice", authMiddleware, async (req: any, res: any) => {
    try {
      const { audioBase64, mimeType, consent } = req.body || {};
      if (consent !== true) return res.status(400).json({ error: 'VOICE_CONSENT_REQUIRED' });
      if (typeof audioBase64 !== 'string' || !audioBase64) return res.status(400).json({ error: 'MISSING_AUDIO_SAMPLE' });
      const profile = await createCustomVoiceClone({ userId: req.user.uid, audioBase64, mimeType, consent: true });
      res.status(201).json({ configured: profile.configured, provider: profile.provider, createdAt: profile.createdAt, updatedAt: profile.updatedAt });
    } catch (error: any) {
      console.error('[custom-voice] creation failed', error);
      const message = String(error?.message || 'CUSTOM_VOICE_CREATE_FAILED');
      const clientError = /VOICE_CONSENT_REQUIRED|Missing audio|too short|exceeds 9 MB/.test(message);
      res.status(clientError ? 400 : 502).json({ error: message });
    }
  });

  app.delete("/api/custom-voice", authMiddleware, async (req: any, res: any) => {
    try {
      await deleteCustomVoice(req.user.uid);
      res.json({ success: true, configured: false });
    } catch (error: any) {
      console.error('[custom-voice] deletion failed', error);
      res.status(502).json({ error: String(error?.message || 'CUSTOM_VOICE_DELETE_FAILED') });
    }
  });

  app.post("/api/scan-receipt", authMiddleware, async (req: any, res: any) => {
    const {
      imageBase64,
      fileBase64,
      text,
      mimeType,
      fileName,
      defaultMonth,
      apiKey: customApiKey,
    } = req.body || {};
    const payloadBase64 = fileBase64 || imageBase64;
    if (!payloadBase64 && !text) {
      return res.status(400).json({ error: "Missing file data" });
    }
    if (payloadBase64 && !mimeType) {
      return res.status(400).json({ error: "Missing mime type" });
    }

    try {
      const localPreview = parseExpenseImportFile({
        base64: payloadBase64,
        text,
        mimeType,
        fileName,
        defaultMonth,
      });
      if (localPreview.ok) {
        return res.json({
          success: true,
          requiresConfirmation: true,
          reason: 'EXPENSE_IMPORT_PAYMENT_METHOD_REQUIRED',
          message: 'حللت الملف ولم أسجل أي شيء بعد. راجع البنود ثم اختر طريقة الدفع للحفظ.',
          merchant: localPreview.merchant,
          totalAmount: localPreview.totalAmount,
          itemsCount: localPreview.items.length,
          items: localPreview.items,
          warnings: localPreview.warnings,
          sourceType: localPreview.sourceType,
          nextStep: 'اعتمد البنود بعد المراجعة ليتم حفظها عبر مسار الفاتورة الذري.'
        });
      }

      const apiKey = customApiKey || process.env.GEMINI_API_KEY;
      if (!apiKey) throw new Error("No API key");

      const ai = new GoogleGenAI({ apiKey });
      const prompt = `Analyze this uploaded expense source. It may be a receipt image, invoice image, PDF, screenshot from another finance app, or a table of historical expenses.
Extract expense rows only. Do not register anything. Return ONLY a valid JSON object matching this schema without markdown code blocks:
{
  "merchant": "Source/store/app name if known",
  "totalAmount": 120,
  "date": "YYYY-MM-DD if all rows share one date, otherwise empty",
  "dateMap": [
    { "rowNumber": 1, "date": "YYYY-MM-DD", "dateSource": "visible-date-column | visible-date-group | visible-row-date", "confidence": 0.0 }
  ],
  "items": [
    {
      "name": "Expense item / description in Arabic",
      "amount": 30.5,
      "date": "YYYY-MM-DD if visibly printed in this row, in the date column beside this row, or in a visible date group/header that clearly applies to this row; otherwise empty. Never use today's/current date as a fallback.",
      "dateSource": "visible-row-date | visible-date-column | visible-date-group | empty",
      "day": 15,
      "category": "Main Category in Arabic: 'الأبناء' | 'طعام ومشتريات منزل' | 'زيارات وضيافة' | 'مواصلات' | 'فواتير والتزامات' | 'صحة وعلاج' | 'أخرى'",
      "subcategory": "Specific subcategory like 'خضار وفواكه', 'منظفات', 'لحوم', 'أدوية', 'ملابس'...",
      "merchant": "Store/vendor if visible",
      "necessity": "'ضروري' or 'كمالي'"
    }
  ]
}
For Arabic/RTL tables, inspect the visual date column on the far right or far left and attach that date to the matching visual row. Build dateMap for every extracted item row that has a visible printed date anywhere aligned with it. If several consecutive rows are visually grouped under one printed date, add a dateMap entry for each affected row. Row numbers in dateMap must be 1-based and match the items array order. If a row has a month but no day, keep date empty and include day only if visible. If a date is not printed in the source, leave date empty; do not infer from upload date, current date, or today's date. If no line items can be broken down, provide a single item with the total amount.`;

      const generated = await generateExpenseImportJsonWithFallback(ai, { payloadBase64, mimeType, prompt });
      const parsed = parseJsonObjectFromModelText(generated.text);
      let preview = normalizeAiExpenseItems(parsed, { defaultMonth, fileName });
      if (!preview.ok) return res.status(422).json({ success: false, ...preview });
      preview = applyExpenseImportDateMap(preview, parsed);
      if (preview.items.some((item: any) => !item.date)) {
        try {
          preview = await repairMissingExpenseImportDates(ai, { payloadBase64, mimeType, preview });
        } catch (repairError: any) {
          console.warn('[expense-import] date repair pass failed; keeping manual review fallback', repairError?.message || repairError);
        }
      }

      res.json({
        success: true,
        requiresConfirmation: true,
        reason: 'EXPENSE_IMPORT_PAYMENT_METHOD_REQUIRED',
        message: 'حللت الملف ولم أسجل أي شيء بعد. راجع البنود ثم اختر طريقة الدفع للحفظ.',
        merchant: preview.merchant || parsed.merchant || 'استيراد مصروفات',
        totalAmount: preview.totalAmount,
        itemsCount: preview.items.length,
        items: preview.items,
        warnings: preview.warnings,
        sourceType: mimeType?.startsWith('image/') ? 'image' : (mimeType === 'application/pdf' ? 'pdf' : 'ai'),
        nextStep: 'اعتمد البنود بعد المراجعة ليتم حفظها عبر مسار الفاتورة الذري.'
      });
    } catch (error: any) {
      console.error("Expense import scan error:", error?.message || error, error?.modelErrors || '');
      const temporary = error?.reason === 'GEMINI_TEMPORARILY_UNAVAILABLE' || isGeminiTemporaryCapacityError(error);
      res.status(temporary ? 503 : 500).json({
        success: false,
        reason: temporary ? 'GEMINI_TEMPORARILY_UNAVAILABLE' : 'EXPENSE_IMPORT_ANALYSIS_FAILED',
        retryable: temporary,
        message: temporary
          ? 'خدمة تحليل الصور مزدحمة مؤقتاً. جرّب بعد قليل أو ارفع الملف كـ Excel/CSV إذا كان متوفراً.'
          : 'تعذر تحليل الملف. جرّب صورة أوضح أو ملف CSV/Excel منظم.',
        error: temporary ? 'GEMINI_TEMPORARILY_UNAVAILABLE' : (error?.message || 'EXPENSE_IMPORT_ANALYSIS_FAILED'),
      });
    }
  });

  app.post("/api/scan-receipt/record", authMiddleware, async (req: any, res: any) => {
    try {
      const { items = [], merchant = 'متجر', paymentMethod, riskConfirmed, currentBalances = {}, splitOverflowToDebt = false, sourceType } = req.body || {};
      if (!paymentMethod) return res.status(400).json({ success: false, needsClarification: true, message: 'اختر طريقة الدفع: كاش أو PalPay أو دين.' });
      if (!Array.isArray(items) || items.length === 0) return res.status(400).json({ success: false, error: 'لا توجد بنود لتسجيلها.' });
      const todayIso = new Date().toISOString().slice(0, 10);
      const aiLikeImport = ['image', 'pdf', 'ai'].includes(String(sourceType || ''));
      if (aiLikeImport && items.some((item: any) => String(item?.date || '').slice(0, 10) === todayIso && !isTrustedImportedDateSource(item?.dateSource))) {
        return res.status(400).json({
          success: false,
          needsClarification: true,
          reason: 'SUSPECT_IMPORTED_CURRENT_DATE',
          message: 'ظهر أن بعض البنود بتاريخ اليوم، وهذا غالباً تاريخ رفع الصورة وليس تاريخ المصروف. لن أسجلها حتى لا أخرب الشهر. أعد التحليل بصورة يظهر فيها التاريخ أو استخدم ملف Excel/CSV بتواريخ واضحة.',
        });
      }
      if (items.some((item: any) => !item?.date)) {
        return res.status(400).json({
          success: false,
          needsClarification: true,
          reason: 'MISSING_IMPORTED_EXPENSE_DATE',
          message: 'بعض البنود بلا تاريخ واضح. لن أسجلها بتاريخ اليوم. أضف تاريخاً لكل بند أو ارفع صورة/ملفاً يظهر التاريخ بوضوح.',
        });
      }
      const splitApplied = Boolean(splitOverflowToDebt && (paymentMethod === 'cash' || paymentMethod === 'palPay'));
      const selectedAvailable = splitApplied
        ? Math.max(0, Number(paymentMethod === 'cash' ? currentBalances.cash : currentBalances.palPay) || 0)
        : Infinity;
      let remainingSelectedBalance = selectedAvailable;
      const expandedItems: any[] = [];
      for (const item of items) {
        const amount = Math.round((Number(item.amount) || 0) * 100) / 100;
        if (!splitApplied || paymentMethod === 'debt') {
          expandedItems.push({ ...item, amount, paymentMethodOverride: paymentMethod });
          continue;
        }
        const selectedPart = Math.round(Math.min(amount, Math.max(0, remainingSelectedBalance)) * 100) / 100;
        const debtPart = Math.round((amount - selectedPart) * 100) / 100;
        if (selectedPart > 0) {
          expandedItems.push({ ...item, amount: selectedPart, paymentMethodOverride: paymentMethod, splitPart: selectedPart < amount ? 'paid-from-selected-balance' : undefined });
          remainingSelectedBalance = Math.round((remainingSelectedBalance - selectedPart) * 100) / 100;
        }
        if (debtPart > 0) {
          expandedItems.push({
            ...item,
            amount: debtPart,
            paymentMethodOverride: 'debt',
            account: 'debt',
            splitPart: selectedPart > 0 ? 'overflow-to-debt' : 'all-overflow-to-debt',
            notes: `${item.notes || item.name || 'بند من فاتورة'} — الباقي دين بعد نفاد رصيد ${paymentMethod === 'cash' ? 'الكاش' : 'PalPay'}`,
          });
        }
      }
      const receiptFingerprint = stableShortFingerprint({
        itemCount: items.length,
        merchant,
        paymentMethod,
        items: items.map((i: any) => ({
          amount: i.amount,
          name: i.name || i.notes || i.subcategory || '',
          date: i.date || '',
        })),
      });
      const receiptId = `receipt_${receiptFingerprint}`;
      const prepared: Array<{ item: any; operationId: string; transaction: any }> = [];
      for (const [index, item] of expandedItems.entries()) {
        const linePaymentMethod = item.paymentMethodOverride || paymentMethod;
        const itemFingerprint = stableShortFingerprint({
          receiptId,
          index,
          linePaymentMethod,
          amount: item.amount,
          name: item.name || item.notes || item.subcategory || '',
          date: item.date || '',
        });
        const operationId = `receipt:${receiptId}:item:${index}:${linePaymentMethod}:${itemFingerprint}`;
        const amount = Math.round((Number(item.amount) || 0) * 100) / 100;
        if (amount <= 0) {
          return res.status(400).json({ success: false, reason: 'INVALID_IMPORTED_EXPENSE_AMOUNT', message: 'يوجد بند مستورد بمبلغ غير صالح.' });
        }
        const lineMerchant = String(item.merchant || merchant || 'استيراد مصروفات').trim();
        const transaction = {
          userId: req.user.uid,
          amount,
          type: 'expense',
          account: linePaymentMethod,
          paymentMethod: linePaymentMethod,
          category: item.category || 'أخرى',
          subcategory: item.subcategory || item.notes || 'مشتريات',
          purchaseItem: item.purchaseItem || item.name || item.notes || item.subcategory || 'بند فاتورة',
          beneficiary: item.beneficiary || item.forWhom || item.purpose || item.category || item.subcategory || item.notes || 'مصروف مستورد',
          merchant: lineMerchant,
          notes: item.notes || item.name || 'بند من فاتورة ممسوحة',
          necessity: item.necessity || '',
          necessitySource: item.necessity ? 'import-review' : '',
          necessityReason: '',
          transactionType: linePaymentMethod === 'debt' ? 'CREDIT_PURCHASE' : 'EXPENSE',
          creditor: linePaymentMethod === 'debt' ? lineMerchant : '',
          creditorKey: linePaymentMethod === 'debt' ? lineMerchant.toLowerCase().trim() : '',
          operationId,
          date: item.date,
          dateSource: item.dateSource || 'explicit-date',
          createdAt: new Date().toISOString(),
          importSource: 'reviewed-expense-file',
        };
        prepared.push({ item, operationId, transaction });
      }

      const committed = await atomicAddTransactions(
        req.user.uid,
        prepared.map((row) => ({ ...row.transaction, receiptId })),
        {
          riskConfirmed: Boolean(riskConfirmed),
          receiptId,
          receiptMeta: {
            merchant,
            paymentMethod,
            itemCount: prepared.length,
            importMode: 'reviewed-file-or-image',
            splitOverflowToDebt: splitApplied,
            selectedBalanceUsed: splitApplied ? Math.round((selectedAvailable - remainingSelectedBalance) * 100) / 100 : 0,
          },
          skipLedgerBalanceCheck: true,
        },
      );
      if ('reason' in committed) {
        return res.json({
          success: false,
          needsConfirmation: committed.reason === 'NEGATIVE_CASH_RESULT' || committed.reason === 'NEGATIVE_PALPAY_RESULT',
          reason: committed.reason,
          balances: committed.balances,
          message: 'لم يتم تسجيل أي بند من الفاتورة لأن العملية كاملة لم تجتز فحص الرصيد بأمان.',
        });
      }

      const created = prepared.map((row, index) => ({
        ...row.item,
        transactionId: committed.docIds[index],
        operationId: row.operationId,
      }));
      res.json({
        success: true,
        createdCount: created.length,
        created,
        atomic: true,
        splitOverflowToDebt: splitApplied,
        selectedBalanceUsed: splitApplied ? Math.round((selectedAvailable - remainingSelectedBalance) * 100) / 100 : 0,
        overflowDebtAmount: Math.round(created.filter((item: any) => item.paymentMethodOverride === 'debt' || item.account === 'debt').reduce((sum: number, item: any) => sum + (Number(item.amount) || 0), 0) * 100) / 100,
        idempotentReplay: Boolean((committed as any).idempotentReplay),
      });
    } catch (e: any) {
      console.error('Record scanned receipt error:', e.message);
      const exhausted = String(e?.code || '').includes('8') || String(e?.message || '').includes('RESOURCE_EXHAUSTED') || String(e?.message || '').includes('Quota exceeded');
      res.status(exhausted ? 429 : 500).json({
        success: false,
        reason: exhausted ? 'FIRESTORE_QUOTA_EXHAUSTED' : 'RECEIPT_RECORD_FAILED',
        retryable: exhausted,
        error: exhausted ? 'استهلكت السحابة حدّها مؤقتاً بسبب طلبات متكررة. انتظر دقيقة ثم اضغط مرة واحدة فقط.' : e.message,
      });
    }
  });

  app.get("/api/budgets", authMiddleware, async (req: any, res: any) => {
    try {
      const { getBudgetsOverview } = await import('./src/server/tools');
      const token = req.headers.authorization.split('Bearer ')[1];
      const result = await getBudgetsOverview({}, req.user.uid, token);
      res.json(result);
    } catch (e: any) {
      res.status(500).json({ error: e.message });
    }
  });

  app.post("/api/budgets", authMiddleware, async (req: any, res: any) => {
    try {
      const { setCategoryBudget } = await import('./src/server/tools');
      const token = req.headers.authorization.split('Bearer ')[1];
      const { category, limit } = req.body;
      const result = await setCategoryBudget({ category, limit }, req.user.uid, token);
      res.json(result);
    } catch (e: any) {
      res.status(500).json({ error: e.message });
    }
  });

  app.get("/api/audit/financial-duplicates", authMiddleware, async (req: any, res: any) => {
    try {
      const { auditFinancialDuplicates } = await import('./src/server/tools');
      const token = req.headers.authorization.split('Bearer ')[1];
      res.json(await auditFinancialDuplicates({}, req.user.uid, token));
    } catch (e: any) {
      console.error('Financial audit error:', e.message);
      res.status(500).json({ error: e.message });
    }
  });

  app.get("/api/treasurer/profile", authMiddleware, async (req: any, res: any) => {
    try {
      const { getTreasurerProfile } = await import('./src/server/tools');
      const token = req.headers.authorization.split('Bearer ')[1];
      res.json(await getTreasurerProfile({}, req.user.uid, token));
    } catch (e: any) {
      res.status(500).json({ error: e.message });
    }
  });

  app.post("/api/treasurer/profile", authMiddleware, async (req: any, res: any) => {
    try {
      const { updateTreasurerProfile } = await import('./src/server/tools');
      const token = req.headers.authorization.split('Bearer ')[1];
      res.json(await updateTreasurerProfile(req.body || {}, req.user.uid, token));
    } catch (e: any) {
      res.status(500).json({ error: e.message });
    }
  });

  app.get("/api/savings-goals", authMiddleware, async (req: any, res: any) => {
    try {
      const { getSavingsGoals } = await import('./src/server/tools');
      const token = req.headers.authorization.split('Bearer ')[1];
      res.json(await getSavingsGoals({}, req.user.uid, token));
    } catch (e: any) {
      res.status(500).json({ error: e.message });
    }
  });

  app.post("/api/savings-goals", authMiddleware, async (req: any, res: any) => {
    try {
      const { createSavingsGoal } = await import('./src/server/tools');
      const token = req.headers.authorization.split('Bearer ')[1];
      res.json(await createSavingsGoal(req.body || {}, req.user.uid, token));
    } catch (e: any) {
      res.status(500).json({ error: e.message });
    }
  });

  app.post("/api/savings-goals/:id/contribute", authMiddleware, async (req: any, res: any) => {
    try {
      const { addSavingsContribution } = await import('./src/server/tools');
      const token = req.headers.authorization.split('Bearer ')[1];
      res.json(await addSavingsContribution({ ...(req.body || {}), id: req.params.id }, req.user.uid, token));
    } catch (e: any) {
      res.status(500).json({ error: e.message });
    }
  });

  app.patch("/api/savings-goals/:id", authMiddleware, async (req: any, res: any) => {
    try {
      const { updateSavingsGoal } = await import('./src/server/tools');
      const token = req.headers.authorization.split('Bearer ')[1];
      res.json(await updateSavingsGoal({ ...(req.body || {}), id: req.params.id }, req.user.uid, token));
    } catch (e: any) {
      res.status(500).json({ error: e.message });
    }
  });

  app.get("/api/market-directory", authMiddleware, async (req: any, res: any) => {
    try {
      const { getMarketDirectory } = await import('./src/server/tools');
      const token = req.headers.authorization.split('Bearer ')[1];
      res.json(await getMarketDirectory(req.query || {}, req.user.uid, token));
    } catch (e: any) {
      res.status(500).json({ error: e.message });
    }
  });

  app.post("/api/market-directory", authMiddleware, async (req: any, res: any) => {
    try {
      const { saveMarketOffer } = await import('./src/server/tools');
      const token = req.headers.authorization.split('Bearer ')[1];
      res.json(await saveMarketOffer(req.body || {}, req.user.uid, token));
    } catch (e: any) {
      res.status(500).json({ error: e.message });
    }
  });

  app.get("/api/commitments", authMiddleware, async (req: any, res: any) => {
    try {
      const { getCommitments } = await import('./src/server/tools');
      const token = req.headers.authorization.split('Bearer ')[1];
      const result = await getCommitments({}, req.user.uid, token);
      res.json(result);
    } catch (e: any) {
      res.status(500).json({ error: e.message });
    }
  });

  app.post("/api/commitments", authMiddleware, async (req: any, res: any) => {
    try {
      const { createCommitment } = await import('./src/server/tools');
      const token = req.headers.authorization.split('Bearer ')[1];
      const result = await createCommitment(req.body, req.user.uid, token);
      res.json(result);
    } catch (e: any) {
      res.status(500).json({ error: e.message });
    }
  });

  app.delete("/api/commitments/:id", authMiddleware, async (req: any, res: any) => {
    try {
      const { deleteCommitment } = await import('./src/server/tools');
      const token = req.headers.authorization.split('Bearer ')[1];
      const result = await deleteCommitment({ id: req.params.id }, req.user.uid, token);
      res.json(result);
    } catch (e: any) {
      res.status(500).json({ error: e.message });
    }
  });

  // V6 (MF-1): commitment lifecycle status update.
  app.patch("/api/commitments/:id/status", authMiddleware, async (req: any, res: any) => {
    try {
      const { updateCommitmentStatus } = await import('./src/server/tools');
      const token = req.headers.authorization.split('Bearer ')[1];
      const result = await updateCommitmentStatus({ id: req.params.id, status: req.body.status }, req.user.uid, token);
      res.json(result);
    } catch (e: any) {
      res.status(500).json({ error: e.message });
    }
  });

  // User Memory Endpoints (for smart assistant recall)
  app.get("/api/memory", authMiddleware, async (req: any, res: any) => {
    try {
      const { memorySearch } = await import('./src/server/tools');
      const token = req.headers.authorization.split('Bearer ')[1];
      const result = await memorySearch({}, req.user.uid, token);
      res.json(result);
    } catch (e: any) {
      res.status(500).json({ error: e.message });
    }
  });

  app.post("/api/memory", authMiddleware, async (req: any, res: any) => {
    try {
      const { memorySave } = await import('./src/server/tools');
      const token = req.headers.authorization.split('Bearer ')[1];
      const { key, value } = req.body;
      if (!key || !value) return res.status(400).json({ error: "Missing key or value" });
      const result = await memorySave({ key, value }, req.user.uid, token);
      res.json(result);
    } catch (e: any) {
      res.status(500).json({ error: e.message });
    }
  });

  app.delete("/api/memory/:key", authMiddleware, async (req: any, res: any) => {
    try {
      const { deleteMemoryKey } = await import('./src/server/tools');
      const token = req.headers.authorization.split('Bearer ')[1];
      const result = await deleteMemoryKey({ key: req.params.key }, req.user.uid, token);
      res.json(result);
    } catch (e: any) {
      res.status(500).json({ error: e.message });
    }
  });

  app.get("/api/notifications", authMiddleware, async (req: any, res: any) => {
    try {
      const { getNotifications } = await import('./src/server/tools');
      const token = req.headers.authorization.split('Bearer ')[1];
      res.json(await getNotifications(req.user.uid, token));
    } catch (e: any) {
      res.status(500).json({ error: e.message });
    }
  });

  app.post("/api/notifications/:id/read", authMiddleware, async (req: any, res: any) => {
    try {
      const { markNotificationRead } = await import('./src/server/tools');
      const token = req.headers.authorization.split('Bearer ')[1];
      res.json(await markNotificationRead({ id: req.params.id }, req.user.uid, token));
    } catch (e: any) {
      res.status(500).json({ error: e.message });
    }
  });


  app.post("/api/sync", authMiddleware, async (req: any, res: any) => {
    try {
      const { syncOfflineData } = await import('./src/server/tools');
      const token = req.headers.authorization.split('Bearer ')[1];
      const result = await syncOfflineData(req.body, req.user.uid, token);
      res.json(result);
    } catch (e: any) {
      // V6 (CF-2): OwnershipError from syncOfflineData should return 403, not 500.
      const status = e?.status && Number.isFinite(e.status) ? e.status : 500;
      res.status(status).json({ error: e.message });
    }
  });

  // V6.2 (FINDING-03/04/06): Financial command dispatch endpoint.
  // Offline replay MUST route through this endpoint (NOT /api/sync).
  // /api/sync is restricted to NON-FINANCIAL state only (reports, commitment status).
  // Financial mutations (transactions, transfers, debt payments, PalPay payments,
  // updates, deletes) go through /api/command which calls dispatchFinancialCommand.
  // dispatchFinancialCommand routes to the SAME tool handlers used by online AI calls,
  // so ALL financial validation (overpayment, insufficient funds, debt guards, etc.)
  // is applied. NO backdoor.
  app.post("/api/command", authMiddleware, async (req: any, res: any) => {
    try {
      const { command } = req.body || {};
      if (!command || !command.commandType || !command.operationId) {
        return res.status(400).json({ error: 'Missing command.commandType or command.operationId' });
      }
      if (!isValidFinancialCommandType(command.commandType)) {
        return res.status(400).json({ error: `Unknown command type: ${command.commandType}` });
      }
      const token = req.headers.authorization.split('Bearer ')[1];
      // V6.2 (FINDING-07 SYNC-AUTH-01): force userId = authenticated UID.
      // The dispatchFinancialCommand function will overwrite command.userId.
      const result = await dispatchFinancialCommand(command, req.user.uid, token);
      res.json(result);
    } catch (e: any) {
      const status = e?.status && Number.isFinite(e.status) ? e.status : 500;
      res.status(status).json({ error: e.message });
    }
  });

  app.get("/api/transactions", authMiddleware, async (req: any, res: any) => {
    try {
      const { queryTransactions } = await import('./src/server/tools');
      const token = req.headers.authorization.split('Bearer ')[1];
      const result = await queryTransactions({ period: 'custom' }, req.user.uid, token); 
      res.json(result);
    } catch (e: any) {
      fs.appendFileSync("app-errors.log", "Transactions Error: " + e.message + "\n"); console.error("Transactions Error:", e.message);
      res.status(500).json({ error: e.message });
    }
  });

  app.get("/api/reports", authMiddleware, async (req: any, res: any) => {
    const { getReports } = await import('./src/server/tools');
    const token = req.headers.authorization.split('Bearer ')[1];
    const result = await getReports({}, req.user.uid, token);
    res.json(result);
  });

  app.delete("/api/reports/:id", authMiddleware, async (req: any, res: any) => {
    try {
      const { deleteReport } = await import('./src/server/tools');
      const token = req.headers.authorization.split('Bearer ')[1];
      const result = await deleteReport({ id: req.params.id }, req.user.uid, token);
      res.json(result);
    } catch (e: any) {
      console.error("Delete report API error:", e.message);
      res.status(500).json({ error: e.message });
    }
  });

  app.delete("/api/reports", authMiddleware, async (req: any, res: any) => {
    try {
      const { clearAllReports } = await import('./src/server/tools');
      const token = req.headers.authorization.split('Bearer ')[1];
      const result = await clearAllReports({}, req.user.uid, token);
      res.json(result);
    } catch (e: any) {
      console.error("Clear all reports API error:", e.message);
      res.status(500).json({ error: e.message });
    }
  });

  app.post("/api/reports/generate", authMiddleware, async (req: any, res: any) => {
    try {
      const { generateReport } = await import('./src/server/tools');
      const token = req.headers.authorization.split('Bearer ')[1];
      const { title, timeframe = 'all', category } = req.body;
      const result = await generateReport({ title, timeframe, category }, req.user.uid, token);
      res.json(result);
    } catch (e: any) {
      console.error("Generate report API error:", e.message);
      res.status(500).json({ error: e.message });
    }
  });

  app.post("/api/reports/treasurer", authMiddleware, async (req: any, res: any) => {
    try {
      const { generateTreasurerReport } = await import('./src/server/tools');
      const token = req.headers.authorization.split('Bearer ')[1];
      const result = await generateTreasurerReport(req.body || {}, req.user.uid, token);
      res.json(result);
    } catch (e: any) {
      console.error("Generate treasurer report API error:", e.message);
      res.status(500).json({ error: e.message });
    }
  });

  // Data Export Endpoint
  app.get("/api/data/export", authMiddleware, async (req: any, res: any) => {
    try {
      const { exportUserData } = await import('./src/server/tools');
      const token = req.headers.authorization.split('Bearer ')[1];
      const backupData = await exportUserData(req.user.uid, token);
      res.json(backupData);
    } catch (e: any) {
      console.error("Export data error:", e.message);
      res.status(500).json({ error: "Failed to export data: " + e.message });
    }
  });

  // Data Import Endpoint
  app.post("/api/data/import", authMiddleware, async (req: any, res: any) => {
    try {
      const { importUserData } = await import('./src/server/tools');
      const token = req.headers.authorization.split('Bearer ')[1];
      const { payload, mode = 'merge' } = req.body;
      if (!payload) {
        return res.status(400).json({ error: "Missing payload to import." });
      }
      const result = await importUserData(payload, req.user.uid, token, mode);
      res.json(result);
    } catch (e: any) {
      console.error("Import data error:", e.message);
      res.status(500).json({ error: "Failed to import data: " + e.message });
    }
  });

  // Data Wipe All Endpoint (clears all user transactions, budgets, commitments, reports, and disk cache)
  app.delete("/api/data/wipe", authMiddleware, async (req: any, res: any) => {
    try {
      const { wipeAllUserData } = await import('./src/server/tools');
      const token = req.headers.authorization.split('Bearer ')[1];
      const result = await wipeAllUserData(req.user.uid, token);
      res.json(result);
    } catch (e: any) {
      console.error("Wipe all data error:", e.message);
      res.status(500).json({ error: "Failed to wipe data: " + e.message });
    }
  });

  app.post("/api/chat", authMiddleware, async (req: any, res: any) => {
    try {
      const { message, clientMessageId = `server_msg_${Date.now()}_${Math.random().toString(36).slice(2, 10)}`, history = [], userName = "يا صديقي", aiName = "مصروفي", relationship = "", persona = "friendly", apiKey: customApiKey } = req.body;
      const recentUserConversationText = [
        ...(Array.isArray(history) ? history.filter((m: any) => m?.role === 'user').slice(-6).map((m: any) => String(m.text || m.content || '')) : []),
        String(message || '')
      ].join('\n');
      const apiKey = customApiKey || process.env.GEMINI_API_KEY;
      if (!apiKey) throw new Error("No API key");

      const personalityMap: Record<string, string> = {
        friendly: "ودود وعفوي وخفيف الدم",
        playful: "مرح جداً ومشاكس بلطف ويستخدم الدعابة الطبيعية دون إفساد الجدية المالية",
        warm: "حنون وداعم ودافئ في الحديث",
        romantic: "رومانسي ودافئ ومحب إذا كان سياق العلاقة يسمح بذلك، دون مبالغة أو تعطيل الدقة المالية",
        professional: "رسمي ومهني ومنهجي",
        strict: "صارم وحازم مالياً مع الحفاظ على الاحترام"
      };
      const relationshipContext = relationship ? `علاقتك بالمستخدم كما عرّفها هو: "${relationship}". افهمها كسياق علاقة وتصرّف وفقها طبيعياً، ولا تضمها إلى اسمك ولا تكررها آلياً. مثال: إذا كان اسمك تغريد والعلاقة زوجتي، فاسمك تغريد وعلاقتك به زوجته، وليس اسمك "تغريد زوجتي".` : "لا توجد علاقة خاصة محددة؛ تعامل كمساعد مالي شخصي.";
      const systemInstruction = `أنت مساعد ومستشار مالي شخصي ذكي. اسمك هو "${aiName}".
أسلوبك: ${personalityMap[persona] || personalityMap.friendly}.
${relationshipContext}
أنت تتحدث الآن مع المستخدم الذي اسمه: "${userName}". 
1. مهمتك مساعدة المستخدم في إدارة أمواله وتسجيل عملياته واستخراج تقارير تفصيلية شاملة.
2. وضعك الأساسي هو **أمين الصندوق الذكي**: لا توافق المستخدم لمجرد أنه يريد الصرف؛ احمِ رصيده وادخاره وميزانيته، واعترض بالأرقام عندما يلزم.
2.1. تصنيف الضروري/الكمالي مسؤوليتك أنت عند وضوح الوصف، وفق واقع غزة والحرب وصعوبة الحياة، وليس وفق معيار رفاهية عام. غذاء/ماء/دواء/كهرباء/غاز/أطفال/مأوى/مواصلات علاج أو عمل غالباً ضروري. الترفيه والعطور والإكسسوارات والأجهزة الفاخرة غالباً كمالي. اسأل فقط إذا الوصف غير كافٍ.
3. في قرارات الشراء، السوق المحلي يعني غزة أولاً ثم فلسطين ثم العالمي كمرجع. استخدم search_local_market للمشتريات المهمة، وخزّن عروض المحلات الموثوقة عبر save_market_offer حتى يبني مصروفي ذاكرة سوق غزة تدريجياً.
4. إذا رجعت أداة مالية pending أو cloudStoragePending فهذا يعني أن Firestore لم يؤكد الحفظ السحابي. لا تبرره بضعف شبكة المستخدم. قل بصراحة: الحفظ السحابي غير مؤكد، وافحص Firebase/Firestore أو أعد المحاولة.

🛑 **قواعد إلزامية ومهمة جداً (إياك مخالفتها)**:
0- **لا رؤية وهمية**: لا تؤكد أي إضافة/تحويل/تعديل/حذف/سداد قبل أن تعود الأداة بنتيجة success=true. إذا أعادت needsClarification فاسأل فقط عن الحقل الناقص. إذا فشلت الأداة فقل إنها لم تُنفذ. لا تعتبر الرد الكلامي تنفيذًا مالياً.
0.1- **التحويل الداخلي**: تحويل cash↔PalPay ليس دخلاً ولا مصروفاً ويجب استخدام transfer_money فقط. لا تنشئ عمليتي دخل/مصروف لمحاكاة التحويل.
0.2- **الحذف والتعديل**: إذا كانت العملية المقصودة غير فريدة، لا تخمن أحدث عملية. اطلب تحديدها. التعديل يجب أن يغير نفس السجل ولا ينشئ عملية مالية جديدة.
0.3- **المستشار الاستباقي V5**: فرّق بين نية الشراء وبين حدوث الشراء. إذا قال المستخدم "بدي أشتري/بفكر أشتري/شو رأيك أشتري" فلا تسجل عملية. للشراء المهم أو المكلف استخدم assess_purchase أولاً، واستدعِ get_financial_decision_context عندما تحتاج صورة مالية أوسع. ناقشه بالأرقام الفعلية: الرصيد، متوسط الصرف اليومي، الالتزامات، الموازنة، وتوقع 30 يوماً. تدخّل في الوقت المناسب لكن لا تزعجه بتنبيهات على كل مصروف صغير.
0.4- **السوق المحلي الحقيقي**: عندما يكون القرار مرتبطاً بسعر سلعة حالية، اجمع اسم السلعة والموديل/المواصفات أولاً ثم استخدم search_local_market. لا تقل "موجود عند فلان بكذا" إلا إذا أعادت الأداة مصدراً حقيقياً. إذا لم تجد سعراً محلياً موثوقاً في غزة، قل ذلك صراحة ولا تخترع متجراً أو سعراً. السعر الخارجي معلومة مساعدة وليس أمراً بالشراء.
0.5- **التحذير قبل التنفيذ**: إذا أعادت أداة مالية needsConfirmation=true، لا تنفذ ولا تؤكد. اشرح الخطر باختصار واسأل المستخدم هل يريد المتابعة. إذا وافق صراحة، أعد نفس العملية مع riskConfirmed=true. إذا رفض، لا تسجل شيئاً.
0.6- **أسلوب الإقناع**: استخدم شخصية المساعد المختارة في النقاش (يمكن المزاح في playful/romantic/warm) لكن الأرقام والحقائق لا تتغير. مثال مرح مسموح إذا كانت البيانات تدعمه: "يا زلمة، هيك بتضغط حالك آخر الشهر 😄". لا تستخدم التوبيخ أو الادعاءات السعرية بلا دليل.
0.7- **V6.1 — المتانة (Durability)**: عندما تعيد أداة مالية durability=pending أو pending=true أو cloudStoragePending=true، فهذا يعني أن العملية لم تُحفظ في Firestore ولم تُسجّل كإضافة مؤكدة. لا تقل "تم" أو "حفظت" أو "سجلتها" أو "ستصل عند عودة الاتصال". قل بصدق: "لم تُسجّل العملية في السحابة، أعد المحاولة أو افحص اتصال/إعدادات Firestore".
0.7.1- **إدخال مصروفات أشهر سابقة**: عند نقل مصروفات أشهر سابقة، إذا ذكر المستخدم تاريخاً كاملاً لكل بند فمرره في date. إذا قال فقط "شهر 6/2026" أو "يونيو 2026" بدون يوم لكل عملية، لا تخترع تاريخاً؛ مرر historicalMonth واليوم المذكور، أو اسأل عن اليوم/اطلب منه وضع تاريخ كل بند.
0.8- **V6.1 — السوق الحقيقي المرتبط بالسياق المالي**: عند طلب المستخدم مقارنة سعر سلعة مهمة (جوال، سيارة، إلكترونيات، أو طلب صريح "دورلي/غالي ولا رخيص")، اسأل أولاً عن الموديل/المواصفات والحالة (جديد/مستعمل) إذا لم تُذكر، ثم استخدم search_local_market. ادمج النتيجة مع السياق المالي: الرصيد، متوسط الصرف اليومي، الالتزامات، الموازنة، توقع 30 يوماً. لا تقدم سعر السوق بمعزل عن الواقع المالي للمستخدم. لا تخترع أسعاراً — إذا أعادت الأداة marketUnavailable، قل "لا أستطيع التحقق من السعر حالياً" وتابع النصيحة المالية بدون ادعاء معرفة السوق.
0.9- **V6.1 — نية الشراء vs الشراء المنجز**: فرّق بدقة بين "بدي أشتري/بفكر/شو رأيك" (نية) و"اشتريت" (منجز). النية = استخدم assess_purchase و search_local_market، لا تسجّل عملية. المنجز = اسأل عن طريقة الدفع ثم سجّل بـ add_transaction. الاختلاط بينهما يفسد البيانات المالية.
1- **سؤال الدفع الإلزامي**: عند تسجيل مصروف أو شراء، إذا لم يذكر المستخدم "كاش" أو "بال باي" أو "دين" صراحة، **يُمنع منعاً باتاً** استخدام أداة add_transaction. اسأله فوراً: "هل دفعت كاش أم من محفظة بال باي أم سجلتها ديناً؟".
2- **سداد الدين الإلزامي**: عند طلب سداد دين، اجمع فقط المعلومات الناقصة: مبلغ السداد، حساب الدفع، والدائن المقصود عند وجود أكثر من دائن. لا تخمن الدائن. إذا أعادت pay_debt needsClarification فاطرح سؤال التوضيح ولا تؤكد النجاح قبل نجاح الأداة. إذا ذكر المستخدم الدائن والحساب بوضوح فلا تطرح أسئلة زائدة.
3- **التفرقة بين (استدانة المال) و (الشراء بالدين)**:
  - إذا قال المستخدم فقط "استدنت 500" أو "أخذت سلفة 500" ولم يوضح هل **استلم مالاً** أم **اشترى أغراضاً بالدين**، فهذا أمر مالي غامض: **لا تنفذ أي أداة**. اسأله باختصار: "استلمت المبلغ نقدي/PalPay، أم اشتريت أغراضاً بالدين؟".
  - **استدانة مال مستلم**: إذا أكد أنه استلم المال، استخدم **transfer_money** من debt إلى الحساب الذي استلم فيه المال. إذا لم يحدد هل استلمه cash أم PalPay، اسأل عن الحساب ولا تفترضه. يجب أيضاً معرفة الدائن. النتيجة: يزيد الحساب المستلم ويزيد الدين بنفس المبلغ، بينما **الدخل الحقيقي يبقى دون تغيير**. transactionType يجب أن يكون DEBT_BORROWING.
  - **شراء غرض بالدين**: إذا أكد أنه اشترى غرضاً بالدين، استخدم **add_transaction** كـ expense وحساب paymentMethod=debt. هذا يزيد المصروف والدين ولا يزيد cash أو PalPay. يجب حفظ الدائن/المحل. هذا النوع هو CREDIT_PURCHASE وليس دخلاً.
  - **سداد الدين**: استخدم pay_debt فقط؛ يخفض حساب الدفع والدين ولا ينشئ مصروفاً جديداً. transactionType=DEBT_PAYMENT.
4- **التسجيل اللفظي والفعلي**: عندما تقوم بتنفيذ عملية السداد عبر الأداة، تأكد من تأكيد ذلك لفظياً للمستخدم، فالأداة هي من تقوم بالخصم وتحديث البيانات على الشاشة. إياك أن ترد صوتياً وتنسى استدعاء الأداة.
- عندما يقول المستخدم "سديت دين" أو "دفعت دين" (مثل: "سديت دين 10 شيكل"):
  * **إياك إطلاقاً** أن تسجل سداد الدين كمصروف (add_transaction - expense). سداد الدين ليس مصروفاً جديداً! يجب استخدام pay_debt فقط.
  * إذا لم يذكر من أين دفع، **اسأله فوراً**: "هل سددت الدين نقداً (كاش) أم من محفظة PalPay؟".
  * فور تحديد الحساب، استخدم أداة \`pay_debt\` لتسجيل السداد، حيث تقوم الأداة بخصم المبلغ من رصيد الكاش أو PalPay وتخفيض إجمالي الديون في نفس اللحظة.

2. **التصنيف الهيكلي الدقيق للعمليات (add_transaction)**:
   - **بند الصرف الرئيسي (category)**: حدد دائماً البند الرئيسي (مثل: 'الأبناء', 'زيارات وضيافة', 'طعام ومشتريات منزل', 'مواصلات', 'فواتير والتزامات', 'صحة وعلاج', 'تعليم وتدريب', 'أخرى').
   - **بند الصرف الفرعي (subcategory)**: حدد دائماً وبدقة البند الفرعي:
     * تحت 'الأبناء': مصروف، ملابس، رسوم جامعة ومدرسة، دورة رسم، مستلزمات مدرسية، علاج، ألعاب...
     * تحت 'زيارات وضيافة': هدايا، مواصلات زيارة، ضيافة، حلويات، مطاعم...
     * تحت 'طعام ومشتريات منزل': خضار وفواكه، تموين، لحوم ودواجن، مخبوزات، منظفات...
     * تحت 'مواصلات': بنزين، تاكسي، صيانة وتصليح...
     * تحت 'فواتير والتزامات': كهرباء، ماء، إنترنت، إيجار...
     * تحت 'صحة وعلاج': كشفية طبيب، أدوية، تحاليل...
   - **المتجر (merchant)**: اسم المحل أو الشخص إن ذكر (مثل مكتبة النور، صيدلية القدس).
   - **البيان والتفاصيل (notes)**: تفصيل شو اشترى والملاحظات.
   - **طريقة الدفع (paymentMethod)**: 'cash' (كاش), 'palPay' (محفظة), أو 'debt' (دين).
   - **درجة الضرورة (necessity)**: 'ضروري' أو 'كمالي'، وتصنيفها مسؤوليتك أنت وفق واقع غزة والحرب وصعوبة الحياة، لا وفق معيار رفاهية عام. غذاء، ماء، دواء، كهرباء، غاز، احتياجات أطفال، مأوى، ومواصلات علاج/عمل = غالباً ضروري. مطاعم، عطور، إكسسوارات، ترفيه، وأجهزة فاخرة = غالباً كمالي. اسأل فقط إذا وصف الشراء غير كافٍ لفهم الحاجة، ولا تسأل المستخدم دائماً "ضروري ولا كمالي".
   - **اكتمال القيد**: قبل add_transaction اجمع amount + type + category + subcategory + paymentMethod. أما necessity فصنّفها أنت وفق واقع غزة عندما الوصف واضح، واسأل سؤالاً قصيراً فقط إذا لم تكفِ تفاصيل الشراء. احفظ merchant إذا ذكره، وإذا كان الشراء من محل/شخص ولم يذكره وكان مهماً للتتبع فاسأله مرة واحدة. املأ purchaseItem بما تم شراؤه وbeneficiary لمن/لأي غرض، لأنهما جزء من id القيد ومنع التكرار الصحيح. notes يجب أن تلخص ما تم شراؤه. التاريخ الحالي يُستخدم تلقائياً ما لم يذكر تاريخاً آخر.
   - مثال: "اشتريت أواعي للعيال بـ200" → لا تنفذ فوراً إذا طريقة الدفع غير مذكورة. اسأل كاش/PalPay/دين، ثم سجّل category=الأبناء وsubcategory=ملابس وamount=200 وpurchaseItem=ملابس وbeneficiary=الأبناء وnotes=ملابس للأبناء وmerchant إن توفر وnecessity وفق ظروف المستخدم لا وفق افتراض عام.
3. **التقارير المالية**: إذا طلب تقريراً بسيطاً استخدم generate_report، وإذا طلب تقريراً شهرياً/ربعياً/سنوياً أو تفصيلاً حسب الأبناء أو بند رئيسي/فرعي أو تحليل تجاوزات ورسوم بيانية، استخدم generate_treasurer_report.
4. **الادخار**: استخدم create_savings_goal وget_savings_goals وadd_savings_contribution عند الحديث عن التحويشة، الاحتياطي، أهداف الشراء، تعليم الأبناء أو أي هدف مالي طويل.
5. **الدخل والراتب**: لا تسجل الراتب كاش تلقائياً؛ اسأل كم نقدي وكم PalPay، أو استخدم allocations إذا أعطى التوزيع. ممنوع استدعاء add_transaction مرتين لنفس الراتب. إذا قال المستخدم إن الراتب تكرر أو تضاعف، استخدم repair_duplicate_income لإزالة النسخة الزائدة ولا تضف عملية عكسية.
6. **قيد واحد لكل أمر مالي**: إذا قال "اشتريت من فلان بـ 50 دين" فهذا قيد واحد فقط: add_transaction type=expense paymentMethod=debt amount=50 merchant=فلان. ممنوع معه transfer_money وممنوع تسجيله مرتين. أما "أخذت دين نقدي 100" فهو transfer_money من debt إلى cash مرة واحدة.
7. لا تقل "تم تسجيل العملية بنجاح" بل تحدث بعفوية ومختصر.`;

      const ai = new GoogleGenAI({ apiKey });
      
      const formattedHistory = history.map((msg: any) => ({
        role: msg.role === 'user' ? 'user' : 'model',
        parts: [{ text: msg.text }]
      }));

      const chat = ai.chats.create({
        model: 'gemini-3.6-flash',
        history: formattedHistory,
        config: {
          systemInstruction,
          tools: [{ functionDeclarations: functionDeclarations as any }]
        }
      });

      // Set history if possible, but the SDK requires parsing it correctly.
      // For simplicity, we just send a single message with context if history is complex,
      // or we can just send the latest message.
      const response = await chat.sendMessage({ message });
      
      let replyText = response.text;
      let executedFunctionResponses: any[] = [];
      
      // If there are function calls
      if (response.functionCalls && response.functionCalls.length > 0) {
        const seenToolKeys = new Set<string>();
        const functionResponses = await Promise.all(
          response.functionCalls.map(async (call: FunctionCall) => {
            const guard = shouldSkipFinancialToolCallForIntent(call, message, seenToolKeys, response.functionCalls || []);
            if (guard.skip) {
              return { id: call.id, name: call.name, response: { success: true, skipped: true, reason: guard.reason, message: 'تم تجاهل استدعاء مكرر/غير مناسب لنفس الأمر حتى لا يتضاعف القيد المالي.' } };
            }
            const handler = toolHandlers[call.name];
            let responseData = { error: "Function not found" };
            if (handler) {
              try {
                const authToken = req.headers.authorization.split('Bearer ')[1];
                const stableOperationId = buildStableOperationIdForToolCall(call, String(clientMessageId || ''));
                const toolArgs = stableOperationId
                  ? { ...(call.args || {}), operationId: stableOperationId, clientMessageId, userText: recentUserConversationText, currentUserText: message }
                  : { ...(call.args || {}), clientMessageId, userText: recentUserConversationText, currentUserText: message };
                responseData = await handler(toolArgs, req.user.uid, authToken);
              } catch (e: any) {
                responseData = { error: e.message };
              }
            }
            return { id: call.id, name: call.name, response: responseData };
          })
        );
        executedFunctionResponses = functionResponses as any[];
        
        const deterministicFinancialReply = buildDeterministicFinancialReply(functionResponses as any);
        if (deterministicFinancialReply) {
          replyText = deterministicFinancialReply;
        } else {
          // Send non-financial tool response back to the model. For financial writes we do not let
          // the model reinterpret a committed write as a failure; the server response is canonical.
          const secondResponse = await chat.sendMessage({ message: functionResponses as any });
          if (secondResponse.text) {
            replyText = secondResponse.text;
          }
        }
      }

      if (!executedFunctionResponses.some((r: any) => isFinancialToolName(r.name)) && looksLikeFinancialIntent(recentUserConversationText)) {
        const fallbackCall = buildFallbackFinancialToolCall(recentUserConversationText, String(clientMessageId || ''));
        if (fallbackCall && toolHandlers[fallbackCall.name]) {
          try {
            const authToken = req.headers.authorization.split('Bearer ')[1];
            const stableOperationId = buildStableOperationIdForToolCall(fallbackCall, String(clientMessageId || ''));
            const toolArgs = stableOperationId
              ? { ...(fallbackCall.args || {}), operationId: stableOperationId, clientMessageId, userText: recentUserConversationText, currentUserText: message }
              : { ...(fallbackCall.args || {}), clientMessageId, userText: recentUserConversationText, currentUserText: message };
            const fallbackResult = await toolHandlers[fallbackCall.name](toolArgs, req.user.uid, authToken);
            executedFunctionResponses.push({ id: 'server_fallback', name: fallbackCall.name, response: fallbackResult });
            const deterministicFallbackReply = buildDeterministicFinancialReply(executedFunctionResponses as any);
            if (deterministicFallbackReply) replyText = deterministicFallbackReply;
          } catch (e: any) {
            executedFunctionResponses.push({ id: 'server_fallback', name: fallbackCall.name, response: { error: e.message } });
            replyText = `لم أسجل العملية فعلياً بسبب خطأ داخلي: ${e.message}`;
          }
        }
      }

      const financialToolResults = executedFunctionResponses
        .filter((r: any) => isFinancialToolName(r.name))
        .map((r: any) => r.response)
        .filter(Boolean);
      if (financialToolResults.length === 0 && looksLikeFinancialIntent(recentUserConversationText) && looksLikeCommittedClaim(replyText || '')) {
        replyText = 'لم أسجل أي قيد فعلياً في السحابة؛ لن أقول تم الحفظ بدون transactionId. أعد الأمر مع التفاصيل المطلوبة أو أجب عن السؤال الناقص.';
      }
      const committedTransactions = financialToolResults
        .filter((r: any) => r?.success === true && r?.transaction)
        .map((r: any) => r.transaction);
      // V6.3: server-local FakeDb pending state is never exported to the browser.
      // The only replayable financial queue is the typed V6.2 client command queue.
      res.json({ success: true, text: replyText, financialToolResults, committedTransactions });
    } catch (error: any) {
      console.error("Text chat error:", error);
      if (error.message && error.message.includes("resource_exhausted")) {
        res.json({ success: true, text: "عذراً يا صديقي، لقد استنفدت الحد المسموح به مجاناً من خدمة الذكاء الاصطناعي (Gemini API Quota Exhausted). يرجى المحاولة لاحقاً أو الترقية." });
      } else {
        res.status(500).json({ error: "Failed to process chat: " + error.message });
      }
    }
  });

  // Vite middleware for development
  if (process.env.NODE_ENV !== "production") {
    const vite = await createViteServer({
      server: { middlewareMode: true },
      appType: "spa",
    });
    app.use(vite.middlewares);
  } else {
    const distPath = path.join(process.cwd(), 'dist');
    app.use(express.static(distPath));
    app.get('*', (req, res) => {
      res.sendFile(path.join(distPath, 'index.html'));
    });
  }
}

function setupLiveApi(wss: WebSocketServer) {
  wss.on("connection", (clientWs: WebSocket, req) => {
    console.log("Client connected to /live");

    // V6.3: Authenticate FIRST, then create the Gemini Live session.
    // The previous flow opened a Gemini session before auth and registered the
    // WS message handler only after that connection completed. Fast clients could
    // send the auth packet before the handler existed, causing auth timeouts and
    // wasting Gemini resources on unauthenticated sockets.
    const url = new URL(req.url || "", `http://${req.headers.host}`);
    const requestedVoice = url.searchParams.get("voice");
    const voice = requestedVoice === "Puck" ? "Puck" : "Zephyr";
    const persona = url.searchParams.get("persona") || "friendly";
    const userName = url.searchParams.get("userName") || "يا صديقي";
    const aiName = url.searchParams.get("aiName") || "مصروفي";
    const relationship = url.searchParams.get("relationship") || "";
    // API keys are intentionally NOT read from the URL. URLs can appear in logs.

    const authState: WSAuthState = { authenticated: false };
    let userId: string | null = null;
    let userEmail: string | undefined = undefined;
    let userToken: string | undefined = undefined;
    const requestId = Math.random().toString(36).slice(2, 8);
    const pendingAudio: string[] = [];
    let liveAudioChunksForwarded = 0;
    let liveToolResponsesSent = 0;
    let liveTurnsCompleted = 0;
    let liveAudioSinceLastToolResponse = 0;
    let liveInterruptions = 0;
    let awaitingPostToolAudio = false;

    let authTimeout: NodeJS.Timeout | null = setTimeout(() => {
      if (!authState.authenticated) {
        try {
          if (clientWs.readyState === WebSocket.OPEN) {
            clientWs.send(JSON.stringify({ error: "Authentication timeout" }));
          }
          clientWs.close(4001, "auth timeout");
        } catch (e) { /* ignore */ }
      }
    }, 5000);

    const safeSend = (payload: any) => {
      if (clientWs.readyState === WebSocket.OPEN) {
        try {
          clientWs.send(typeof payload === "string" ? payload : JSON.stringify(payload));
        } catch (err) {
          console.warn("Failed to send message over clientWs:", err);
        }
      }
    };

    const pingInterval = setInterval(() => {
      if (clientWs.readyState === WebSocket.OPEN) {
        try {
          clientWs.ping();
        } catch (e) { /* ignore */ }
      }
    }, 15000);

    let session: any = null;
    let sessionPromise: Promise<any> | null = null;
    let isActive = true;

    const connectGeminiSession = async (activeApiKey: string) => {
      if (sessionPromise || session) return sessionPromise || session;
      const ai = new GoogleGenAI({ apiKey: activeApiKey });

      let personalityDesc = "";
      if (persona === "friendly") {
        personalityDesc = "أنت شخصية ودودة، ذكية، عفوية، خفيفة الدم، وتتحدث العربية الطبيعية (شامية، فلسطينية، فصحى بشكل طبيعي).";
      } else if (persona === "strict") {
        personalityDesc = "أنت مستشار مالي صارم وحازم جداً. توبخ المستخدم بلباقة إذا أسرف في صرف أمواله وتطالبه بالالتزام بالميزانية.";
      } else if (persona === "professional") {
        personalityDesc = "أنت خبير مالي رسمي ومهني جداً. تتحدث بلغة عربية فصحى دقيقة وتطرح تحليلات مالية منهجية بعيداً عن المزاح.";
      } else if (persona === "playful") {
        personalityDesc = "أنت مرح جداً ومشاكس بلطف، تستخدم الدعابة الطبيعية لكن تصبح دقيقاً وجاداً فور تنفيذ عملية مالية.";
      } else if (persona === "warm") {
        personalityDesc = "أنت حنون وداعم ودافئ في الحديث، مع دقة مالية كاملة.";
      } else if (persona === "romantic") {
        personalityDesc = "أنت رومانسي ودافئ ومحب عندما يسمح سياق العلاقة بذلك، لكن لا تسمح للرومانسية بتغيير أي حقيقة أو قاعدة مالية.";
      }

      const relationshipContext = relationship ? `علاقتك بالمستخدم كما عرّفها هو: "${relationship}". هذه علاقة وسياق وليست جزءاً من اسمك. إذا كان اسمك تغريد والعلاقة زوجتي، فأنت تغريد وعلاقتك به زوجته؛ لا تقل إن اسمك "تغريد زوجتي".` : "لا توجد علاقة خاصة محددة.";
      const systemInstruction = `أنت مساعد ومستشار مالي شخصي ذكي. اسمك هو "${aiName}".
أنت لست آلة أو Chatbot، ${personalityDesc}
${relationshipContext}
أنت تتحدث الآن مع المستخدم الذي اسمه: "${userName}". 
1. بمجرد بدء المحادثة أو دخول المستخدم، يجب أن ترحب به باسمه قائلاً: "أهلاً بك يا ${userName}..." وتتحدث معه كصديق مقرب (أو كمدير صارم إذا كانت شخصيتك كذلك).
2. إذا سألك المستخدم "من أنت؟" أو "ما اسمك؟"، أجب بثقة بأن اسمك هو "${aiName}".
3. وضعك الأساسي هو **أمين الصندوق الذكي**: لا توافق المستخدم لمجرد أنه يريد الصرف؛ احمِ رصيده وادخاره وميزانيته، واعترض بالأرقام عندما يلزم. للتقارير العميقة استخدم generate_treasurer_report، وللادخار استخدم أدوات savings، وللراتب اسأل دائماً كم كاش وكم PalPay. في قرارات الشراء ابحث غزة أولاً، فلسطين ثانياً، العالمي ثالثاً عبر search_local_market، وخزّن عروض المحلات الموثوقة عبر save_market_offer لبناء دفتر سوق غزة.
4. إذا رجعت أداة مالية pending أو cloudStoragePending فهذا يعني أن Firestore لم يؤكد الحفظ السحابي. لا تبرره بضعف شبكة المستخدم. قل بصراحة: الحفظ السحابي غير مؤكد، وافحص Firebase/Firestore أو أعد المحاولة.

🛑 **المقاطعة والتوقف الفوري عن الحديث (Interruption Directive)**:
إذا قاطعك المستخدم وتكلم أثناء حديثك، ستصلك إشارة مقاطعة؛ **توقف فوراً وبشكل قطعي عن إكمال الجملة أو الكلام السابق، واسكت لتسمع ما يقوله**.
عند الرد بعد المقاطعة، أجب بإيجاز واستهل بعبارة لطيفة مثل: "أنا باسمعك يا ${userName}... تفضل" أو نفذ ما طلبه مباشرة دون تكرار ما كنت تقوله قبل المقاطعة.

🛑 **قواعد إلزامية ومهمة جداً (إياك مخالفتها)**:
0- **لا رؤية وهمية**: لا تؤكد أي إضافة/تحويل/تعديل/حذف/سداد قبل أن تعود الأداة بنتيجة success=true. إذا أعادت needsClarification فاسأل فقط عن الحقل الناقص. إذا فشلت الأداة فقل إنها لم تُنفذ. لا تعتبر الرد الكلامي تنفيذًا مالياً.
0.1- **التحويل الداخلي**: تحويل cash↔PalPay ليس دخلاً ولا مصروفاً ويجب استخدام transfer_money فقط. لا تنشئ عمليتي دخل/مصروف لمحاكاة التحويل.
0.2- **الحذف والتعديل**: إذا كانت العملية المقصودة غير فريدة، لا تخمن أحدث عملية. اطلب تحديدها. التعديل يجب أن يغير نفس السجل ولا ينشئ عملية مالية جديدة.
0.3- **المستشار الاستباقي V5**: فرّق بين نية الشراء وبين حدوث الشراء. إذا قال المستخدم "بدي أشتري/بفكر أشتري/شو رأيك أشتري" فلا تسجل عملية. للشراء المهم أو المكلف استخدم assess_purchase أولاً، واستدعِ get_financial_decision_context عندما تحتاج صورة مالية أوسع. ناقشه بالأرقام الفعلية: الرصيد، متوسط الصرف اليومي، الالتزامات، الموازنة، وتوقع 30 يوماً. تدخّل في الوقت المناسب لكن لا تزعجه بتنبيهات على كل مصروف صغير.
0.4- **السوق المحلي الحقيقي**: عندما يكون القرار مرتبطاً بسعر سلعة حالية، اجمع اسم السلعة والموديل/المواصفات أولاً ثم استخدم search_local_market. لا تقل "موجود عند فلان بكذا" إلا إذا أعادت الأداة مصدراً حقيقياً. إذا لم تجد سعراً محلياً موثوقاً في غزة، قل ذلك صراحة ولا تخترع متجراً أو سعراً. السعر الخارجي معلومة مساعدة وليس أمراً بالشراء.
0.5- **التحذير قبل التنفيذ**: إذا أعادت أداة مالية needsConfirmation=true، لا تنفذ ولا تؤكد. اشرح الخطر باختصار واسأل المستخدم هل يريد المتابعة. إذا وافق صراحة، أعد نفس العملية مع riskConfirmed=true. إذا رفض، لا تسجل شيئاً.
0.6- **أسلوب الإقناع**: استخدم شخصية المساعد المختارة في النقاش (يمكن المزاح في playful/romantic/warm) لكن الأرقام والحقائق لا تتغير. مثال مرح مسموح إذا كانت البيانات تدعمه: "يا زلمة، هيك بتضغط حالك آخر الشهر 😄". لا تستخدم التوبيخ أو الادعاءات السعرية بلا دليل.
0.7- **V6.1 — المتانة (Durability)**: عندما تعيد أداة مالية durability=pending أو pending=true أو cloudStoragePending=true، فهذا يعني أن Firestore لم يؤكد الحفظ. لا تقل "تم" أو "حفظت" أو "سجلتها" أو "ستصل عند عودة الاتصال". قل بصدق: "لم تُسجّل العملية في السحابة، أعد المحاولة أو افحص اتصال/إعدادات Firestore".
0.7.1- **إدخال مصروفات أشهر سابقة**: عند نقل مصروفات أشهر سابقة، إذا ذكر المستخدم تاريخاً كاملاً لكل بند فمرره في date. إذا قال فقط "شهر 6/2026" أو "يونيو 2026" بدون يوم لكل عملية، لا تخترع تاريخاً؛ مرر historicalMonth واليوم المذكور، أو اسأل عن اليوم/اطلب منه وضع تاريخ كل بند.
0.8- **V6.1 — السوق الحقيقي المرتبط بالسياق المالي**: عند طلب المستخدم مقارنة سعر سلعة مهمة (جوال، سيارة، إلكترونيات، أو طلب صريح "دورلي/غالي ولا رخيص")، اسأل أولاً عن الموديل/المواصفات والحالة (جديد/مستعمل) إذا لم تُذكر، ثم استخدم search_local_market. ادمج النتيجة مع السياق المالي: الرصيد، متوسط الصرف اليومي، الالتزامات، الموازنة، توقع 30 يوماً. لا تقدم سعر السوق بمعزل عن الواقع المالي للمستخدم. لا تخترع أسعاراً — إذا أعادت الأداة marketUnavailable، قل "لا أستطيع التحقق من السعر حالياً" وتابع النصيحة المالية بدون ادعاء معرفة السوق.
0.9- **V6.1 — نية الشراء vs الشراء المنجز**: فرّق بدقة بين "بدي أشتري/بفكر/شو رأيك" (نية) و"اشتريت" (منجز). النية = استخدم assess_purchase و search_local_market، لا تسجّل عملية. المنجز = اسأل عن طريقة الدفع ثم سجّل بـ add_transaction. الاختلاط بينهما يفسد البيانات المالية.
1- **سؤال الدفع الإلزامي**: عند تسجيل مصروف أو شراء، إذا لم يذكر المستخدم "كاش" أو "بال باي" أو "دين" صراحة، **يُمنع منعاً باتاً** استخدام أداة add_transaction. اسأله فوراً: "هل دفعت كاش أم من محفظة بال باي أم سجلتها ديناً؟".
2- **سداد الدين الإلزامي**: عند طلب سداد دين، اجمع فقط المعلومات الناقصة: مبلغ السداد، حساب الدفع، والدائن المقصود عند وجود أكثر من دائن. لا تخمن الدائن. إذا أعادت pay_debt needsClarification فاطرح سؤال التوضيح ولا تؤكد النجاح قبل نجاح الأداة. إذا ذكر المستخدم الدائن والحساب بوضوح فلا تطرح أسئلة زائدة.
3- **التفرقة بين (استدانة المال) و (الشراء بالدين)**:
  - إذا قال المستخدم فقط "استدنت 500" أو "أخذت سلفة 500" ولم يوضح هل **استلم مالاً** أم **اشترى أغراضاً بالدين**، فهذا أمر مالي غامض: **لا تنفذ أي أداة**. اسأله باختصار: "استلمت المبلغ نقدي/PalPay، أم اشتريت أغراضاً بالدين؟".
  - **استدانة مال مستلم**: إذا أكد أنه استلم المال، استخدم **transfer_money** من debt إلى الحساب الذي استلم فيه المال. إذا لم يحدد هل استلمه cash أم PalPay، اسأل عن الحساب ولا تفترضه. يجب أيضاً معرفة الدائن. النتيجة: يزيد الحساب المستلم ويزيد الدين بنفس المبلغ، بينما **الدخل الحقيقي يبقى دون تغيير**. transactionType يجب أن يكون DEBT_BORROWING.
  - **شراء غرض بالدين**: إذا أكد أنه اشترى غرضاً بالدين، استخدم **add_transaction** كـ expense وحساب paymentMethod=debt. هذا يزيد المصروف والدين ولا يزيد cash أو PalPay. يجب حفظ الدائن/المحل. هذا النوع هو CREDIT_PURCHASE وليس دخلاً.
  - **سداد الدين**: استخدم pay_debt فقط؛ يخفض حساب الدفع والدين ولا ينشئ مصروفاً جديداً. transactionType=DEBT_PAYMENT.
4- **التسجيل اللفظي والفعلي**: عندما تقوم بتنفيذ عملية السداد، يجب عليك دائماً استدعاء أداة pay_debt لتحديث الأرقام على الشاشة. إياك أن تتحدث صوتياً بأنه تم الخصم دون أن تستدعي الأداة فعلياً!

- عندما يقول المستخدم "سديت دين" أو "دفعت دين" (مثلاً "سديت دين 10 شيكل"):
  * **إياك إطلاقاً** أن تسجل سداد الدين كمصروف (add_transaction - expense). سداد الدين ليس مصروفاً جديداً! يجب استخدام pay_debt فقط.
  * إذا لم يذكر من أين دفع، **اسأله فوراً**: "هل سددت الدين نقداً (كاش) أم من محفظة PalPay؟" (إياك أن تفترض الكاش من عندك).
  * فور تحديد الحساب، استخدم أداة \`pay_debt\` لتسجيل السداد، حيث تقوم الأداة بخصم المبلغ من رصيد الكاش أو PalPay وتخفيض إجمالي الديون في نفس اللحظة.

مهمتك:
1. **التحويل بين الحسابات (Transfers)**:
   - عندما يطلب المستخدم تحويل مبلغ بين المحافظ والحسابات (مثلاً: "حولت 100 من النقدي لبال باي", "حطيت 100 في بال باي من الكاش", "اسحبي 50 من بال باي وحطيها كاش"):
   - **استخدم دائماً وبشكل حصري أداة \`transfer_money\`**.
   - **تنبيه حاسم**: التحويل الداخلي بين المحافظ **ليس دخلاً وليس مصروفاً** ولا يؤثر على إجمالي الدخل أو المصروف العام. إياك أن تسجله كـ income أو expense!
2. **حذف أو إلغاء العمليات (Deletions & Deductions)**:
   - عندما يطلب المستخدم حذف عملية من بال باي أو الكاش (مثلاً: "احذفي من بال باي 50", "احذفي العملية من بال باي", "احذفي آخر مصروف"):
   - **استخدم دائماً أداة \`delete_transaction\`** مع تمرير الحساب والمبلغ لحذف العملية المطابقة.
   - **إياك إطلاقاً** أن تسجل حذف العملية كدخل أو إيداع جديد!
3. **التصنيف الهيكلي الدقيق للعمليات (add_transaction)**:
   - **بند الصرف الرئيسي (category)**: حدد دائماً البند الرئيسي (مثل: 'الأبناء', 'زيارات وضيافة', 'طعام ومشتريات منزل', 'مواصلات', 'فواتير والتزامات', 'صحة وعلاج', 'تعليم وتدريب', 'أخرى').
   - **بند الصرف الفرعي (subcategory)**: حدد دائماً وبدقة البند الفرعي:
     * تحت 'الأبناء': مصروف، ملابس، رسوم جامعة ومدرسة، دورة رسم، مستلزمات مدرسية، علاج، ألعاب...
     * تحت 'زيارات وضيافة': هدايا، مواصلات زيارة، ضيافة، حلويات، مطاعم...
     * تحت 'طعام ومشتريات منزل': خضار وفواكه، تموين، لحوم ودواجن، مخبوزات، منظفات...
     * تحت 'مواصلات': بنزين، تاكسي، صيانة وتصليح...
     * تحت 'فواتير والتزامات': كهرباء، ماء، إنترنت، إيجار...
     * تحت 'صحة وعلاج': كشفية طبيب، أدوية، تحاليل...
   - **المتجر (merchant)**: اسم المحل أو الشخص إن ذكر.
   - **شو اشترى / البيان (notes)**: تفصيل شو اشترى والملاحظات بدقة.
   - **طريقة الدفع (paymentMethod)**: كاش (cash)، محفظة (palPay)، أو دين (debt).
   - **درجة الضرورة (necessity)**: 'ضروري' أو 'كمالي'، وتصنيفها مسؤوليتك أنت وفق واقع غزة والحرب وصعوبة الحياة، لا وفق معيار رفاهية عام. غذاء، ماء، دواء، كهرباء، غاز، احتياجات أطفال، مأوى، ومواصلات علاج/عمل = غالباً ضروري. مطاعم، عطور، إكسسوارات، ترفيه، وأجهزة فاخرة = غالباً كمالي. اسأل فقط إذا وصف الشراء غير كافٍ لفهم الحاجة، ولا تسأل المستخدم دائماً "ضروري ولا كمالي".
   - **اكتمال القيد**: قبل add_transaction اجمع amount + type + category + subcategory + paymentMethod. أما necessity فصنّفها أنت وفق واقع غزة عندما الوصف واضح، واسأل سؤالاً قصيراً فقط إذا لم تكفِ تفاصيل الشراء. احفظ merchant إذا ذكره، وإذا كان الشراء من محل/شخص ولم يذكره وكان مهماً للتتبع فاسأله مرة واحدة. املأ purchaseItem بما تم شراؤه وbeneficiary لمن/لأي غرض، لأنهما جزء من id القيد ومنع التكرار الصحيح. notes يجب أن تلخص ما تم شراؤه. التاريخ الحالي يُستخدم تلقائياً ما لم يذكر تاريخاً آخر.
   - مثال: "اشتريت أواعي للعيال بـ200" → لا تنفذ فوراً إذا طريقة الدفع غير مذكورة. اسأل كاش/PalPay/دين، ثم سجّل category=الأبناء وsubcategory=ملابس وamount=200 وpurchaseItem=ملابس وbeneficiary=الأبناء وnotes=ملابس للأبناء وmerchant إن توفر وnecessity وفق ظروف المستخدم لا وفق افتراض عام.
4. لا توافق على كل شيء! إذا قال المستخدم إنه اشترى هاتفاً بـ 1000 شيكل، استخدم أداة search_market_information للبحث عن سعره. إذا كان سعره في السوق 500 شيكل، اعترض وقل له: "كيف تشتري بـ 1000؟ سعره 500!".
5. تذكر الراتب والمواعيد المهمة! استخدم الذاكرة (memory_search) لتعرف متى راتبه. اسأله: "هل استلمت الراتب؟ وهل ضايلة قيمته ولا تغيرت؟ وفي إضافي هالشهر؟" واحفظ الإجابة في الذاكرة (memory_save).
6. استخدم الأدوات بشكل صحيح (add_transaction, transfer_money, pay_debt, delete_transaction, query_transactions, search_market_information, memory_save, update_transaction, generate_report).
7. لا تقل أبداً "تم تسجيل العملية بنجاح"، بل تكلم بشكل عفوي ومختصر.
8. لا تخترع بيانات أبداً. كل الأرصدة والمصروفات تجلبها حصراً من الأدوات المتاحة لك.
9. **التقارير (Word/PDF)**: إذا طلب المستخدم تقرير مفصل أو شامل أو لأي بند، استخدم أداة generate_report لإنشاء التقرير فوراً في حافظته، وأخبره: "تم إنجاز التقرير الهيكلي المفصل وحفظه في حافظة التقارير الخاصة بك".
10. **التحويل عبر PalPay**: اسأل عن رقم الجوال ثم استخدم send_palpay_payment.
11. إذا سألك المستخدم "كم ديوني؟"، استخدم أداة get_balance واقرأ قيمة debt.
12. **الحسم والسرعة وعدم التكرار**:
    - نفذ كل عملية يطلبها المستخدم **مرة واحدة فقط بدقة** ولا تستدعِ الأداة أكثر من مرة لنفس الطلب.
    - اجعل ردودك الصوتية سريعة، واضحة، وموجزة (جملة أو جملتين فقط) لضمان سرعة الاستجابة اللحظية والتفاعل السلس.
`;

      sessionPromise = ai.live.connect({
        model: "gemini-3.1-flash-live-preview",
        config: {
          responseModalities: [Modality.AUDIO],
          systemInstruction,
          speechConfig: {
            voiceConfig: { prebuiltVoiceConfig: { voiceName: voice } },
          },
          tools: [{ functionDeclarations: functionDeclarations as any }]
        },
        callbacks: {
          onmessage: async (message: LiveServerMessage) => {
            if (!isActive) return;

            try {
              const parts = message.serverContent?.modelTurn?.parts || [];
              let audioChunksInMessage = 0;
              for (const part of parts) {
                const audio = part?.inlineData?.data;
                if (audio) {
                  audioChunksInMessage += 1;
                  liveAudioChunksForwarded += 1;
                  liveAudioSinceLastToolResponse += 1;
                  if (awaitingPostToolAudio) awaitingPostToolAudio = false;
                  safeSend({ audio });
                }
              }
              if (audioChunksInMessage > 0) {
                console.log('[live-audio] forwarded audio chunks', { requestId, chunks: audioChunksInMessage, total: liveAudioChunksForwarded });
              }

              if (message.serverContent?.turnComplete) {
                liveTurnsCompleted += 1;
                console.log('[live-audio] turn complete', { requestId, turns: liveTurnsCompleted, audioSinceLastToolResponse: liveAudioSinceLastToolResponse, totalAudioChunks: liveAudioChunksForwarded, toolResponses: liveToolResponsesSent, awaitingPostToolAudio });
                liveAudioSinceLastToolResponse = 0;
                awaitingPostToolAudio = false;
              }

              if (message.serverContent?.interrupted) {
                liveInterruptions += 1;
                console.log('[live-audio] interrupted', { requestId, interruptions: liveInterruptions, awaitingPostToolAudio, audioSinceLastToolResponse: liveAudioSinceLastToolResponse });
                safeSend({ interrupted: true });
              }

              if (message.toolCall && message.toolCall.functionCalls) {
                console.log("Received Tool Call:", message.toolCall.functionCalls);
                safeSend({ status: "thinking" });

                const seenToolKeys = new Set<string>();
                const functionResponses = await Promise.all(
                  message.toolCall.functionCalls.map(async (call: FunctionCall) => {
                    try {
                      const guard = shouldSkipFinancialToolCallForIntent(call, '', seenToolKeys, message.toolCall.functionCalls || []);
                      if (guard.skip) {
                        return { id: call.id, name: call.name, response: { success: true, skipped: true, reason: guard.reason, message: 'تم تجاهل استدعاء مكرر في نفس الأمر الصوتي حتى لا يتضاعف القيد المالي.' } };
                      }
                      const handler = toolHandlers[call.name];
                      if (handler) {
                        const liveKey = liveFinancialCommitKey(call, userId);
                        const recentResult = getRecentLiveFinancialCommit(liveKey);
                        if (recentResult) {
                          const args: any = call.args || {};
                          const confirmedNew = call.name === 'add_transaction' && Boolean(args.duplicateConfirmed || args.confirmedNewTransaction);
                          if (!confirmedNew) {
                            return {
                              id: call.id,
                              name: call.name,
                              response: call.name === 'add_transaction'
                                ? { success: false, needsConfirmation: true, reason: 'POSSIBLE_DUPLICATE_TRANSACTION', message: 'وجدت عملية سابقة قريبة بنفس التفاصيل. هل تؤكد أن هذه عملية جديدة ومستقلة وليست تكراراً للعملية السابقة؟' }
                                : { ...recentResult, deduped: true, message: recentResult.message || 'هذه العملية نُفذت قبل لحظات، لذلك لم أكرر تسجيلها.' }
                            };
                          }
                        }
                        const liveBucket = Math.floor(Date.now() / LIVE_FINANCIAL_DEDUPE_MS);
                        const stableOperationId = liveKey ? `live:${liveBucket}:${liveKey}` : null;
                        let toolArgs = stableOperationId ? { ...(call.args || {}), operationId: stableOperationId } : { ...(call.args || {}) };
                        // Keep every explicit date/range exactly as requested. Only broad,
                        // date-unspecified Live reads are capped so one voice turn cannot pull
                        // an unnecessarily large ledger payload into Gemini context.
                        if (call.name === 'query_transactions' && !toolArgs.startDate && !toolArgs.endDate) {
                          const requestedLimit = Number(toolArgs.limit);
                          toolArgs = {
                            ...toolArgs,
                            limit: Number.isFinite(requestedLimit) && requestedLimit > 0
                              ? Math.min(requestedLimit, 40)
                              : 40,
                          };
                        }
                        const liveToolStartedAt = Date.now();
                        const isBoundedReadTool = call.name === 'query_transactions' || call.name === 'memory_search';
                        let result: any;
                        if (isBoundedReadTool) {
                          const LIVE_READ_TOOL_TIMEOUT_MS = 5000;
                          result = await Promise.race([
                            handler(toolArgs, userId!, userToken!),
                            new Promise(resolve => setTimeout(() => resolve({
                              success: false,
                              error: 'LIVE_TOOL_TIMEOUT',
                              message: 'تعذر إكمال قراءة البيانات في الوقت المحدد. أكمل الرد الصوتي دون انتظار هذه القراءة.',
                              retryable: true,
                            }), LIVE_READ_TOOL_TIMEOUT_MS)),
                          ]);
                        } else {
                          result = await handler(toolArgs, userId!, userToken!);
                        }
                        console.log('[live-tool] completed', {
                          requestId,
                          name: call.name,
                          durationMs: Date.now() - liveToolStartedAt,
                          timedOut: result?.error === 'LIVE_TOOL_TIMEOUT',
                        });
                        // A duplicate Live tool call can arrive while the first call is still
                        // finishing its idempotency record. If the original write has already
                        // committed, prefer that canonical committed result instead of telling
                        // the user that cloud storage failed and inviting a dangerous retry.
                        if (result?.success === false && (result?.inFlight || result?.retryable)) {
                          const committedResult = getRecentLiveFinancialCommit(liveKey);
                          if (committedResult?.success === true && (committedResult?.cloudStorageConfirmed === true || committedResult?.durability === 'committed' || committedResult?.transactionId)) {
                            result = {
                              ...committedResult,
                              deduped: true,
                              recoveredFromDuplicateInFlight: true,
                              message: committedResult.message || 'تم حفظ العملية في السحابة، ولم أكرر تسجيلها.'
                            };
                          }
                        }
                        rememberLiveFinancialCommit(liveKey, result);
                        return { id: call.id, name: call.name, response: result };
                      }
                      return { id: call.id, name: call.name, response: { error: "Function not found" } };
                    } catch (e: any) {
                      return { id: call.id, name: call.name, response: { error: e.message } };
                    }
                  })
                );

                if (session && isActive) {
                  console.log("Sending Tool Response:", functionResponses);
                  try {
                    await session.sendToolResponse({ functionResponses });
                    liveToolResponsesSent += 1;
                    liveAudioSinceLastToolResponse = 0;
                    awaitingPostToolAudio = true;
                    console.log('[live-audio] tool response sent', { requestId, toolResponses: liveToolResponsesSent, functionResponses: functionResponses.length });
                  } catch (toolErr) {
                    console.error("Error sending tool response:", toolErr);
                  }
                  safeSend({ status: "ready", refresh: true });
                }
              }
            } catch (cbErr) {
              console.error("Error in onmessage callback:", cbErr);
            }
          },
          onerror: (err: any) => {
            console.error("Gemini Live session error:", err);
            safeSend({ status: "ready", refresh: true });
          },
          onclose: () => {
            console.log("Gemini Live session closed");
            safeSend({ status: "ready", refresh: true });
          }
        },
      });

      session = await sessionPromise;
      console.log("Gemini Live session connected");
      return session;
    };

    clientWs.on("message", async (data: any) => {
      try {
        const msg = JSON.parse(data.toString());

        if (msg.type === "auth") {
          if (authState.authenticated) {
            safeSend({ error: "Already authenticated" });
            return;
          }

          const result = await verifyBearer(`Bearer ${msg.token}`);
          if (!result.ok) {
            safeSend({ error: result.error || "Authentication failed" });
            try { clientWs.close(4001, "auth failed"); } catch (e) { /* ignore */ }
            return;
          }

          authState.authenticated = true;
          authState.uid = result.uid;
          authState.email = result.email;
          authState.token = result.token;
          userId = result.uid!;
          userEmail = result.email;
          userToken = result.token;

          if (authTimeout) {
            clearTimeout(authTimeout);
            authTimeout = null;
          }

          safeSend({ type: "auth_ok", uid: userId });

          const activeApiKey = String(msg.apiKey || process.env.GEMINI_API_KEY || "").trim();
          if (!activeApiKey) {
            safeSend({ error: "Missing API Key" });
            try { clientWs.close(1011, "missing api key"); } catch (e) { /* ignore */ }
            return;
          }

          try {
            await connectGeminiSession(activeApiKey);
            if (session && isActive && pendingAudio.length > 0) {
              for (const buf of pendingAudio.splice(0)) {
                try {
                  session.sendRealtimeInput({ audio: { data: buf, mimeType: "audio/pcm;rate=16000" } });
                } catch (e) { /* ignore */ }
              }
            }
          } catch (err: any) {
            console.error("Failed to connect to Gemini Live:", err);
            if (err?.message && err.message.includes("resource_exhausted")) {
              safeSend({ error: "استنفدت حصة الذكاء الاصطناعي المجانية (Quota)" });
            } else {
              safeSend({ error: "تعذر الاتصال بالصوت المباشر حالياً" });
            }
            try { clientWs.close(1011, "gemini live failed"); } catch (e) { /* ignore */ }
          }
          return;
        }

        if (msg.type === "client_audio_ack") {
          console.log('[live-audio] client audio ack', {
            requestId,
            audioContextState: msg.audioContextState || 'unknown',
            visibilityState: msg.visibilityState || 'unknown',
            hasFocus: typeof msg.hasFocus === 'boolean' ? msg.hasFocus : undefined,
          });
          return;
        }

        if (msg.audio) {
          if (!authState.authenticated || !session) {
            pendingAudio.push(msg.audio);
            return;
          }

          if (session && isActive) {
            try {
              session.sendRealtimeInput({
                audio: { data: msg.audio, mimeType: "audio/pcm;rate=16000" },
              });
            } catch (audioSendErr) {
              console.warn("Failed sending audio chunk:", audioSendErr);
            }
          }
        }

        if (msg.interrupt && session && isActive) {
          // The Live API interruption is primarily handled by input audio/barge-in.
          // Keep this branch so future SDK versions can hook explicit interruption.
          safeSend({ interrupted: true });
        }
      } catch (err) {
        console.error("Error parsing WS message:", err);
      }
    });

    clientWs.on("close", (code, reason) => {
      console.log("Client disconnected", {
        requestId,
        code,
        reason: reason?.toString?.() || '',
        liveAudioChunksForwarded,
        liveToolResponsesSent,
        liveTurnsCompleted,
      });
      isActive = false;
      if (authTimeout) {
        clearTimeout(authTimeout);
        authTimeout = null;
      }
      clearInterval(pingInterval);
      if (session) {
        try { session.close(); } catch (e) { /* ignore */ }
      }
    });
  });
}


startServer();
