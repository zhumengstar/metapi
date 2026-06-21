export function normalizeRechargeRatio(value: unknown): number {
  const parsed = typeof value === 'number'
    ? value
    : typeof value === 'string'
      ? Number(value.trim())
      : Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : 1;
}

export function parseRechargeRatioInput(value: unknown): number | null {
  const parsed = typeof value === 'number'
    ? value
    : typeof value === 'string'
      ? Number(value.trim())
      : Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : null;
}

export function roundMoneyAmount(value: unknown, precision = 6): number {
  const parsed = typeof value === 'number'
    ? value
    : typeof value === 'string'
      ? Number(value.trim())
      : Number(value);
  if (!Number.isFinite(parsed)) return 0;
  const factor = 10 ** precision;
  return Math.round(parsed * factor) / factor;
}

export function toActualAmount(value: unknown, rechargeRatio: unknown): number {
  return roundMoneyAmount(Number(value || 0) / normalizeRechargeRatio(rechargeRatio));
}
