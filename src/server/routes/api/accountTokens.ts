import { FastifyInstance } from 'fastify';
import { and, eq, inArray } from 'drizzle-orm';
import { db, schema } from '../../db/index.js';
import { insertAndGetById } from '../../db/insertHelpers.js';
import {
  ACCOUNT_TOKEN_VALUE_STATUS_MASKED_PENDING,
  ACCOUNT_TOKEN_VALUE_STATUS_READY,
  isMaskedPendingAccountToken,
  isMaskedTokenValue,
  isUsableAccountToken,
  listTokensWithRelations,
  normalizeTokenForDisplay,
  maskToken,
  repairDefaultToken,
  resolveAccountTokenValueStatus,
  setDefaultToken,
  upsertAccountTokenGroupEnabledPreference,
} from '../../services/accountTokenService.js';
import { getAdapter } from '../../services/platforms/index.js';
import { getCredentialModeFromExtraConfig, getProxyUrlFromExtraConfig, resolvePlatformUserId } from '../../services/accountExtraConfig.js';
import {
  appendBackgroundTaskLog,
  startBackgroundTask,
  waitForBackgroundTaskCompletion,
} from '../../services/backgroundTaskService.js';
import { withAccountProxyOverride } from '../../services/siteProxy.js';
import { type ModelRefreshResult } from '../../services/modelService.js';
import { scheduleRoutesOnlyRebuild } from '../../services/routeRefreshWorkflow.js';
import { deleteRouteChannelsByTokenIdsPreservingStats } from '../../services/routeChannelStatsService.js';
import {
  type CoverageBatchRebuildResult,
  convergeAccountMutation,
  refreshAccountCoverageBatch,
} from '../../services/accountMutationWorkflow.js';
import {
  parseAccountTokenBatchPayload,
  parseAccountTokenCreatePayload,
  parseAccountTokenSyncAllPayload,
  parseAccountTokenUpdatePayload,
} from '../../contracts/accountTokensRoutePayloads.js';
import {
  buildTokenGroupPricingOverview,
  listTokenGroupPricingGroups,
  syncTokenGroupPricingCache,
} from '../../services/tokenGroupPricingOverviewService.js';
import { getAccountTokenModels } from '../../services/accountTokenModelService.js';
import {
  persistSkippedAccountTokenModelAvailability,
  testAccountTokenModelAvailability,
} from '../../services/accountTokenAvailabilityTestService.js';
import {
  recordManualAccountTokenHealthCheckResults,
  runAccountTokenHealthCheck,
  updateAccountTokenHealthCheckConfig,
} from '../../services/accountTokenHealthCheckService.js';
import { invalidateTokenRouterCache } from '../../services/tokenRouter.js';

type AccountWithSiteRow = {
  accounts: typeof schema.accounts.$inferSelect;
  sites: typeof schema.sites.$inferSelect;
};

type SyncExecutionResult = {
  accountId: number;
  accountName: string;
  accountStatus: string | null;
  siteId: number;
  siteName: string;
  siteStatus: string | null;
  status: 'synced' | 'skipped' | 'failed';
  reason?: string;
  message?: string;
  synced: boolean;
  created: number;
  updated: number;
  maskedPending?: number;
  pendingTokenIds?: number[];
  deleted?: number;
  total: number;
  defaultTokenId?: number | null;
};

function shouldRunAsyncAccountTokenTask(body: Record<string, unknown>): boolean {
  return body.async === true || body.background === true || body.wait === false;
}

function buildTaskQueuedResponse(task: { id: string; status: string }, reused: boolean) {
  return {
    success: true,
    queued: true,
    reused,
    jobId: task.id,
    taskId: task.id,
    status: task.status,
    message: reused ? '检测任务已在后台执行中' : '检测任务已在后台启动',
  };
}

function buildTaskFailureReply(reply: any, task: { error?: string | null } | null, fallbackMessage: string) {
  return reply.code(502).send({
    success: false,
    message: task?.error || fallbackMessage,
  });
}

type CoverageRefreshFailureItem = {
  accountId: number;
  refreshed: false;
  status: 'failed';
  errorCode: 'coverage_refresh_failed';
  errorMessage: string;
  modelCount: 0;
  modelsPreview: string[];
  reason: 'coverage_refresh_failed';
  tokenScanned: 0;
  discoveredByCredential: false;
  discoveredApiToken: false;
};

type CoverageRefreshItem = ModelRefreshResult | CoverageRefreshFailureItem;
type CoverageRefreshRebuildResult = CoverageBatchRebuildResult;

type EnsureGroupTokensExecutionResult = {
  accountId: number;
  accountName: string;
  accountStatus: string | null;
  siteId: number;
  siteName: string;
  siteStatus: string | null;
  status: 'synced' | 'skipped' | 'failed';
  reason?: string;
  message?: string;
  groupCount: number;
  missingGroupCount: number;
  created: number;
  disabled: number;
  syncedCreated: number;
  syncedUpdated: number;
};

const TOKEN_SYNC_TIMEOUT_MS = 15_000;
const GROUP_TOKEN_ENSURE_TIMEOUT_MS = 60_000;
const SYNC_ALL_BATCH_SIZE = 3;
const ACCOUNT_TOKEN_DELETE_TIMEOUT_MS = 15_000;

type AccountTokenDeleteResult = {
  tokenId: number;
  tokenName?: string;
  accountName?: string;
  siteName?: string;
  success: boolean;
  message?: string;
  upstreamAttempted: boolean;
  upstreamDeleted: boolean;
  upstreamSkippedReason?: string;
  localDeleted: boolean;
};

type AccountTokenDeleteTaskResult = {
  total: number;
  successIds: number[];
  failedItems: Array<{ id: number; message: string }>;
  results: AccountTokenDeleteResult[];
};

function buildSyncAccountLabel(item: SyncExecutionResult): string {
  const account = (item.accountName || `#${item.accountId}`).trim();
  const site = (item.siteName || 'unknown-site').trim();
  return `${account} @ ${site}`;
}

function buildSyncReason(item: SyncExecutionResult): string {
  const message = String(item.message || item.reason || '').trim();
  if (!message) return '';
  if (message.length <= 32) return message;
  return `${message.slice(0, 32)}...`;
}

function buildTokenSyncTaskDetailMessage(results: SyncExecutionResult[]): string {
  if (!Array.isArray(results) || results.length === 0) return '';

  const synced = results.filter((item) => item.status === 'synced');
  const skipped = results.filter((item) => item.status === 'skipped');
  const failed = results.filter((item) => item.status === 'failed');

  const renderRows = (rows: SyncExecutionResult[], withReason = false) => {
    const sliced = rows.slice(0, 12).map((item) => {
      const base = buildSyncAccountLabel(item);
      if (!withReason) return base;
      const reason = buildSyncReason(item);
      return reason ? `${base}(${reason})` : base;
    });
    if (rows.length > 12) sliced.push(`...等${rows.length}个`);
    return sliced.join('、');
  };

  const segments: string[] = [
    `成功(${synced.length}): ${synced.length > 0 ? renderRows(synced) : '-'}`,
    `跳过(${skipped.length}): ${skipped.length > 0 ? renderRows(skipped, true) : '-'}`,
    `失败(${failed.length}): ${failed.length > 0 ? renderRows(failed, true) : '-'}`,
  ];
  return segments.join('\n');
}

function buildDeleteTokenLabel(result: AccountTokenDeleteResult): string {
  const token = (result.tokenName || `#${result.tokenId}`).trim();
  const account = (result.accountName || '').trim();
  const site = (result.siteName || '').trim();
  if (account && site) return `${token} (${account} @ ${site})`;
  if (account) return `${token} (${account})`;
  if (site) return `${token} (${site})`;
  return token;
}

function buildTokenDeleteTaskDetailMessage(results: AccountTokenDeleteResult[]): string {
  if (!Array.isArray(results) || results.length === 0) return '';

  const succeeded = results.filter((item) => item.success);
  const failed = results.filter((item) => !item.success);
  const upstreamDeleted = results.filter((item) => item.upstreamDeleted);
  const upstreamSkipped = results.filter((item) => item.upstreamSkippedReason);

  const renderRows = (rows: AccountTokenDeleteResult[], withReason = false) => {
    const sliced = rows.slice(0, 12).map((item) => {
      const base = buildDeleteTokenLabel(item);
      if (!withReason) return base;
      const reason = String(item.message || item.upstreamSkippedReason || '').trim();
      return reason ? `${base}(${reason})` : base;
    });
    if (rows.length > 12) sliced.push(`...等${rows.length}个`);
    return sliced.join('、');
  };

  return [
    `成功(${succeeded.length}): ${succeeded.length > 0 ? renderRows(succeeded) : '-'}`,
    `失败(${failed.length}): ${failed.length > 0 ? renderRows(failed, true) : '-'}`,
    `原站点已删除(${upstreamDeleted.length}): ${upstreamDeleted.length > 0 ? renderRows(upstreamDeleted) : '-'}`,
    `跳过原站点(${upstreamSkipped.length}): ${upstreamSkipped.length > 0 ? renderRows(upstreamSkipped, true) : '-'}`,
  ].join('\n');
}

function buildTokenDeleteEventMessage(result: AccountTokenDeleteResult): string {
  const target = buildDeleteTokenLabel(result);
  const upstream = result.upstreamDeleted
    ? '原站点删除成功'
    : (result.upstreamAttempted
      ? `原站点删除失败：${result.message || '未知错误'}`
      : `原站点未删除：${result.upstreamSkippedReason || '未执行'}`);
  const local = result.localDeleted ? '本地删除成功' : '本地未删除';
  const status = result.success ? '删除成功' : `删除失败：${result.message || '未知错误'}`;
  return `${target}: ${status}；${upstream}；${local}`;
}

async function appendTokenDeleteEvent(result: AccountTokenDeleteResult) {
  const title = result.success ? '账号令牌删除成功' : '账号令牌删除失败';
  const level = result.success ? 'info' : 'error';
  try {
    await db.insert(schema.events).values({
      type: 'token',
      title,
      message: buildTokenDeleteEventMessage(result),
      level,
      relatedId: result.tokenId,
      relatedType: 'account_token',
      createdAt: new Date().toISOString(),
    }).run();
  } catch {}
}

function isSiteDisabled(status?: string | null): boolean {
  return (status || 'active') === 'disabled';
}

function isApiKeyConnection(account: typeof schema.accounts.$inferSelect): boolean {
  const explicit = getCredentialModeFromExtraConfig(account.extraConfig);
  if (explicit && explicit !== 'auto') return explicit === 'apikey';
  return !(account.accessToken || '').trim();
}

