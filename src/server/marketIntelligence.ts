import { parsePositiveFinancialAmount } from '../lib/amount';

/**
 * V6.1 — Real Local Market Intelligence (PHASE 13-15).
 *
 * Enhances searchLocalMarket with:
 *   - Source-backed result model (product, brand, model, seller, location, price,
 *     currency, source, sourceUrl, fetchedAt, confidence)
 *   - Multi-source aggregation (collect credible offers, compute range)
 *   - Gaza/Palestine priority (sources from Gaza preferred, external marked as reference)
 *   - Price freshness (cached entries have timestamp; stale cache is refreshed or warned)
 *   - Market cache (reduce API calls for repeat searches)
 *   - Prompt-injection protection (web content is DATA ONLY — no tool invocation possible)
 *   - Failure handling (MARKET_DATA_UNAVAILABLE — never fabricate)
 *
 * Storage: in-memory Map for cache. Cache key = normalized product + variant + condition.
 * TTL: 1 hour (prices may change).
 */

export type MarketScope = 'gaza' | 'palestine' | 'global' | 'unknown';

export interface MarketResult {
  product: string;
  brand?: string;
  model?: string;
  variant?: string;
  condition?: 'new' | 'used' | 'unknown';
  seller?: string;
  location?: string;
  price: number;
  currency: string;
  originalPrice?: number;
  originalCurrency?: string;
  normalizedPriceIls?: number;
  fxRateSource?: string;
  fxRateDate?: string;
  fxRateStale?: boolean;
  marketScope?: MarketScope;
  availability?: 'in-stock' | 'out-of-stock' | 'unknown';
  source: string;       // e.g., "Google Search grounding" or seller name
  sourceUrl?: string;
  fetchedAt: string;    // ISO timestamp
  isLocalGaza: boolean; // true if source is Gaza-specific
  confidence: 'high' | 'medium' | 'low';
  notes?: string;
}

export interface MarketSearchResponse {
  success: boolean;
  item: string;
  model?: string;
  results: MarketResult[];
  priceRange?: { min: number; max: number; median: number; currency: string };
  marketComparison?: {
    gazaRange?: { min: number; max: number; median: number; currency: string } | null;
    palestineRange?: { min: number; max: number; median: number; currency: string } | null;
    globalRange?: { min: number; max: number; median: number; currency: string } | null;
    allRange?: { min: number; max: number; median: number; currency: string } | null;
    warnings: string[];
  };
  sources: { title: string; uri: string; isLocalGaza: boolean }[];
  searchQueries: string[];
  summary: string;
  marketUnavailable?: boolean;
  message?: string;
  partial?: boolean;
  /** True if results came from cache (vs. fresh search). */
  cached?: boolean;
  cacheAgeMinutes?: number;
}

const CACHE_TTL_MS = 60 * 60 * 1000; // 1 hour
const FX_CACHE_TTL_MS = 12 * 60 * 60 * 1000; // Representative rates usually publish daily; refresh twice a day.
const BOI_EXCHANGE_RATES_URL = 'https://www.boi.org.il/PublicApi/GetExchangeRates';
const marketCache = new Map<string, { response: MarketSearchResponse; cachedAt: number }>();

export type FxRatesToIlsSnapshot = {
  rates: Record<string, number>;
  fetchedAt: number;
  source: string;
  rateDate?: string;
  stale?: boolean;
};

let fxRatesToIlsCache: FxRatesToIlsSnapshot | null = null;
let fxRatesRefreshPromise: Promise<FxRatesToIlsSnapshot | null> | null = null;

function normalizeCurrencyCode(currency: string): string {
  const cur = String(currency || 'ILS').trim().toUpperCase();
  if (cur === '₪' || cur === 'NIS' || cur === 'ILS') return 'ILS';
  return cur;
}

export function parseBankOfIsraelRates(payload: unknown): FxRatesToIlsSnapshot | null {
  const body = payload && typeof payload === 'object' && !Array.isArray(payload)
    ? payload as { exchangeRates?: unknown }
    : {};
  const rows = Array.isArray(body.exchangeRates) ? body.exchangeRates : [];
  const rates: Record<string, number> = { ILS: 1, NIS: 1 };
  let rateDate = '';
  for (const rawRow of rows) {
    const row = rawRow && typeof rawRow === 'object' && !Array.isArray(rawRow)
      ? rawRow as { key?: unknown; currentExchangeRate?: unknown; unit?: unknown; lastUpdate?: unknown }
      : {};
    const key = normalizeCurrencyCode(String(row.key || ''));
    const value = Number(row.currentExchangeRate);
    const unit = Number(row.unit || 1) || 1;
    if (!key || !Number.isFinite(value) || value <= 0 || unit <= 0) continue;
    rates[key] = Math.round((value / unit) * 1000000) / 1000000;
    if (!rateDate && row?.lastUpdate) rateDate = String(row.lastUpdate);
  }
  return Object.keys(rates).length > 2
    ? { rates, fetchedAt: Date.now(), source: 'Bank of Israel representative exchange rates', rateDate: rateDate || undefined }
    : null;
}

