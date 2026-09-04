/**
 * Financial Report Utilities
 * Provides hierarchical grouping by Main Category -> Subcategory -> Transaction Details
 * and builds high-fidelity printable / Word-exportable formats.
 */

import { parseAbsoluteFinancialAmount } from './amount';
import { calculateBalances, normalizeAccount } from './balanceCalc';

export interface HierarchicalTransactionItem {
  id: string;
  amount: number;
  type: 'expense' | 'income' | 'transfer';
  account: 'cash' | 'palPay' | 'debt';
  accountLabel: string;
  category: string;
  subcategory: string;
  merchant: string;
  notes: string;
  necessity: 'ضروري' | 'كمالي';
  date: string;
  formattedDate: string;
  formattedTime: string;
  dayName: string;
}

export interface SubcategoryGroup {
  name: string;
  total: number;
  count: number;
  percentageOfCategory: number;
  percentageOfTotal: number;
  items: HierarchicalTransactionItem[];
}

export interface MainCategoryGroup {
  name: string;
  icon?: string;
  total: number;
  count: number;
  percentageOfTotal: number;
  subcategories: SubcategoryGroup[];
}

export interface HierarchicalReportData {
  totalExpenses: number;
  totalIncome: number;
  netSavings: number;
  totalDebt: number;
  totalCash: number;
  totalPalPay: number;
  necessaryTotal: number;
  necessaryPercentage: number;
  luxuryTotal: number;
  luxuryPercentage: number;
  categories: MainCategoryGroup[];
  incomes: HierarchicalTransactionItem[];
  debts: HierarchicalTransactionItem[];
  allTransactionsCount: number;
  topCategoryName: string;
  topCategoryAmount: number;
  recommendations: string[];
}

export type ReportSnapshotRecord = {
  userId: string;
  title: string;
  timeframe: string;
  category: string;
  status: 'empty' | 'completed';
  date: string;
  isSnapshot: true;
  generatedAt: string;
  transactions: Record<string, unknown>[];
  createdAt: string;
};

export function buildReportSnapshotRecord(input: {
  userId: string;
  title: string;
  timeframe: string;
  category: string;
  transactions: Record<string, unknown>[];
  now?: Date;
}): ReportSnapshotRecord {
  const generatedAt = (input.now || new Date()).toISOString();
  return {
    userId: input.userId,
    title: input.title,
    timeframe: input.timeframe,
    category: input.category,
    status: input.transactions.length === 0 ? 'empty' : 'completed',
    date: generatedAt,
    isSnapshot: true,
    generatedAt,
    transactions: input.transactions,
    createdAt: generatedAt,
  };
}

export function normalizeArabic(text: string): string {
  if (!text) return '';
  return text
    .toLowerCase()
    .trim()
    .replace(/[إأآا]/g, 'ا')
    .replace(/ة/g, 'ه')
    .replace(/[ىي]/g, 'ي')
    .replace(/[\u064B-\u065F\u0670]/g, '') // remove tashkeel
    .replace(/\s+/g, ' ');
}

// Check if a text contains any of the given keywords as complete words or distinct sub-phrases
function containsAnyWord(text: string, keywords: string[]): boolean {
  if (!text) return false;
  const norm = normalizeArabic(text);
  const words = norm.split(/[\s,،.\-_/\\+()]+/).filter(Boolean);
  
  return keywords.some(k => {
    const normK = normalizeArabic(k);
    if (normK.includes(' ')) {
      return norm.includes(normK);
    }
    return words.includes(normK);
  });
}

const CHILDREN_KEYWORDS = [
  'ابناء', 'الابناء', 'اولاد', 'الاولاد', 'اطفال', 'الاطفال', 'طفل', 'طفله',
  'بنين', 'بنات', 'مدارس', 'مدرسه', 'مدرسي', 'مدرسيه', 'جامعه', 'جامعي',
  'جامعيه', 'روضه', 'حضانه', 'حفاضات', 'بامبرز', 'حليب اطفال', 'العاب اطفال',
  'العاب اولاد', 'ملابس اطفال', 'ملابس اولاد', 'ملابس بنات', 'قرطاسيه',
  'دفاتر', 'شنطه مدرسيه', 'حقيبه مدرسيه', 'اقساط مدرسيه', 'قسط مدرسه',
  'قسط جامعه', 'مصروف الابناء', 'مصروف الاولاد', 'مصروف اطفال', 'تعليم'
];