function asTrimmedString(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined;
  const trimmed = value.trim();
  return trimmed || undefined;
}

function parseOptionalBoolean(value: unknown): boolean | undefined {
  if (typeof value === 'boolean') return value;
  if (typeof value !== 'string') return undefined;
  const normalized = value.trim().toLowerCase();
  if (normalized === 'true' || normalized === '1') return true;
  if (normalized === 'false' || normalized === '0') return false;
  return undefined;
}

function parsePositiveInteger(value: unknown): number | undefined {
  if (typeof value === 'number' && Number.isFinite(value)) {
    const normalized = Math.trunc(value);
    return normalized > 0 ? normalized : undefined;
  }
  if (typeof value !== 'string') return undefined;
  const trimmed = value.trim();
  if (!trimmed) return undefined;
  const normalized = Number.parseInt(trimmed, 10);
  if (Number.isNaN(normalized) || normalized <= 0) return undefined;
  return normalized;
}

function parseExpiredTime(value: unknown): number | undefined {
  if (typeof value === 'number' && Number.isFinite(value)) {
    const normalized = Math.trunc(value);
    return normalized > 0 ? normalized : undefined;
  }
  if (typeof value !== 'string') return undefined;
  const trimmed = value.trim();
  if (!trimmed) return undefined;

  if (/^\d+$/.test(trimmed)) {
    const numericValue = Number.parseInt(trimmed, 10);
    if (!Number.isNaN(numericValue) && numericValue > 0) return numericValue;
  }

  const parsedMs = Date.parse(trimmed);
  if (!Number.isFinite(parsedMs)) return undefined;
  const seconds = Math.trunc(parsedMs / 1000);
  return seconds > 0 ? seconds : undefined;
}

function normalizeBatchIds(input: unknown): number[] {
  if (!Array.isArray(input)) return [];
  return input
    .map((item) => Number.parseInt(String(item), 10))
    .filter((id) => Number.isFinite(id) && id > 0);
}

function normalizeTokenGroupKey(value: unknown): string {
  return String(value || '').trim();
}

function normalizeTokenValueKey(value: unknown): string {
  return String(value || '').trim();
}

async function removeRouteChannelsForAccountTokens(tokenIds: number[]): Promise<number> {
  const removed = await deleteRouteChannelsByTokenIdsPreservingStats(tokenIds);
  invalidateTokenRouterCache();
  if (removed > 0) {
    scheduleRoutesOnlyRebuild('account-token-route-channels-removed');
  }
  return removed;
}

async function saveAccountTokenEnabledPreference(token: typeof schema.accountTokens.$inferSelect): Promise<void> {
  await upsertAccountTokenGroupEnabledPreference({
    accountId: token.accountId,
    tokenGroup: token.tokenGroup,
    tokenName: token.name,
    enabled: token.enabled === true,
  });
}

function scheduleAccountTokenRouteRebuild(reason: string) {
  invalidateTokenRouterCache();
  scheduleRoutesOnlyRebuild(reason);
}

async function removeRouteChannelsForDisabledAccountTokens(accountId: number): Promise<number> {
  const disabledTokens = await db.select({ id: schema.accountTokens.id })
    .from(schema.accountTokens)
    .where(and(
      eq(schema.accountTokens.accountId, accountId),
      eq(schema.accountTokens.enabled, false),
    ))
    .all();
  return removeRouteChannelsForAccountTokens(disabledTokens.map((token) => token.id));
}

function normalizeGeneratedTokenName(group: string, index: number): string {
  const collapsed = group.replace(/\s+/g, '');
  const sanitized = collapsed.replace(/[^\p{L}\p{N}_-]+/gu, '-').replace(/^-+|-+$/g, '');
  return sanitized || `group-${index}`;
}

function buildCapturedTokenSyncResult(
  row: AccountWithSiteRow,
  tokenSync: Awaited<ReturnType<typeof convergeAccountMutation>>['tokenSync'],
): SyncExecutionResult {
  return {
    accountId: row.accounts.id,
    accountName: row.accounts.username || `account-${row.accounts.id}`,
    accountStatus: row.accounts.status,
    siteId: row.sites.id,
    siteName: row.sites.name,
    siteStatus: row.sites.status,
    status: 'synced',
    reason: 'created_token_captured',
    message: 'created token captured from upstream response',
    synced: true,
    created: tokenSync?.created || 0,
    updated: tokenSync?.updated || 0,
    maskedPending: tokenSync?.maskedPending || 0,
    pendingTokenIds: tokenSync?.pendingTokenIds || [],
    deleted: 0,
    total: tokenSync?.total || 0,
    defaultTokenId: tokenSync?.defaultTokenId || null,
  };
}