export function getExchangeRateSnapshot(): FxRatesToIlsSnapshot | null {
  return fxRatesToIlsCache ? { ...fxRatesToIlsCache, rates: { ...fxRatesToIlsCache.rates } } : null;
}

export function setExchangeRateSnapshotForTests(snapshot: FxRatesToIlsSnapshot | null): void {
  fxRatesToIlsCache = snapshot ? { ...snapshot, rates: { ...snapshot.rates } } : null;
  fxRatesRefreshPromise = null;
}

export async function refreshExchangeRatesToIls(fetcher: typeof fetch = fetch): Promise<FxRatesToIlsSnapshot | null> {
  const now = Date.now();
  if (fxRatesToIlsCache && now - fxRatesToIlsCache.fetchedAt <= FX_CACHE_TTL_MS) return fxRatesToIlsCache;
  if (fxRatesRefreshPromise) return fxRatesRefreshPromise;
  fxRatesRefreshPromise = (async () => {
    try {
      if (typeof fetcher !== 'function') return fxRatesToIlsCache ? { ...fxRatesToIlsCache, stale: true } : null;
      const response = await fetcher(BOI_EXCHANGE_RATES_URL, { headers: { Accept: 'application/json' } } as any);
      if (!response?.ok) return fxRatesToIlsCache ? { ...fxRatesToIlsCache, stale: true } : null;
      const parsed = parseBankOfIsraelRates(await response.json());
      if (parsed) {
        fxRatesToIlsCache = parsed;
        return parsed;
      }
      return fxRatesToIlsCache ? { ...fxRatesToIlsCache, stale: true } : null;
    } catch {
      return fxRatesToIlsCache ? { ...fxRatesToIlsCache, stale: true } : null;
    } finally {
      fxRatesRefreshPromise = null;
    }
  })();
  return fxRatesRefreshPromise;
}

interface CacheKey {
  product: string;
  model?: string;
  condition?: string;
}

function makeCacheKey(k: CacheKey): string {
  return `${normalizeForCache(k.product)}|${normalizeForCache(k.model || '')}|${normalizeForCache(k.condition || '')}`;
}

function normalizeForCache(s: string): string {
  return String(s || '').trim().toLowerCase().replace(/\s+/g, ' ');
}

/**
 * Check cache for a recent result. Returns null if cache miss or stale.
 */
export function getCachedMarketResult(key: CacheKey): MarketSearchResponse | null {
  const k = makeCacheKey(key);
  const entry = marketCache.get(k);
  if (!entry) return null;
  const ageMs = Date.now() - entry.cachedAt;
  if (ageMs > CACHE_TTL_MS) {
    // Stale — return null (caller will refresh).
    marketCache.delete(k);
    return null;
  }
  return { ...entry.response, cached: true, cacheAgeMinutes: Math.round(ageMs / 60000) };
}

/**
 * Store a market search response in cache.
 */
export function cacheMarketResult(key: CacheKey, response: MarketSearchResponse): void {
  const k = makeCacheKey(key);
  marketCache.set(k, { response, cachedAt: Date.now() });
  // Cap cache size to prevent unbounded growth.
  if (marketCache.size > 50) {
    // Evict oldest entries.
    const entries = Array.from(marketCache.entries()).sort((a, b) => a[1].cachedAt - b[1].cachedAt);
    for (let i = 0; i < 10; i++) {
      marketCache.delete(entries[i][0]);
    }
  }
}

/**
 * Detect if a source URL or title is Gaza-specific.
 */
export function isGazaSource(title: string, uri: string): boolean {
  const t = (title + ' ' + uri).toLowerCase();
  // Heuristic: contains "gaza" / "غزة" / "palestine" / "فلسطين".
  return t.includes('gaza') || t.includes('غزة') || t.includes('palestine') || t.includes('فلسطين') || t.includes('ramallah') || t.includes('رام الله');
}

