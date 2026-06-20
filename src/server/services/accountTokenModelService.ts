import { and, eq } from 'drizzle-orm';
import { db, schema } from '../db/index.js';
import { getProxyUrlFromExtraConfig, resolvePlatformUserId } from './accountExtraConfig.js';
import { isReadyAccountToken } from './accountTokenService.js';
import { getAdapter } from './platforms/index.js';
import { withAccountProxyOverride } from './siteProxy.js';

const TOKEN_MODEL_DISCOVERY_TIMEOUT_MS = 30_000;

type AccountTokenModelRow = {
  account_tokens: typeof schema.accountTokens.$inferSelect;
  accounts: typeof schema.accounts.$inferSelect;
  sites: typeof schema.sites.$inferSelect;
};

export type AccountTokenModelsResult = {
  tokenId: number;
  refreshed: boolean;
  source: 'cache' | 'upstream';
  models: string[];
  modelCount: number;
  checkedAt: string | null;
  token: {
    id: number;
    name: string | null;
    tokenGroup: string | null;
  };
  account: {
    id: number;
    username: string | null;
  };
  site: {
    id: number;
    name: string;
    url: string;
    platform: string;
  };
};

function normalizeModels(models: string[]): string[] {
  const result: string[] = [];
  const seen = new Set<string>();
  for (const rawModel of models) {
    if (typeof rawModel !== 'string') continue;
    const modelName = rawModel.trim();
    if (!modelName) continue;
    const key = modelName.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    result.push(modelName);
  }
  return result.sort((left, right) => left.localeCompare(right));
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

async function loadTokenModelRow(tokenId: number): Promise<AccountTokenModelRow | null> {
  const row = await db.select()
    .from(schema.accountTokens)
    .innerJoin(schema.accounts, eq(schema.accountTokens.accountId, schema.accounts.id))
    .innerJoin(schema.sites, eq(schema.accounts.siteId, schema.sites.id))
    .where(eq(schema.accountTokens.id, tokenId))
    .get();
  return row || null;
}

export async function loadCachedAccountTokenModels(tokenId: number) {
  const rows = await db.select({
    modelName: schema.tokenModelAvailability.modelName,
    checkedAt: schema.tokenModelAvailability.checkedAt,
  })
    .from(schema.tokenModelAvailability)
    .where(and(
      eq(schema.tokenModelAvailability.tokenId, tokenId),
      eq(schema.tokenModelAvailability.available, true),
    ))
    .all();

  let checkedAt: string | null = null;
  for (const row of rows) {
    if (!row.checkedAt) continue;
    if (!checkedAt || row.checkedAt > checkedAt) checkedAt = row.checkedAt;
  }

  return {
    models: normalizeModels(rows.map((row) => row.modelName)),
    checkedAt,
  };
}

function buildResult(
  row: AccountTokenModelRow,
  models: string[],
  checkedAt: string | null,
  source: 'cache' | 'upstream',
  refreshed: boolean,
): AccountTokenModelsResult {
  return {
    tokenId: row.account_tokens.id,
    refreshed,
    source,
    models,
    modelCount: models.length,
    checkedAt,
    token: {
      id: row.account_tokens.id,
      name: row.account_tokens.name,
      tokenGroup: row.account_tokens.tokenGroup,
    },
    account: {
      id: row.accounts.id,
      username: row.accounts.username,
    },
    site: {
      id: row.sites.id,
      name: row.sites.name,
      url: row.sites.url,
      platform: row.sites.platform,
    },
  };
}

export async function getAccountTokenModels(
  tokenId: number,
  options: { refresh?: boolean } = {},
): Promise<AccountTokenModelsResult | null> {
  const row = await loadTokenModelRow(tokenId);
  if (!row) return null;

  const cached = await loadCachedAccountTokenModels(tokenId);
  if (options.refresh === false) {
    return buildResult(row, cached.models, cached.checkedAt, 'cache', false);
  }

  if ((row.sites.status || 'active') === 'disabled') {
    throw new Error('站点已禁用，无法拉取模型');
  }
  if (!row.account_tokens.enabled) {
    throw new Error('令牌已禁用，无法拉取模型');
  }
  if (!isReadyAccountToken(row.account_tokens)) {
    throw new Error('令牌明文未补全，无法拉取模型');
  }

  const adapter = getAdapter(row.sites.platform);
  if (!adapter) {
    throw new Error('站点平台不支持模型拉取');
  }

  const platformUserId = resolvePlatformUserId(row.accounts.extraConfig, row.accounts.username);
  const proxyUrl = getProxyUrlFromExtraConfig(row.accounts.extraConfig);
  const startedAt = Date.now();
  const models = normalizeModels(await withTimeout(
    () => withAccountProxyOverride(proxyUrl,
      () => adapter.getModels(row.sites.url, row.account_tokens.token, platformUserId)),
    TOKEN_MODEL_DISCOVERY_TIMEOUT_MS,
    `token model discovery timeout (${Math.round(TOKEN_MODEL_DISCOVERY_TIMEOUT_MS / 1000)}s)`,
  ));
  const checkedAt = new Date().toISOString();
  const latencyMs = Date.now() - startedAt;

  await db.delete(schema.tokenModelAvailability)
    .where(eq(schema.tokenModelAvailability.tokenId, tokenId))
    .run();

  if (models.length > 0) {
    await db.insert(schema.tokenModelAvailability)
      .values(models.map((modelName) => ({
        tokenId,
        modelName,
        available: true,
        latencyMs,
        checkedAt,
      })))
      .run();
  }

  return buildResult(row, models, checkedAt, 'upstream', true);
}
