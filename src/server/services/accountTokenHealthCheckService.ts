import { and, eq, lte, or, sql } from 'drizzle-orm';
import { db, schema } from '../db/index.js';
import { rebuildRoutesBestEffort } from './routeRefreshWorkflow.js';
import { isReadyAccountToken } from './accountTokenService.js';
import {
  testAccountTokenModelAvailability,
  type AccountTokenModelTestResult,
} from './accountTokenAvailabilityTestService.js';

const DEFAULT_HEALTH_CHECK_INTERVAL_MINUTES = 60;
const MIN_HEALTH_CHECK_INTERVAL_MINUTES = 1;
const MAX_HEALTH_CHECK_INTERVAL_MINUTES = 7 * 24 * 60;
const HEALTH_CHECK_SCAN_INTERVAL_MS = 60_000;
const HEALTH_CHECK_SCAN_LIMIT = 12;

let healthCheckTimer: ReturnType<typeof setInterval> | null = null;
let healthCheckRunning = false;

export type AccountTokenHealthCheckConfigInput = {
  enabled?: boolean;
  model?: string;
  intervalMinutes?: number;
};

export type AccountTokenHealthCheckRunResult = {
  token: typeof schema.accountTokens.$inferSelect;
  result: AccountTokenModelTestResult;
  results: AccountTokenModelTestResult[];
  routeRebuilt: boolean;
};

function normalizeIntervalMinutes(value: unknown): number {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return DEFAULT_HEALTH_CHECK_INTERVAL_MINUTES;
  return Math.min(
    MAX_HEALTH_CHECK_INTERVAL_MINUTES,
    Math.max(MIN_HEALTH_CHECK_INTERVAL_MINUTES, Math.round(parsed)),
  );
}

function normalizeHealthCheckModels(value: unknown): string[] {
  const raw = typeof value === 'string' ? value : '';
  const seen = new Set<string>();
  return raw
    .split(/[\n,，]+/g)
    .map((item) => item.trim())
    .filter((model) => {
      if (!model) return false;
      const key = model.toLowerCase();
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });
}

function formatHealthCheckModels(models: string[]): string {
  return models.join(', ');
}

function summarizeHealthCheckResults(
  tokenId: number,
  models: string[],
  results: AccountTokenModelTestResult[],
  checkedAt: string,
): AccountTokenModelTestResult {
  const successfulResults = results.filter((item) => item.available);
  if (successfulResults.length > 0) {
    const firstSuccess = successfulResults[0];
    return {
      ...firstSuccess,
      model: formatHealthCheckModels(successfulResults.map((item) => item.model)),
      available: true,
      message: `成功 ${successfulResults.length}/${models.length}：${successfulResults.map((item) => item.model).join('、')}`,
      latencyMs: results.reduce((sum, item) => sum + (Number.isFinite(Number(item.latencyMs)) ? Number(item.latencyMs) : 0), 0),
      checkedAt: firstSuccess.checkedAt || checkedAt,
    };
  }

  return {
    tokenId,
    model: formatHealthCheckModels(models),
    available: false,
    message: results.length > 0
      ? `全部失败：${results.map((item) => `${item.model}: ${item.message || '未知错误'}`).join('；')}`
      : '测活未返回结果',
    responseText: results.find((item) => item.responseText)?.responseText || null,
    httpStatus: results.find((item) => item.httpStatus !== null && item.httpStatus !== undefined)?.httpStatus ?? null,
    latencyMs: results.reduce((sum, item) => sum + (Number.isFinite(Number(item.latencyMs)) ? Number(item.latencyMs) : 0), 0),
    checkedAt,
  };
}

function addMinutes(date: Date, minutes: number): string {
  return new Date(date.getTime() + minutes * 60_000).toISOString();
}

async function loadAccountToken(tokenId: number) {
  return db.select()
    .from(schema.accountTokens)
    .where(eq(schema.accountTokens.id, tokenId))
    .get();
}

export async function updateAccountTokenHealthCheckConfig(
  tokenId: number,
  input: AccountTokenHealthCheckConfigInput,
) {
  const target = await loadAccountToken(tokenId);
  if (!target) return null;

  const now = new Date();
  const enabled = input.enabled === undefined ? target.healthCheckEnabled === true : input.enabled === true;
  const model = formatHealthCheckModels(normalizeHealthCheckModels(input.model ?? target.healthCheckModel));
  const intervalMinutes = normalizeIntervalMinutes(input.intervalMinutes ?? target.healthCheckIntervalMinutes);
  const nextRunAt = enabled ? addMinutes(now, intervalMinutes) : null;

  await db.update(schema.accountTokens)
    .set({
      healthCheckEnabled: enabled,
      healthCheckIntervalMinutes: intervalMinutes,
      healthCheckModel: model,
      healthCheckNextRunAt: nextRunAt,
      updatedAt: now.toISOString(),
    })
    .where(eq(schema.accountTokens.id, tokenId))
    .run();

  return loadAccountToken(tokenId);
}

