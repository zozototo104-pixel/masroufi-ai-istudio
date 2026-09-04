import { inflateRawSync } from 'node:zlib';
import { parsePositiveFinancialAmount } from './amount';
import { normalizeHistoricalTransactionDate } from './historicalDate';

export type ExpenseImportDraft = {
  amount: number;
  type: 'expense';
  category: string;
  subcategory: string;
  merchant: string;
  notes: string;
  necessity: string;
  date?: string;
  dateSource?: string;
  sourceRow?: number;
  confidence?: number;
};

export type ExpenseImportPreview = {
  ok: true;
  merchant: string;
  items: ExpenseImportDraft[];
  totalAmount: number;
  warnings: string[];
  sourceType: 'csv' | 'tsv' | 'text' | 'json' | 'xlsx';
} | {
  ok: false;
  reason: string;
  message: string;
  warnings?: string[];
};

type Row = Record<string, string>;

type TableParseOptions = {
  defaultMonth?: unknown;
  fileName?: string;
  now?: Date;
  allowCurrentDateFallback?: boolean;
};

const DEFAULT_CATEGORY = 'أخرى';
const DEFAULT_NECESSITY = 'ضروري';

function normalizeArabicDigits(value: string): string {
  const arabic = '٠١٢٣٤٥٦٧٨٩';
  const eastern = '۰۱۲۳۴۵۶۷۸۹';
  return String(value || '').replace(/[٠-٩]/g, ch => String(arabic.indexOf(ch))).replace(/[۰-۹]/g, ch => String(eastern.indexOf(ch)));
}

function cleanAmount(value: unknown): number {
  const raw = normalizeArabicDigits(String(value ?? ''))
    .replace(/₪|شيكل|ش|ILS|NIS|USD|دولار/gi, '')
    .replace(/,/g, '')
    .trim();
  return parsePositiveFinancialAmount(raw);
}

function decodeXml(value: string): string {
  return String(value || '')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&amp;/g, '&')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .trim();
}

