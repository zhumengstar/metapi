import { inArray, eq } from 'drizzle-orm';
import { fetch } from 'undici';
import { db, schema } from '../db/index.js';
import { getProxyUrlFromExtraConfig } from './accountExtraConfig.js';
import { isReadyAccountToken } from './accountTokenService.js';
import { normalizePlatformBaseUrl } from './platforms/standardApiProvider.js';
import { withAccountProxyOverride, withSiteProxyRequestInit } from './siteProxy.js';
import { isImageGenerationModel } from './modelType.js';
import { scheduleRoutesOnlyRebuild } from './routeRefreshWorkflow.js';
import { invalidateTokenRouterCache } from './tokenRouter.js';

const TOKEN_MODEL_TEST_TIMEOUT_MS = 60_000;
const TOKEN_MODEL_TEST_CONCURRENCY = 12;

type AccountTokenAvailabilityRow = {
  account_tokens: typeof schema.accountTokens.$inferSelect;
  accounts: typeof schema.accounts.$inferSelect;
  sites: typeof schema.sites.$inferSelect;
};

export type AccountTokenModelTestResult = {
  tokenId: number;
  model: string;
  available: boolean;
  message: string;
  responseText: string | null;
  httpStatus: number | null;
  latencyMs: number | null;
  checkedAt: string;
};

export type AccountTokenModelTestOptions = {
  model: string;
  tokenIds: number[];
};

function resolveChatCompletionsUrl(baseUrl: string): string {
  const normalized = normalizePlatformBaseUrl(baseUrl);
  if (/\/v\d+(?:\.\d+)?(?:beta)?$/i.test(normalized)) {
    return `${normalized}/chat/completions`;
  }
  return `${normalized}/v1/chat/completions`;
}

function normalizeTokenIds(tokenIds: number[]): number[] {
  const seen = new Set<number>();
  const result: number[] = [];
  for (const rawId of tokenIds) {
    const id = Number(rawId);
    if (!Number.isInteger(id) || id <= 0 || seen.has(id)) continue;
    seen.add(id);
    result.push(id);
  }
  return result;
}

async function loadTokenRows(tokenIds: number[]): Promise<AccountTokenAvailabilityRow[]> {
  if (tokenIds.length === 0) return [];
  const rows = await db.select()
    .from(schema.accountTokens)
    .innerJoin(schema.accounts, eq(schema.accountTokens.accountId, schema.accounts.id))
    .innerJoin(schema.sites, eq(schema.accounts.siteId, schema.sites.id))
    .where(inArray(schema.accountTokens.id, tokenIds))
    .all();

  const rowById = new Map(rows.map((row) => [row.account_tokens.id, row]));
  return tokenIds.map((id) => rowById.get(id)).filter((row): row is AccountTokenAvailabilityRow => !!row);
}

async function readResponsePayload(response: { text: () => Promise<string> }) {
  const text = await response.text();
  if (!text) {
    return { text, payload: null as any };
  }
  try {
    return { text, payload: JSON.parse(text) };
  } catch {
    return { text, payload: null as any };
  }
}

async function persistTokenModelTestResults(results: AccountTokenModelTestResult[]) {
  if (results.length === 0) return;
  const checkedAt = new Date().toISOString();
  const tokenIds = normalizeTokenIds(results.map((result) => result.tokenId));
  const existingRows = tokenIds.length > 0
    ? await db.select()
      .from(schema.tokenModelAvailability)
      .where(inArray(schema.tokenModelAvailability.tokenId, tokenIds))
      .all()
    : [];
  const existingByKey = new Map<string, typeof schema.tokenModelAvailability.$inferSelect>(
    existingRows.map((row) => [`${row.tokenId}:${row.modelName.toLowerCase()}`, row]),
  );
  let routeRelevantAvailabilityChanged = false;

  for (const result of results) {
    const existing = existingByKey.get(`${result.tokenId}:${result.model.toLowerCase()}`);
    if (existing?.routeEnabled === true && existing.available !== result.available) {
      routeRelevantAvailabilityChanged = true;
    }
    await db.insert(schema.tokenModelAvailability)
      .values({
        tokenId: result.tokenId,
        modelName: result.model,
        available: result.available,
        message: result.message,
        httpStatus: result.httpStatus,
        responseText: result.responseText,
        latencyMs: result.latencyMs,
        checkedAt: result.checkedAt || checkedAt,
      })
      .onConflictDoUpdate({
        target: [schema.tokenModelAvailability.tokenId, schema.tokenModelAvailability.modelName],
        set: {
          available: result.available,
          message: result.message,
          httpStatus: result.httpStatus,
          responseText: result.responseText,
          latencyMs: result.latencyMs,
          checkedAt: result.checkedAt || checkedAt,
        },
      })
      .run();
  }

  if (tokenIds.length > 0) {
    await db.update(schema.accountTokens)
      .set({ updatedAt: checkedAt })
      .where(inArray(schema.accountTokens.id, tokenIds))
      .run();
  }

  if (routeRelevantAvailabilityChanged) {
    invalidateTokenRouterCache();
    scheduleRoutesOnlyRebuild('account-token-model-availability-changed');
  }
}