const FOOD_KEYWORDS = [
  'طعام', 'اكل', 'بقاله', 'سوبرماركت', 'خضار', 'فواكه', 'لحوم', 'دواجن',
  'اسماك', 'سمك', 'دجاج', 'مطعم', 'مخبز', 'خبز', 'تموين', 'منظفات',
  'مشتريات منزل', 'شاي', 'قهوه', 'زيت', 'سكر', 'ارز', 'معلبات'
];

const VISITS_KEYWORDS = [
  'زيارات', 'ضيافه', 'هدايا', 'هديه', 'مناسبات', 'واجب', 'عزومه',
  'حلويات', 'شوكولاته', 'كيك', 'عشاء ضيوف', 'ضيافه عيد', 'عيديات'
];

const TRANSPORT_KEYWORDS = [
  'مواصلات', 'بنزين', 'وقود', 'سولار', 'سياره', 'تاكسي', 'صيانه سياره',
  'سرفيس', 'كراج', 'غسيل سياره', 'زيت سياره', 'موقف'
];

const BILLS_KEYWORDS = [
  'فواتير', 'فاتوره', 'كهرباء', 'مياه', 'ماء', 'نت', 'انترنت', 'ايجار',
  'اقساط', 'اشتراك', 'مولد', 'تلفون', 'جوال', 'شحن رصيد'
];

const HEALTH_KEYWORDS = [
  'صحه', 'علاج', 'ادويه', 'دواء', 'صيدليه', 'عياده', 'طبيب', 'دكتور',
  'مستشفي', 'تحاليل', 'فحوصات', 'نظارات', 'اسنان'
];

export function matchesArabicCategory(tx: any, query: string): boolean {
  if (!query || query === 'all' || query === 'الكل' || query === 'كافة البنود' || query === 'عام' || query === 'التقرير الشامل') {
    return true;
  }
  
  const normQuery = normalizeArabic(query);
  const normCat = normalizeArabic(tx.category || '');
  const normSub = normalizeArabic(tx.subcategory || '');
  const normNotes = normalizeArabic(tx.notes || '');
  const normMerchant = normalizeArabic(tx.merchant || '');

  // Determine query target cluster
  const isChildrenQuery = containsAnyWord(normQuery, CHILDREN_KEYWORDS);
  const isFoodQuery = containsAnyWord(normQuery, FOOD_KEYWORDS);
  const isVisitsQuery = containsAnyWord(normQuery, VISITS_KEYWORDS);
  const isTransportQuery = containsAnyWord(normQuery, TRANSPORT_KEYWORDS);
  const isBillsQuery = containsAnyWord(normQuery, BILLS_KEYWORDS);
  const isHealthQuery = containsAnyWord(normQuery, HEALTH_KEYWORDS);

  if (isChildrenQuery) {
    // 1. Direct category match
    if (normCat.includes('ابناء') || normCat.includes('اولاد') || normCat.includes('اطفال') || normCat.includes('تعليم')) {
      return true;
    }
    // 2. If it belongs explicitly to another main category, only match if subcategory specifically targets children
    const isOtherExplicitCategory = (
      (normCat.includes('طعام') || normCat.includes('بقاله')) ||
      (normCat.includes('مواصلات') || normCat.includes('بنزين') || normCat.includes('سيار')) ||
      (normCat.includes('فواتير') || normCat.includes('كهرباء') || normCat.includes('ماء') || normCat.includes('ايجار')) ||
      (normCat.includes('صحه') || normCat.includes('علاج') || normCat.includes('ادوي')) ||
      (normCat.includes('زيارات') || normCat.includes('ضياف'))
    );

    if (isOtherExplicitCategory) {
      return containsAnyWord(normSub, CHILDREN_KEYWORDS);
    }

    return (
      containsAnyWord(normSub, CHILDREN_KEYWORDS) ||
      containsAnyWord(normNotes, CHILDREN_KEYWORDS) ||
      containsAnyWord(normMerchant, CHILDREN_KEYWORDS)
    );
  }

  if (isFoodQuery) {
    if (normCat.includes('طعام') || normCat.includes('مشتريات') || normCat.includes('بقاله')) return true;
    return containsAnyWord(normSub, FOOD_KEYWORDS) || containsAnyWord(normNotes, FOOD_KEYWORDS);
  }

  if (isVisitsQuery) {
    if (normCat.includes('زيارات') || normCat.includes('ضياف') || normCat.includes('هدايا')) return true;
    return containsAnyWord(normSub, VISITS_KEYWORDS) || containsAnyWord(normNotes, VISITS_KEYWORDS);
  }

  if (isTransportQuery) {
    if (normCat.includes('مواصلات') || normCat.includes('سيار') || normCat.includes('بنزين')) return true;
    return containsAnyWord(normSub, TRANSPORT_KEYWORDS) || containsAnyWord(normNotes, TRANSPORT_KEYWORDS);
  }

  if (isBillsQuery) {
    if (normCat.includes('فواتير') || normCat.includes('التزامات') || normCat.includes('كهرباء') || normCat.includes('ماء') || normCat.includes('ايجار')) return true;
    return containsAnyWord(normSub, BILLS_KEYWORDS) || containsAnyWord(normNotes, BILLS_KEYWORDS);
  }

  if (isHealthQuery) {
    if (normCat.includes('صحه') || normCat.includes('علاج') || normCat.includes('ادوي')) return true;
    return containsAnyWord(normSub, HEALTH_KEYWORDS) || containsAnyWord(normNotes, HEALTH_KEYWORDS);
  }

  // Fallback: Direct exact or token match
  if (normCat && normCat === normQuery) return true;
  if (normSub && normSub === normQuery) return true;
  if (normCat && normCat.includes(normQuery)) return true;
  if (normSub && normSub.includes(normQuery)) return true;

  return false;
}

