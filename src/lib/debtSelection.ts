import { normalizeCreditorKey } from './balanceCalc';

export type OpenCreditorDebt = {
  key: string;
  creditor: string;
  remaining: number;
};

export type CreditorDebtSelection =
  | { ok: true; selected: OpenCreditorDebt }
  | {
      ok: false;
      reason: 'AMBIGUOUS_CREDITOR' | 'NO_IDENTIFIABLE_OPEN_DEBT' | 'CREDITOR_NOT_FOUND';
      options: Array<{ creditor: string; remaining: number }>;
      message: string;
    };

function debtOptions(debts: OpenCreditorDebt[]): Array<{ creditor: string; remaining: number }> {
  return debts.map((d) => ({ creditor: d.creditor, remaining: d.remaining }));
}

export function selectOpenCreditorDebt(input: {
  debts: OpenCreditorDebt[];
  requestedCreditor?: unknown;
  amount: number;
}): CreditorDebtSelection {
  const debts = input.debts || [];
  const requested = String(input.requestedCreditor || '').trim();
  const key = normalizeCreditorKey(requested);
  const options = debtOptions(debts);

  if (debts.length === 1 && !key) return { ok: true, selected: debts[0] };

  if (!key) {
    return {
      ok: false,
      reason: debts.length ? 'AMBIGUOUS_CREDITOR' : 'NO_IDENTIFIABLE_OPEN_DEBT',
      options,
      message: debts.length
        ? `لمن تريد سداد ${input.amount} ₪؟ لديك ديون مفتوحة لـ: ${debts.map((d) => `${d.creditor} (${d.remaining} ₪)`).join('، ')}`
        : 'لم أجد ديناً مفتوحاً محدداً. لمن تريد تسجيل هذا السداد؟',
    };
  }

  const matches = debts.filter((d) => d.key === key);
  if (matches.length !== 1) {
    return {
      ok: false,
      reason: 'CREDITOR_NOT_FOUND',
      options,
      message: `لم أجد ديناً مفتوحاً مطابقاً تماماً لـ ${requested}. حدد الدائن.`,
    };
  }

  return { ok: true, selected: matches[0] };
}
