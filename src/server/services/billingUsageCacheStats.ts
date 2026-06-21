function readNonNegativeNumber(value: unknown): number | null {
  if (typeof value === 'number' && Number.isFinite(value) && value >= 0) return value;
  if (typeof value === 'string') {
    const parsed = Number(value.trim());
    if (Number.isFinite(parsed) && parsed >= 0) return parsed;
  }
  return null;
}

function readBillingUsage(details: Record<string, unknown> | null | undefined): Record<string, unknown> | null {
  const usage = details?.usage;
  if (!usage || typeof usage !== 'object' || Array.isArray(usage)) return null;
  return usage as Record<string, unknown>;
}

export function readBillingUsageToken(
  details: Record<string, unknown> | null | undefined,
  key: string,
): number | null {
  const usage = readBillingUsage(details);
  if (!usage) return null;
  return readNonNegativeNumber(usage[key]);
}

export function readBillingUsageBoolean(
  details: Record<string, unknown> | null | undefined,
  key: string,
): boolean | null {
  const usage = readBillingUsage(details);
  if (!usage) return null;
  const raw = usage[key];
  if (typeof raw === 'boolean') return raw;
  if (typeof raw === 'string') {
    const normalized = raw.trim().toLowerCase();
    if (['1', 'true', 'yes'].includes(normalized)) return true;
    if (['0', 'false', 'no'].includes(normalized)) return false;
  }
  return null;
}

export function resolveBillablePromptTokensForCacheStats(input: {
  billingDetails?: Record<string, unknown> | null;
  promptTokens?: number | null;
  cacheReadTokens?: number | null;
}): number | null {
  const billablePromptTokens = readBillingUsageToken(input.billingDetails, 'billablePromptTokens');
  if (billablePromptTokens != null) return billablePromptTokens;

  const rawPromptTokens = readNonNegativeNumber(input.promptTokens)
    ?? readBillingUsageToken(input.billingDetails, 'promptTokens');
  if (rawPromptTokens == null) return null;

  const promptTokensIncludeCache = readBillingUsageBoolean(input.billingDetails, 'promptTokensIncludeCache');
  if (promptTokensIncludeCache === false) return rawPromptTokens;

  const cacheReadTokens = input.cacheReadTokens ?? readBillingUsageToken(input.billingDetails, 'cacheReadTokens') ?? 0;
  const cacheCreationTokens = readBillingUsageToken(input.billingDetails, 'cacheCreationTokens') ?? 0;
  return Math.max(0, rawPromptTokens - cacheReadTokens - cacheCreationTokens);
}

export function calculateCacheHitRatePercent(input: {
  cacheReadTokens?: number | null;
  billablePromptTokens?: number | null;
}): number | null {
  const cacheReadTokens = readNonNegativeNumber(input.cacheReadTokens);
  const billablePromptTokens = readNonNegativeNumber(input.billablePromptTokens);
  if (cacheReadTokens == null || billablePromptTokens == null) return null;
  const denominator = cacheReadTokens + billablePromptTokens;
  if (denominator <= 0) return null;
  return Math.round((cacheReadTokens / denominator) * 10_000) / 100;
}