const arabicDays = ['الأحد', 'الاثنين', 'الثلاثاء', 'الأربعاء', 'الخميس', 'الجمعة', 'السبت'];

export function formatArabicDate(dateStr: string): { dayName: string; dateFormatted: string; timeFormatted: string } {
  try {
    const d = new Date(dateStr || Date.now());
    if (isNaN(d.getTime())) {
      return { dayName: 'اليوم', dateFormatted: new Date().toLocaleDateString('ar-EG'), timeFormatted: '' };
    }
    const dayName = arabicDays[d.getDay()];
    const dateFormatted = `${d.getFullYear()}/${String(d.getMonth() + 1).padStart(2, '0')}/${String(d.getDate()).padStart(2, '0')}`;
    const hours = d.getHours();
    const minutes = String(d.getMinutes()).padStart(2, '0');
    const ampm = hours >= 12 ? 'م' : 'ص';
    const hour12 = hours % 12 || 12;
    const timeFormatted = `${hour12}:${minutes} ${ampm}`;
    return { dayName, dateFormatted, timeFormatted };
  } catch {
    return { dayName: 'اليوم', dateFormatted: '', timeFormatted: '' };
  }
}

export function normalizeAccountLabel(account: string, paymentMethod?: string): { code: 'cash' | 'palPay' | 'debt'; label: string } {
  const code = normalizeAccount(paymentMethod || account);
  if (code === 'debt') return { code, label: 'دين / ذمة' };
  if (code === 'palPay') return { code, label: 'محفظة PalPay' };
  return { code, label: 'نقدي (كاش)' };
}

export function normalizeNecessity(necessity?: string, type?: string): 'ضروري' | 'كمالي' {
  if (type === 'income') return 'ضروري';
  const str = String(necessity || '').toLowerCase();
  if (str.includes('كمالي') || str.includes('luxury') || str.includes('ترفيه') || str.includes('غير ضروري')) {
    return 'كمالي';
  }
  return 'ضروري';
}