async function markHealthCheckFailure(
  token: typeof schema.accountTokens.$inferSelect,
  model: string,
  message: string,
  checkedAt = new Date().toISOString(),
): Promise<AccountTokenHealthCheckRunResult> {
  const intervalMinutes = normalizeIntervalMinutes(token.healthCheckIntervalMinutes);
  const result: AccountTokenModelTestResult = {
    tokenId: token.id,
    model,
    available: false,
    message,
    responseText: null,
    httpStatus: null,
    latencyMs: null,
    checkedAt,
  };
  await db.update(schema.accountTokens)
    .set({
      healthCheckLastRunAt: checkedAt,
      healthCheckNextRunAt: addMinutes(new Date(checkedAt), intervalMinutes),
      healthCheckLastAvailable: false,
      healthCheckLastMessage: message,
      healthCheckLastLatencyMs: null,
      updatedAt: checkedAt,
    })
    .where(eq(schema.accountTokens.id, token.id))
    .run();
  return {
    token: (await loadAccountToken(token.id)) || token,
    result,
    results: [result],
    routeRebuilt: false,
  };
}

export async function runAccountTokenHealthCheck(tokenId: number): Promise<AccountTokenHealthCheckRunResult | null> {
  const token = await loadAccountToken(tokenId);
  if (!token) return null;

  const models = normalizeHealthCheckModels(token.healthCheckModel);
  const checkedAt = new Date().toISOString();
  if (models.length === 0) {
    return markHealthCheckFailure(token, '', '未配置测活模型', checkedAt);
  }
  if (!isReadyAccountToken(token)) {
    return markHealthCheckFailure(token, formatHealthCheckModels(models), '令牌明文未补全', checkedAt);
  }

  const results: AccountTokenModelTestResult[] = [];
  for (const model of models) {
    const test = await testAccountTokenModelAvailability({ model, tokenIds: [token.id] });
    results.push(test.results[0] || {
      tokenId: token.id,
      model,
      available: false,
      message: '测活未返回结果',
      responseText: null,
      httpStatus: null,
      latencyMs: null,
      checkedAt,
    });
  }
  const result = summarizeHealthCheckResults(token.id, models, results, checkedAt);
  const intervalMinutes = normalizeIntervalMinutes(token.healthCheckIntervalMinutes);
  const nextRunAt = addMinutes(new Date(result.checkedAt || checkedAt), intervalMinutes);

  const tokenPatch: Partial<typeof schema.accountTokens.$inferInsert> = {
    healthCheckLastRunAt: result.checkedAt || checkedAt,
    healthCheckNextRunAt: nextRunAt,
    healthCheckLastAvailable: result.available,
    healthCheckLastMessage: result.message,
    healthCheckLastLatencyMs: result.latencyMs,
    updatedAt: result.checkedAt || checkedAt,
  };

  await db.update(schema.accountTokens)
    .set(tokenPatch)
    .where(eq(schema.accountTokens.id, token.id))
    .run();

  let routeRebuilt = false;
  const successfulResults = results.filter((item) => item.available);
  if (successfulResults.length > 0) {
    for (const item of successfulResults) {
      await db.update(schema.tokenModelAvailability)
        .set({ routeEnabled: true, checkedAt: item.checkedAt || checkedAt })
        .where(and(
          eq(schema.tokenModelAvailability.tokenId, token.id),
          eq(schema.tokenModelAvailability.modelName, item.model),
        ))
        .run();
    }
    routeRebuilt = await rebuildRoutesBestEffort();
  }

  return {
    token: (await loadAccountToken(token.id)) || token,
    result,
    results,
    routeRebuilt,
  };
}

export async function runDueAccountTokenHealthChecks() {
  if (healthCheckRunning) return { skipped: true, total: 0, results: [] as AccountTokenHealthCheckRunResult[] };
  healthCheckRunning = true;
  try {
    const now = new Date().toISOString();
    const dueRows = await db.select()
      .from(schema.accountTokens)
      .where(and(
        eq(schema.accountTokens.healthCheckEnabled, true),
        or(
          lte(schema.accountTokens.healthCheckNextRunAt, now),
          sql`${schema.accountTokens.healthCheckNextRunAt} IS NULL`,
        ),
      ))
      .limit(HEALTH_CHECK_SCAN_LIMIT)
      .all();

    const results: AccountTokenHealthCheckRunResult[] = [];
    for (const row of dueRows) {
      const result = await runAccountTokenHealthCheck(row.id);
      if (result) results.push(result);
    }
    return { skipped: false, total: dueRows.length, results };
  } finally {
    healthCheckRunning = false;
  }
}

export function startAccountTokenHealthCheckScheduler(intervalMs = HEALTH_CHECK_SCAN_INTERVAL_MS) {
  if (healthCheckTimer) return;
  healthCheckTimer = setInterval(() => {
    runDueAccountTokenHealthChecks().catch((error) => {
      console.warn(`Account token health check scheduler failed: ${(error as Error)?.message || 'unknown error'}`);
    });
  }, intervalMs);
}

export function stopAccountTokenHealthCheckScheduler() {
  if (!healthCheckTimer) return;
  clearInterval(healthCheckTimer);
  healthCheckTimer = null;
}