export async function persistSkippedAccountTokenModelAvailability(
  results: AccountTokenModelTestResult[],
): Promise<void> {
  await persistTokenModelTestResults(results);
}

function extractFailureMessage(payload: any, text: string, fallback: string): string {
  const message = payload?.error?.message || payload?.message || payload?.msg;
  if (typeof message === 'string' && message.trim()) return message.trim();
  const trimmed = text.trim();
  if (trimmed) return trimmed.slice(0, 180);
  return fallback;
}

function extractModelReply(payload: any, text: string): string | null {
  const candidates = [
    payload?.choices?.[0]?.message?.content,
    payload?.choices?.[0]?.text,
    payload?.output_text,
    payload?.message,
  ];
  for (const candidate of candidates) {
    if (typeof candidate === 'string' && candidate.trim()) return candidate.trim().slice(0, 500);
  }
  const output = payload?.output;
  if (Array.isArray(output)) {
    const parts: string[] = [];
    for (const item of output) {
      const content = item?.content;
      if (!Array.isArray(content)) continue;
      for (const block of content) {
        const value = block?.text || block?.content;
        if (typeof value === 'string' && value.trim()) parts.push(value.trim());
      }
    }
    const joined = parts.join('\n').trim();
    if (joined) return joined.slice(0, 500);
  }
  const trimmed = text.trim();
  return trimmed ? trimmed.slice(0, 500) : null;
}

async function testOneTokenModel(
  row: AccountTokenAvailabilityRow,
  model: string,
): Promise<AccountTokenModelTestResult> {
  const checkedAt = new Date().toISOString();
  const unavailable = (
    message: string,
    httpStatus: number | null = null,
    latencyMs: number | null = null,
  ): AccountTokenModelTestResult => ({
    tokenId: row.account_tokens.id,
    model,
    available: false,
    message,
    responseText: null,
    httpStatus,
    latencyMs,
    checkedAt,
  });

  if ((row.sites.status || 'active') === 'disabled') {
    return unavailable('站点已禁用');
  }
  if (!isReadyAccountToken(row.account_tokens)) {
    return unavailable('令牌明文未补全');
  }
  if (isImageGenerationModel(model)) {
    return unavailable('图片模型不进行聊天可用性测试');
  }

  const endpoint = resolveChatCompletionsUrl(row.sites.url);
  const startedAt = Date.now();
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TOKEN_MODEL_TEST_TIMEOUT_MS);

  try {
    const response = await withAccountProxyOverride(
      getProxyUrlFromExtraConfig(row.accounts.extraConfig),
      async () => fetch(endpoint, await withSiteProxyRequestInit(endpoint, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${row.account_tokens.token}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          model,
          messages: [{ role: 'user', content: '你是什么模型？' }],
          max_tokens: 80,
          temperature: 0,
          stream: false,
        }),
        signal: controller.signal,
      })),
    );
    const latencyMs = Date.now() - startedAt;
    const { text, payload } = await readResponsePayload(response);
    if (!response.ok || payload?.error) {
      return unavailable(
        extractFailureMessage(payload, text, `请求失败：HTTP ${response.status}`),
        response.status,
        latencyMs,
      );
    }
    return {
      tokenId: row.account_tokens.id,
      model,
      available: true,
      message: '请求成功',
      responseText: extractModelReply(payload, text),
      httpStatus: response.status,
      latencyMs,
      checkedAt,
    };
  } catch (error: any) {
    const latencyMs = Date.now() - startedAt;
    const message = error?.name === 'AbortError'
      ? `请求超时（${Math.round(TOKEN_MODEL_TEST_TIMEOUT_MS / 1000)}s）`
      : (error?.message || '请求失败');
    return unavailable(message, null, latencyMs);
  } finally {
    clearTimeout(timer);
  }
}

export async function testAccountTokenModelAvailability(
  options: AccountTokenModelTestOptions,
): Promise<{ model: string; total: number; results: AccountTokenModelTestResult[] }> {
  const model = options.model.trim();
  const tokenIds = normalizeTokenIds(options.tokenIds);
  const rows = await loadTokenRows(tokenIds);
  const results: AccountTokenModelTestResult[] = [];

  for (let index = 0; index < rows.length; index += TOKEN_MODEL_TEST_CONCURRENCY) {
    const batch = rows.slice(index, index + TOKEN_MODEL_TEST_CONCURRENCY);
    results.push(...await Promise.all(batch.map((row) => testOneTokenModel(row, model))));
  }
  await persistTokenModelTestResults(results);

  return {
    model,
    total: results.length,
    results,
  };
}
