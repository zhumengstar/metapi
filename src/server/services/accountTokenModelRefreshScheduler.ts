import { and, eq } from 'drizzle-orm';
import { db, schema } from '../db/index.js';
import {
  ACCOUNT_TOKEN_VALUE_STATUS_READY,
  isReadyAccountToken,
} from './accountTokenService.js';
import { getAccountTokenModels } from './accountTokenModelService.js';
import { startBackgroundTask } from './backgroundTaskService.js';

const ACCOUNT_TOKEN_MODEL_REFRESH_INTERVAL_MS = 60 * 60 * 1000;
const ACCOUNT_TOKEN_MODEL_REFRESH_CONCURRENCY = 4;

let tokenModelRefreshTimer: ReturnType<typeof setInterval> | null = null;

function clearTokenModelRefreshTimer() {
  if (!tokenModelRefreshTimer) return;
  clearInterval(tokenModelRefreshTimer);
  tokenModelRefreshTimer = null;
}

async function listRefreshableTokenIds(): Promise<number[]> {
  const rows = await db.select({
    id: schema.accountTokens.id,
    token: schema.accountTokens.token,
    valueStatus: schema.accountTokens.valueStatus,
    tokenEnabled: schema.accountTokens.enabled,
    accountStatus: schema.accounts.status,
    siteStatus: schema.sites.status,
  })
    .from(schema.accountTokens)
    .innerJoin(schema.accounts, eq(schema.accountTokens.accountId, schema.accounts.id))
    .innerJoin(schema.sites, eq(schema.accounts.siteId, schema.sites.id))
    .where(and(
      eq(schema.accountTokens.valueStatus, ACCOUNT_TOKEN_VALUE_STATUS_READY),
      eq(schema.accounts.status, 'active'),
    ))
    .all();

  return rows
    .filter((row) => row.siteStatus !== 'disabled')
    .filter((row) => isReadyAccountToken({ token: row.token, valueStatus: row.valueStatus }))
    .map((row) => row.id);
}

async function executeAccountTokenModelRefreshPass() {
  const tokenIds = await listRefreshableTokenIds();
  let refreshed = 0;
  const empty: Array<{ tokenId: number; message: string }> = [];
  const failed: Array<{ tokenId: number; message: string }> = [];

  for (let offset = 0; offset < tokenIds.length; offset += ACCOUNT_TOKEN_MODEL_REFRESH_CONCURRENCY) {
    const batch = tokenIds.slice(offset, offset + ACCOUNT_TOKEN_MODEL_REFRESH_CONCURRENCY);
    const results = await Promise.allSettled(batch.map((tokenId) => getAccountTokenModels(tokenId, { refresh: true })));
    results.forEach((result, index) => {
      const tokenId = batch[index]!;
      if (result.status === 'fulfilled') {
        if (result.value?.refreshed) refreshed++;
        if (result.value?.modelDiscoveryStatus === 'empty') {
          empty.push({
            tokenId,
            message: result.value.modelDiscoveryMessage || '上游模型列表为空',
          });
        }
        return;
      }
      failed.push({
        tokenId,
        message: result.reason?.message || 'refresh failed',
      });
    });
  }

  return {
    total: tokenIds.length,
    refreshed,
    empty: empty.length,
    emptyModels: empty.slice(0, 20),
    failed: failed.length,
    failures: failed.slice(0, 20),
  };
}

function queueAccountTokenModelRefreshTask() {
  return startBackgroundTask(
    {
      type: 'token',
      title: '自动刷新账号令牌模型列表',
      dedupeKey: 'account-token-model-refresh-hourly',
      notifyOnFailure: false,
      successMessage: (currentTask) => {
        const result = currentTask.result as Awaited<ReturnType<typeof executeAccountTokenModelRefreshPass>> | null;
        if (!result) return '自动刷新账号令牌模型列表已完成';
        const emptySummary = result.emptyModels.length > 0
          ? `\n空模型明细：${result.emptyModels.map((item) => `#${item.tokenId} ${item.message}`).join('；')}`
          : '';
        const failureSummary = result.failures.length > 0
          ? `\n失败明细：${result.failures.map((item) => `#${item.tokenId} ${item.message}`).join('；')}`
          : '';
        return `自动刷新账号令牌模型列表完成：总数 ${result.total}，刷新 ${result.refreshed}，空模型 ${result.empty}，失败 ${result.failed}${emptySummary}${failureSummary}`;
      },
    },
    async () => {
      const startedAt = Date.now();
      const result = await executeAccountTokenModelRefreshPass();
      console.log(
        `[account-token-model-refresh] complete: total=${result.total}, refreshed=${result.refreshed}, empty=${result.empty}, failed=${result.failed}, durationMs=${Date.now() - startedAt}`,
      );
      return result;
    },
  );
}

export function startAccountTokenModelRefreshScheduler(intervalMs = ACCOUNT_TOKEN_MODEL_REFRESH_INTERVAL_MS) {
  clearTokenModelRefreshTimer();
  const safeIntervalMs = Math.max(60_000, Math.trunc(intervalMs || 0));
  tokenModelRefreshTimer = setInterval(() => {
    queueAccountTokenModelRefreshTask();
  }, safeIntervalMs);
  tokenModelRefreshTimer.unref?.();
  setTimeout(() => {
    queueAccountTokenModelRefreshTask();
  }, 5_000).unref?.();
  console.log(`[Scheduler] Account token model refresh interval: ${Math.round(safeIntervalMs / 60000)}m`);
  return {
    enabled: true,
    intervalMs: safeIntervalMs,
  };
}

export async function stopAccountTokenModelRefreshScheduler() {
  clearTokenModelRefreshTimer();
}

export async function __resetAccountTokenModelRefreshSchedulerForTests() {
  await stopAccountTokenModelRefreshScheduler();
}
