import { parsePositiveFinancialAmount } from './amount';
import { normalizeArabic } from './reportUtils';

export type SavingsGoalRecord = Record<string, unknown> & {
  id?: string;
  name?: string;
  targetAmount?: number;
  savedAmount?: number;
  dueDate?: string;
  status?: string;
  createdAt?: string;
};

export type SavingsContributionRecord = Record<string, unknown> & {
  amount?: number;
  createdAt?: string;
};

export type SavingsGoalPlan = SavingsGoalRecord & {
  targetAmount: number;
  savedAmount: number;
  remainingAmount: number;
  progressPercentage: number;
  monthsRemaining: number;
  daysRemaining: number;
  monthlyRequired: number;
  monthlySavedAmount: number;
  monthlyNetAvailable: number;
  alertLevel: 'completed' | 'critical' | 'warning' | 'safe';
  alertMessage: string;
};

export function roundMoney(value: number): number {
  return Math.round((Number.isFinite(value) ? value : 0) * 100) / 100;
}

export function addMonths(date: Date, months: number): Date {
  const copy = new Date(date.getTime());
  const day = copy.getDate();
  copy.setMonth(copy.getMonth() + months);
  if (copy.getDate() !== day) copy.setDate(0);
  return copy;
}

export function normalizeSavingsDueDate(input: {
  dueDate?: unknown;
  durationMonths?: unknown;
  now?: Date;
}): string {
  const explicit = String(input.dueDate || '').trim();
  if (/^\d{4}-\d{2}-\d{2}$/.test(explicit)) return explicit;
  const rawMonths = Number(input.durationMonths);
  const months = Number.isFinite(rawMonths) ? Math.max(0, Math.floor(rawMonths)) : 0;
  if (months <= 0) return '';
  return addMonths(input.now || new Date(), months).toISOString().slice(0, 10);
}

export function daysRemainingUntil(dueDate: unknown, now: Date = new Date()): number {
  const due = String(dueDate || '').trim();
  if (!/^\d{4}-\d{2}-\d{2}$/.test(due)) return 0;
  const end = new Date(`${due}T23:59:59.999Z`).getTime();
  const current = now.getTime();
  return Math.max(0, Math.ceil((end - current) / 86400000));
}

export function monthsRemainingUntil(dueDate: unknown, now: Date = new Date()): number {
  const due = String(dueDate || '').trim();
  if (!/^\d{4}-\d{2}-\d{2}$/.test(due)) return 0;
  const [year, month, day] = due.split('-').map(Number);
  const end = new Date(Date.UTC(year, month - 1, day, 23, 59, 59, 999));
  if (end.getTime() <= now.getTime()) return 0;
  let months = (year - now.getUTCFullYear()) * 12 + (month - 1 - now.getUTCMonth());
  if (months <= 0) return 1;
  if (day > now.getUTCDate()) months += 1;
  return Math.max(1, months);
}

export function monthKey(date: Date = new Date()): string {
  return date.toISOString().slice(0, 7);
}

export function calculateMonthlyNetAvailable(transactions: SavingsContributionRecord[], now: Date = new Date()): number {
  const key = monthKey(now);
  return roundMoney((transactions || []).reduce((sum, raw) => {
    const type = String(raw?.type || '');
    const category = String(raw?.category || '');
    if (type === 'transfer' || category === 'تحويل' || category === 'تحويل داخلي') return sum;
    const date = String(raw?.date || raw?.createdAt || '');
    if (!date.startsWith(key)) return sum;
    const amount = parsePositiveFinancialAmount(raw?.amount);
    if (type === 'income') return sum + amount;
    if (type === 'expense') return sum - amount;
    return sum;
  }, 0));
}

export function calculateMonthlyContributions(contributions: SavingsContributionRecord[], now: Date = new Date()): number {
  const key = monthKey(now);
  return roundMoney((contributions || []).reduce((sum, c) => {
    const date = String(c?.createdAt || c?.date || '');
    if (!date.startsWith(key)) return sum;
    return sum + parsePositiveFinancialAmount(c?.amount);
  }, 0));
}

