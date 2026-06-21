import {
  db,
  schema,
  hasProxyLogBillingDetailsColumn,
  hasProxyLogClientColumns,
  hasProxyLogDownstreamApiKeyIdColumn,
  hasProxyLogStreamTimingColumns,
} from '../db/index.js';
import { and, eq, isNull } from 'drizzle-orm';
import { mergeAccountCacheUsageStats } from './accountExtraConfig.js';
import {
  readBillingUsageToken,
  resolveBillablePromptTokensForCacheStats,
} from './billingUsageCacheStats.js';

export type ProxyLogInsertInput = {
  routeId?: number | null;
  channelId?: number | null;
  accountId?: number | null;
  downstreamApiKeyId?: number | null;
  modelRequested?: string | null;
  modelActual?: string | null;
  status?: string | null;
  httpStatus?: number | null;
  isStream?: boolean | null;
  firstByteLatencyMs?: number | null;
  latencyMs?: number | null;
  promptTokens?: number | null;
  completionTokens?: number | null;
  totalTokens?: number | null;
  estimatedCost?: number | null;
  billingDetails?: unknown;
  clientFamily?: string | null;
  clientAppId?: string | null;
  clientAppName?: string | null;
  clientConfidence?: string | null;
  errorMessage?: string | null;
  retryCount?: number | null;
  createdAt?: string | null;
};

function buildProxyLogCoreSelectFields() {
  return {
    id: schema.proxyLogs.id,
    routeId: schema.proxyLogs.routeId,
    channelId: schema.proxyLogs.channelId,
    accountId: schema.proxyLogs.accountId,
    downstreamApiKeyId: schema.proxyLogs.downstreamApiKeyId,
    modelRequested: schema.proxyLogs.modelRequested,
    modelActual: schema.proxyLogs.modelActual,
    status: schema.proxyLogs.status,
    httpStatus: schema.proxyLogs.httpStatus,
    latencyMs: schema.proxyLogs.latencyMs,
    promptTokens: schema.proxyLogs.promptTokens,
    completionTokens: schema.proxyLogs.completionTokens,
    totalTokens: schema.proxyLogs.totalTokens,
    estimatedCost: schema.proxyLogs.estimatedCost,
    errorMessage: schema.proxyLogs.errorMessage,
    retryCount: schema.proxyLogs.retryCount,
    createdAt: schema.proxyLogs.createdAt,
  };
}

function buildProxyLogClientSelectFields() {
  return {
    clientFamily: schema.proxyLogs.clientFamily,
    clientAppId: schema.proxyLogs.clientAppId,
    clientAppName: schema.proxyLogs.clientAppName,
    clientConfidence: schema.proxyLogs.clientConfidence,
  };
}

function buildProxyLogStreamTimingSelectFields() {
  return {
    isStream: schema.proxyLogs.isStream,
    firstByteLatencyMs: schema.proxyLogs.firstByteLatencyMs,
  };
}

function buildProxyLogSelectFields(options?: {
  includeBillingDetails?: boolean;
  includeClientFields?: boolean;
  includeStreamTimingFields?: boolean;
}) {
  return {
    ...buildProxyLogCoreSelectFields(),
    ...(options?.includeStreamTimingFields ? buildProxyLogStreamTimingSelectFields() : {}),
    ...(options?.includeClientFields ? buildProxyLogClientSelectFields() : {}),
    ...(options?.includeBillingDetails ? { billingDetails: schema.proxyLogs.billingDetails } : {}),
  };
}

export function getProxyLogBaseSelectFields() {
  return buildProxyLogCoreSelectFields();
}

export type ProxyLogSelectFields = ReturnType<typeof buildProxyLogSelectFields>;

export type ResolvedProxyLogSelectFields = {
  includeBillingDetails: boolean;
  includeClientFields: boolean;
  includeStreamTimingFields: boolean;
  fields: ProxyLogSelectFields;
};

