import { and, eq, inArray, lte, or, sql } from 'drizzle-orm';
import { db, schema } from '../db/index.js';
import { scheduleRoutesOnlyRebuild } from './routeRefreshWorkflow.js';
import { isReadyAccountToken } from './accountTokenService.js';
import { invalidateTokenRouterCache } from './tokenRouter.js';
import {
  testAccountTokenModelAvailability,
  type AccountTokenModelTestResult,
} from './accountTokenAvailabilityTestService.js';

const DEFAULT_HEALTH_CHECK_INTERVAL_MINUTES = 60;
const MIN_HEALTH_CHECK_INTERVAL_MINUTES = 1;
const MAX_HEALTH_CHECK_INTERVAL_MINUTES = 7 * 24 * 60;
const HEALTH_CHECK_SCAN_INTERVAL_MS = 60_000;
const HEALTH_CHECK_SCAN_LIMIT = 12;
const HEALTH_CHECK_AUTO_ENABLE_SUCCESS_STREAK = 3;

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

export type SuccessfulHealthCheckRoutingResult = {
  routeEligibleModels: Array<{ tokenId: number; model: string }>;
  routeRebuilt: boolean;
};

export type SuccessfulHealthCheckRoutingOptions = {
  autoEnableRoute?: boolean;
  successStreakThreshold?: number;
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

function sumLatencyMs(results: AccountTokenModelTestResult[]): number | null {
  const numericValues = results
    .map((item) => {
      const value: unknown = item.latencyMs;
      if (typeof value === 'number') return value;
      if (typeof value === 'string' && value.trim()) return Number(value);
      return Number.NaN;
    })
    .filter((value) => Number.isFinite(value));
  if (numericValues.length === 0) return null;
  return numericValues.reduce((sum, value) => sum + value, 0);
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
      latencyMs: sumLatencyMs(results),
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
    latencyMs: sumLatencyMs(results),
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

function buildHealthCheckPatch(
  token: typeof schema.accountTokens.$inferSelect,
  result: AccountTokenModelTestResult,
  models: string[],
  checkedAt: string,
): Partial<typeof schema.accountTokens.$inferInsert> {
  const runAt = result.checkedAt || checkedAt;
  const intervalMinutes = normalizeIntervalMinutes(token.healthCheckIntervalMinutes);
  const existingModels = normalizeHealthCheckModels(token.healthCheckModel);
  const patch: Partial<typeof schema.accountTokens.$inferInsert> = {
    healthCheckLastRunAt: runAt,
    healthCheckLastAvailable: result.available,
    healthCheckLastMessage: result.message,
    healthCheckLastLatencyMs: result.latencyMs,
    updatedAt: runAt,
  };

  if (token.healthCheckEnabled === true) {
    patch.healthCheckNextRunAt = addMinutes(new Date(runAt), intervalMinutes);
  }
  if (existingModels.length === 0 && models.length > 0) {
    patch.healthCheckModel = formatHealthCheckModels(models);
  }

  return patch;
}

export async function recordManualAccountTokenHealthCheckResults(
  results: AccountTokenModelTestResult[],
): Promise<Array<typeof schema.accountTokens.$inferSelect>> {
  const tokenIds = Array.from(new Set(results
    .map((item) => Number(item.tokenId))
    .filter((id) => Number.isInteger(id) && id > 0)));
  if (tokenIds.length === 0) return [];

  const tokens = await db.select()
    .from(schema.accountTokens)
    .where(inArray(schema.accountTokens.id, tokenIds))
    .all();
  const tokenById = new Map<number, typeof schema.accountTokens.$inferSelect>(
    tokens.map((token) => [token.id, token]),
  );
  const resultsByTokenId = new Map<number, AccountTokenModelTestResult[]>();
  for (const result of results) {
    const tokenId = Number(result.tokenId);
    if (!tokenById.has(tokenId)) continue;
    const group = resultsByTokenId.get(tokenId) || [];
    group.push(result);
    resultsByTokenId.set(tokenId, group);
  }

  const updatedIds: number[] = [];
  const fallbackCheckedAt = new Date().toISOString();
  for (const [tokenId, tokenResults] of resultsByTokenId) {
    const token = tokenById.get(tokenId);
    if (!token) continue;
    const models = normalizeHealthCheckModels(formatHealthCheckModels(tokenResults.map((item) => item.model)));
    const latestCheckedAt = tokenResults
      .map((item) => item.checkedAt)
      .filter((value): value is string => typeof value === 'string' && value.trim().length > 0)
      .sort()
      .at(-1) || fallbackCheckedAt;
    const result = summarizeHealthCheckResults(tokenId, models, tokenResults, latestCheckedAt);
    await db.update(schema.accountTokens)
      .set(buildHealthCheckPatch(token, result, models, latestCheckedAt))
      .where(eq(schema.accountTokens.id, tokenId))
      .run();
    updatedIds.push(tokenId);
  }

  if (updatedIds.length === 0) return [];
  return db.select()
    .from(schema.accountTokens)
    .where(inArray(schema.accountTokens.id, updatedIds))
    .all();
}

export async function enableSuccessfulHealthCheckModelsForRouting(
  results: AccountTokenModelTestResult[],
  options: SuccessfulHealthCheckRoutingOptions = {},
): Promise<SuccessfulHealthCheckRoutingResult> {
  const autoEnableRoute = options.autoEnableRoute === true;
  const successfulModels: Array<{ tokenId: number; model: string; checkedAt?: string }> = [];
  const seen = new Set<string>();
  for (const item of results) {
    const tokenId = Number(item.tokenId);
    const model = String(item.model || '').trim();
    if (!item.available || !Number.isInteger(tokenId) || tokenId <= 0 || !model) continue;
    const key = `${tokenId}:${model.toLowerCase()}`;
    if (seen.has(key)) continue;
    seen.add(key);
    successfulModels.push({ tokenId, model, checkedAt: item.checkedAt });
  }

  if (successfulModels.length === 0) {
    return { routeEligibleModels: [], routeRebuilt: false };
  }

  const fallbackCheckedAt = new Date().toISOString();
  const successStreakThreshold = Math.max(1, Math.trunc(options.successStreakThreshold || HEALTH_CHECK_AUTO_ENABLE_SUCCESS_STREAK));
  const existingRows = await db.select()
    .from(schema.tokenModelAvailability)
    .where(inArray(schema.tokenModelAvailability.tokenId, Array.from(new Set(successfulModels.map((item) => item.tokenId)))))
    .all();
  const existingByKey = new Map<string, typeof schema.tokenModelAvailability.$inferSelect>(
    existingRows.map((row) => [`${row.tokenId}:${row.modelName.toLowerCase()}`, row]),
  );
  let routesChanged = false;
  const routeEligibleModels: Array<{ tokenId: number; model: string }> = [];

  for (const item of successfulModels) {
    const checkedAt = item.checkedAt || fallbackCheckedAt;
    const existing = existingByKey.get(`${item.tokenId}:${item.model.toLowerCase()}`);
    const nextSuccessStreak = (existing?.healthCheckSuccessStreak || 0) + 1;
    const wasManuallyDisabled = existing?.routeEnabled === false
      && existing.routeEnabledSource === 'manual'
      && !!existing.routeManualDisabledAt;
    const canAutoEnableRoute = autoEnableRoute
      && !wasManuallyDisabled
      && nextSuccessStreak >= successStreakThreshold;
    const nextRouteEnabled = canAutoEnableRoute ? true : existing?.routeEnabled === true;
    const nextRouteEnabledSource = canAutoEnableRoute
      ? 'health_check'
      : (existing?.routeEnabledSource || 'manual');
    const nextRouteManualDisabledAt = canAutoEnableRoute
      ? null
      : existing?.routeManualDisabledAt ?? null;
    if (nextRouteEnabled) {
      routeEligibleModels.push({ tokenId: item.tokenId, model: item.model });
    }
    if (nextRouteEnabled && (existing?.available !== true || existing?.routeEnabled !== true)) {
      routesChanged = true;
    }
    await db.insert(schema.tokenModelAvailability)
      .values({
        tokenId: item.tokenId,
        modelName: item.model,
        available: true,
        message: '请求成功',
        httpStatus: 200,
        routeEnabled: nextRouteEnabled,
        routeEnabledSource: nextRouteEnabledSource,
        healthCheckSuccessStreak: nextSuccessStreak,
        routeManualDisabledAt: nextRouteManualDisabledAt,
        checkedAt,
      })
      .onConflictDoUpdate({
        target: [schema.tokenModelAvailability.tokenId, schema.tokenModelAvailability.modelName],
        set: {
          available: true,
          routeEnabled: nextRouteEnabled,
          routeEnabledSource: nextRouteEnabledSource,
          healthCheckSuccessStreak: nextSuccessStreak,
          routeManualDisabledAt: nextRouteManualDisabledAt,
          checkedAt,
        },
      })
      .run();
  }

  if (routesChanged) {
    invalidateTokenRouterCache();
    scheduleRoutesOnlyRebuild('account-token-health-check-success');
  }
  return {
    routeEligibleModels,
    routeRebuilt: routesChanged,
  };
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

export async function runAccountTokenHealthCheck(
  tokenId: number,
  options: { autoEnableSuccessfulModels?: boolean } = {},
): Promise<AccountTokenHealthCheckRunResult | null> {
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
  await db.update(schema.accountTokens)
    .set(buildHealthCheckPatch(token, result, models, checkedAt))
    .where(eq(schema.accountTokens.id, token.id))
    .run();

  let routeRebuilt = false;
  const successfulResults = results.filter((item) => item.available);
  const failedResults = results.filter((item) => !item.available);
  for (const item of failedResults) {
    await db.update(schema.tokenModelAvailability)
      .set({ healthCheckSuccessStreak: 0 })
      .where(and(
        eq(schema.tokenModelAvailability.tokenId, item.tokenId),
        eq(schema.tokenModelAvailability.modelName, item.model),
      ))
      .run();
  }
  if (successfulResults.length > 0) {
    routeRebuilt = (await enableSuccessfulHealthCheckModelsForRouting(successfulResults, {
      autoEnableRoute: options.autoEnableSuccessfulModels === true,
    })).routeRebuilt;
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
      const result = await runAccountTokenHealthCheck(row.id, { autoEnableSuccessfulModels: true });
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
