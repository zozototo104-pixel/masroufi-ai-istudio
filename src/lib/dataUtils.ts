// Helper functions for Data Export & Import (JSON, CSV, Excel)

export interface BackupDataPayload {
  version: string;
  exportDate: string;
  app: string;
  userEmail?: string;
  transactions: any[];
  budgets?: Record<string, number>;
  commitments?: any[];
  reports?: any[];
  memory?: Record<string, string>;
}

// Convert transactions list to UTF-8 BOM CSV compatible with Excel and Google Sheets
export function exportTransactionsToCSV(transactions: any[], userName: string = 'المستخدم'): string {
  const headers = [
    'المعرف (ID)',
    'التاريخ والوقت',
    'النوع',
    'المبلغ (₪)',
    'التصنيف الرئيسي',
    'البند الفرعي',
    'البيان / ملاحظات',
    'المتجر / الجهة',
    'طريقة الدفع / الحساب',
    'درجة الضرورة'
  ];

  const escapeCSV = (str: any) => {
    if (str === null || str === undefined) return '""';
    const s = String(str).replace(/"/g, '""');
    return `"${s}"`;
  };

  const rows = transactions.map(t => [
    escapeCSV(t.id || ''),
    escapeCSV(t.date ? new Date(t.date).toLocaleString('ar-EG') : (t.createdAt || '')),
    escapeCSV(t.type === 'income' ? 'دخل / إيداع' : t.type === 'transfer' ? (t.transactionType === 'DEBT_BORROWING' ? 'استدانة مال' : t.transactionType === 'DEBT_PAYMENT' ? 'سداد دين' : 'تحويل داخلي') : 'مصروف / سحب'),
    t.amount !== undefined ? Number(t.amount) : 0,
    escapeCSV(t.category || 'غير مصنف'),
    escapeCSV(t.subcategory || ''),
    escapeCSV(t.notes || ''),
    escapeCSV(t.merchant || ''),
    escapeCSV(t.account === 'debt' ? 'دين' : t.account === 'palPay' ? 'PalPay' : 'كاش'),
    escapeCSV(t.necessity || (t.type === 'expense' ? 'ضروري' : '—'))
  ]);

  // Prepend UTF-8 BOM (\uFEFF) so Arabic text displays properly in Excel
  const csvContent = '\uFEFF' + [
    headers.join(','),
    ...rows.map(row => row.join(','))
  ].join('\r\n');

  return csvContent;
}

// Download a blob or string to user's computer/phone
export function triggerFileDownload(content: string, filename: string, mimeType: string = 'application/json') {
  const blob = new Blob([content], { type: `${mimeType};charset=utf-8;` });
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  link.setAttribute('download', filename);
  document.body.appendChild(link);
  link.click();
  document.body.removeChild(link);
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

// Parse CSV text into transaction items
export function parseCSVToTransactions(csvText: string): any[] {
  // Remove BOM if present
  let cleanText = csvText.replace(/^\uFEFF/, '').trim();
  const lines = cleanText.split(/\r?\n/).filter(line => line.trim().length > 0);
  if (lines.length <= 1) return [];

  const parseLine = (line: string): string[] => {
    const result: string[] = [];
    let current = '';
    let inQuotes = false;
    for (let i = 0; i < line.length; i++) {
      const char = line[i];
      if (char === '"') {
        if (inQuotes && line[i + 1] === '"') {
          current += '"';
          i++;
        } else {
          inQuotes = !inQuotes;
        }
      } else if (char === ',' && !inQuotes) {
        result.push(current.trim());
        current = '';
      } else {
        current += char;
      }
    }
    result.push(current.trim());
    return result;
  };

  // Check header
  const header = parseLine(lines[0]);
  const transactions: any[] = [];

  for (let i = 1; i < lines.length; i++) {
    const cols = parseLine(lines[i]);
    if (cols.length < 3) continue;

    // Try detecting columns by header position or default indexes
    // Default indices if exported from this app:
    // [0]=ID, [1]=Date, [2]=Type, [3]=Amount, [4]=Category, [5]=Subcategory, [6]=Notes, [7]=Merchant, [8]=Account, [9]=Necessity
    let rawAmount = 0;
    let type = 'expense';
    let category = 'عام';
    let subcategory = '';
    let notes = '';
    let merchant = '';
    let account = 'cash';
    let necessity = 'ضروري';
    let date = new Date().toISOString();

    if (cols.length >= 4) {
      rawAmount = parseFloat(cols[3].replace(/[^\d.-]/g, '')) || 0;
      const typeStr = cols[2] || '';
      if (typeStr.includes('دخل') || typeStr.includes('income')) type = 'income';
      category = cols[4] || 'عام';
      subcategory = cols[5] || '';
      notes = cols[6] || '';
      merchant = cols[7] || '';
      const accStr = cols[8] || '';
      if (accStr.includes('دين') || accStr.includes('debt')) account = 'debt';
      else if (accStr.includes('palpay') || accStr.includes('بال')) account = 'palPay';
      necessity = cols[9] || 'ضروري';
    } else {
      // Basic 3-column CSV: [0]=notes/title, [1]=amount, [2]=category
      notes = cols[0] || '';
      rawAmount = parseFloat(cols[1].replace(/[^\d.-]/g, '')) || 0;
      category = cols[2] || 'عام';
    }

    if (rawAmount > 0) {
      transactions.push({
        amount: Math.abs(rawAmount),
        type,
        category,
        subcategory,
        notes: notes || subcategory || category,
        merchant,
        account,
        necessity,
        date,
        createdAt: date
      });
    }
  }

  return transactions;
}