export async function resolveProxyLogSelectFields(options?: {
  includeBillingDetails?: boolean;
  includeClientFields?: boolean;
  includeStreamTimingFields?: boolean;
}) {
  const includeBillingDetails = options?.includeBillingDetails === true
    && await hasProxyLogBillingDetailsColumn();
  const includeClientFields = options?.includeClientFields !== false
    && await hasProxyLogClientColumns();
  const includeStreamTimingFields = options?.includeStreamTimingFields !== false
    && await hasProxyLogStreamTimingColumns();

  return {
    includeBillingDetails,
    includeClientFields,
    includeStreamTimingFields,
    fields: buildProxyLogSelectFields({
      includeBillingDetails,
      includeClientFields,
      includeStreamTimingFields,
    }),
  };
}

export async function withProxyLogSelectFields<T>(
  runner: (selection: ResolvedProxyLogSelectFields) => Promise<T>,
  options?: { includeBillingDetails?: boolean; includeClientFields?: boolean; includeStreamTimingFields?: boolean },
): Promise<T> {
  let selection = await resolveProxyLogSelectFields(options);

  while (true) {
    try {
      return await runner(selection);
    } catch (error) {
      if (selection.includeBillingDetails && isMissingBillingDetailsColumnError(error)) {
        selection = {
          includeBillingDetails: false,
          includeClientFields: selection.includeClientFields,
          includeStreamTimingFields: selection.includeStreamTimingFields,
          fields: buildProxyLogSelectFields({
            includeBillingDetails: false,
            includeClientFields: selection.includeClientFields,
            includeStreamTimingFields: selection.includeStreamTimingFields,
          }),
        };
        continue;
      }

      if (selection.includeClientFields && isMissingProxyLogClientColumnsError(error)) {
        selection = {
          includeBillingDetails: selection.includeBillingDetails,
          includeClientFields: false,
          includeStreamTimingFields: selection.includeStreamTimingFields,
          fields: buildProxyLogSelectFields({
            includeBillingDetails: selection.includeBillingDetails,
            includeClientFields: false,
            includeStreamTimingFields: selection.includeStreamTimingFields,
          }),
        };
        continue;
      }

      if (selection.includeStreamTimingFields && isMissingProxyLogStreamTimingColumnsError(error)) {
        selection = {
          includeBillingDetails: selection.includeBillingDetails,
          includeClientFields: selection.includeClientFields,
          includeStreamTimingFields: false,
          fields: buildProxyLogSelectFields({
            includeBillingDetails: selection.includeBillingDetails,
            includeClientFields: selection.includeClientFields,
            includeStreamTimingFields: false,
          }),
        };
        continue;
      }

      throw error;
    }
  }
}

export function parseProxyLogBillingDetails(value: unknown): Record<string, unknown> | null {
  if (value && typeof value === 'object' && !Array.isArray(value)) {
    return value as Record<string, unknown>;
  }
  if (typeof value !== 'string' || value.trim().length === 0) return null;
  try {
    const parsed = JSON.parse(value);
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
      ? parsed as Record<string, unknown>
      : null;
  } catch {
    return null;
  }
}

function readNonNegativeInt(value: unknown): number {
  if (typeof value === 'number' && Number.isFinite(value) && value >= 0) {
    return Math.trunc(value);
  }
  if (typeof value === 'string') {
    const parsed = Number(value.trim());
    if (Number.isFinite(parsed) && parsed >= 0) return Math.trunc(parsed);
  }
  return 0;
}