function normalizeHeader(value: string): string {
  return normalizeArabicDigits(String(value || '').toLowerCase())
    .replace(/[أإآ]/g, 'ا')
    .replace(/ى/g, 'ي')
    .replace(/ة/g, 'ه')
    .replace(/[ـًٌٍَُِّْ]/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

function pick(row: Row, aliases: string[]): string {
  const normalizedAliases = aliases.map(normalizeHeader);
  for (const [key, value] of Object.entries(row)) {
    const nk = normalizeHeader(key);
    if (normalizedAliases.includes(nk) || normalizedAliases.some(a => nk.includes(a))) return value;
  }
  return '';
}

function inferDelimited(text: string): ',' | ';' | '\t' | '|' {
  const sample = text.split(/\r?\n/).slice(0, 5).join('\n');
  const candidates: Array<',' | ';' | '\t' | '|'> = [',', ';', '\t', '|'];
  return candidates
    .map(delimiter => ({ delimiter, score: (sample.match(new RegExp(delimiter === '\t' ? '\\t' : `\\${delimiter}`, 'g')) || []).length }))
    .sort((a, b) => b.score - a.score)[0].delimiter;
}

function parseCsvLine(line: string, delimiter: string): string[] {
  const cells: string[] = [];
  let current = '';
  let quoted = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (ch === '"') {
      if (quoted && line[i + 1] === '"') {
        current += '"';
        i++;
      } else {
        quoted = !quoted;
      }
    } else if (ch === delimiter && !quoted) {
      cells.push(current.trim());
      current = '';
    } else {
      current += ch;
    }
  }
  cells.push(current.trim());
  return cells;
}

function rowsFromDelimited(text: string): Row[] {
  const lines = String(text || '').replace(/^\uFEFF/, '').split(/\r?\n/).map(l => l.trim()).filter(Boolean);
  if (lines.length === 0) return [];
  const delimiter = inferDelimited(lines.slice(0, 5).join('\n'));
  const first = parseCsvLine(lines[0], delimiter);
  const looksLikeHeader = first.some(cell => /date|تاريخ|amount|مبلغ|category|تصنيف|بند|merchant|متجر|ملاحظ/i.test(normalizeHeader(cell)));
  const headers = looksLikeHeader ? first : ['date', 'notes', 'amount', 'category', 'subcategory', 'merchant', 'necessity'];
  const dataLines = looksLikeHeader ? lines.slice(1) : lines;
  return dataLines.map((line) => {
    const cells = parseCsvLine(line, delimiter);
    const row: Row = {};
    headers.forEach((h, index) => { row[h || `col${index + 1}`] = cells[index] || ''; });
    return row;
  });
}

function excelSerialToDate(serial: string): string {
  const n = Number(serial);
  if (!Number.isFinite(n) || n <= 0) return serial;
  const ms = Math.round((n - 25569) * 86400 * 1000);
  return new Date(ms).toISOString().slice(0, 10);
}

function readZipEntries(buffer: Buffer): Map<string, Buffer> {
  const entries = new Map<string, Buffer>();
  let eocd = -1;
  for (let i = buffer.length - 22; i >= 0; i--) {
    if (buffer.readUInt32LE(i) === 0x06054b50) { eocd = i; break; }
  }
  if (eocd < 0) throw new Error('INVALID_XLSX_ZIP');
  const total = buffer.readUInt16LE(eocd + 10);
  let offset = buffer.readUInt32LE(eocd + 16);
  for (let i = 0; i < total; i++) {
    if (buffer.readUInt32LE(offset) !== 0x02014b50) throw new Error('INVALID_XLSX_CENTRAL_DIRECTORY');
    const method = buffer.readUInt16LE(offset + 10);
    const compressedSize = buffer.readUInt32LE(offset + 20);
    const nameLength = buffer.readUInt16LE(offset + 28);
    const extraLength = buffer.readUInt16LE(offset + 30);
    const commentLength = buffer.readUInt16LE(offset + 32);
    const localOffset = buffer.readUInt32LE(offset + 42);
    const name = buffer.slice(offset + 46, offset + 46 + nameLength).toString('utf8');
    const localNameLength = buffer.readUInt16LE(localOffset + 26);
    const localExtraLength = buffer.readUInt16LE(localOffset + 28);
    const dataStart = localOffset + 30 + localNameLength + localExtraLength;
    const compressed = buffer.slice(dataStart, dataStart + compressedSize);
    const data = method === 0 ? compressed : method === 8 ? inflateRawSync(compressed) : Buffer.alloc(0);
    if (data.length > 0) entries.set(name, data);
    offset += 46 + nameLength + extraLength + commentLength;
  }
  return entries;
}

function parseSharedStrings(xml: string): string[] {
  const values: string[] = [];
  const siMatches = xml.match(/<si[\s\S]*?<\/si>/g) || [];
  for (const si of siMatches) {
    const texts = [...si.matchAll(/<t[^>]*>([\s\S]*?)<\/t>/g)].map(m => decodeXml(m[1]));
    values.push(texts.join(''));
  }
  return values;
}

function columnIndex(cellRef: string): number {
  const letters = (cellRef.match(/[A-Z]+/i)?.[0] || '').toUpperCase();
  let n = 0;
  for (const ch of letters) n = n * 26 + (ch.charCodeAt(0) - 64);
  return Math.max(0, n - 1);
}

function rowsFromSheetXml(xml: string, sharedStrings: string[]): string[][] {
  const rows: string[][] = [];
  const rowMatches = xml.match(/<row[^>]*>[\s\S]*?<\/row>/g) || [];
  for (const rowXml of rowMatches) {
    const row: string[] = [];
    const cellMatches = rowXml.match(/<c[^>]*>[\s\S]*?<\/c>/g) || [];
    for (const cellXml of cellMatches) {
      const ref = cellXml.match(/\sr="([A-Z]+\d+)"/)?.[1] || '';
      const type = cellXml.match(/\st="([^"]+)"/)?.[1] || '';
      const idx = ref ? columnIndex(ref) : row.length;
      let value = '';
      const inline = cellXml.match(/<is>[\s\S]*?<t[^>]*>([\s\S]*?)<\/t>[\s\S]*?<\/is>/);
      const v = cellXml.match(/<v>([\s\S]*?)<\/v>/)?.[1] || '';
      if (type === 's') value = sharedStrings[Number(v)] || '';
      else if (type === 'inlineStr' && inline) value = decodeXml(inline[1]);
      else value = decodeXml(v);
      row[idx] = value;
    }
    if (row.some(Boolean)) rows.push(row);
  }
  return rows;
}

function rowsFromXlsx(base64: string): Row[] {
  const buffer = Buffer.from(base64, 'base64');
  const entries = readZipEntries(buffer);
  const sharedStrings = entries.has('xl/sharedStrings.xml') ? parseSharedStrings(entries.get('xl/sharedStrings.xml')!.toString('utf8')) : [];
  const sheetName = [...entries.keys()].find(k => /^xl\/worksheets\/sheet\d+\.xml$/.test(k));
  if (!sheetName) return [];
  const matrix = rowsFromSheetXml(entries.get(sheetName)!.toString('utf8'), sharedStrings);
  if (matrix.length === 0) return [];
  const first = matrix[0].map(String);
  const looksLikeHeader = first.some(cell => /date|تاريخ|amount|مبلغ|category|تصنيف|بند|merchant|متجر|ملاحظ/i.test(normalizeHeader(cell)));
  const headers = looksLikeHeader ? first : ['date', 'notes', 'amount', 'category', 'subcategory', 'merchant', 'necessity'];
  const dataRows = looksLikeHeader ? matrix.slice(1) : matrix;
  return dataRows.map((cells) => {
    const row: Row = {};
    headers.forEach((h, index) => { row[h || `col${index + 1}`] = cells[index] || ''; });
    return row;
  });
}

