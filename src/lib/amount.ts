export function parseFiniteAmount(value: unknown): number {
  const parsed = typeof value === 'string' ? Number(value.trim()) : Number(value);
  return Number.isFinite(parsed) ? parsed : 0;
}

export function parsePositiveFinancialAmount(value: unknown): number {
  const parsed = parseFiniteAmount(value);
  return parsed > 0 ? parsed : 0;
}

export function parseAbsoluteFinancialAmount(value: unknown): number {
  const parsed = parseFiniteAmount(value);
  return parsed === 0 ? 0 : Math.abs(parsed);
}
