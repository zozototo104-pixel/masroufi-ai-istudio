type InputScalar = string | number | boolean | null | undefined;

export type TransactionLike = Record<string, unknown> & {
  id?: InputScalar;
  amount?: InputScalar;
  type?: InputScalar;
  account?: InputScalar;
  fromAccount?: InputScalar;
  toAccount?: InputScalar;
  transactionType?: InputScalar;
  date?: InputScalar;
  createdAt?: InputScalar;
  category?: InputScalar;
  subcategory?: InputScalar;
  merchant?: InputScalar;
  necessity?: InputScalar;
  notes?: InputScalar;
};

type TreasurerReportArgs = Record<string, unknown> & {
  period?: unknown;
  timeframe?: unknown;
  year?: unknown;
  month?: unknown;
  quarter?: unknown;
  startDate?: unknown;
  endDate?: unknown;
  category?: unknown;
  type?: unknown;
  necessity?: unknown;
  title?: unknown;
  allocations?: unknown;
  split?: unknown;
  incomeSplit?: unknown;
};

type SavingsGoalLike = Record<string, unknown> & {
  id?: unknown;
  name?: unknown;
  targetAmount?: unknown;
  savedAmount?: unknown;
  dueDate?: unknown;
  status?: unknown;
};

type SummaryRow = Record<string, unknown> & {
  total: number;
  count: number;
};

type MonthRow = {
  month: string;
  income: number;
  expense: number;
  transfer: number;
  debtPurchases: number;
  netCashFlow: number;
  count: number;
};

type CategoryRow = SummaryRow & {
  category: string;
  budgetLimit: number;
  remaining: number;
  percentage: number | null;
};

type SubcategoryRow = SummaryRow & { category: string; subcategory: string };
type MerchantRow = SummaryRow & { merchant: string };
type NecessityRow = SummaryRow & { necessity: string };

type BalanceSnapshot = { cash?: number; palPay?: number; debt?: number; total?: number };

type TreasurerNoteInput = {
  totalIncome: number;
  totalExpense: number;
  net: number;
  savingsRate: number | null;
  overspending: CategoryRow[];
  nearLimits: CategoryRow[];
  categoryRows: CategoryRow[];
};