function rowsFromJson(text: string): Row[] {
  const parsed = JSON.parse(text);
  const source = Array.isArray(parsed) ? parsed : Array.isArray(parsed.items) ? parsed.items : Array.isArray(parsed.transactions) ? parsed.transactions : [];
  return source.filter((r: unknown) => r && typeof r === 'object' && !Array.isArray(r)).map((r: any) => {
    const row: Row = {};
    for (const [k, v] of Object.entries(r)) row[k] = String(v ?? '');
    return row;
  });
}

function buildDraftsFromRows(rows: Row[], options: TableParseOptions = {}): ExpenseImportPreview {
  const warnings: string[] = [];
  const items: ExpenseImportDraft[] = [];
  const now = options.now || new Date();
  rows.forEach((row, index) => {
    const amount = cleanAmount(pick(row, ['amount', 'مبلغ', 'القيمة', 'السعر', 'المجموع', 'total', 'debit', 'مصروف']) || row.amount || row.col3 || row.col2);
    if (amount <= 0) {
      warnings.push(`تم تجاهل السطر ${index + 1}: لم أجد مبلغاً صالحاً.`);
      return;
    }
    const rawDate = pick(row, ['date', 'تاريخ', 'اليوم', 'transaction date', 'created at']) || row.date || '';
    const rawDateSource = row.dateSource || pick(row, ['dateSource', 'مصدر التاريخ']) || '';
    const rawDay = pick(row, ['day', 'يوم', 'رقم اليوم']) || '';
    const dateInput = rawDate && /^\d+(?:\.\d+)?$/.test(rawDate) ? excelSerialToDate(rawDate) : rawDate;
    const hasExplicitDateSignal = Boolean(String(dateInput || '').trim() || String(options.defaultMonth || '').trim() || String(rawDay || '').trim());
    const dateResult = hasExplicitDateSignal || options.allowCurrentDateFallback
      ? normalizeHistoricalTransactionDate({
        date: dateInput,
        historicalMonth: dateInput ? undefined : options.defaultMonth,
        day: rawDay || undefined,
        now,
      })
      : {
        ok: false as const,
        reason: 'MISSING_IMPORTED_EXPENSE_DATE',
        message: 'لم أجد تاريخاً واضحاً لهذا البند. لن أسجله بتاريخ اليوم؛ أضف تاريخاً لكل بند أو اذكر الشهر واليوم.',
      };
    if (dateResult.ok === false) {
      warnings.push(`السطر ${index + 1}: ${dateResult.message}`);
    }
    const notes = pick(row, ['notes', 'ملاحظات', 'description', 'وصف', 'البند', 'item', 'name', 'اسم', 'تفصيل']) || row.notes || row.col2 || 'مصروف مستورد';
    const category = pick(row, ['category', 'تصنيف', 'الفئة', 'بند الصرف', 'main category']) || DEFAULT_CATEGORY;
    const subcategory = pick(row, ['subcategory', 'تصنيف فرعي', 'البند الفرعي', 'sub category']) || notes;
    const merchant = pick(row, ['merchant', 'متجر', 'محل', 'vendor', 'shop']) || 'استيراد مصروفات';
    const necessity = pick(row, ['necessity', 'اهمية', 'الأهمية', 'ضروري', 'كمالي']) || DEFAULT_NECESSITY;
    items.push({
      amount,
      type: 'expense',
      category,
      subcategory,
      merchant,
      notes,
      necessity: necessity === 'كمالي' ? 'كمالي' : 'ضروري',
      date: dateResult.ok ? dateResult.date : undefined,
      dateSource: dateResult.ok ? (rawDateSource ? String(rawDateSource) : dateResult.source) : undefined,
      sourceRow: index + 1,
      confidence: dateResult.ok ? 0.95 : 0.7,
    });
  });
  if (items.length === 0) {
    return { ok: false, reason: 'NO_EXPENSE_ROWS', message: 'لم أجد مصروفات صالحة داخل الملف.', warnings };
  }
  return {
    ok: true,
    merchant: options.fileName || 'استيراد مصروفات',
    items,
    totalAmount: Math.round(items.reduce((sum, i) => sum + i.amount, 0) * 100) / 100,
    warnings,
    sourceType: 'text',
  };
}