async function withTimeout<T>(fn: () => Promise<T>, timeoutMs: number, timeoutMessage: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | null = null;
  try {
    return await Promise.race([
      fn(),
      new Promise<T>((_, reject) => {
        timer = setTimeout(() => reject(new Error(timeoutMessage)), timeoutMs);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

async function executeAccountTokenSync(row: AccountWithSiteRow): Promise<SyncExecutionResult> {
  const accountId = row.accounts.id;
  const base = {
    accountId,
    accountName: row.accounts.username || `account-${accountId}`,
    accountStatus: row.accounts.status,
    siteId: row.sites.id,
    siteName: row.sites.name,
    siteStatus: row.sites.status,
  };

  if (isSiteDisabled(row.sites.status)) {
    return {
      ...base,
      status: 'skipped',
      reason: 'site_disabled',
      message: 'site disabled',
      synced: false,
      created: 0,
      updated: 0,
      total: 0,
      defaultTokenId: null,
    };
  }

  if (isApiKeyConnection(row.accounts)) {
    return {
      ...base,
      status: 'skipped',
      reason: 'apikey_connection',
      message: 'apikey connection does not support account tokens',
      synced: false,
      created: 0,
      updated: 0,
      total: 0,
      defaultTokenId: null,
    };
  }

  if (!row.accounts.accessToken) {
    return {
      ...base,
      status: 'skipped',
      reason: 'missing_access_token',
      synced: false,
      created: 0,
      updated: 0,
      total: 0,
      defaultTokenId: null,
    };
  }

  const adapter = getAdapter(row.sites.platform);
  if (!adapter) {
    return {
      ...base,
      status: 'failed',
      reason: 'unsupported_platform',
      message: `不支持的平台: ${row.sites.platform}`,
      synced: false,
      created: 0,
      updated: 0,
      total: 0,
      defaultTokenId: null,
    };
  }

  try {
    const platformUserId = resolvePlatformUserId(row.accounts.extraConfig, row.accounts.username);
    const accountProxyUrl = getProxyUrlFromExtraConfig(row.accounts.extraConfig);
    const tokens = await withTimeout(
      () => withAccountProxyOverride(accountProxyUrl,
        () => adapter.getApiTokens(row.sites.url, row.accounts.accessToken, platformUserId)),
      TOKEN_SYNC_TIMEOUT_MS,
      `token sync timeout (${Math.round(TOKEN_SYNC_TIMEOUT_MS / 1000)}s)`,
    );

    if (tokens.length === 0) {
      const deleted = await deleteAllLocalAccountTokens(accountId);
      return {
        ...base,
        status: deleted > 0 ? 'synced' : 'skipped',
        reason: 'no_upstream_tokens',
        message: deleted > 0
          ? 'upstream returned no api tokens; local account tokens were cleared'
          : 'upstream returned no api tokens',
        synced: deleted > 0,
        created: 0,
        updated: 0,
        deleted,
        total: 0,
        defaultTokenId: null,
      };
    }

    const convergence = await convergeAccountMutation({
      accountId,
      upstreamTokens: tokens,
    });
    const synced = convergence.tokenSync!;
    const deleted = await deleteMissingUpstreamTokens(accountId, tokens);
    await removeRouteChannelsForDisabledAccountTokens(accountId);
    if ((synced.maskedPending || 0) > 0) {
      return {
        ...base,
        status: 'synced',
        reason: 'upstream_masked_tokens',
        message: `上游返回 ${synced.maskedPending} 条脱敏令牌，已保存为待补全记录，请手动补全明文 token。`,
        synced: true,
        ...synced,
        deleted,
      };
    }
    return {
      ...base,
      status: 'synced',
      synced: true,
      ...synced,
      deleted,
    };
  } catch (error: any) {
    return {
      ...base,
      status: 'failed',
      reason: 'sync_error',
      message: error?.message || 'sync failed',
      synced: false,
      created: 0,
      updated: 0,
      total: 0,
      defaultTokenId: null,
    };
  }
}

async function appendTokenSyncEvent(result: SyncExecutionResult) {
  const title = result.status === 'synced'
    ? '令牌同步成功'
    : (result.status === 'skipped' ? '令牌同步跳过' : '令牌同步失败');
  const level = result.status === 'synced'
    ? 'info'
    : (result.status === 'skipped' ? 'warning' : 'error');
  const detail = result.status === 'synced'
    ? `新增 ${result.created}，更新 ${result.updated}，删除本地多余 ${result.deleted || 0}，待补全 ${result.maskedPending || 0}，总数 ${result.total}`
    : (result.message || result.reason || 'sync skipped');

  try {
    await db.insert(schema.events).values({
      type: 'token',
      title,
      message: `${result.accountName} @ ${result.siteName}: ${detail}`,
      level,
      relatedId: result.accountId,
      relatedType: 'account',
      createdAt: new Date().toISOString(),
    }).run();
  } catch {}
}

async function executeSyncAllAccountTokens() {
  const rows = await db.select().from(schema.accounts)
    .innerJoin(schema.sites, eq(schema.accounts.siteId, schema.sites.id))
    .where(eq(schema.accounts.status, 'active'))
    .all();

  let pricingRefresh: Awaited<ReturnType<typeof buildTokenGroupPricingOverview>> | null = null;
  try {
    pricingRefresh = await buildTokenGroupPricingOverview({ refresh: true });
  } catch (error: any) {
    console.warn(`[account-tokens] group pricing refresh failed before sync-all: ${error?.message || error}`);
  }

  const results: SyncExecutionResult[] = [];
  for (let offset = 0; offset < rows.length; offset += SYNC_ALL_BATCH_SIZE) {
    const batch = rows.slice(offset, offset + SYNC_ALL_BATCH_SIZE);
    const batchResults = await Promise.all(
      batch.map(async (row) => {
        const result = await executeAccountTokenSync(row);
        appendTokenSyncEvent(result);
        return result;
      }),
    );
    results.push(...batchResults);
  }

  const coverageRefresh = await refreshCoverageForAccounts(
    results
      .filter((item) => item.status === 'synced')
      .map((item) => item.accountId),
  );

  const summary = {
    total: results.length,
    synced: results.filter((item) => item.status === 'synced').length,
    skipped: results.filter((item) => item.status === 'skipped').length,
    failed: results.filter((item) => item.status === 'failed').length,
    created: results.reduce((acc, item) => acc + item.created, 0),
    updated: results.reduce((acc, item) => acc + item.updated, 0),
    deleted: results.reduce((acc, item) => acc + (item.deleted || 0), 0),
    pricingAvailableCount: pricingRefresh?.summary?.pricingAvailableCount || 0,
    pricingRefreshFailed: pricingRefresh === null,
  };

  return { summary, results, coverageRefresh, pricingRefresh };
}

async function fetchUpstreamApiTokens(row: AccountWithSiteRow, timeoutMs = TOKEN_SYNC_TIMEOUT_MS) {
  const adapter = getAdapter(row.sites.platform);
  if (!adapter) throw new Error(`不支持的平台: ${row.sites.platform}`);
  const platformUserId = resolvePlatformUserId(row.accounts.extraConfig, row.accounts.username);
  const accountProxyUrl = getProxyUrlFromExtraConfig(row.accounts.extraConfig);
  const tokens = await withTimeout(
    () => withAccountProxyOverride(accountProxyUrl,
      () => adapter.getApiTokens(row.sites.url, row.accounts.accessToken, platformUserId)),
    timeoutMs,
    `token sync timeout (${Math.round(timeoutMs / 1000)}s)`,
  );
  return tokens;
}

async function deleteAllLocalAccountTokens(accountId: number) {
  const localTokens = await db.select()
    .from(schema.accountTokens)
    .where(eq(schema.accountTokens.accountId, accountId))
    .all();
  if (localTokens.length === 0) return 0;

  await removeRouteChannelsForAccountTokens(localTokens.map((token) => token.id));
  for (const token of localTokens) {
    await db.delete(schema.accountTokens)
      .where(eq(schema.accountTokens.id, token.id))
      .run();
  }
  await repairDefaultToken(accountId);
  return localTokens.length;
}

async function deleteMissingUpstreamTokens(accountId: number, upstreamTokens: Array<{ key?: string | null; name?: string | null; tokenGroup?: string | null }>) {
  const upstreamTokenValues = new Set(upstreamTokens.map((token) => normalizeTokenValueKey(token.key)).filter(Boolean));
  const upstreamNameGroupKeys = new Set(upstreamTokens.map((token) => {
    const name = String(token.name || '').trim();
    const group = normalizeTokenGroupKey(token.tokenGroup || token.name);
    return name || group ? `${name}::${group}` : '';
  }).filter(Boolean));
  if (upstreamTokenValues.size === 0 && upstreamNameGroupKeys.size === 0) return 0;

  const localTokens = await db.select()
    .from(schema.accountTokens)
    .where(eq(schema.accountTokens.accountId, accountId))
    .all();
  const tokensToDelete: typeof schema.accountTokens.$inferSelect[] = [];
  for (const token of localTokens) {
    if (upstreamTokenValues.has(normalizeTokenValueKey(token.token))) continue;
    const localNameGroupKey = `${String(token.name || '').trim()}::${normalizeTokenGroupKey(token.tokenGroup || token.name)}`;
    if (upstreamNameGroupKeys.has(localNameGroupKey)) continue;
    tokensToDelete.push(token);
  }

  if (tokensToDelete.length === 0) return 0;

  const deletedTokenIds = tokensToDelete.map((token) => token.id);
  const defaultDeleted = tokensToDelete.some((token) => token.isDefault === true);
  await removeRouteChannelsForAccountTokens(deletedTokenIds);
  for (const token of tokensToDelete) {
    await db.delete(schema.accountTokens)
      .where(eq(schema.accountTokens.id, token.id))
      .run();
  }
  if (defaultDeleted) {
    await repairDefaultToken(accountId);
  }
  return tokensToDelete.length;
}

async function executeEnsureGroupTokensForAccount(row: AccountWithSiteRow): Promise<EnsureGroupTokensExecutionResult> {
  const accountId = row.accounts.id;
  const base = {
    accountId,
    accountName: row.accounts.username || `account-${accountId}`,
    accountStatus: row.accounts.status,
    siteId: row.sites.id,
    siteName: row.sites.name,
    siteStatus: row.sites.status,
  };

  if (isSiteDisabled(row.sites.status)) {
    return { ...base, status: 'skipped', reason: 'site_disabled', message: 'site disabled', groupCount: 0, missingGroupCount: 0, created: 0, disabled: 0, syncedCreated: 0, syncedUpdated: 0 };
  }
  if (isApiKeyConnection(row.accounts)) {
    return { ...base, status: 'skipped', reason: 'apikey_connection', message: 'apikey connection does not support account tokens', groupCount: 0, missingGroupCount: 0, created: 0, disabled: 0, syncedCreated: 0, syncedUpdated: 0 };
  }
  if (!row.accounts.accessToken?.trim()) {
    return { ...base, status: 'skipped', reason: 'missing_access_token', message: '账号缺少访问令牌', groupCount: 0, missingGroupCount: 0, created: 0, disabled: 0, syncedCreated: 0, syncedUpdated: 0 };
  }

  const adapter = getAdapter(row.sites.platform);
  if (!adapter) {
    return { ...base, status: 'failed', reason: 'unsupported_platform', message: `不支持的平台: ${row.sites.platform}`, groupCount: 0, missingGroupCount: 0, created: 0, disabled: 0, syncedCreated: 0, syncedUpdated: 0 };
  }

  try {
    const platformUserId = resolvePlatformUserId(row.accounts.extraConfig, row.accounts.username);
    const accountProxyUrl = getProxyUrlFromExtraConfig(row.accounts.extraConfig);
    const groups = await withTimeout(
      () => withAccountProxyOverride(accountProxyUrl,
        () => adapter.getUserGroups(row.sites.url, row.accounts.accessToken, platformUserId)),
      GROUP_TOKEN_ENSURE_TIMEOUT_MS,
      `group fetch timeout (${Math.round(GROUP_TOKEN_ENSURE_TIMEOUT_MS / 1000)}s)`,
    );
    const normalizedGroups = Array.from(new Set((groups || []).map(normalizeTokenGroupKey).filter(Boolean)));
    if (normalizedGroups.length === 0) {
      return { ...base, status: 'skipped', reason: 'no_groups', message: 'upstream returned no groups', groupCount: 0, missingGroupCount: 0, created: 0, disabled: 0, syncedCreated: 0, syncedUpdated: 0 };
    }

    let upstreamTokens = await fetchUpstreamApiTokens(row, GROUP_TOKEN_ENSURE_TIMEOUT_MS);
    const syncedBeforeCreate = upstreamTokens.length > 0
      ? (await convergeAccountMutation({ accountId, upstreamTokens })).tokenSync
      : null;
    let deleted = upstreamTokens.length > 0 ? await deleteMissingUpstreamTokens(accountId, upstreamTokens) : 0;
    await removeRouteChannelsForDisabledAccountTokens(accountId);
    const existingGroups = new Set(upstreamTokens.map((token) => normalizeTokenGroupKey(token.tokenGroup || token.name)).filter(Boolean));
    const missingGroups = normalizedGroups.filter((group) => !existingGroups.has(group));
    let created = 0;
    let createdWithoutClearToken = 0;

    for (let index = 0; index < missingGroups.length; index += 1) {
      const group = missingGroups[index]!;
      const name = normalizeGeneratedTokenName(group, index + 1);
      const createdTokensFromUpstream: Array<{ name: string; key: string; enabled?: boolean; tokenGroup?: string | null }> = [];
      let createdViaUpstream = false;
      try {
        createdViaUpstream = await withTimeout(
          () => withAccountProxyOverride(accountProxyUrl,
            () => adapter.createApiToken(
              row.sites.url,
              row.accounts.accessToken,
              platformUserId,
              {
                name,
                group,
                unlimitedQuota: true,
                onCreatedToken: (token) => createdTokensFromUpstream.push(token),
              },
            )),
          GROUP_TOKEN_ENSURE_TIMEOUT_MS,
          `token create timeout (${Math.round(GROUP_TOKEN_ENSURE_TIMEOUT_MS / 1000)}s)`,
        );
      } catch (error: any) {
        const refreshedTokens = await fetchUpstreamApiTokens(row, GROUP_TOKEN_ENSURE_TIMEOUT_MS).catch(() => []);
        const matchedAfterTimeout = refreshedTokens.find((token) => (
          normalizeTokenGroupKey(token.tokenGroup || token.name) === group
          || String(token.name || '').trim() === name
        ));
        if (!matchedAfterTimeout) {
          throw error;
        }
        createdViaUpstream = true;
        upstreamTokens = refreshedTokens;
        await convergeAccountMutation({ accountId, upstreamTokens: refreshedTokens });
        deleted += await deleteMissingUpstreamTokens(accountId, refreshedTokens);
        await removeRouteChannelsForDisabledAccountTokens(accountId);
      }
      if (!createdViaUpstream) continue;
      created++;
      const capturedToken = createdTokensFromUpstream.find((token) => !isMaskedTokenValue(token.key));
      if (capturedToken) {
        await convergeAccountMutation({
          accountId,
          upstreamTokens: [{ ...capturedToken, name, tokenGroup: group }],
        });
        await removeRouteChannelsForDisabledAccountTokens(accountId);
      } else {
        createdWithoutClearToken++;
      }
    }

    if (createdWithoutClearToken > 0 || (created === 0 && upstreamTokens.length === 0)) {
      upstreamTokens = await fetchUpstreamApiTokens(row, GROUP_TOKEN_ENSURE_TIMEOUT_MS);
      if (upstreamTokens.length > 0) {
        await convergeAccountMutation({ accountId, upstreamTokens });
        deleted += await deleteMissingUpstreamTokens(accountId, upstreamTokens);
        await removeRouteChannelsForDisabledAccountTokens(accountId);
      }
    }

    return {
      ...base,
      status: 'synced',
      groupCount: normalizedGroups.length,
      missingGroupCount: missingGroups.length,
      created,
      disabled: deleted,
      syncedCreated: syncedBeforeCreate?.created || 0,
      syncedUpdated: syncedBeforeCreate?.updated || 0,
    };
  } catch (error: any) {
    return {
      ...base,
      status: 'failed',
      reason: 'ensure_group_tokens_error',
      message: error?.message || '获取分组并补齐令牌失败',
      groupCount: 0,
      missingGroupCount: 0,
      created: 0,
      disabled: 0,
      syncedCreated: 0,
      syncedUpdated: 0,
    };
  }
}

async function executeEnsureGroupTokensAllAccounts() {
  const rows = await db.select().from(schema.accounts)
    .innerJoin(schema.sites, eq(schema.accounts.siteId, schema.sites.id))
    .where(eq(schema.accounts.status, 'active'))
    .all();

  const results: EnsureGroupTokensExecutionResult[] = [];
  for (let offset = 0; offset < rows.length; offset += SYNC_ALL_BATCH_SIZE) {
    const batch = rows.slice(offset, offset + SYNC_ALL_BATCH_SIZE);
    const batchResults = await Promise.all(batch.map((row) => executeEnsureGroupTokensForAccount(row)));
    results.push(...batchResults);
  }

  const syncedAccountIds = results.filter((item) => item.status === 'synced').map((item) => item.accountId);
  const coverageRefresh = await refreshCoverageForAccounts(syncedAccountIds);
  let pricingRefresh: Awaited<ReturnType<typeof buildTokenGroupPricingOverview>> | null = null;
  try {
    pricingRefresh = await buildTokenGroupPricingOverview({ refresh: true });
  } catch (error: any) {
    console.warn(`[account-tokens] group pricing refresh failed after ensure-all: ${error?.message || error}`);
  }
  const summary = {
    total: results.length,
    synced: results.filter((item) => item.status === 'synced').length,
    skipped: results.filter((item) => item.status === 'skipped').length,
    failed: results.filter((item) => item.status === 'failed').length,
    groupCount: results.reduce((acc, item) => acc + item.groupCount, 0),
    missingGroupCount: results.reduce((acc, item) => acc + item.missingGroupCount, 0),
    created: results.reduce((acc, item) => acc + item.created, 0),
    disabled: results.reduce((acc, item) => acc + item.disabled, 0),
    pricingAvailableCount: pricingRefresh?.summary?.pricingAvailableCount || 0,
    pricingRefreshFailed: pricingRefresh === null,
  };

  return { summary, results, coverageRefresh, pricingRefresh };
}

async function refreshCoverageForAccounts(accountIds: number[]) {
  const result = await refreshAccountCoverageBatch({
    accountIds,
    batchSize: SYNC_ALL_BATCH_SIZE,
    mapFailure: buildCoverageRefreshFailureItem,
  });

  result.refresh.forEach((item) => {
    if ((item as CoverageRefreshFailureItem).reason === 'coverage_refresh_failed') {
      const failed = item as CoverageRefreshFailureItem;
      console.warn(`[account-tokens] coverage refresh failed for account ${failed.accountId}: ${failed.errorMessage}`);
    }
  });
  if (result.rebuild && !result.rebuild.success) {
    console.warn(`[account-tokens] token route rebuild failed after coverage refresh: ${result.rebuild.error}`);
  }

  return {
    refresh: result.refresh as CoverageRefreshItem[],
    rebuild: result.rebuild as CoverageRefreshRebuildResult | null,
  };
}

function buildCoverageRefreshFailureItem(
  accountId: number,
  errorMessage: string,
): CoverageRefreshFailureItem {
  return {
    accountId,
    refreshed: false,
    status: 'failed',
    errorCode: 'coverage_refresh_failed',
    errorMessage,
    modelCount: 0,
    modelsPreview: [],
    reason: 'coverage_refresh_failed',
    tokenScanned: 0,
    discoveredByCredential: false,
    discoveredApiToken: false,
  };
}

export async function accountTokensRoutes(app: FastifyInstance) {
  app.get<{ Querystring: { accountId?: string } }>('/api/account-tokens', async (request) => {
    const accountId = request.query.accountId ? Number.parseInt(request.query.accountId, 10) : undefined;
    return listTokensWithRelations(Number.isFinite(accountId as number) ? accountId : undefined);
  });

  app.get<{ Querystring: { refresh?: string | boolean } }>('/api/account-tokens/group-pricing/overview', async (request) => {
    const refresh = parseOptionalBoolean(request.query.refresh) === true;
    return buildTokenGroupPricingOverview({ refresh });
  });

  app.post('/api/account-tokens/group-pricing/sync', async () => syncTokenGroupPricingCache());

  app.get<{ Querystring: { model?: string; sortBy?: string; sortOrder?: string } }>('/api/account-tokens/group-pricing/groups', async (request) => {
    const sortBy = ['site', 'group', 'ratio', 'modelCount'].includes(String(request.query.sortBy || ''))
      ? request.query.sortBy as 'site' | 'group' | 'ratio' | 'modelCount'
      : undefined;
    const sortOrder = request.query.sortOrder === 'desc' ? 'desc' : 'asc';
    return listTokenGroupPricingGroups({
      model: request.query.model,
      sortBy,
      sortOrder,
    });
  });

  app.post<{ Body: unknown }>('/api/account-tokens', async (request, reply) => {
    const parsedBody = parseAccountTokenCreatePayload(request.body);
    if (!parsedBody.success) {
      return reply.code(400).send({ success: false, message: parsedBody.error });
    }

    const body = parsedBody.data;
    const row = await db.select()
      .from(schema.accounts)
      .innerJoin(schema.sites, eq(schema.accounts.siteId, schema.sites.id))
      .where(eq(schema.accounts.id, body.accountId))
      .get();
    if (!row) {
      return reply.code(404).send({ success: false, message: '账号不存在' });
    }

    if (isApiKeyConnection(row.accounts)) {
      return reply.code(400).send({ success: false, message: 'API Key 连接不支持创建账号令牌' });
    }

    const tokenValue = (body.token || '').trim();
    if (tokenValue) {
      const now = new Date().toISOString();
      const existing = await db.select().from(schema.accountTokens)
        .where(eq(schema.accountTokens.accountId, body.accountId))
        .all();
      const valueStatus = isMaskedTokenValue(tokenValue)
        ? ACCOUNT_TOKEN_VALUE_STATUS_MASKED_PENDING
        : ACCOUNT_TOKEN_VALUE_STATUS_READY;
      const enabled = valueStatus === ACCOUNT_TOKEN_VALUE_STATUS_READY
        ? (body.enabled ?? true)
        : false;
      const isDefault = valueStatus === ACCOUNT_TOKEN_VALUE_STATUS_READY
        ? (body.isDefault ?? false)
        : false;

      let created = await insertAndGetById<typeof schema.accountTokens.$inferSelect>({
        table: schema.accountTokens,
        idColumn: schema.accountTokens.id,
        values: {
          accountId: body.accountId,
          name: (body.name || '').trim() || (existing.length === 0 ? 'default' : `token-${existing.length + 1}`),
          token: tokenValue,
          tokenGroup: (body.group || '').trim() || null,
          valueStatus,
          source: body.source || 'manual',
          enabled,
          isDefault,
          createdAt: now,
          updatedAt: now,
        },
        insertErrorMessage: '创建令牌失败',
        loadErrorMessage: '创建令牌失败',
      });

      if (valueStatus === ACCOUNT_TOKEN_VALUE_STATUS_READY && (body.isDefault || (existing.length === 0 && enabled))) {
        await setDefaultToken(created.id);
      } else if (valueStatus === ACCOUNT_TOKEN_VALUE_STATUS_READY && existing.every((token) => !token.isDefault) && enabled) {
        await setDefaultToken(created.id);
      }
      const coverageRefresh = await refreshCoverageForAccounts([body.accountId]);
      created = await db.select().from(schema.accountTokens).where(eq(schema.accountTokens.id, created.id)).get();
      if (!created) {
        return reply.code(500).send({ success: false, message: '创建令牌失败' });
      }
      return { success: true, token: created, coverageRefresh };
    }

    const account = row.accounts;
    const site = row.sites;

    if (isSiteDisabled(site.status)) {
      return reply.code(400).send({ success: false, message: '站点已禁用，无法创建令牌' });
    }

    if (!account.accessToken?.trim()) {
      return reply.code(400).send({ success: false, message: '账号缺少访问令牌，无法创建站点令牌' });
    }

    const adapter = getAdapter(site.platform);
    if (!adapter) {
      return reply.code(400).send({ success: false, message: `不支持的平台: ${site.platform}` });
    }

    const unlimitedQuota = body.unlimitedQuota === undefined
      ? undefined
      : parseOptionalBoolean(body.unlimitedQuota);
    if (body.unlimitedQuota !== undefined && unlimitedQuota === undefined) {
      return reply.code(400).send({ success: false, message: 'unlimitedQuota 参数无效' });
    }

    const remainQuota = body.remainQuota === undefined
      ? undefined
      : parsePositiveInteger(body.remainQuota);
    if (body.remainQuota !== undefined && remainQuota === undefined) {
      return reply.code(400).send({ success: false, message: 'remainQuota 必须是正整数' });
    }
    if (unlimitedQuota === false && remainQuota === undefined) {
      return reply.code(400).send({ success: false, message: '有限额度令牌必须填写 remainQuota' });
    }

    const expiredTime = body.expiredTime === undefined
      ? undefined
      : parseExpiredTime(body.expiredTime);
    if (body.expiredTime !== undefined && expiredTime === undefined) {
      return reply.code(400).send({ success: false, message: 'expiredTime 参数无效' });
    }

    const modelLimitsEnabled = body.modelLimitsEnabled === undefined
      ? undefined
      : parseOptionalBoolean(body.modelLimitsEnabled);
    if (body.modelLimitsEnabled !== undefined && modelLimitsEnabled === undefined) {
      return reply.code(400).send({ success: false, message: 'modelLimitsEnabled 参数无效' });
    }

    const platformUserId = resolvePlatformUserId(account.extraConfig, account.username);
    const createdTokensFromUpstream: Array<{ name: string; key: string; enabled?: boolean; tokenGroup?: string | null }> = [];
    const rememberCreatedToken = (token: { name: string; key: string; enabled?: boolean; tokenGroup?: string | null }) => {
      createdTokensFromUpstream.push(token);
    };
    const createdViaUpstream = await withAccountProxyOverride(
      getProxyUrlFromExtraConfig(account.extraConfig),
      () => adapter.createApiToken(
        site.url,
        account.accessToken,
        platformUserId,
        {
          name: asTrimmedString(body.name),
          group: asTrimmedString(body.group),
          unlimitedQuota,
          remainQuota,
          expiredTime,
          allowIps: asTrimmedString(body.allowIps),
          modelLimitsEnabled,
          modelLimits: asTrimmedString(body.modelLimits),
          onCreatedToken: rememberCreatedToken,
        },
      ),
    );
    if (!createdViaUpstream) {
      return reply.code(502).send({ success: false, message: '站点创建令牌失败' });
    }

    const requestedName = asTrimmedString(body.name);
    const requestedGroup = asTrimmedString(body.group);
    const capturedToken = createdTokensFromUpstream.find((token) => !isMaskedTokenValue(token.key));
    let syncResult: SyncExecutionResult;

    if (capturedToken && !isMaskedTokenValue(capturedToken.key)) {
      const convergence = await convergeAccountMutation({
        accountId: account.id,
        upstreamTokens: [{
          ...capturedToken,
          name: requestedName || capturedToken.name,
          tokenGroup: requestedGroup || capturedToken.tokenGroup || null,
        }],
      });
      syncResult = buildCapturedTokenSyncResult(row, convergence.tokenSync);
      const createdLocalToken = await db.select()
        .from(schema.accountTokens)
        .where(and(
          eq(schema.accountTokens.accountId, account.id),
          eq(schema.accountTokens.token, capturedToken.key),
          eq(schema.accountTokens.valueStatus, ACCOUNT_TOKEN_VALUE_STATUS_READY),
        ))
        .get();
      if (createdLocalToken) {
        await setDefaultToken(createdLocalToken.id);
        syncResult.defaultTokenId = createdLocalToken.id;
      }
    } else {
      try {
        syncResult = await executeAccountTokenSync(row);
      } catch (error: any) {
        const refreshedTokens = await fetchUpstreamApiTokens(row, TOKEN_SYNC_TIMEOUT_MS).catch(() => []);
        const matchedAfterCreate = refreshedTokens.find((token) => {
          const name = String(token.name || '').trim();
          const group = normalizeTokenGroupKey(token.tokenGroup || token.name);
          return (requestedName && name === requestedName) || (requestedGroup && group === requestedGroup);
        });
        if (!matchedAfterCreate) {
          throw error;
        }
        const convergence = await convergeAccountMutation({
          accountId: account.id,
          upstreamTokens: refreshedTokens,
        });
        syncResult = buildCapturedTokenSyncResult(row, convergence.tokenSync);
      }
      if (syncResult.status !== 'synced' && /timeout|超时/i.test(String(syncResult.message || syncResult.reason || ''))) {
        const refreshedTokens = await fetchUpstreamApiTokens(row, TOKEN_SYNC_TIMEOUT_MS).catch(() => []);
        const matchedAfterCreate = refreshedTokens.find((token) => {
          const name = String(token.name || '').trim();
          const group = normalizeTokenGroupKey(token.tokenGroup || token.name);
          return (requestedName && name === requestedName) || (requestedGroup && group === requestedGroup);
        });
        if (matchedAfterCreate) {
          const convergence = await convergeAccountMutation({
            accountId: account.id,
            upstreamTokens: refreshedTokens,
          });
          syncResult = buildCapturedTokenSyncResult(row, convergence.tokenSync);
        }
      }
    }
    appendTokenSyncEvent(syncResult);

    if (syncResult.status === 'failed') {
      return reply.code(502).send({ success: false, message: syncResult.message || '同步站点令牌失败' });
    }
    if (syncResult.status === 'skipped') {
      return reply.code(502).send({ success: false, message: syncResult.message || '站点未返回可用令牌' });
    }
    void refreshCoverageForAccounts([account.id]).catch((error) => {
      app.log.warn({ err: error, accountId: account.id }, 'refresh account token coverage after create failed');
    });

    const preferred = await db.select().from(schema.accountTokens)
      .where(and(eq(schema.accountTokens.accountId, account.id), eq(schema.accountTokens.isDefault, true)))
      .get();
    const token = preferred || (await db.select().from(schema.accountTokens)
      .where(eq(schema.accountTokens.accountId, account.id))
      .all())
      .slice(-1)[0] || null;

    return {
      success: true,
      createdViaUpstream: true,
      ...syncResult,
      coverageRefresh: { queued: true },
      token,
    };
  });

  const appendDeleteLog = (taskId: string | null | undefined, message: string) => {
    if (!taskId) return;
    appendBackgroundTaskLog(taskId, message);
  };

  const deleteAccountTokenById = async (
    tokenId: number,
    options: { taskId?: string | null } = {},
  ): Promise<AccountTokenDeleteResult> => {
    const baseResult: AccountTokenDeleteResult = {
      tokenId,
      success: false,
      upstreamAttempted: false,
      upstreamDeleted: false,
      localDeleted: false,
    };
    const row = await db.select()
      .from(schema.accountTokens)
      .innerJoin(schema.accounts, eq(schema.accountTokens.accountId, schema.accounts.id))
      .innerJoin(schema.sites, eq(schema.accounts.siteId, schema.sites.id))
      .where(eq(schema.accountTokens.id, tokenId))
      .get();
    if (!row) {
      appendDeleteLog(options.taskId, `令牌 #${tokenId} 删除失败：令牌不存在`);
      const result = { ...baseResult, message: '令牌不存在' };
      await appendTokenDeleteEvent(result);
      return result;
    }

    const existing = row.account_tokens;
    const account = row.accounts;
    const site = row.sites;
    const labeledResult = {
      ...baseResult,
      tokenName: existing.name || undefined,
      accountName: account.username || undefined,
      siteName: site.name || undefined,
    };
    const tokenLabel = buildDeleteTokenLabel(labeledResult);
    appendDeleteLog(options.taskId, `开始删除账号令牌：${tokenLabel}`);

    if (isApiKeyConnection(row.accounts)) {
      appendDeleteLog(options.taskId, `${tokenLabel} 删除失败：API Key 连接不支持管理账号令牌`);
      const result = { ...labeledResult, message: 'API Key 连接不支持管理账号令牌' };
      await appendTokenDeleteEvent(result);
      return result;
    }

    const adapter = getAdapter(site.platform);
    let upstreamSkippedReason = '';
    if (isMaskedPendingAccountToken(existing)) {
      upstreamSkippedReason = '本地仅保存脱敏占位令牌';
    } else if (isSiteDisabled(site.status)) {
      upstreamSkippedReason = '站点已禁用';
    } else if (!account.accessToken?.trim()) {
      upstreamSkippedReason = '账号缺少访问令牌';
    } else if (!adapter) {
      upstreamSkippedReason = `不支持的平台: ${site.platform}`;
    }
    if (upstreamSkippedReason) {
      const message = `原站点未删除：${upstreamSkippedReason}，本地未删除`;
      appendDeleteLog(options.taskId, `${tokenLabel} 删除失败：${message}`);
      const result = {
        ...labeledResult,
        upstreamSkippedReason,
        message,
      };
      await appendTokenDeleteEvent(result);
      return result;
    }

    const platformUserId = resolvePlatformUserId(account.extraConfig, account.username);
    appendDeleteLog(options.taskId, `${tokenLabel} 正在删除原站点令牌`);
    let upstreamDeleted = false;
    try {
      upstreamDeleted = await withTimeout(
        () => withAccountProxyOverride(
          getProxyUrlFromExtraConfig(account.extraConfig),
          () => adapter!.deleteApiToken(
            site.url,
            account.accessToken,
            existing.token,
            platformUserId,
            {
              name: existing.name,
              group: existing.tokenGroup,
            },
          ),
        ),
        ACCOUNT_TOKEN_DELETE_TIMEOUT_MS,
        `站点删除令牌超时（${Math.round(ACCOUNT_TOKEN_DELETE_TIMEOUT_MS / 1000)}s），本地未删除`,
      );
    } catch (error: any) {
      const message = error?.message || '站点删除令牌失败，本地未删除';
      appendDeleteLog(options.taskId, `${tokenLabel} 原站点删除失败：${message}`);
      const result = {
        ...labeledResult,
        upstreamAttempted: true,
        message,
      };
      await appendTokenDeleteEvent(result);
      return result;
    }
    if (!upstreamDeleted) {
      appendDeleteLog(options.taskId, `${tokenLabel} 原站点删除失败：站点删除令牌失败，本地未删除`);
      const result = {
        ...labeledResult,
        upstreamAttempted: true,
        message: '站点删除令牌失败，本地未删除',
      };
      await appendTokenDeleteEvent(result);
      return result;
    }
    appendDeleteLog(options.taskId, `${tokenLabel} 原站点删除成功`);

    await saveAccountTokenEnabledPreference(existing);
    await removeRouteChannelsForAccountTokens([tokenId]);
    await db.delete(schema.accountTokens).where(eq(schema.accountTokens.id, tokenId)).run();
    if (existing.isDefault) {
      await repairDefaultToken(existing.accountId);
    }
    appendDeleteLog(options.taskId, `${tokenLabel} 本地令牌已删除`);

    const result = {
      ...labeledResult,
      success: true,
      upstreamAttempted: true,
      upstreamDeleted: true,
      localDeleted: true,
    };
    await appendTokenDeleteEvent(result);
    return result;
  };

  const executeDeleteAccountTokens = async (ids: number[], taskId?: string | null): Promise<AccountTokenDeleteTaskResult> => {
    const results: AccountTokenDeleteResult[] = [];
    const successIds: number[] = [];
    const failedItems: Array<{ id: number; message: string }> = [];

    appendDeleteLog(taskId, `删除任务开始，共 ${ids.length} 个账号令牌`);
    for (const id of ids) {
      const result = await deleteAccountTokenById(id, { taskId });
      results.push(result);
      if (result.success) {
        successIds.push(id);
      } else {
        failedItems.push({ id, message: result.message || '删除失败' });
      }
    }
    appendDeleteLog(taskId, `删除任务完成：成功 ${successIds.length}，失败 ${failedItems.length}`);

    const taskResult = {
      total: ids.length,
      successIds,
      failedItems,
      results,
    };
    if (failedItems.length > 0 && successIds.length === 0) {
      throw new Error(failedItems[0]?.message || '账号令牌删除失败');
    }
    return taskResult;
  };

  const queueDeleteAccountTokenTask = (ids: number[]) => {
    let taskId = '';
    const title = ids.length === 1 ? `删除账号令牌 #${ids[0]}` : `批量删除账号令牌（${ids.length}个）`;
    const { task, reused } = startBackgroundTask(
      {
        type: 'token',
        title,
        dedupeKey: `account-token-delete:${ids.join(',')}`,
        notifyOnFailure: true,
        successTitle: (currentTask) => {
          const result = currentTask.result as AccountTokenDeleteTaskResult | null;
          if (!result) return `${title}已完成`;
          return `${title}已完成（成功${result.successIds.length}/失败${result.failedItems.length}）`;
        },
        failureTitle: () => `${title}失败`,
        successMessage: (currentTask) => {
          const result = currentTask.result as AccountTokenDeleteTaskResult | null;
          if (!result) return `${title}已完成`;
          const detail = buildTokenDeleteTaskDetailMessage(result.results);
          const summary = `${title}完成：成功 ${result.successIds.length}，失败 ${result.failedItems.length}`;
          return detail ? `${summary}\n${detail}` : summary;
        },
        failureMessage: (currentTask) => `${title}失败：${currentTask.error || 'unknown error'}`,
      },
      async () => {
        await Promise.resolve();
        return executeDeleteAccountTokens(ids, taskId);
      },
    );
    taskId = task.id;
    return { task, reused };
  };

  app.post<{ Body: unknown }>('/api/account-tokens/batch', async (request, reply) => {
    const parsedBody = parseAccountTokenBatchPayload(request.body);
    if (!parsedBody.success) {
      return reply.code(400).send({ message: parsedBody.error });
    }

    const ids = normalizeBatchIds(parsedBody.data.ids);
    const action = String(parsedBody.data.action || '').trim();
    if (ids.length === 0) {
      return reply.code(400).send({ message: 'ids is required' });
    }
    if (!['enable', 'disable', 'delete'].includes(action)) {
      return reply.code(400).send({ message: 'Invalid action' });
    }

    if (action === 'delete') {
      const { task, reused } = queueDeleteAccountTokenTask(ids);
      return reply.code(202).send({
        success: true,
        queued: true,
        reused,
        jobId: task.id,
        status: task.status,
        successIds: [],
        failedItems: [],
        message: reused
          ? '账号令牌删除任务执行中，请稍后查看程序日志'
          : '账号令牌删除进行中，请稍后查看程序日志',
      });
    }

    const successIds: number[] = [];
    const failedItems: Array<{ id: number; message: string }> = [];
    let removedRouteChannels = 0;
    let routesChanged = false;

    for (const id of ids) {
      try {
        const existing = await db.select().from(schema.accountTokens).where(eq(schema.accountTokens.id, id)).get();
        if (!existing) {
          failedItems.push({ id, message: 'Token not found' });
          continue;
        }

        const owner = await db.select().from(schema.accounts).where(eq(schema.accounts.id, existing.accountId)).get();
        if (!owner) {
          failedItems.push({ id, message: 'Account not found' });
          continue;
        }
        if (isApiKeyConnection(owner)) {
          failedItems.push({ id, message: 'API Key 连接不支持管理账号令牌' });
          continue;
        }

        if (isMaskedPendingAccountToken(existing)) {
          failedItems.push({ id, message: '待补全令牌不能修改启用状态，请先补全明文 token' });
          continue;
        }
        const nextEnabled = action === 'enable';
        if (existing.enabled !== nextEnabled) {
          routesChanged = true;
        }
        await db.update(schema.accountTokens)
          .set({
            enabled: nextEnabled,
            autoDisabledAt: null,
            autoDisabledReason: null,
            autoDisabledPreviousEnabled: null,
            updatedAt: new Date().toISOString(),
          })
          .where(eq(schema.accountTokens.id, id))
          .run();
        await upsertAccountTokenGroupEnabledPreference({
          accountId: existing.accountId,
          tokenGroup: existing.tokenGroup,
          tokenName: existing.name,
          enabled: nextEnabled,
        });
        if (nextEnabled === false && existing.enabled !== false) {
          removedRouteChannels += await removeRouteChannelsForAccountTokens([id]);
          if (existing.isDefault) {
            await repairDefaultToken(existing.accountId);
          }
        }

        successIds.push(id);
      } catch (error: any) {
        failedItems.push({ id, message: error?.message || 'Batch operation failed' });
      }
    }

    if (successIds.length > 0 && routesChanged) {
      scheduleAccountTokenRouteRebuild(`account-token-batch-${action}`);
    }

    return {
      success: true,
      localOnly: true,
      successIds,
      failedItems,
      removedRouteChannels,
      routeRebuildScheduled: successIds.length > 0 && routesChanged,
    };
  });

  app.put<{ Params: { id: string }; Body: unknown }>('/api/account-tokens/:id', async (request, reply) => {
    const parsedBody = parseAccountTokenUpdatePayload(request.body);
    if (!parsedBody.success) {
      return reply.code(400).send({ success: false, message: parsedBody.error });
    }

    const tokenId = Number.parseInt(request.params.id, 10);
    if (Number.isNaN(tokenId)) {
      return reply.code(400).send({ success: false, message: '令牌 ID 无效' });
    }

    const existing = await db.select().from(schema.accountTokens).where(eq(schema.accountTokens.id, tokenId)).get();
    if (!existing) {
      return reply.code(404).send({ success: false, message: '令牌不存在' });
    }

    const owner = await db.select().from(schema.accounts).where(eq(schema.accounts.id, existing.accountId)).get();
    if (!owner) {
      return reply.code(404).send({ success: false, message: '账号不存在' });
    }
    if (isApiKeyConnection(owner)) {
      return reply.code(400).send({ success: false, message: 'API Key 连接不支持管理账号令牌' });
    }

    const body = parsedBody.data;
    const updates: Record<string, unknown> = { updatedAt: new Date().toISOString() };
    const previousValueStatus = resolveAccountTokenValueStatus(existing);
    let nextValueStatus = previousValueStatus;
    let routesChanged = false;

    if (body.name !== undefined) {
      updates.name = (body.name || '').trim() || existing.name;
    }

    if (body.token !== undefined) {
      const tokenValue = body.token.trim();
      if (!tokenValue) {
        return reply.code(400).send({ success: false, message: '令牌不能为空' });
      }
      updates.token = tokenValue;
      nextValueStatus = isMaskedTokenValue(tokenValue)
        ? ACCOUNT_TOKEN_VALUE_STATUS_MASKED_PENDING
        : ACCOUNT_TOKEN_VALUE_STATUS_READY;
      updates.valueStatus = nextValueStatus;
      if (previousValueStatus !== nextValueStatus) {
        routesChanged = true;
      }
    }

    if (body.group !== undefined) {
      updates.tokenGroup = (body.group || '').trim() || null;
    }

    if (nextValueStatus === ACCOUNT_TOKEN_VALUE_STATUS_MASKED_PENDING) {
      if (existing.enabled !== false) routesChanged = true;
      updates.enabled = false;
      updates.isDefault = false;
    } else {
      if (body.enabled !== undefined) {
        if (existing.enabled !== body.enabled) routesChanged = true;
        updates.enabled = body.enabled;
        updates.autoDisabledAt = null;
        updates.autoDisabledReason = null;
        updates.autoDisabledPreviousEnabled = null;
      }
      if (body.isDefault !== undefined) updates.isDefault = body.isDefault;
    }
    if (body.source !== undefined) updates.source = body.source;

    await db.update(schema.accountTokens).set(updates).where(eq(schema.accountTokens.id, tokenId)).run();

    let latest = await db.select().from(schema.accountTokens).where(eq(schema.accountTokens.id, tokenId)).get();
    if (!latest) {
      return reply.code(500).send({ success: false, message: '更新失败' });
    }

    let removedRouteChannels = 0;
    if (nextValueStatus !== ACCOUNT_TOKEN_VALUE_STATUS_MASKED_PENDING && body.enabled !== undefined) {
      await saveAccountTokenEnabledPreference(latest);
      if (latest.enabled === false && existing.enabled !== false) {
        removedRouteChannels = await removeRouteChannelsForAccountTokens([tokenId]);
      }
    } else if (nextValueStatus === ACCOUNT_TOKEN_VALUE_STATUS_MASKED_PENDING) {
      removedRouteChannels = await removeRouteChannelsForAccountTokens([tokenId]);
    }

    if (body.isDefault === true && isUsableAccountToken(latest)) {
      await setDefaultToken(tokenId);
    } else if (latest.isDefault && isUsableAccountToken(latest)) {
      await setDefaultToken(tokenId);
    } else if (existing.isDefault && !isUsableAccountToken(latest)) {
      await repairDefaultToken(existing.accountId);
    } else if (body.isDefault === false && existing.isDefault) {
      await repairDefaultToken(existing.accountId);
    }

    latest = await db.select().from(schema.accountTokens).where(eq(schema.accountTokens.id, tokenId)).get();
    if (!latest) {
      return reply.code(500).send({ success: false, message: '更新失败' });
    }

    if (routesChanged) {
      scheduleAccountTokenRouteRebuild('account-token-updated');
    }

    return { success: true, localOnly: body.enabled !== undefined, token: latest, removedRouteChannels, routeRebuildScheduled: routesChanged };
  });

  app.post<{ Params: { id: string } }>('/api/account-tokens/:id/default', async (request, reply) => {
    const tokenId = Number.parseInt(request.params.id, 10);
    if (Number.isNaN(tokenId)) {
      return reply.code(400).send({ success: false, message: '令牌 ID 无效' });
    }
    const tokenRow = await db.select().from(schema.accountTokens).where(eq(schema.accountTokens.id, tokenId)).get();
    if (!tokenRow) {
      return reply.code(404).send({ success: false, message: '令牌不存在' });
    }
    const owner = await db.select().from(schema.accounts).where(eq(schema.accounts.id, tokenRow.accountId)).get();
    if (!owner) {
      return reply.code(404).send({ success: false, message: '账号不存在' });
    }
    if (isApiKeyConnection(owner)) {
      return reply.code(400).send({ success: false, message: 'API Key 连接不支持管理账号令牌' });
    }
    if (isMaskedPendingAccountToken(tokenRow)) {
      return reply.code(400).send({ success: false, message: '待补全令牌不能设为默认，请先补全明文 token' });
    }
    const success = await setDefaultToken(tokenId);
    if (!success) {
      return reply.code(400).send({ success: false, message: '令牌不可设为默认，请先补全明文 token' });
    }
    const accountTokens = await db.select({
      id: schema.accountTokens.id,
      accountId: schema.accountTokens.accountId,
      isDefault: schema.accountTokens.isDefault,
      enabled: schema.accountTokens.enabled,
      updatedAt: schema.accountTokens.updatedAt,
    })
      .from(schema.accountTokens)
      .where(eq(schema.accountTokens.accountId, tokenRow.accountId))
      .all();
    const token = accountTokens.find((item) => item.id === tokenId) || null;
    return { success: true, token, accountTokens };
  });

  app.get<{ Params: { id: string } }>('/api/account-tokens/:id/value', async (request, reply) => {
    const tokenId = Number.parseInt(request.params.id, 10);
    if (Number.isNaN(tokenId)) {
      return reply.code(400).send({ success: false, message: '令牌 ID 无效' });
    }

    const row = await db.select()
      .from(schema.accountTokens)
      .innerJoin(schema.accounts, eq(schema.accountTokens.accountId, schema.accounts.id))
      .innerJoin(schema.sites, eq(schema.accounts.siteId, schema.sites.id))
      .where(eq(schema.accountTokens.id, tokenId))
      .get();
    if (!row) {
      return reply.code(404).send({ success: false, message: '令牌不存在' });
    }

    if (isApiKeyConnection(row.accounts)) {
      return reply.code(400).send({ success: false, message: 'API Key 连接不支持管理账号令牌' });
    }

    if (isMaskedPendingAccountToken(row.account_tokens) || isMaskedTokenValue(row.account_tokens.token)) {
      return reply.code(409).send({
        success: false,
        message: '当前仅保存了脱敏令牌，无法展开/复制。请在站点重新生成并同步，或手动更新为完整令牌。',
      });
    }

    const tokenValue = normalizeTokenForDisplay(row.account_tokens.token, row.sites.platform);
    return {
      success: true,
      id: row.account_tokens.id,
      name: row.account_tokens.name,
      token: tokenValue,
      tokenMasked: maskToken(row.account_tokens.token, row.sites.platform),
    };
  });

  app.get<{ Params: { id: string }; Querystring: { refresh?: string | boolean } }>('/api/account-tokens/:id/models', async (request, reply) => {
    const tokenId = Number.parseInt(request.params.id, 10);
    if (Number.isNaN(tokenId)) {
      return reply.code(400).send({ success: false, message: '令牌 ID 无效' });
    }

    try {
      const refresh = parseOptionalBoolean(request.query?.refresh);
      const result = await getAccountTokenModels(tokenId, { refresh: refresh !== false });
      if (!result) {
        return reply.code(404).send({ success: false, message: '令牌不存在' });
      }
      return {
        success: true,
        ...result,
      };
    } catch (error: any) {
      return reply.code(502).send({
        success: false,
        message: error?.message || '拉取令牌模型失败',
      });
    }
  });

  app.post<{ Params: { id: string }; Body: unknown }>('/api/account-tokens/:id/models/route-enabled', async (request, reply) => {
    const tokenId = Number.parseInt(request.params.id, 10);
    if (Number.isNaN(tokenId)) {
      return reply.code(400).send({ success: false, message: '令牌 ID 无效' });
    }
    const body = (request.body || {}) as Record<string, unknown>;
    const modelName = typeof body.modelName === 'string' ? body.modelName.trim() : '';
    if (!modelName) {
      return reply.code(400).send({ success: false, message: '模型名称不能为空' });
    }
    if (typeof body.routeEnabled !== 'boolean') {
      return reply.code(400).send({ success: false, message: 'routeEnabled 必须是布尔值' });
    }

    const tokenRow = await db.select().from(schema.accountTokens).where(eq(schema.accountTokens.id, tokenId)).get();
    if (!tokenRow) {
      return reply.code(404).send({ success: false, message: '令牌不存在' });
    }

    const modelRow = await db.select()
      .from(schema.tokenModelAvailability)
      .where(and(
        eq(schema.tokenModelAvailability.tokenId, tokenId),
        eq(schema.tokenModelAvailability.modelName, modelName),
      ))
      .get();
    if (!modelRow) {
      return reply.code(404).send({ success: false, message: '模型不存在，请先拉取令牌模型列表' });
    }

    const nextRouteEnabled = body.routeEnabled === true;
    const routeEnabledChanged = modelRow.routeEnabled !== nextRouteEnabled;
    const now = new Date().toISOString();
    if (routeEnabledChanged || !modelRow.checkedAt) {
      await db.update(schema.tokenModelAvailability)
        .set({
          routeEnabled: nextRouteEnabled,
          routeEnabledSource: 'manual',
          routeManualDisabledAt: nextRouteEnabled ? null : now,
          checkedAt: modelRow.checkedAt || now,
        })
        .where(eq(schema.tokenModelAvailability.id, modelRow.id))
        .run();
    }
    if (routeEnabledChanged) {
      scheduleAccountTokenRouteRebuild('account-token-model-route-enabled-changed');
    }
    const cachedModels = await getAccountTokenModels(tokenId, { refresh: false });

    return {
      success: true,
      tokenId,
      modelName,
      routeEnabled: nextRouteEnabled,
      models: cachedModels?.models || [],
      modelNames: cachedModels?.modelNames || [],
      checkedAt: cachedModels?.checkedAt || null,
      routeRebuildScheduled: routeEnabledChanged,
    };
  });

  app.put<{ Params: { id: string }; Body: unknown }>('/api/account-tokens/:id/health-check', async (request, reply) => {
    const tokenId = Number.parseInt(request.params.id, 10);
    if (Number.isNaN(tokenId)) {
      return reply.code(400).send({ success: false, message: '令牌 ID 无效' });
    }
    const body = (request.body || {}) as Record<string, unknown>;
    const enabled = typeof body.enabled === 'boolean' ? body.enabled : undefined;
    const model = Array.isArray(body.models)
      ? body.models.map((item) => String(item || '').trim()).filter(Boolean).join(', ')
      : (typeof body.model === 'string' ? body.model.trim() : undefined);
    const intervalMinutes = body.intervalMinutes === undefined ? undefined : Number(body.intervalMinutes);
    if (enabled === true && !model) {
      return reply.code(400).send({ success: false, message: '开启定时测活时必须填写模型' });
    }
    if (intervalMinutes !== undefined && (!Number.isFinite(intervalMinutes) || intervalMinutes <= 0)) {
      return reply.code(400).send({ success: false, message: '测活间隔必须是正数分钟' });
    }

    const token = await updateAccountTokenHealthCheckConfig(tokenId, {
      enabled,
      model,
      intervalMinutes,
    });
    if (!token) {
      return reply.code(404).send({ success: false, message: '令牌不存在' });
    }
    return { success: true, token };
  });

  app.post<{ Params: { id: string }; Body: unknown }>('/api/account-tokens/:id/health-check/run', async (request, reply) => {
    const tokenId = Number.parseInt(request.params.id, 10);
    if (Number.isNaN(tokenId)) {
      return reply.code(400).send({ success: false, message: '令牌 ID 无效' });
    }
    const body = (request.body || {}) as Record<string, unknown>;
    const runHealthCheckTask = async (taskId?: string) => {
      const startedAt = Date.now();
      appendBackgroundTaskLog(taskId || '', `开始检测令牌 #${tokenId}`);
      const result = await runAccountTokenHealthCheck(tokenId);
      if (!result) {
        throw new Error('令牌不存在');
      }
      appendBackgroundTaskLog(
        taskId || '',
        `令牌 #${tokenId} 检测完成：${result.result?.message || (result.result?.available ? '可用' : '不可用')}，耗时 ${Date.now() - startedAt}ms`,
      );
      return { success: true, ...result };
    };

    try {
      let taskId = '';
      const { task, reused } = startBackgroundTask(
        {
          type: 'token',
          title: `检测令牌 #${tokenId}`,
          dedupeKey: `account-token-health-check:${tokenId}`,
          keepMs: 30 * 60_000,
          notifyOnFailure: true,
          successTitle: `令牌 #${tokenId} 检测完成`,
          failureTitle: `令牌 #${tokenId} 检测失败`,
          successMessage: '令牌测活已完成',
          failureMessage: '令牌测活失败',
        },
        async () => {
          await Promise.resolve();
          return runHealthCheckTask(taskId);
        },
      );
      taskId = task.id;
      if (shouldRunAsyncAccountTokenTask(body)) {
        return reply.code(202).send(buildTaskQueuedResponse(task, reused));
      }
      const completedTask = await waitForBackgroundTaskCompletion(task.id, 50);
      if (!completedTask || completedTask.status === 'failed') {
        if (completedTask?.error === '令牌不存在') {
          return reply.code(404).send({ success: false, message: '令牌不存在' });
        }
        return buildTaskFailureReply(reply, completedTask, '令牌测活失败');
      }
      return completedTask.result;
    } catch (error: any) {
      return reply.code(502).send({
        success: false,
        message: error?.message || '令牌测活失败',
      });
    }
  });

  app.post<{ Body: unknown }>('/api/account-tokens/models/test', async (request, reply) => {
    const body = (request.body || {}) as Record<string, unknown>;
    const model = typeof body.model === 'string' ? body.model.trim() : '';
    const tokenIds = Array.isArray(body.tokenIds)
      ? body.tokenIds
        .map((id) => Number(id))
        .filter((id) => Number.isInteger(id) && id > 0)
      : [];

    if (!model) {
      return reply.code(400).send({ success: false, message: '模型名称不能为空' });
    }
    if (tokenIds.length === 0) {
      return reply.code(400).send({ success: false, message: '请选择需要测试的令牌' });
    }
    if (tokenIds.length > 100) {
      return reply.code(400).send({ success: false, message: '单次最多测试 100 个令牌' });
    }

    const runModelTestTask = async (taskId?: string) => {
      const startedAt = Date.now();
      appendBackgroundTaskLog(taskId || '', `开始检测模型 ${model}，令牌 ${tokenIds.length} 个`);
      app.log.info({ model, tokenCount: tokenIds.length }, 'account token model availability test started');
      const result = await testAccountTokenModelAvailability({ model, tokenIds });
      const healthCheckTokens = await recordManualAccountTokenHealthCheckResults(result.results);
      const availableCount = result.results.filter((item) => item.available).length;
      appendBackgroundTaskLog(
        taskId || '',
        `模型 ${model} 检测完成：可用 ${availableCount} / ${result.results.length}，耗时 ${Date.now() - startedAt}ms`,
      );
      app.log.info({
        model,
        tokenCount: tokenIds.length,
        availableCount,
        durationMs: Date.now() - startedAt,
      }, 'account token model availability test completed');
      return {
        success: true,
        ...result,
        healthCheckTokens,
      };
    };

    try {
      let taskId = '';
      const dedupeTokenIds = [...tokenIds].sort((a, b) => a - b).join(',');
      const { task, reused } = startBackgroundTask(
        {
          type: 'token',
          title: `检测模型 ${model}（${tokenIds.length} 个令牌）`,
          dedupeKey: `account-token-model-test:${model}:${dedupeTokenIds}`,
          keepMs: 30 * 60_000,
          notifyOnFailure: true,
          successTitle: `模型 ${model} 检测完成`,
          failureTitle: `模型 ${model} 检测失败`,
          successMessage: '令牌模型检测已完成',
          failureMessage: '令牌模型检测失败',
        },
        async () => {
          await Promise.resolve();
          return runModelTestTask(taskId);
        },
      );
      taskId = task.id;
      if (shouldRunAsyncAccountTokenTask(body)) {
        return reply.code(202).send(buildTaskQueuedResponse(task, reused));
      }
      const completedTask = await waitForBackgroundTaskCompletion(task.id, 50);
      if (!completedTask || completedTask.status === 'failed') {
        return buildTaskFailureReply(reply, completedTask, '测试令牌可用性失败');
      }
      return completedTask.result;
    } catch (error: any) {
      return reply.code(502).send({
        success: false,
        message: error?.message || '测试令牌可用性失败',
      });
    }
  });

  app.post<{ Body: unknown }>('/api/account-tokens/models/test-skipped', async (request, reply) => {
    const body = (request.body || {}) as Record<string, unknown>;
    const rawResults = Array.isArray(body.results) ? body.results : [];
    const results = rawResults
      .map((item) => {
        const tokenId = Number((item as any)?.tokenId);
        const model = typeof (item as any)?.model === 'string' ? (item as any).model.trim() : '';
        if (!Number.isInteger(tokenId) || tokenId <= 0 || !model) return null;
        return {
          tokenId,
          model,
          available: false,
          message: typeof (item as any)?.message === 'string' && (item as any).message.trim()
            ? (item as any).message.trim()
            : '跳过测试',
          responseText: null,
          httpStatus: null,
          latencyMs: null,
          checkedAt: typeof (item as any)?.checkedAt === 'string' && (item as any).checkedAt.trim()
            ? (item as any).checkedAt.trim()
            : new Date().toISOString(),
        };
      })
      .filter((item): item is NonNullable<typeof item> => !!item);

    if (results.length === 0) {
      return reply.code(400).send({ success: false, message: '没有可保存的跳过结果' });
    }
    if (results.length > 100) {
      return reply.code(400).send({ success: false, message: '单次最多保存 100 个跳过结果' });
    }

    await persistSkippedAccountTokenModelAvailability(results);
    const healthCheckTokens = await recordManualAccountTokenHealthCheckResults(results);
    return {
      success: true,
      total: results.length,
      results,
      healthCheckTokens,
    };
  });

  app.get<{ Params: { accountId: string } }>('/api/account-tokens/groups/:accountId', async (request, reply) => {
    const accountId = Number.parseInt(request.params.accountId, 10);
    if (Number.isNaN(accountId)) {
      return reply.code(400).send({ success: false, message: '账号 ID 无效' });
    }

    const row = await db.select()
      .from(schema.accounts)
      .innerJoin(schema.sites, eq(schema.accounts.siteId, schema.sites.id))
      .where(eq(schema.accounts.id, accountId))
      .get();
    if (!row) {
      return reply.code(404).send({ success: false, message: '账号不存在' });
    }

    if (isApiKeyConnection(row.accounts)) {
      return reply.code(400).send({ success: false, message: 'API Key 连接不支持拉取账号令牌分组' });
    }

    const account = row.accounts;
    const site = row.sites;
    const adapter = getAdapter(site.platform);
    if (!adapter) {
      return reply.code(400).send({ success: false, message: `不支持的平台: ${site.platform}` });
    }
    if (!account.accessToken?.trim()) {
      return reply.code(400).send({ success: false, message: '账号缺少访问令牌，无法拉取分组' });
    }

    try {
      const platformUserId = resolvePlatformUserId(account.extraConfig, account.username);
      const groups = await withAccountProxyOverride(
        getProxyUrlFromExtraConfig(account.extraConfig),
        () => adapter.getUserGroups(site.url, account.accessToken, platformUserId),
      );
      const normalized = Array.from(new Set((groups || []).map((item) => String(item || '').trim()).filter(Boolean)));
      return { success: true, groups: normalized.length > 0 ? normalized : ['default'] };
    } catch (error: any) {
      return reply.code(502).send({
        success: false,
        message: error?.message || '拉取分组失败',
      });
    }
  });

  app.delete<{ Params: { id: string } }>('/api/account-tokens/:id', async (request, reply) => {
    const tokenId = Number.parseInt(request.params.id, 10);
    if (Number.isNaN(tokenId)) {
      return reply.code(400).send({ success: false, message: '令牌 ID 无效' });
    }
    const { task, reused } = queueDeleteAccountTokenTask([tokenId]);
    return reply.code(202).send({
      success: true,
      queued: true,
      reused,
      jobId: task.id,
      status: task.status,
      message: reused
        ? '账号令牌删除任务执行中，请稍后查看程序日志'
        : '账号令牌删除进行中，请稍后查看程序日志',
    });
  });

  app.post<{ Params: { accountId: string } }>('/api/account-tokens/sync/:accountId', async (request, reply) => {
    const accountId = Number.parseInt(request.params.accountId, 10);
    if (Number.isNaN(accountId)) {
      return reply.code(400).send({ success: false, message: '账号 ID 无效' });
    }

    const row = await db.select().from(schema.accounts)
      .innerJoin(schema.sites, eq(schema.accounts.siteId, schema.sites.id))
      .where(eq(schema.accounts.id, accountId))
      .get();

    if (!row) {
      return reply.code(404).send({ success: false, message: '账号不存在' });
    }

    const result = await executeAccountTokenSync(row);
    appendTokenSyncEvent(result);
    if (result.status === 'skipped' && result.reason === 'apikey_connection') {
      return reply.code(400).send({ success: false, message: 'API Key 连接不支持同步账号令牌' });
    }
    if (result.status === 'failed' && result.reason === 'unsupported_platform') {
      return reply.code(400).send({ success: false, message: result.message });
    }
    if (result.status === 'failed') {
      return reply.code(502).send({ success: false, message: result.message || '同步失败' });
    }
    const coverageRefresh = await refreshCoverageForAccounts([accountId]);
    return { success: true, ...result, coverageRefresh };
  });

  app.post<{ Body: unknown }>('/api/account-tokens/sync-all', async (request, reply) => {
    const parsedBody = parseAccountTokenSyncAllPayload(request.body);
    if (!parsedBody.success) {
      return reply.code(400).send({ success: false, message: parsedBody.error });
    }

    if (parsedBody.data.wait) {
      const syncResult = await executeSyncAllAccountTokens();
      return { success: true, ...syncResult };
    }

    const { task, reused } = startBackgroundTask(
      {
        type: 'token',
        title: '同步全部账号令牌',
        dedupeKey: 'sync-all-account-tokens',
        notifyOnFailure: true,
        successTitle: (currentTask) => {
          const summary = (currentTask.result as any)?.summary;
          if (!summary) return '同步全部账号令牌已完成';
          return `同步全部账号令牌已完成（成功${summary.synced}/跳过${summary.skipped}/失败${summary.failed}）`;
        },
        failureTitle: () => '同步全部账号令牌失败',
        successMessage: (currentTask) => {
          const summary = (currentTask.result as any)?.summary;
          const results = (currentTask.result as any)?.results as SyncExecutionResult[] | undefined;
          if (!summary) return '全部账号令牌同步任务已完成';
          const detail = buildTokenSyncTaskDetailMessage(Array.isArray(results) ? results : []);
          return detail
            ? `全部账号令牌同步完成：成功 ${summary.synced}，跳过 ${summary.skipped}，失败 ${summary.failed}\n${detail}`
            : `全部账号令牌同步完成：成功 ${summary.synced}，跳过 ${summary.skipped}，失败 ${summary.failed}`;
        },
        failureMessage: (currentTask) => `全部账号令牌同步失败：${currentTask.error || 'unknown error'}`,
      },
      async () => executeSyncAllAccountTokens(),
    );

    return reply.code(202).send({
      success: true,
      queued: true,
      reused,
      jobId: task.id,
      status: task.status,
      message: reused
        ? '令牌同步任务执行中，请稍后查看程序日志'
        : '全部账号令牌同步进行中，请稍后查看程序日志',
    });
  });

  app.post<{ Body: unknown }>('/api/account-tokens/groups/ensure-all', async (request, reply) => {
    const parsedBody = parseAccountTokenSyncAllPayload(request.body);
    if (!parsedBody.success) {
      return reply.code(400).send({ success: false, message: parsedBody.error });
    }

    if (parsedBody.data.wait) {
      const ensureResult = await executeEnsureGroupTokensAllAccounts();
      return { success: true, ...ensureResult };
    }

    const { task, reused } = startBackgroundTask(
      {
        type: 'token',
        title: '获取全部账号分组并补齐令牌',
        dedupeKey: 'ensure-all-account-group-tokens',
        notifyOnFailure: true,
        successTitle: (currentTask) => {
          const summary = (currentTask.result as any)?.summary;
          if (!summary) return '获取全部账号分组已完成';
          return `获取全部账号分组已完成（补齐${summary.created}/禁用${summary.disabled}/失败${summary.failed}）`;
        },
        failureTitle: () => '获取全部账号分组失败',
        successMessage: (currentTask) => {
          const summary = (currentTask.result as any)?.summary;
          if (!summary) return '全部账号分组补齐任务已完成';
          return `全部账号分组补齐完成：成功 ${summary.synced}，跳过 ${summary.skipped}，失败 ${summary.failed}，补齐令牌 ${summary.created}，禁用失效令牌 ${summary.disabled}`;
        },
        failureMessage: (currentTask) => `全部账号分组补齐失败：${currentTask.error || 'unknown error'}`,
      },
      async () => executeEnsureGroupTokensAllAccounts(),
    );

    return reply.code(202).send({
      success: true,
      queued: true,
      reused,
      jobId: task.id,
      status: task.status,
      message: reused
        ? '账号分组补齐任务执行中，请稍后查看程序日志'
        : '获取全部账号分组并补齐令牌进行中，请稍后查看程序日志',
    });
  });

  app.get<{ Params: { accountId: string } }>('/api/account-tokens/account/:accountId/default', async (request, reply) => {
    const accountId = Number.parseInt(request.params.accountId, 10);
    if (Number.isNaN(accountId)) {
      return reply.code(400).send({ success: false, message: '账号 ID 无效' });
    }

    const row = await db.select()
      .from(schema.accountTokens)
      .innerJoin(schema.accounts, eq(schema.accountTokens.accountId, schema.accounts.id))
      .innerJoin(schema.sites, eq(schema.accounts.siteId, schema.sites.id))
      .where(and(eq(schema.accountTokens.accountId, accountId), eq(schema.accountTokens.isDefault, true)))
      .get();

    return {
      success: true,
      token: row
        ? (() => {
          if (isApiKeyConnection(row.accounts)) return null;
          const { token: rawToken, ...meta } = row.account_tokens;
          return { ...meta, tokenMasked: maskToken(rawToken, row.sites.platform) };
        })()
        : null,
    };
  });
}