function asObject(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

export type CategorySuggestion = {
  category: string;
  subcategory: string;
  confidence: 'high' | 'medium' | 'low';
  source: 'explicit' | 'rule' | 'fallback';
  isNewCategory: boolean;
  reason: string;
};

export const TREASURER_CATEGORY_TAXONOMY: Record<string, string[]> = {
  'الأبناء': ['مصروف يومي', 'ملابس', 'رسوم جامعة ومدرسة', 'دورات وتدريب', 'مستلزمات مدرسية', 'علاج', 'ألعاب وترفيه', 'مواصلات الأبناء'],
  'طعام ومشتريات منزل': ['خضار وفواكه', 'تموين', 'لحوم ودواجن', 'مخبوزات', 'منظفات', 'مياه وغاز', 'مطاعم ووجبات', 'حلويات'],
  'زيارات وضيافة': ['هدايا', 'مواصلات زيارة', 'ضيافة', 'حلويات', 'مطاعم', 'مناسبات'],
  'مواصلات': ['بنزين', 'تاكسي', 'مواصلات عامة', 'صيانة وتصليح', 'ترخيص وتأمين'],
  'فواتير والتزامات': ['كهرباء', 'ماء', 'إنترنت', 'إيجار', 'اتصالات', 'اشتراكات', 'أقساط'],
  'صحة وعلاج': ['كشفية طبيب', 'أدوية', 'تحاليل', 'طوارئ', 'علاج أسنان', 'تأمين صحي'],
  'تعليم وتدريب': ['جامعة', 'مدرسة', 'دورات', 'كتب وقرطاسية', 'مواصلات تعليم'],
  'ادخار واستثمار': ['ادخار طارئ', 'هدف شراء', 'تعليم الأبناء', 'استثمار', 'احتياطي'],
  'سداد ديون والتزامات': ['سداد دين', 'سداد قسط', 'تسوية حساب'],
  'إلكترونيات ومشتريات كبيرة': ['جوال', 'لابتوب', 'أجهزة منزلية', 'صيانة أجهزة', 'إكسسوارات'],
  'أخرى': ['غير مصنف', 'متفرقات']
};

const CATEGORY_RULES: Array<{ category: string; subcategory: string; keywords: string[] }> = [
  { category: 'الأبناء', subcategory: 'ملابس', keywords: ['عيال', 'اولاد', 'أولاد', 'ابن', 'بنت', 'ملابس اطفال', 'اواعي', 'أواعي', 'لبس للعيال'] },
  { category: 'الأبناء', subcategory: 'رسوم جامعة ومدرسة', keywords: ['جامعة', 'مدرسة', 'قسط جامعة', 'رسوم مدرسة', 'روضة', 'حضانة'] },
  { category: 'الأبناء', subcategory: 'مستلزمات مدرسية', keywords: ['شنطة مدرسة', 'دفاتر', 'قرطاسية', 'زي مدرسة', 'مكتبة'] },
  { category: 'الأبناء', subcategory: 'علاج', keywords: ['طبيب أطفال', 'دكتور للولد', 'دواء للولد', 'علاج بنتي', 'علاج ابني'] },
  { category: 'طعام ومشتريات منزل', subcategory: 'خضار وفواكه', keywords: ['خضار', 'فواكه', 'بندورة', 'بطاطا', 'موز', 'تفاح', 'خيار'] },
  { category: 'طعام ومشتريات منزل', subcategory: 'تموين', keywords: ['تموين', 'سوبرماركت', 'رز', 'سكر', 'زيت', 'طحين', 'معلبات', 'بقالة'] },
  { category: 'طعام ومشتريات منزل', subcategory: 'لحوم ودواجن', keywords: ['لحمة', 'لحم', 'دجاج', 'فراخ', 'سمك'] },
  { category: 'طعام ومشتريات منزل', subcategory: 'مخبوزات', keywords: ['خبز', 'مخبز', 'كعك', 'معجنات'] },
  { category: 'طعام ومشتريات منزل', subcategory: 'منظفات', keywords: ['منظفات', 'كلور', 'صابون', 'مسحوق', 'سائل جلي'] },
  { category: 'زيارات وضيافة', subcategory: 'هدايا', keywords: ['هدية', 'هدايا', 'زيارة', 'عزومة', 'مباركة'] },
  { category: 'زيارات وضيافة', subcategory: 'ضيافة', keywords: ['ضيافة', 'حلويات زيارة', 'قهوة للضيوف', 'شوكولاتة'] },
  { category: 'مواصلات', subcategory: 'بنزين', keywords: ['بنزين', 'سولار', 'وقود'] },
  { category: 'مواصلات', subcategory: 'تاكسي', keywords: ['تاكسي', 'أجرة', 'مواصلات', 'مشوار'] },
  { category: 'مواصلات', subcategory: 'صيانة وتصليح', keywords: ['ميكانيكي', 'تصليح سيارة', 'كوشوك', 'زيت سيارة', 'صيانة سيارة'] },
  { category: 'فواتير والتزامات', subcategory: 'كهرباء', keywords: ['كهرباء', 'مولد', 'شحن كهربا'] },
  { category: 'فواتير والتزامات', subcategory: 'ماء', keywords: ['مياه', 'ماء', 'تنك مياه'] },
  { category: 'فواتير والتزامات', subcategory: 'إنترنت', keywords: ['انترنت', 'إنترنت', 'راوتر', 'نت'] },
  { category: 'فواتير والتزامات', subcategory: 'إيجار', keywords: ['ايجار', 'إيجار', 'أجرة البيت'] },
  { category: 'صحة وعلاج', subcategory: 'أدوية', keywords: ['صيدلية', 'دواء', 'أدوية', 'علاج'] },
  { category: 'صحة وعلاج', subcategory: 'كشفية طبيب', keywords: ['دكتور', 'طبيب', 'كشفية', 'عيادة'] },
  { category: 'تعليم وتدريب', subcategory: 'دورات', keywords: ['دورة', 'كورس', 'تدريب'] },
  { category: 'إلكترونيات ومشتريات كبيرة', subcategory: 'جوال', keywords: ['ايفون', 'آيفون', 'iphone', 'سامسونج', 'جوال', 'موبايل', 'هاتف'] },
  { category: 'إلكترونيات ومشتريات كبيرة', subcategory: 'لابتوب', keywords: ['لابتوب', 'كمبيوتر', 'حاسوب', 'macbook', 'ماك بوك'] },
  { category: 'ادخار واستثمار', subcategory: 'ادخار طارئ', keywords: ['ادخار', 'وفرت', 'حوشة', 'تحويشة', 'طوارئ'] },
  { category: 'سداد ديون والتزامات', subcategory: 'سداد دين', keywords: ['سداد دين', 'سديت دين', 'دفعت دين', 'دين'] }
];

export function normalizeArabicText(value: unknown): string {
  return String(value || '')
    .toLowerCase()
    .replace(/[أإآ]/g, 'ا')
    .replace(/ى/g, 'ي')
    .replace(/ة/g, 'ه')
    .replace(/[ـًٌٍَُِّْ]/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

export type NecessitySuggestion = {
  necessity: 'ضروري' | 'كمالي' | 'محتاج تأكيد';
  confidence: 'high' | 'medium' | 'low';
  reason: string;
  warContext: true;
};

const GAZA_NECESSITY_RULES: Array<{ necessity: 'ضروري' | 'كمالي' | 'محتاج تأكيد'; confidence: 'high' | 'medium' | 'low'; keywords: string[]; reason: string }> = [
  { necessity: 'ضروري', confidence: 'high', keywords: ['خبز','طحين','دقيق','رز','سكر','زيت','عدس','فول','معلبات','تموين','بقاله','بقالة','خضار','بطاطا','بندوره','بندورة','مياه','ماء','تنك مياه','غاز','حليب','حفاض','حفاظ','رضاعه','رضاعة'], reason: 'غذاء/ماء/تموين أساسي، وفي واقع غزة والحرب هذا يُعامل كضرورة.' },
  { necessity: 'ضروري', confidence: 'high', keywords: ['دواء','ادويه','أدوية','صيدليه','صيدلية','دكتور','طبيب','عياده','عيادة','تحاليل','اسعاف','إسعاف','طوارئ','علاج','حليب اطفال','حليب أطفال'], reason: 'صحة وعلاج؛ هذا لا يُعامل كمالي في ظروف الحرب وصعوبة الوصول للخدمات.' },
  { necessity: 'ضروري', confidence: 'high', keywords: ['كهرباء','شحن كهربا','شحن كهرباء','مولد','بطاريه','بطارية','اناره','إنارة','شمع','كشاف','باور بانك','غاز طبخ'], reason: 'طاقة/إنارة/طبخ أساسي في ظروف الانقطاع والحرب.' },
  { necessity: 'ضروري', confidence: 'medium', keywords: ['مواصلات','مشوار','تاكسي','اجره','أجرة','بنزين','سولار'], reason: 'المواصلات قد تكون ضرورة للعمل أو العلاج أو قضاء حاجة أساسية في غزة.' },
  { necessity: 'ضروري', confidence: 'medium', keywords: ['ملابس اطفال','ملابس للاطفال','لبس للعيال','حذاء للاطفال','بطانيه','بطانية','فرشه','فراش','حرام','نايلون','خيمه','خيمة'], reason: 'احتياج عائلي/أطفال/مأوى؛ غالباً ضروري في واقع النزوح والحرب.' },
  { necessity: 'محتاج تأكيد', confidence: 'medium', keywords: ['جوال','موبايل','هاتف','شاحن','سماعه','سماعة','راوتر','انترنت','إنترنت','لابتوب','كمبيوتر'], reason: 'قد يكون ضرورياً للتواصل والعمل والتعليم والأمان، وقد يكون كمالياً حسب السعر والبديل والحاجة.' },
  { necessity: 'محتاج تأكيد', confidence: 'medium', keywords: ['هدية','هدايا','ضيافه','ضيافة','زياره','زيارة','حلويات'], reason: 'قد تكون اجتماعية مهمة، لكنها تحتاج تقدير حسب الوضع والميزانية.' },
  { necessity: 'كمالي', confidence: 'medium', keywords: ['مطعم','وجبه جاهزه','وجبة جاهزة','قهوه','قهوة','حلويات فخمه','اكسسوار','إكسسوار','عطر','ميك اب','مكياج','لعبه','لعبة'], reason: 'غالباً كمالي إذا لم يكن مرتبطاً بحالة صحية أو عائلية مباشرة.' },
  { necessity: 'كمالي', confidence: 'high', keywords: ['ايفون','آيفون','iphone','بلايستيشن','playstation','ساعة ذكية','تابلت للترفيه'], reason: 'مشتريات كبيرة/ترفيهية غالباً كمالية ما لم يثبت أنها للعمل أو الأمان أو ضرورة تواصل.' }
];

export function inferNecessityForGazaContext(input: { category?: unknown; subcategory?: unknown; notes?: unknown; merchant?: unknown; item?: unknown; amount?: unknown }): NecessitySuggestion {
  const text = normalizeArabicText(`${input.category || ''} ${input.subcategory || ''} ${input.notes || ''} ${input.merchant || ''} ${input.item || ''}`);
  for (const rule of GAZA_NECESSITY_RULES) {
    if (rule.keywords.some(k => text.includes(normalizeArabicText(k)))) {
      return { necessity: rule.necessity, confidence: rule.confidence, reason: rule.reason, warContext: true };
    }
  }
  const amount = Number(input.amount) || 0;
  if (amount >= 1000) return { necessity: 'محتاج تأكيد', confidence: 'medium', reason: 'المبلغ كبير؛ يجب تحديد هل هو حاجة قاهرة أم يمكن تأجيله.', warContext: true };
  return { necessity: 'محتاج تأكيد', confidence: 'low', reason: 'الوصف لا يكفي للحكم على الضرورة وفق واقع غزة؛ يلزم سؤال مختصر.', warContext: true };
}

export function inferCategory(input: {
  type?: unknown;
  category?: unknown;
  subcategory?: unknown;
  notes?: unknown;
  merchant?: unknown;
  item?: unknown;
}): CategorySuggestion {
  const explicitCategory = String(input.category || '').trim();
  const explicitSubcategory = String(input.subcategory || '').trim();
  const knownCategories = new Set(Object.keys(TREASURER_CATEGORY_TAXONOMY));
  if (explicitCategory && explicitSubcategory) {
    return {
      category: explicitCategory,
      subcategory: explicitSubcategory,
      confidence: knownCategories.has(explicitCategory) ? 'high' : 'medium',
      source: 'explicit',
      isNewCategory: !knownCategories.has(explicitCategory),
      reason: knownCategories.has(explicitCategory) ? 'التصنيف مذكور صراحة.' : 'المستخدم أدخل تصنيفاً جديداً؛ سيتم قبوله بمرونة.'
    };
  }

  const text = normalizeArabicText(`${input.category || ''} ${input.subcategory || ''} ${input.notes || ''} ${input.merchant || ''} ${input.item || ''}`);
  for (const rule of CATEGORY_RULES) {
    if (rule.keywords.some(k => text.includes(normalizeArabicText(k)))) {
      return {
        category: explicitCategory || rule.category,
        subcategory: explicitSubcategory || rule.subcategory,
        confidence: explicitCategory || explicitSubcategory ? 'medium' : 'high',
        source: 'rule',
        isNewCategory: false,
        reason: `تم التصنيف حسب كلمات دلالية مرتبطة بـ ${rule.category}/${rule.subcategory}.`
      };
    }
  }

  if (explicitCategory) {
    const fallbackSub = explicitSubcategory || 'متفرقات';
    return {
      category: explicitCategory,
      subcategory: fallbackSub,
      confidence: knownCategories.has(explicitCategory) ? 'medium' : 'low',
      source: 'fallback',
      isNewCategory: !knownCategories.has(explicitCategory),
      reason: 'تم قبول البند الرئيسي كما أدخله المستخدم، مع بند فرعي افتراضي قابل للتعديل.'
    };
  }

  return {
    category: 'أخرى',
    subcategory: explicitSubcategory || 'غير مصنف',
    confidence: 'low',
    source: 'fallback',
    isNewCategory: false,
    reason: 'لم تكفِ البيانات لتصنيف أدق؛ يجب سؤال المستخدم إذا كانت العملية مهمة.'
  };
}

export function getDateRange(args: TreasurerReportArgs, now = new Date()): { start?: Date; end?: Date; label: string; granularity: 'day' | 'month' | 'quarter' | 'year' | 'all' } {
  const period = String(args?.period || args?.timeframe || 'all');
  const year = Number(args?.year) || now.getFullYear();
  const month = Number(args?.month);
  const quarter = Number(args?.quarter);
  if (args?.startDate || args?.endDate) {
    return {
      start: args.startDate ? startOfDay(new Date(String(args.startDate))) : undefined,
      end: args.endDate ? endOfDay(new Date(String(args.endDate))) : undefined,
      label: `من ${args.startDate || 'البداية'} إلى ${args.endDate || 'اليوم'}`,
      granularity: 'day'
    };
  }
  if (period === 'today') {
    return { start: startOfDay(now), end: endOfDay(now), label: 'اليوم', granularity: 'day' };
  }
  if (period === 'week' || period === 'this_week') {
    return { start: startOfDay(new Date(now.getTime() - 7 * 86400000)), end: endOfDay(now), label: 'آخر 7 أيام', granularity: 'day' };
  }
  if (period === 'month' || period === 'this_month' || month) {
    const m = month ? month - 1 : now.getMonth();
    const y = month ? year : now.getFullYear();
    return { start: new Date(y, m, 1), end: endOfDay(new Date(y, m + 1, 0)), label: `${y}-${String(m + 1).padStart(2, '0')}`, granularity: 'month' };
  }
  if (period === 'quarter' || quarter) {
    const q = Math.min(4, Math.max(1, quarter || Math.floor(now.getMonth() / 3) + 1));
    const startMonth = (q - 1) * 3;
    return { start: new Date(year, startMonth, 1), end: endOfDay(new Date(year, startMonth + 3, 0)), label: `الربع ${q} / ${year}`, granularity: 'quarter' };
  }
  if (period === 'year' || args?.year) {
    return { start: new Date(year, 0, 1), end: endOfDay(new Date(year, 11, 31)), label: `سنة ${year}`, granularity: 'year' };
  }
  return { label: 'كل الفترات', granularity: 'all' };
}

function startOfDay(d: Date) { const x = new Date(d); x.setHours(0,0,0,0); return x; }
function endOfDay(d: Date) { const x = new Date(d); x.setHours(23,59,59,999); return x; }

export function filterTransactionsByDate(txs: TransactionLike[], range: { start?: Date; end?: Date }): TransactionLike[] {
  return txs.filter(t => {
    const rawDate = t.date || t.createdAt || 0;
    const ts = new Date(typeof rawDate === 'number' ? rawDate : String(rawDate)).getTime();
    if (!Number.isFinite(ts)) return false;
    if (range.start && ts < range.start.getTime()) return false;
    if (range.end && ts > range.end.getTime()) return false;
    return true;
  });
}

function txMonth(t: TransactionLike): string {
  return String(t.date || t.createdAt || '').slice(0, 7) || 'غير مؤرخ';
}

function round(n: number) { return Math.round((Number(n) || 0) * 100) / 100; }

function addToMap<T extends SummaryRow>(map: Map<string, T>, key: string, seed: T, amount: number) {
  const current = map.get(key) || { ...seed };
  current.total = round((Number(current.total) || 0) + amount);
  current.count = (Number(current.count) || 0) + 1;
  map.set(key, current);
}

export function buildTreasurerReport(args: TreasurerReportArgs, allTransactions: TransactionLike[], budgets: Record<string, number> = {}, savingsGoals: SavingsGoalLike[] = []) {
  const range = getDateRange(args);
  let txs = filterTransactionsByDate(allTransactions, range);
  const categoryQuery = String(args?.category || '').trim();
  if (categoryQuery && !['all', 'الكل', 'كافة البنود'].includes(categoryQuery)) {
    const q = normalizeArabicText(categoryQuery);
    txs = txs.filter(t => normalizeArabicText(`${t.category || ''} ${t.subcategory || ''} ${t.notes || ''}`).includes(q));
  }
  if (args?.type) txs = txs.filter(t => t.type === args.type);
  if (args?.necessity) txs = txs.filter(t => t.necessity === args.necessity);

  const expenses = txs.filter(t => t.type === 'expense');
  const incomes = txs.filter(t => t.type === 'income' && t.transactionType !== 'DEBT_BORROWING');
  const transfers = txs.filter(t => t.type === 'transfer');
  const debtPurchases = expenses.filter(t => t.transactionType === 'CREDIT_PURCHASE' || t.account === 'debt');
  const paidByCash = expenses.filter(t => t.account === 'cash').reduce((s, t) => s + (Number(t.amount) || 0), 0);
  const paidByPalPay = expenses.filter(t => t.account === 'palPay').reduce((s, t) => s + (Number(t.amount) || 0), 0);
  const onDebt = debtPurchases.reduce((s, t) => s + (Number(t.amount) || 0), 0);

  const byMonth = new Map<string, MonthRow>();
  const byCategory = new Map<string, CategoryRow>();
  const bySubcategory = new Map<string, SubcategoryRow>();
  const byMerchant = new Map<string, MerchantRow>();
  const byNecessity = new Map<string, NecessityRow>();

  for (const t of txs) {
    const amount = Number(t.amount) || 0;
    const month = txMonth(t);
    const category = String(t.category || 'أخرى');
    const subcategory = String(t.subcategory || 'غير مصنف');
    const merchant = String(t.merchant || 'غير محدد');
    const necessity = String(t.necessity || (t.type === 'expense' ? 'غير محدد' : ''));
    const m = byMonth.get(month) || { month, income: 0, expense: 0, transfer: 0, debtPurchases: 0, netCashFlow: 0, count: 0 };
    if (t.type === 'income') m.income = round(m.income + amount);
    if (t.type === 'expense') m.expense = round(m.expense + amount);
    if (t.type === 'transfer') m.transfer = round(m.transfer + amount);
    if (t.transactionType === 'CREDIT_PURCHASE' || t.account === 'debt') m.debtPurchases = round(m.debtPurchases + amount);
    m.netCashFlow = round(m.income - m.expense);
    m.count++;
    byMonth.set(month, m);

    if (t.type === 'expense') {
      addToMap(byCategory, category, { category, total: 0, count: 0, budgetLimit: Number(budgets[category] || 0), remaining: 0, percentage: 0 }, amount);
      addToMap(bySubcategory, `${category} / ${subcategory}`, { category, subcategory, total: 0, count: 0 }, amount);
      addToMap(byMerchant, merchant, { merchant, total: 0, count: 0 }, amount);
      if (necessity) addToMap(byNecessity, necessity, { necessity, total: 0, count: 0 }, amount);
    }
  }

  const categoryRows: CategoryRow[] = Array.from(byCategory.values()).map((r) => {
    const limit = Number(r.budgetLimit || 0);
    return { ...r, remaining: round(limit - r.total), percentage: limit > 0 ? Math.round(r.total / limit * 100) : null };
  }).sort((a, b) => b.total - a.total);

  const totalExpense = round(expenses.reduce((s, t) => s + (Number(t.amount) || 0), 0));
  const totalIncome = round(incomes.reduce((s, t) => s + (Number(t.amount) || 0), 0));
  const net = round(totalIncome - totalExpense);
  const savingsRate = totalIncome > 0 ? Math.round(net / totalIncome * 100) : null;
  const highTransactions = expenses
    .slice()
    .sort((a, b) => (Number(b.amount) || 0) - (Number(a.amount) || 0))
    .slice(0, 15)
    .map(t => ({ id: t.id, date: t.date, amount: t.amount, category: t.category, subcategory: t.subcategory, merchant: t.merchant, necessity: t.necessity, paymentMethod: t.account, notes: t.notes }));

  const overspending = categoryRows.filter((r) => r.percentage !== null && r.percentage >= 100);
  const nearLimits = categoryRows.filter((r) => r.percentage !== null && r.percentage >= 80 && r.percentage < 100);
  const monthlyRows = Array.from(byMonth.values()).sort((a, b) => String(a.month).localeCompare(String(b.month)));

  return {
    title: args?.title || `تقرير أمين الصندوق - ${range.label}`,
    rangeLabel: range.label,
    generatedAt: new Date().toISOString(),
    counts: { transactions: txs.length, expenses: expenses.length, incomes: incomes.length, transfers: transfers.length },
    totals: {
      income: totalIncome,
      expense: totalExpense,
      netCashFlow: net,
      paidByCash: round(paidByCash),
      paidByPalPay: round(paidByPalPay),
      creditPurchases: round(onDebt),
      savingsRate
    },
    byMonth: monthlyRows,
    byCategory: categoryRows,
    bySubcategory: Array.from(bySubcategory.values()).sort((a, b) => b.total - a.total),
    byMerchant: Array.from(byMerchant.values()).sort((a, b) => b.total - a.total).slice(0, 30),
    byNecessity: Array.from(byNecessity.values()).sort((a, b) => b.total - a.total),
    highTransactions,
    overspending,
    nearLimits,
    savingsGoals: savingsGoals.map(g => ({
      id: g.id,
      name: g.name,
      targetAmount: Number(g.targetAmount || 0),
      savedAmount: Number(g.savedAmount || 0),
      remaining: round((Number(g.targetAmount || 0) - Number(g.savedAmount || 0))),
      dueDate: g.dueDate || '',
      status: g.status || 'active'
    })),
    charts: {
      categoryPie: categoryRows.map((r) => ({ label: r.category, value: r.total })),
      monthlyCashflow: monthlyRows.map((r) => ({ month: r.month, income: r.income, expense: r.expense, net: r.netCashFlow })),
      subcategoryBar: Array.from(bySubcategory.values()).sort((a, b) => b.total - a.total).slice(0, 20).map((r) => ({ label: `${r.category}/${r.subcategory}`, value: r.total })),
      merchantBar: Array.from(byMerchant.values()).sort((a, b) => b.total - a.total).slice(0, 15).map((r) => ({ label: r.merchant, value: r.total }))
    },
    treasurerNotes: buildTreasurerNotes({ totalIncome, totalExpense, net, savingsRate, overspending, nearLimits, categoryRows })
  };
}

function buildTreasurerNotes(input: TreasurerNoteInput): string[] {
  const notes: string[] = [];
  if (input.totalIncome > 0 && input.net < 0) notes.push(`أنت صرفت أكثر من دخلك في هذه الفترة بفارق ${Math.abs(input.net)} ₪. هذا يحتاج فرملة فورية يا كبير.`);
  if (input.savingsRate !== null && input.savingsRate < 10) notes.push(`نسبة الادخار الظاهرة ${input.savingsRate}% فقط. الأفضل رفعها تدريجياً إلى 10%-20% حسب ظروفك.`);
  if (input.overspending?.length) notes.push(`فيه تجاوزات صريحة في: ${input.overspending.map((r) => `${r.category} (${r.percentage}%)`).join('، ')}.`);
  if (input.nearLimits?.length) notes.push(`بنود قريبة من السقف: ${input.nearLimits.map((r) => `${r.category} (${r.percentage}%)`).join('، ')}.`);
  const top = input.categoryRows?.[0];
  if (top) notes.push(`أعلى بند صرف هو ${top.category} بمبلغ ${top.total} ₪.`);
  if (!notes.length) notes.push('الوضع منضبط نسبياً في هذه الفترة، لكن راقب الكماليات والالتزامات القادمة.');
  return notes;
}

export function evaluateTreasurerRisk(params: {
  amount: number;
  type: string;
  account: string;
  category: string;
  subcategory?: string;
  necessity?: string;
  merchant?: string;
  balances: BalanceSnapshot;
  budgetLimit?: number;
  categorySpent?: number;
  dailyExpenseAverage?: number;
  projected30DayBalance?: number;
  savingsReserveTarget?: number;
  riskConfirmed?: boolean;
}) {
  const warnings: string[] = [];
  const amount = Number(params.amount) || 0;
  if (params.type !== 'expense') return { needsConfirmation: false, severity: 'none', warnings };
  const available = params.account === 'palPay' ? Number(params.balances?.palPay || 0) : params.account === 'cash' ? Number(params.balances?.cash || 0) : Number(params.balances?.total || 0);
  const after = params.account === 'debt' ? available : available - amount;
  const projected = Number(params.projected30DayBalance || 0) - (params.account === 'debt' ? 0 : amount);
  const daily = Number(params.dailyExpenseAverage || 0);
  const coverageDays = daily > 0 && params.account !== 'debt' ? Math.floor(Math.max(0, after) / daily) : null;
  const categoryProjected = Number(params.categorySpent || 0) + amount;
  const pct = Number(params.budgetLimit || 0) > 0 ? Math.round(categoryProjected / Number(params.budgetLimit) * 100) : null;
  if (params.account !== 'debt' && amount > available + 0.0001) warnings.push(`المبلغ أكبر من الرصيد المتاح في الحساب (${available} ₪).`);
  if (pct !== null && pct >= 100) warnings.push(`هذا يرفع بند ${params.category} إلى ${pct}% من سقفه الشهري.`);
  else if (pct !== null && pct >= 80) warnings.push(`هذا يقرّب بند ${params.category} من السقف (${pct}%).`);
  if (String(params.necessity || '') === 'كمالي' && amount >= 300) warnings.push(`مصروف كمالي كبير (${amount} ₪)، لازم موافقة صريحة قبل التسجيل.`);
  if (amount >= 1000) warnings.push(`عملية كبيرة بقيمة ${amount} ₪؛ أمين الصندوق يطلب تأكيداً واعياً.`);
  if (coverageDays !== null && coverageDays < 14) warnings.push(`بعد العملية يغطي الرصيد تقريباً ${coverageDays} يوم فقط حسب متوسط صرفك.`);
  if (projected < 0) warnings.push(`توقع 30 يوماً بعد العملية يصبح سالباً (${Math.abs(Math.round(projected))} ₪ عجز تقريبي).`);
  if (Number(params.savingsReserveTarget || 0) > 0 && after < Number(params.savingsReserveTarget)) warnings.push(`العملية تهبط بالسيولة تحت احتياطي الادخار/الأمان المحدد (${params.savingsReserveTarget} ₪).`);
  const severity = warnings.some(w => /عجز|أكبر من الرصيد|سالب/.test(w)) ? 'critical' : warnings.length ? 'warning' : 'none';
  return { needsConfirmation: warnings.length > 0 && !params.riskConfirmed, severity, warnings, availableBefore: available, availableAfter: after, budgetPercentageAfter: pct, coverageDays, projected30DayBalanceAfter: round(projected) };
}

export function normalizeIncomeAllocations(args: TreasurerReportArgs): Array<{ account: 'cash' | 'palPay'; amount: number; note?: string }> {
  const raw = Array.isArray(args?.allocations) ? args.allocations
    : Array.isArray(args?.split) ? args.split
    : Array.isArray(args?.incomeSplit) ? args.incomeSplit
    : [];
  const allocations: Array<{ account: 'cash' | 'palPay'; amount: number; note?: string }> = [];
  for (const rawItem of raw) {
    const item = asObject(rawItem);
    const amount = Math.abs(Number(item.amount) || 0);
    const txt = normalizeArabicText(item.account || item.paymentMethod || item.wallet || '');
    const account = txt.includes('pal') || txt.includes('بال') || txt.includes('محفظ') ? 'palPay' : 'cash';
    if (amount > 0) allocations.push({ account, amount, note: String(item.note || item.notes || '') });
  }
  return allocations;
}

export function needsIncomeAllocationQuestion(args: TreasurerReportArgs, type: string, paymentWasProvided: boolean): boolean {
  if (type !== 'income') return false;
  if (paymentWasProvided) return false;
  if (normalizeIncomeAllocations(args).length > 0) return false;
  const text = normalizeArabicText(`${args?.category || ''} ${args?.notes || ''}`);
  return text.includes('راتب') || text.includes('دخل') || text.includes('قبض') || text.includes('استلمت') || text.includes('ايداع') || text.includes('إيداع') || true;
}