async function accumulateAccountCacheUsage(input: ProxyLogInsertInput): Promise<void> {
  try {
    if (input.accountId == null) return;
    const billingDetails = parseProxyLogBillingDetails(input.billingDetails);
    const cacheReadTokens = readBillingUsageToken(billingDetails, 'cacheReadTokens') ?? 0;
    const promptTokens = resolveBillablePromptTokensForCacheStats({
      billingDetails,
      promptTokens: input.promptTokens == null ? null : readNonNegativeInt(input.promptTokens),
      cacheReadTokens,
    }) ?? 0;
    if (promptTokens <= 0 && cacheReadTokens <= 0) return;

    for (let attempt = 0; attempt < 3; attempt += 1) {
      const rows = await db
        .select({
          id: schema.accounts.id,
          extraConfig: schema.accounts.extraConfig,
        })
        .from(schema.accounts)
        .where(eq(schema.accounts.id, input.accountId))
        .limit(1)
        .all();
      const account = rows[0];
      if (!account) return;

      const whereClause = account.extraConfig == null
        ? and(eq(schema.accounts.id, account.id), isNull(schema.accounts.extraConfig))
        : and(eq(schema.accounts.id, account.id), eq(schema.accounts.extraConfig, account.extraConfig));
      const result = await db
        .update(schema.accounts)
        .set({
          extraConfig: mergeAccountCacheUsageStats(account.extraConfig, {
            promptTokens,
            cacheReadTokens,
          }),
          updatedAt: new Date().toISOString(),
        })
        .where(whereClause)
        .run();
      const changed = typeof result === 'object'
        && result !== null
        && 'changes' in result
        && typeof result.changes === 'number'
        ? result.changes
        : 1;
      if (changed > 0) return;
    }
  } catch {
    // Cache hit-rate accumulation is auxiliary; proxy log persistence should still succeed.
  }
}

function normalizeProxyLogStoreErrorMessage(error: unknown): string {
  const message = typeof error === 'object' && error && 'message' in error
    ? String((error as { message?: unknown }).message || '')
    : String(error || '');
  return message.toLowerCase();
}

export function isMissingBillingDetailsColumnError(error: unknown): boolean {
  const lowered = normalizeProxyLogStoreErrorMessage(error);
  return lowered.includes('billing_details')
    && (
      lowered.includes('does not exist')
      || lowered.includes('unknown column')
      || lowered.includes('no such column')
      || lowered.includes('has no column named')
    );
}

export function isMissingDownstreamApiKeyIdColumnError(error: unknown): boolean {
  const lowered = normalizeProxyLogStoreErrorMessage(error);
  return lowered.includes('downstream_api_key_id')
    && (
      lowered.includes('does not exist')
      || lowered.includes('unknown column')
      || lowered.includes('no such column')
      || lowered.includes('has no column named')
    );
}

export function isMissingProxyLogClientColumnsError(error: unknown): boolean {
  const lowered = normalizeProxyLogStoreErrorMessage(error);
  const hasClientColumnReference = [
    'client_family',
    'client_app_id',
    'client_app_name',
    'client_confidence',
  ].some((columnName) => lowered.includes(columnName));

  return hasClientColumnReference
    && (
      lowered.includes('does not exist')
      || lowered.includes('unknown column')
      || lowered.includes('no such column')
      || lowered.includes('has no column named')
    );
}

export function isMissingProxyLogStreamTimingColumnsError(error: unknown): boolean {
  const lowered = normalizeProxyLogStoreErrorMessage(error);
  const hasStreamTimingColumnReference = [
    'is_stream',
    'first_byte_latency_ms',
  ].some((columnName) => lowered.includes(columnName));

  return hasStreamTimingColumnReference
    && (
      lowered.includes('does not exist')
      || lowered.includes('unknown column')
      || lowered.includes('no such column')
      || lowered.includes('has no column named')
    );
}

async function withChannelTokenBillingDetails(
  billingDetails: unknown,
  channelId?: number | null,
): Promise<unknown> {
  if (!channelId) return billingDetails ?? null;
  const base = billingDetails && typeof billingDetails === 'object' && !Array.isArray(billingDetails)
    ? { ...(billingDetails as Record<string, unknown>) }
    : {};
  const existing = base.selectedToken;
  if (existing && typeof existing === 'object' && !Array.isArray(existing)) {
    const tokenGroup = String((existing as Record<string, unknown>).tokenGroup || '').trim();
    if (tokenGroup) return base;
  }
  let row: {
    tokenId?: number | null;
    tokenName?: string | null;
    tokenGroup?: string | null;
  } | undefined;
  try {
    row = await db.select({
      tokenId: schema.accountTokens.id,
      tokenName: schema.accountTokens.name,
      tokenGroup: schema.accountTokens.tokenGroup,
    })
      .from(schema.routeChannels)
      .leftJoin(schema.accountTokens, eq(schema.routeChannels.tokenId, schema.accountTokens.id))
      .where(eq(schema.routeChannels.id, channelId))
      .get();
  } catch {
    return billingDetails ?? null;
  }
  const tokenGroup = String(row?.tokenGroup || '').trim();
  const tokenName = String(row?.tokenName || '').trim();
  const tokenId = Number(row?.tokenId);
  if (!tokenGroup && !tokenName && !Number.isFinite(tokenId)) return billingDetails ?? null;
  return {
    ...base,
    selectedToken: {
      tokenId: Number.isFinite(tokenId) ? tokenId : null,
      tokenName: tokenName || null,
      tokenGroup: tokenGroup || null,
    },
  };
}