export function buildHierarchicalReport(transactions: any[]): HierarchicalReportData {
  const expenseItems: HierarchicalTransactionItem[] = [];
  const incomeItems: HierarchicalTransactionItem[] = [];
  const debtItems: HierarchicalTransactionItem[] = [];

  let totalExpenses = 0;
  let totalIncome = 0;
  let necessaryTotal = 0;
  let luxuryTotal = 0;

  (transactions || []).forEach((t) => {
    const amount = parseAbsoluteFinancialAmount(t.amount);
    const txType = String(t.type || 'expense').toLowerCase();
    const isExpense = txType === 'expense';
    const isIncome = txType === 'income';
    const isTransfer = txType === 'transfer';
    const accInfo = normalizeAccountLabel(t.account, t.paymentMethod);
    const necessity = normalizeNecessity(t.necessity, t.type);
    const { dayName, dateFormatted, timeFormatted } = formatArabicDate(t.date || t.createdAt);

    const item: HierarchicalTransactionItem = {
      id: t.id || Math.random().toString(), amount,
      type: isExpense ? 'expense' : isIncome ? 'income' : 'transfer',
      account: accInfo.code, accountLabel: accInfo.label,
      category: (t.category || 'غير مصنف').trim(), subcategory: (t.subcategory || 'عام').trim(),
      merchant: (t.merchant || '').trim(), notes: (t.notes || '').trim(), necessity,
      date: t.date || new Date().toISOString(), formattedDate: `${dayName} ${dateFormatted}`, formattedTime: timeFormatted, dayName
    };

    if (isExpense) {
      expenseItems.push(item); totalExpenses += amount;
      if (accInfo.code === 'debt') debtItems.push(item);
      if (necessity === 'ضروري') necessaryTotal += amount; else luxuryTotal += amount;
    } else if (isIncome) {
      incomeItems.push(item); totalIncome += amount;
    } else if (isTransfer) {
      // Transfers affect canonical balances but are not category expenses/incomes in this report.
    }
  });
  const ledgerBalances = calculateBalances(transactions || []);
  const totalDebt = Math.max(0, ledgerBalances.debt);
  const totalCash = ledgerBalances.cash;
  const totalPalPay = ledgerBalances.palPay;

  // Group Expenses by Main Category -> Subcategory
  const categoryMap = new Map<string, Map<string, HierarchicalTransactionItem[]>>();

  expenseItems.forEach((item) => {
    const mainCat = item.category || 'مصروفات عامة';
    const subCat = item.subcategory || 'بند عام';

    if (!categoryMap.has(mainCat)) {
      categoryMap.set(mainCat, new Map());
    }
    const subMap = categoryMap.get(mainCat)!;
    if (!subMap.has(subCat)) {
      subMap.set(subCat, []);
    }
    subMap.get(subCat)!.push(item);
  });

  const categories: MainCategoryGroup[] = [];

  categoryMap.forEach((subMap, mainCatName) => {
    let categoryTotal = 0;
    let categoryCount = 0;
    const subcategories: SubcategoryGroup[] = [];

    subMap.forEach((items, subCatName) => {
      const subTotal = items.reduce((sum, i) => sum + i.amount, 0);
      categoryTotal += subTotal;
      categoryCount += items.length;

      // Sort items by date descending
      items.sort((a, b) => new Date(b.date).getTime() - new Date(a.date).getTime());

      subcategories.push({
        name: subCatName,
        total: subTotal,
        count: items.length,
        percentageOfCategory: 0, // calculated below
        percentageOfTotal: totalExpenses > 0 ? (subTotal / totalExpenses) * 100 : 0,
        items
      });
    });

    // Calculate percentage of category for each subcategory
    subcategories.forEach((sub) => {
      sub.percentageOfCategory = categoryTotal > 0 ? (sub.total / categoryTotal) * 100 : 0;
    });

    // Sort subcategories by total amount descending
    subcategories.sort((a, b) => b.total - a.total);

    categories.push({
      name: mainCatName,
      total: categoryTotal,
      count: categoryCount,
      percentageOfTotal: totalExpenses > 0 ? (categoryTotal / totalExpenses) * 100 : 0,
      subcategories
    });
  });

  // Sort main categories by total amount descending
  categories.sort((a, b) => b.total - a.total);

  const necessaryPercentage = totalExpenses > 0 ? (necessaryTotal / totalExpenses) * 100 : 0;
  const luxuryPercentage = totalExpenses > 0 ? (luxuryTotal / totalExpenses) * 100 : 0;
  const netSavings = totalIncome - totalExpenses;

  // Recommendations and insights
  const recommendations: string[] = [];
  if (categories.length > 0) {
    recommendations.push(`البند الأكثر استهلاكاً للميزانية هو "${categories[0].name}" بمبلغ ${categories[0].total.toLocaleString()} ₪ (${categories[0].percentageOfTotal.toFixed(1)}% من إجمالي المصروفات).`);
  }
  if (luxuryPercentage > 25) {
    recommendations.push(`نسبة الإنفاق على الكماليات بلغت ${luxuryPercentage.toFixed(1)}% (${luxuryTotal.toLocaleString()} ₪). يُنصح بترشيد بعض البنود غير الأساسية لتعزيز الوفر المالي.`);
  } else {
    recommendations.push(`معدل الإنفاق الضروري ممتاز ومتزن حيث يمثل ${necessaryPercentage.toFixed(1)}% من إجمالي مصروفاتك.`);
  }
  if (totalDebt > 0) {
    recommendations.push(`يوجد التزامات مؤجلة (ديون مسجلة) بقيمة ${totalDebt.toLocaleString()} ₪، يفضل جدولتها ضمن خطة السداد القادمة.`);
  }
  if (netSavings >= 0) {
    recommendations.push(`الوضع المالي إيجابي بفائض قدره ${netSavings.toLocaleString()} ₪ متاح للادخار أو الطوارئ.`);
  } else {
    recommendations.push(`تنبيه: المصروفات تجاوزت المداخيل المسجلة بعجز قدره ${Math.abs(netSavings).toLocaleString()} ₪.`);
  }

  return {
    totalExpenses,
    totalIncome,
    netSavings,
    totalDebt,
    totalCash,
    totalPalPay,
    necessaryTotal,
    necessaryPercentage,
    luxuryTotal,
    luxuryPercentage,
    categories,
    incomes: incomeItems.sort((a, b) => new Date(b.date).getTime() - new Date(a.date).getTime()),
    debts: debtItems.sort((a, b) => new Date(b.date).getTime() - new Date(a.date).getTime()),
    allTransactionsCount: (transactions || []).length,
    topCategoryName: categories.length > 0 ? categories[0].name : 'لا يوجد',
    topCategoryAmount: categories.length > 0 ? categories[0].total : 0,
    recommendations
  };
}