export function classifyMarketScope(title: string = '', uri: string = '', location: string = ''): MarketScope {
  const t = `${title} ${uri} ${location}`.toLowerCase();
  if (t.includes('gaza') || t.includes('غزة') || t.includes('خان يونس') || t.includes('رفح') || t.includes('النصيرات') || t.includes('دير البلح') || t.includes('جباليا')) return 'gaza';
  if (t.includes('palestine') || t.includes('فلسطين') || t.includes('ramallah') || t.includes('رام الله') || t.includes('nablus') || t.includes('نابلس') || t.includes('hebron') || t.includes('الخليل')) return 'palestine';
  if (t.includes('amazon') || t.includes('ebay') || t.includes('aliexpress') || t.includes('gsmarena') || t.includes('apple.com') || t.includes('samsung.com') || t.includes('bestbuy') || t.includes('walmart')) return 'global';
  return 'unknown';
}

export function normalizeCurrencyToIls(price: number, currency: string): number | null {
  const cur = normalizeCurrencyCode(currency || 'ILS');
  const amount = parsePositiveFinancialAmount(price);
  if (amount <= 0) return null;
  if (cur === 'ILS' || cur === 'NIS') return Math.round(amount * 100) / 100;
  const rate = fxRatesToIlsCache?.rates?.[cur];
  if (!Number.isFinite(rate) || Number(rate) <= 0) return null;
  return Math.round(amount * Number(rate) * 100) / 100;
}

export function getFxConversionMetadata(currency: string): Pick<MarketResult, 'fxRateSource' | 'fxRateDate' | 'fxRateStale'> {
  const cur = normalizeCurrencyCode(currency || 'ILS');
  if (cur === 'ILS' || cur === 'NIS') return {};
  const snapshot = fxRatesToIlsCache;
  const rate = snapshot?.rates?.[cur];
  if (!snapshot || !Number.isFinite(rate) || Number(rate) <= 0) return {};
  return {
    fxRateSource: snapshot.source,
    fxRateDate: snapshot.rateDate,
    fxRateStale: Boolean(snapshot.stale),
  };
}

function hasUnconvertedForeignCurrency(results: MarketResult[]): boolean {
  return results.some((r) => {
    const cur = normalizeCurrencyCode(r.currency || 'ILS');
    return cur !== 'ILS' && cur !== 'NIS' && !Number(r.normalizedPriceIls || 0);
  });
}

export function computeNormalizedPriceRange(results: MarketResult[]): { min: number; max: number; median: number; currency: string } | null {
  const prices = results
    .map(r => Number(r.normalizedPriceIls ?? normalizeCurrencyToIls(r.price, r.currency)))
    .filter(p => Number.isFinite(p) && p > 0)
    .sort((a, b) => a - b);
  if (!prices.length) return null;
  const median = prices[Math.floor(prices.length / 2)];
  const filtered = prices.filter(p => p <= median * 2);
  const list = filtered.length ? filtered : prices;
  return { min: list[0], max: list[list.length - 1], median, currency: 'ILS' };
}

export function buildMarketComparison(results: MarketResult[], offeredPrice?: number) {
  const byScope = (scope: MarketScope) => results.filter(r => (r.marketScope || (r.isLocalGaza ? 'gaza' : 'unknown')) === scope);
  const gazaRange = computeNormalizedPriceRange(byScope('gaza'));
  const palestineRange = computeNormalizedPriceRange(byScope('palestine'));
  const globalRange = computeNormalizedPriceRange(byScope('global'));
  const allRange = computeNormalizedPriceRange(results);
  const reference = gazaRange || palestineRange || allRange || globalRange;
  const warnings: string[] = [];
  if (offeredPrice && reference) {
    const diff = Math.round((offeredPrice - reference.median) * 100) / 100;
    const pct = reference.median > 0 ? Math.round(diff / reference.median * 100) : 0;
    if (pct > 20) warnings.push(`السعر المعروض أعلى من مرجع السوق بحوالي ${pct}% (${diff} ₪ فوق الوسيط).`);
    else if (pct < -15) warnings.push(`السعر المعروض أقل من السوق بحوالي ${Math.abs(pct)}%؛ تأكد من الحالة والضمان حتى لا تكون صفقة ملغومة.`);
  }
  if (!gazaRange && (palestineRange || globalRange)) warnings.push('لم أجد سعراً محلياً موثوقاً من غزة؛ استخدمت فلسطين/العالمي كمرجع فقط.');
  if (hasUnconvertedForeignCurrency(results)) warnings.push('بعض الأسعار بعملة غير الشيكل ولم تتوفر نشرة صرف موثوقة، لذلك لم أخلطها في مقارنة الشيكل.');
  if (globalRange && reference && globalRange.median < reference.median * 0.75) warnings.push('السعر العالمي أقل بكثير من المحلي؛ راقب تكاليف الشحن والجمارك والتوفر قبل المقارنة النهائية.');
  return { gazaRange, palestineRange, globalRange, allRange, warnings };
}

