import { parseFiniteAmount } from './amount';

/**
 * V6.3 — Shared Financial Domain Core.
 *
 * This module is the canonical owner of pure financial interpretation shared by
 * client and server: account normalization, balance reconstruction, creditor-key
 * normalization, and creditor remaining-debt reconstruction.
 *
 * Server mutation orchestration stays in src/server, but neither tools.ts nor
 * atomicOps.ts should duplicate these pure ledger rules.
 */

// Canonical account normalization shared by server tools, atomic operations, and reports.
export function normalizeAccount(acc: any): 'cash' | 'palPay' | 'debt' {
  if (!acc) return 'cash';
  const s = String(acc).toLowerCase().trim();
  if (s.includes('pal') || s.includes('بال') || s.includes('محفظ')) return 'palPay';
  if (s.includes('debt') || s.includes('دين') || s.includes('آجل') || s.includes('اجل')) return 'debt';
  return 'cash';
}

export interface Balances {
  cash: number;
  palPay: number;
  debt: number;
  total: number; // cash + palPay (debt excluded from liquidity)
}

export interface BalanceBreakdown {
  income: number;
  expense: number;
  transferCount: number;
  creditorDebts: Record<string, number>;
}

/**
 * Canonical balance calculator. Accepts transaction objects (with .account, .type,
 * .amount, .fromAccount, .toAccount, .creditor, .merchant, .transactionType).
 *
 * Pass plain JS objects (NOT Firestore DocumentSnapshot). The backend version
 * handles both — this client version assumes plain objects.
 */
export function calculateBalances(transactions: any[]): Balances {
  let cash = 0, palPay = 0, debt = 0;
  for (const tx of transactions || []) {
    const amount = parseFiniteAmount(tx?.amount);
    const account = normalizeAccount(tx?.account);
    if (tx?.type === 'expense') {
      if (account === 'palPay') palPay -= amount;
      else if (account === 'debt') debt += amount;
      else cash -= amount;
    } else if (tx?.type === 'income') {
      if (account === 'palPay') palPay += amount;
      else if (account === 'debt') debt -= amount;
      else cash += amount;
    } else if (tx?.type === 'transfer') {
      const f = normalizeAccount(tx?.fromAccount || tx?.account);
      const t = normalizeAccount(tx?.toAccount);
      if (f === 'palPay') palPay -= amount;
      else if (f === 'debt') debt += amount;
      else cash -= amount;
      if (t === 'palPay') palPay += amount;
      else if (t === 'debt') debt -= amount;
      else cash += amount;
    }
  }
  // Round to 2 decimal places to avoid floating-point drift.
  cash = Math.round(cash * 100) / 100;
  palPay = Math.round(palPay * 100) / 100;
  debt = Math.round(debt * 100) / 100;
  return { cash, palPay, debt, total: cash + palPay };
}

/**
 * Detailed breakdown for reports/forecast. Mirrors what the backend's
 * buildHierarchicalReport and getFinancialDecisionContext do separately.
 */
export function calculateBreakdown(transactions: any[]): BalanceBreakdown {
  let income = 0, expense = 0, transferCount = 0;
  const creditorDebts: Record<string, number> = {};
  for (const tx of transactions || []) {
    const amount = parseFiniteAmount(tx?.amount);
    if (tx?.type === 'income' && tx?.transactionType !== 'DEBT_BORROWING') {
      income += amount;
    } else if (tx?.type === 'expense') {
      // V6.1: exclude CREDIT_PURCHASE from "real expense" for forecast, but count in expense total.
      expense += amount;
    } else if (tx?.type === 'transfer') {
      transferCount++;
    }
    // Per-creditor debt tracking — same logic as backend calculateOpenCreditorDebts.
    const creditor = String(tx?.creditor || tx?.merchant || '').trim();
    if (!creditor) continue;
    let delta = 0;
    if (tx?.type === 'expense' && normalizeAccount(tx?.account) === 'debt') delta = amount;
    if (tx?.type === 'income' && normalizeAccount(tx?.account) === 'debt') delta = -amount;
    if (tx?.type === 'transfer' && normalizeAccount(tx?.toAccount) === 'debt') delta = -amount;
    if (tx?.type === 'transfer' && normalizeAccount(tx?.fromAccount || tx?.account) === 'debt') delta = amount;
    if (delta === 0) continue;
    const key = normalizeCreditorKey(creditor);
    creditorDebts[key] = (creditorDebts[key] || 0) + delta;
  }
  // Filter to only positive remaining debts (like backend).
  const positiveDebts: Record<string, number> = {};
  for (const [k, v] of Object.entries(creditorDebts)) {
    if (v > 0.0001) positiveDebts[k] = Math.round(v * 100) / 100;
  }
  return { income, expense, transferCount, creditorDebts: positiveDebts };
}

/** Canonical creditor identity normalization shared by client and server. */
export function normalizeCreditorKey(value: any): string {
  return String(value || '').trim().toLowerCase()
    .replace(/[أإآ]/g, 'ا')
    .replace(/ى/g, 'ي')
    .replace(/ة/g, 'ه')
    .replace(/[ـًٌٍَُِّْ]/g, '')
    .replace(/\s+/g, ' ');
}

/** Canonical remaining debt for one creditor, derived from ledger semantics. */
export function calculateCreditorRemaining(transactions: any[], creditor: string): number {
  const targetKey = normalizeCreditorKey(creditor);
  if (!targetKey) return 0;
  const debts = calculateBreakdown(transactions).creditorDebts;
  return Math.round(Math.max(0, Number(debts[targetKey] || 0)) * 100) / 100;
}