/**
 * Builds standard Word HTML export content with high-fidelity formatting and Arabic RTL.
 */
export function buildWordDocumentContent(
  reportTitle: string,
  reportDate: string,
  userName: string,
  data: HierarchicalReportData
): string {
  let categoriesHtml = '';

  data.categories.forEach((cat, catIdx) => {
    let subcategoriesHtml = '';

    cat.subcategories.forEach((sub, subIdx) => {
      let rowsHtml = '';
      sub.items.forEach((item, itemIdx) => {
        const necessityBadge = item.necessity === 'ضروري' 
          ? '<span style="color:#16a34a;font-weight:bold;">🟢 ضروري</span>' 
          : '<span style="color:#ca8a04;font-weight:bold;">🟡 كمالي</span>';
        
        const paymentBadge = item.account === 'debt' 
          ? '<span style="color:#dc2626;font-weight:bold;">📋 دين</span>'
          : item.account === 'palPay'
          ? '<span style="color:#2563eb;font-weight:bold;">📱 PalPay</span>'
          : '<span style="color:#475569;">💵 كاش</span>';

        rowsHtml += `
          <tr style="background-color:${itemIdx % 2 === 0 ? '#ffffff' : '#f8fafc'};">
            <td style="padding:8px 10px;border:1px solid #cbd5e1;font-size:11pt;text-align:right;">${item.formattedDate}</td>
            <td style="padding:8px 10px;border:1px solid #cbd5e1;font-size:11pt;text-align:right;font-weight:600;color:#0f172a;">${item.notes || item.subcategory || 'شراء متفرقات'}</td>
            <td style="padding:8px 10px;border:1px solid #cbd5e1;font-size:11pt;text-align:right;color:#475569;">${item.merchant || '—'}</td>
            <td style="padding:8px 10px;border:1px solid #cbd5e1;font-size:11pt;text-align:center;">${paymentBadge}</td>
            <td style="padding:8px 10px;border:1px solid #cbd5e1;font-size:11pt;text-align:center;">${necessityBadge}</td>
            <td style="padding:8px 10px;border:1px solid #cbd5e1;font-size:11pt;text-align:left;font-weight:bold;color:#b91c1c;">${item.amount.toLocaleString()} ₪</td>
          </tr>
        `;
      });

      subcategoriesHtml += `
        <div style="margin-top:14px;margin-bottom:14px;">
          <div style="background-color:#e2e8f0;padding:6px 12px;border-right:4px solid #0284c7;font-weight:bold;font-size:12pt;color:#0f172a;display:flex;justify-content:space-between;">
            <span>📌 البند الفرعي: ${sub.name} (${sub.count} عملية)</span>
            <span style="float:left;color:#0369a1;">المجموع الفرعي: ${sub.total.toLocaleString()} ₪</span>
          </div>
          <table style="width:100%;border-collapse:collapse;margin-top:6px;direction:rtl;" border="1" cellpadding="6" cellspacing="0">
            <thead>
              <tr style="background-color:#0f172a;color:#ffffff;font-size:11pt;text-align:right;">
                <th style="padding:8px;border:1px solid #0f172a;width:22%;">اليوم والتاريخ</th>
                <th style="padding:8px;border:1px solid #0f172a;width:30%;">البيان / شو اشتريت</th>
                <th style="padding:8px;border:1px solid #0f172a;width:16%;">المتجر / الجهة</th>
                <th style="padding:8px;border:1px solid #0f172a;width:12%;text-align:center;">طريقة الدفع</th>
                <th style="padding:8px;border:1px solid #0f172a;width:10%;text-align:center;">الأهمية</th>
                <th style="padding:8px;border:1px solid #0f172a;width:10%;text-align:left;">المبلغ</th>
              </tr>
            </thead>
            <tbody>
              ${rowsHtml}
            </tbody>
            <tfoot>
              <tr style="background-color:#f1f5f9;font-weight:bold;">
                <td colspan="5" style="padding:8px 10px;border:1px solid #cbd5e1;text-align:right;color:#0f172a;">مجموع بند (${sub.name})</td>
                <td style="padding:8px 10px;border:1px solid #cbd5e1;text-align:left;color:#b91c1c;font-size:12pt;">${sub.total.toLocaleString()} ₪</td>
              </tr>
            </tfoot>
          </table>
        </div>
      `;
    });

    categoriesHtml += `
      <div style="margin-top:28px;margin-bottom:20px;border:2px solid #0f172a;border-radius:6px;padding:14px;background-color:#ffffff;">
        <div style="background-color:#0f172a;color:#ffffff;padding:10px 14px;font-size:14pt;font-weight:bold;display:flex;justify-content:space-between;align-items:center;">
          <span>📂 [${catIdx + 1}] بند الصرف الرئيسي: ${cat.name}</span>
          <span style="float:left;background-color:#38bdf8;color:#0f172a;padding:2px 10px;border-radius:4px;font-size:12pt;">
            الإجمالي: ${cat.total.toLocaleString()} ₪ (${cat.percentageOfTotal.toFixed(1)}%)
          </span>
        </div>
        ${subcategoriesHtml}
      </div>
    `;
  });

  return `
    <html xmlns:o='urn:schemas-microsoft-com:office:office' xmlns:w='urn:schemas-microsoft-com:office:word' xmlns='http://www.w3.org/TR/REC-html40'>
    <head>
      <meta charset='utf-8'>
      <title>${reportTitle}</title>
      <!--[if gte mso 9]>
      <xml>
        <w:WordDocument>
          <w:View>Print</w:View>
          <w:Zoom>100</w:Zoom>
          <w:DoNotOptimizeForBrowser/>
        </w:WordDocument>
      </xml>
      <![endif]-->
      <style>
        body { font-family: 'Segoe UI', Tahoma, Arial, sans-serif; direction: rtl; text-align: right; margin: 20px; color: #0f172a; }
        table { border-collapse: collapse; width: 100%; mso-table-lspace:0pt; mso-table-rspace:0pt; }
        th, td { border: 1px solid #cbd5e1; padding: 8px; }
        h1, h2, h3, h4 { margin: 0; padding: 0; }
        .page-break { page-break-before: always; }
      </style>
    </head>
    <body style="direction:rtl;text-align:right;">
      <div style="text-align:center;border-bottom:3px solid #0f172a;padding-bottom:14px;margin-bottom:20px;">
        <h1 style="color:#0f172a;font-size:22pt;margin-bottom:6px;">${reportTitle}</h1>
        <p style="color:#64748b;font-size:12pt;margin:0;">المستشار والمصرفي المالي الذكي | حساب: <strong>${userName}</strong></p>
        <p style="color:#64748b;font-size:10pt;margin-top:4px;">تاريخ التقرير: ${reportDate}</p>
      </div>

      <!-- Financial Summary Cards -->
      <table style="width:100%;margin-bottom:24px;border:none;">
        <tr>
          <td style="background-color:#fee2e2;border:2px solid #ef4444;padding:12px;text-align:center;width:25%;">
            <div style="font-size:11pt;color:#991b1b;font-weight:bold;">إجمالي المصروفات</div>
            <div style="font-size:18pt;color:#dc2626;font-weight:bold;margin-top:4px;">${data.totalExpenses.toLocaleString()} ₪</div>
          </td>
          <td style="background-color:#dcfce7;border:2px solid #22c55e;padding:12px;text-align:center;width:25%;">
            <div style="font-size:11pt;color:#166534;font-weight:bold;">إجمالي الدخل</div>
            <div style="font-size:18pt;color:#16a34a;font-weight:bold;margin-top:4px;">${data.totalIncome.toLocaleString()} ₪</div>
          </td>
          <td style="background-color:#e0f2fe;border:2px solid #0284c7;padding:12px;text-align:center;width:25%;">
            <div style="font-size:11pt;color:#075985;font-weight:bold;">صافي الوفر / الفائض</div>
            <div style="font-size:18pt;color:#0284c7;font-weight:bold;margin-top:4px;">${data.netSavings.toLocaleString()} ₪</div>
          </td>
          <td style="background-color:#fef3c7;border:2px solid #f59e0b;padding:12px;text-align:center;width:25%;">
            <div style="font-size:11pt;color:#92400e;font-weight:bold;">الديون والالتزامات</div>
            <div style="font-size:18pt;color:#d97706;font-weight:bold;margin-top:4px;">${data.totalDebt.toLocaleString()} ₪</div>
          </td>
        </tr>
      </table>

      <!-- Executive Overview Table -->
      <h3 style="color:#0f172a;font-size:14pt;border-bottom:2px solid #cbd5e1;padding-bottom:6px;margin-bottom:12px;">
        📊 جدول التوزيع الإحصائي للبنود الرئيسية
      </h3>
      <table style="width:100%;border-collapse:collapse;margin-bottom:24px;">
        <thead>
          <tr style="background-color:#1e293b;color:#ffffff;font-size:11pt;">
            <th style="padding:8px;text-align:right;">البند الرئيسي</th>
            <th style="padding:8px;text-align:center;">عدد البنود الفرعية</th>
            <th style="padding:8px;text-align:center;">عدد العمليات</th>
            <th style="padding:8px;text-align:center;">النسبة من المصروفات</th>
            <th style="padding:8px;text-align:left;">إجمالي المبلغ</th>
          </tr>
        </thead>
        <tbody>
          ${data.categories.map((c, i) => `
            <tr style="background-color:${i % 2 === 0 ? '#ffffff' : '#f8fafc'};">
              <td style="padding:8px;font-weight:bold;">${c.name}</td>
              <td style="padding:8px;text-align:center;">${c.subcategories.length}</td>
              <td style="padding:8px;text-align:center;">${c.count}</td>
              <td style="padding:8px;text-align:center;font-weight:bold;color:#0284c7;">${c.percentageOfTotal.toFixed(1)}%</td>
              <td style="padding:8px;text-align:left;font-weight:bold;color:#b91c1c;">${c.total.toLocaleString()} ₪</td>
            </tr>
          `).join('')}
        </tbody>
        <tfoot>
          <tr style="background-color:#0f172a;color:#ffffff;font-weight:bold;">
            <td colspan="4" style="padding:10px;text-align:right;">المجموع الكلي لكافة المصروفات</td>
            <td style="padding:10px;text-align:left;color:#38bdf8;font-size:13pt;">${data.totalExpenses.toLocaleString()} ₪</td>
          </tr>
        </tfoot>
      </table>

      <!-- Detailed Breakdown Section -->
      <h2 style="color:#0f172a;font-size:16pt;margin-top:24px;border-bottom:3px solid #0284c7;padding-bottom:6px;">
        📑 تفصيل الصرف الكامل (البنود الرئيسية > البنود الفرعية > المعاملات)
      </h2>
      ${categoriesHtml}

      <!-- Insights and Recommendations -->
      <div style="margin-top:30px;background-color:#f8fafc;border:2px solid #94a3b8;border-radius:6px;padding:16px;">
        <h3 style="color:#0f172a;font-size:13pt;margin-bottom:8px;">💡 ملاحظات وتحليلات المستشار المالي</h3>
        <ul style="margin:0;padding-right:20px;font-size:11pt;color:#334155;">
          ${data.recommendations.map(r => `<li style="margin-bottom:6px;">${r}</li>`).join('')}
        </ul>
      </div>

      <div style="margin-top:40px;text-align:center;font-size:10pt;color:#94a3b8;border-top:1px solid #e2e8f0;padding-top:10px;">
        تم استخراج هذا التقرير آلياً عبر منصة المصرفي الذكي — تم التنسيق والتدقيق الهيكلي المالي
      </div>
    </body>
    </html>
  `;
}