export async function insertProxyLog(input: ProxyLogInsertInput): Promise<void> {
  const baseValues = {
    routeId: input.routeId ?? null,
    channelId: input.channelId ?? null,
    accountId: input.accountId ?? null,
    modelRequested: input.modelRequested ?? null,
    modelActual: input.modelActual ?? null,
    status: input.status ?? null,
    httpStatus: input.httpStatus ?? null,
    latencyMs: input.latencyMs ?? null,
    promptTokens: input.promptTokens ?? null,
    completionTokens: input.completionTokens ?? null,
    totalTokens: input.totalTokens ?? null,
    estimatedCost: input.estimatedCost ?? 0,
    errorMessage: input.errorMessage ?? null,
    retryCount: input.retryCount ?? 0,
    createdAt: input.createdAt ?? null,
  };
  const enrichedBillingDetails = await withChannelTokenBillingDetails(
    input.billingDetails ?? null,
    input.channelId,
  );
  const serializedBillingDetails = enrichedBillingDetails == null
    ? null
    : JSON.stringify(enrichedBillingDetails);
  const includeBillingDetails = serializedBillingDetails !== null
    && await hasProxyLogBillingDetailsColumn();
  const includeDownstreamApiKeyId = input.downstreamApiKeyId != null
    && await hasProxyLogDownstreamApiKeyIdColumn();
  const requestedClientFields = [
    input.clientFamily,
    input.clientAppId,
    input.clientAppName,
    input.clientConfidence,
  ].some((value) => value != null && String(value).trim().length > 0);
  const includeClientFields = requestedClientFields
    && await hasProxyLogClientColumns();
  const requestedStreamTimingFields = input.isStream != null || input.firstByteLatencyMs != null;
  const includeStreamTimingFields = requestedStreamTimingFields
    && await hasProxyLogStreamTimingColumns();

  let allowBillingDetails = includeBillingDetails;
  let allowDownstreamApiKeyId = includeDownstreamApiKeyId;
  let allowClientFields = includeClientFields;
  let allowStreamTimingFields = includeStreamTimingFields;

  while (true) {
    const values = {
      ...baseValues,
      ...(allowStreamTimingFields
        ? {
          isStream: input.isStream ?? null,
          firstByteLatencyMs: input.firstByteLatencyMs ?? null,
        }
        : {}),
      ...(allowBillingDetails ? { billingDetails: serializedBillingDetails } : {}),
      ...(allowDownstreamApiKeyId ? { downstreamApiKeyId: input.downstreamApiKeyId } : {}),
      ...(allowClientFields
        ? {
          clientFamily: input.clientFamily ?? null,
          clientAppId: input.clientAppId ?? null,
          clientAppName: input.clientAppName ?? null,
          clientConfidence: input.clientConfidence ?? null,
        }
        : {}),
    };

    try {
      await db.insert(schema.proxyLogs).values(values).run();
      await accumulateAccountCacheUsage(input);
      return;
    } catch (error) {
      if (allowBillingDetails && isMissingBillingDetailsColumnError(error)) {
        allowBillingDetails = false;
        continue;
      }

      if (allowDownstreamApiKeyId && isMissingDownstreamApiKeyIdColumnError(error)) {
        allowDownstreamApiKeyId = false;
        continue;
      }

      if (allowClientFields && isMissingProxyLogClientColumnsError(error)) {
        allowClientFields = false;
        continue;
      }

      if (allowStreamTimingFields && isMissingProxyLogStreamTimingColumnsError(error)) {
        allowStreamTimingFields = false;
        continue;
      }

      throw error;
    }
  }
}