export function buildSavingsGoalPlan(input: {
  goal: SavingsGoalRecord;
  transactions?: SavingsContributionRecord[];
  contributions?: SavingsContributionRecord[];
  now?: Date;
}): SavingsGoalPlan {
  const now = input.now || new Date();
  const targetAmount = parsePositiveFinancialAmount(input.goal.targetAmount);
  const savedAmount = Math.min(targetAmount, parsePositiveFinancialAmount(input.goal.savedAmount));
  const remainingAmount = roundMoney(Math.max(0, targetAmount - savedAmount));
  const daysRemaining = daysRemainingUntil(input.goal.dueDate, now);
  const monthsRemaining = monthsRemainingUntil(input.goal.dueDate, now);
  const divisor = monthsRemaining > 0 ? monthsRemaining : 1;
  const monthlyRequired = remainingAmount > 0 ? roundMoney(remainingAmount / divisor) : 0;
  const monthlySavedAmount = calculateMonthlyContributions(input.contributions || [], now);
  const monthlyNetAvailable = calculateMonthlyNetAvailable(input.transactions || [], now);
  const progressPercentage = targetAmount > 0 ? Math.min(100, Math.round((savedAmount / targetAmount) * 100)) : 0;

  let alertLevel: SavingsGoalPlan['alertLevel'] = 'safe';
  let alertMessage = 'هدف الادخار تحت السيطرة.';
  if (remainingAmount <= 0 || input.goal.status === 'completed') {
    alertLevel = 'completed';
    alertMessage = 'تم تحقيق هدف الادخار 🎉';
  } else if (monthlyRequired > 0 && monthlyNetAvailable > 0 && monthlyNetAvailable <= monthlyRequired * 1.05 && monthlySavedAmount < monthlyRequired) {
    alertLevel = 'critical';
    alertMessage = `تنبيه أحمر: المتبقي هذا الشهر (${monthlyNetAvailable} ₪) وصل تقريباً لحد الادخار المطلوب (${monthlyRequired} ₪). ادخره الآن قبل صرفه.`;
  } else if (monthlyRequired > 0 && monthlySavedAmount < monthlyRequired) {
    alertLevel = 'warning';
    alertMessage = `تحتاج ادخار ${roundMoney(monthlyRequired - monthlySavedAmount)} ₪ إضافية هذا الشهر للبقاء على المسار.`;
  }

  return {
    ...input.goal,
    targetAmount,
    savedAmount,
    remainingAmount,
    progressPercentage,
    monthsRemaining,
    daysRemaining,
    monthlyRequired,
    monthlySavedAmount,
    monthlyNetAvailable,
    alertLevel,
    alertMessage,
  };
}

export function buildSavingsGoalRecord(input: {
  userId: string;
  name: string;
  targetAmount: unknown;
  savedAmount?: unknown;
  dueDate?: unknown;
  durationMonths?: unknown;
  priority?: unknown;
  notes?: unknown;
  now?: Date;
}): { ok: true; goal: Record<string, unknown> } | { ok: false; reason: string; message: string } {
  const name = String(input.name || '').trim();
  const targetAmount = parsePositiveFinancialAmount(input.targetAmount);
  const savedAmount = parsePositiveFinancialAmount(input.savedAmount);
  if (!name) return { ok: false, reason: 'MISSING_SAVINGS_GOAL_NAME', message: 'ما اسم هدف الادخار؟ مثال: احتياطي طوارئ، آيفون، تعليم الأبناء.' };
  if (targetAmount <= 0) return { ok: false, reason: 'INVALID_TARGET_AMOUNT', message: 'كم مبلغ هدف الادخار؟' };
  const now = input.now || new Date();
  const dueDate = normalizeSavingsDueDate({ dueDate: input.dueDate, durationMonths: input.durationMonths, now });
  const plan = buildSavingsGoalPlan({ goal: { targetAmount, savedAmount, dueDate }, now });
  const timestamp = now.toISOString();
  return {
    ok: true,
    goal: {
      userId: input.userId,
      name,
      targetAmount,
      savedAmount,
      dueDate,
      durationMonths: (() => {
        const rawMonths = Number(input.durationMonths);
        return Number.isFinite(rawMonths) ? Math.max(0, Math.floor(rawMonths)) || null : null;
      })(),
      monthlyRequired: plan.monthlyRequired,
      priority: String(input.priority || 'medium'),
      notes: String(input.notes || ''),
      status: savedAmount >= targetAmount ? 'completed' : 'active',
      createdAt: timestamp,
      updatedAt: timestamp,
    },
  };
}

export type SavingsGoalSelection =
  | { ok: true; selected: SavingsGoalRecord }
  | { ok: false; reason: 'MISSING_SAVINGS_GOAL' | 'AMBIGUOUS_SAVINGS_GOAL' | 'SAVINGS_GOAL_NOT_FOUND'; message: string; options: Array<{ id: string; name: string; remainingAmount: number }> };

export function selectSavingsGoalForContribution(goals: SavingsGoalRecord[], requestedGoal?: unknown): SavingsGoalSelection {
  const active = (goals || []).filter(g => String(g.status || 'active') !== 'completed');
  const options = active.map(g => ({
    id: String(g.id || ''),
    name: String(g.name || 'هدف ادخار'),
    remainingAmount: Math.max(0, parsePositiveFinancialAmount(g.targetAmount) - parsePositiveFinancialAmount(g.savedAmount)),
  }));
  const requested = normalizeArabic(String(requestedGoal || '').trim());
  if (requested) {
    const matches = active.filter(g => {
      const name = normalizeArabic(String(g.name || ''));
      return name === requested || name.includes(requested) || requested.includes(name);
    });
    if (matches.length === 1) return { ok: true, selected: matches[0] };
    return { ok: false, reason: 'SAVINGS_GOAL_NOT_FOUND', options, message: 'لم أجد هدف ادخار مطابقاً. اختر هدفاً من القائمة.' };
  }
  if (active.length === 1) return { ok: true, selected: active[0] };
  if (active.length === 0) return { ok: false, reason: 'MISSING_SAVINGS_GOAL', options: [], message: 'لا يوجد هدف ادخار نشط. أنشئ هدفاً أولاً مثل: هدفي أوصل 5000 ₪ خلال سنة.' };
  return { ok: false, reason: 'AMBIGUOUS_SAVINGS_GOAL', options, message: 'لأي هدف تريد إضافة هذا الادخار؟ اختر هدفاً من القائمة.' };
}