export function parseExpenseImportFile(input: {
  base64?: string;
  text?: string;
  mimeType?: string;
  fileName?: string;
  defaultMonth?: unknown;
  now?: Date;
}): ExpenseImportPreview {
  const mime = String(input.mimeType || '').toLowerCase();
  const name = String(input.fileName || '').toLowerCase();
  try {
    if (input.text !== undefined) {
      return { ...buildDraftsFromRows(rowsFromDelimited(input.text), input), sourceType: 'text' } as ExpenseImportPreview;
    }
    const base64 = String(input.base64 || '');
    if (!base64) return { ok: false, reason: 'MISSING_FILE_DATA', message: 'لم يصل محتوى الملف.' };
    if (mime.includes('spreadsheetml') || name.endsWith('.xlsx')) {
      const preview = buildDraftsFromRows(rowsFromXlsx(base64), input);
      return preview.ok ? { ...preview, sourceType: 'xlsx' } : preview;
    }
    if (mime.includes('json') || name.endsWith('.json')) {
      const text = Buffer.from(base64, 'base64').toString('utf8');
      const preview = buildDraftsFromRows(rowsFromJson(text), input);
      return preview.ok ? { ...preview, sourceType: 'json' } : preview;
    }
    if (mime.includes('csv') || name.endsWith('.csv')) {
      const text = Buffer.from(base64, 'base64').toString('utf8');
      const preview = buildDraftsFromRows(rowsFromDelimited(text), input);
      return preview.ok ? { ...preview, sourceType: 'csv' } : preview;
    }
    if (mime.includes('tab-separated') || name.endsWith('.tsv')) {
      const text = Buffer.from(base64, 'base64').toString('utf8');
      const preview = buildDraftsFromRows(rowsFromDelimited(text), input);
      return preview.ok ? { ...preview, sourceType: 'tsv' } : preview;
    }
    if (mime.startsWith('text/') || name.endsWith('.txt')) {
      const text = Buffer.from(base64, 'base64').toString('utf8');
      const preview = buildDraftsFromRows(rowsFromDelimited(text), input);
      return preview.ok ? { ...preview, sourceType: 'text' } : preview;
    }
    if (name.endsWith('.xls') || mime === 'application/vnd.ms-excel') {
      return { ok: false, reason: 'UNSUPPORTED_XLS', message: 'ملفات Excel القديمة .xls غير مدعومة حالياً. احفظ الملف بصيغة .xlsx أو CSV ثم ارفعه.' };
    }
    return { ok: false, reason: 'UNSUPPORTED_LOCAL_PARSE', message: 'هذا النوع يحتاج تحليل Gemini أو غير مدعوم محلياً.' };
  } catch (error: any) {
    return { ok: false, reason: 'PARSE_FAILED', message: error?.message || 'تعذر تحليل الملف.' };
  }
}

export function normalizeAiExpenseItems(parsed: any, options: TableParseOptions = {}): ExpenseImportPreview {
  const now = options.now || new Date();
  const currentDate = now.toISOString().slice(0, 10);
  const sourceItems = Array.isArray(parsed?.items) && parsed.items.length > 0 ? parsed.items : [
    {
      name: parsed?.merchant ? `مشتريات من ${parsed.merchant}` : 'مصروف مستورد',
      amount: parsed?.totalAmount || parsed?.amount || 0,
      category: parsed?.category || DEFAULT_CATEGORY,
      subcategory: parsed?.subcategory || 'عام',
      necessity: parsed?.necessity || DEFAULT_NECESSITY,
      date: parsed?.date,
      merchant: parsed?.merchant,
    }
  ];
  const rows = sourceItems.map((item: any) => {
    const modelDate = String(item.date || parsed?.date || '').trim();
    const modelDateSource = String(item.dateSource || '').trim();
    const dateSourceIsVisible = /visible|مرئي|column|group|row|عمود|مجموعة|صف/i.test(modelDateSource);
    const dateLooksLikeCurrentFallback = modelDate.slice(0, 10) === currentDate
      && !dateSourceIsVisible
      && !String(options.defaultMonth || '').trim()
      && options.allowCurrentDateFallback !== true;
    return {
      date: dateLooksLikeCurrentFallback ? '' : modelDate,
      day: String(item.day || ''),
      amount: String(item.amount || ''),
      category: String(item.category || DEFAULT_CATEGORY),
      subcategory: String(item.subcategory || item.name || 'عام'),
      merchant: String(item.merchant || parsed?.merchant || 'استيراد مصروفات'),
      notes: String(item.notes || item.name || 'مصروف مستورد'),
      necessity: String(item.necessity || DEFAULT_NECESSITY),
      dateSource: modelDateSource,
    };
  });
  return buildDraftsFromRows(rows, { ...options, fileName: parsed?.merchant || options.fileName });
}