/**
 * Parse Gemini's text response to extract price candidates.
 * Returns array of (price, source) pairs. NO fabrication — only what Gemini returns.
 */
export function extractPricesFromText(text: string): { price: number; currency: string; raw: string }[] {
  const results: { price: number; currency: string; raw: string }[] = [];
  if (!text) return results;
  // Match patterns:
  //   "3200 ₪" / "3200 shekel" / "3200 ILS" / "3200 NS" / "3200 شيكل" / "3200 دولار" / "3200 دينار"
  //   "₪ 3200" / "shekel 3200" / "ILS 3200" / "USD 3200" / "JOD 3200" / "دولار 3200"
  const patterns = [
    // Number followed by currency name.
    /(\d[\d,]*(?:\.\d+)?)\s*(₪|ils|shekel|n[s|h]|دولار|usd|jod|دينار|شيكل)/gi,
    // Currency name followed by number.
    /(₪|ils|shekel|usd|jod|دولار|دينار|شيكل)\s*(\d[\d,]*(?:\.\d+)?)/gi,
  ];
  for (const p of patterns) {
    let m;
    while ((m = p.exec(text)) !== null) {
      const numStr = (m[1] || m[2]);
      // Skip if first capture is a currency name (we need the number).
      let rawNum = numStr;
      let curRaw = (m[2] || m[1] || '');
      // If first capture is currency (non-numeric), use second.
      if (isNaN(parseFloat(rawNum))) {
        rawNum = m[2];
        curRaw = m[1];
      }
      rawNum = String(rawNum || '').replace(/,/g, '');
      const price = parseFloat(rawNum);
      if (!isNaN(price) && price > 0) {
        const cur = String(curRaw || '').toLowerCase();
        const currency = cur.includes('usd') || cur.includes('دولار') ? 'USD'
                      : cur.includes('jod') || cur.includes('دينار') ? 'JOD'
                      : 'ILS';
        results.push({ price, currency, raw: m[0] });
      }
    }
  }
  return results;
}

/**
 * Compute a credible price range from multiple results.
 * Excludes outliers (>2x median).
 */
export function computePriceRange(results: MarketResult[]): { min: number; max: number; median: number; currency: string } | null {
  if (results.length === 0) return null;
  const sameCurrency = results.every(r => r.currency === results[0].currency);
  if (!sameCurrency) return null;  // refuse to mix currencies
  const prices = results.map(r => r.price).sort((a, b) => a - b);
  const median = prices[Math.floor(prices.length / 2)];
  // Exclude outliers >2x median.
  const filtered = prices.filter(p => p <= median * 2);
  if (filtered.length === 0) return { min: prices[0], max: prices[prices.length - 1], median, currency: results[0].currency };
  return {
    min: filtered[0],
    max: filtered[filtered.length - 1],
    median,
    currency: results[0].currency,
  };
}

/**
 * Determine if a market search is "small/normal expense" — for these, the AI
 * should NOT invoke market search (PHASE 31). Returns true if the user's
 * request seems to be a small daily purchase (food, transport, etc.).
 */
export function isSmallDailyPurchase(item: string): boolean {
  const s = normalizeForCache(item);
  const smallItems = ['خبز', 'ماء', 'خضار', 'فواكه', 'فاكهة', 'بنزين', 'تاكسي', 'مواصلات', 'كهرباء', 'صيام', 'قهوة', 'شاي', 'مصروف', 'حلويات', 'عصير'];
  return smallItems.some(k => s.includes(k));
}

/**
 * Determine if market search is appropriate for the user's intent.
 * Triggers: high-value (>500 ₪), electronics, vehicles, appliances, "غالي ولا رخيص",
 * "دورلي بالسوق", explicit price comparison request.
 */
export function shouldSearchMarket(item: string, amount?: number): boolean {
  const s = normalizeForCache(item);
  // Explicit comparison requests.
  if (s.includes('دورلي') || s.includes('سعر السوق') || s.includes('غالي') || s.includes('رخيص')) return true;
  // High-value categories.
  const highValueKeywords = ['جوال', 'موبايل', 'موبيل', 'تلفون', 'هاتف', 'ايفون', 'أندرويد', 'android', 'iphone', 'samsung', 'سيارة', 'سياره', 'car', 'ثلاجة', 'غسالة', 'تلفزيون', 'لابتوب', 'كمبيوتر', 'laptop', 'pc'];
  if (highValueKeywords.some(k => s.includes(k))) return true;
  // High amount threshold (>=500 ₪).
  if (amount && amount >= 500) return true;
  return false;
}