/**
 * Builds a beautifully formatted plain-text / WhatsApp-ready report summary.
 */
export function buildWhatsAppReportText(title: string, dateStr: string, userName: string, data: HierarchicalReportData): string {
  let text = `📊 *${title}*\n`;
  text += `👤 *المستخدم:* ${userName}\n`;
  text += `📅 *التاريخ:* ${dateStr}\n`;
  text += `━━━━━━━━━━━━━━━━━━━━━\n\n`;

  text += `💰 *المؤشرات المالية الرئيسية:*\n`;
  text += `🔻 *إجمالي المصروفات:* ${data.totalExpenses.toLocaleString()} ₪\n`;
  text += `🟢 *إجمالي الدخل:* ${data.totalIncome.toLocaleString()} ₪\n`;
  text += `💎 *صافي الوفر:* ${data.netSavings >= 0 ? '+' : ''}${data.netSavings.toLocaleString()} ₪\n`;
  if (data.totalDebt > 0) {
    text += `📋 *إجمالي الديون والالتزامات:* ${data.totalDebt.toLocaleString()} ₪\n`;
  }
  text += `⚖️ *الضروريات:* ${data.necessaryPercentage.toFixed(1)}% | *الكماليات:* ${data.luxuryPercentage.toFixed(1)}%\n\n`;

  text += `📂 *تفصيل المصروفات حسب البنود الرئيسية:*\n`;
  data.categories.forEach((cat, idx) => {
    text += `\n*${idx + 1}. ${cat.name}*: ${cat.total.toLocaleString()} ₪ (${cat.percentageOfTotal.toFixed(1)}%)\n`;
    cat.subcategories.slice(0, 4).forEach(sub => {
      text += `   • ${sub.name}: ${sub.total.toLocaleString()} ₪ (${sub.count} عملية)\n`;
    });
  });

  if (data.recommendations.length > 0) {
    text += `\n💡 *أهم التوصيات المالية:*\n`;
    data.recommendations.slice(0, 2).forEach(rec => {
      text += `▫️ ${rec}\n`;
    });
  }

  text += `\n━━━━━━━━━━━━━━━━━━━━━\n`;
  text += `_تم استخراج التقرير بواسطة منصة المصرفي الذكي 🤖_`;

  return text;
}

