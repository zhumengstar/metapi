import { and, eq } from 'drizzle-orm';
import { fetch } from 'undici';
import { db, schema } from '../db/index.js';
import { getProxyUrlFromExtraConfig, resolvePlatformUserId } from './accountExtraConfig.js';
import { maskToken, resolveAccountTokenValueStatus } from './accountTokenService.js';
import { convergeAccountMutation } from './accountMutationWorkflow.js';
import {
  fetchModelPricingCatalog,
  listCatalogModelsForGroup,
  refreshModelPricingCatalog,
  type ModelPricingCatalog,
} from './modelPricingService.js';
import { getAdapter } from './platforms/index.js';
import { withAccountProxyOverride, withSiteRecordProxyRequestInit } from './siteProxy.js';

type AccountRow = typeof schema.accounts.$inferSelect;
type SiteRow = typeof schema.sites.$inferSelect;

type AccountWithSite = {
  accounts: AccountRow;
  sites: SiteRow;
  localTokenGroups?: string[];
};

type GroupDetail = {
  group: string;
  ratio?: number;
  name?: string | null;
  description?: string | null;
};

export type TokenGroupPricingOverviewOptions = {
  refresh?: boolean;
};

export type TokenGroupPricingOverviewAccount = {
  account: {
    id: number;
    username: string | null;
    status: string | null;
  };
  site: {
    id: number;
    name: string;
    url: string;
    platform: string;
    status: string | null;
  };
  groups: string[];
  groupSource: 'upstream' | 'local' | 'default';
  groupError?: string;
  pricing: ReturnType<typeof summarizePricing>;
  tokens: Array<{
    id: number;
    name: string;
    tokenMasked: string;
    group: string;
    modelNames: string[];
    enabled: boolean;
    isDefault: boolean;
    source: string | null;
    valueStatus: string;
    createdAt?: string | null;
  }>;
};

type TokenGroupPricingOverviewToken = TokenGroupPricingOverviewAccount['tokens'][number];

export type TokenGroupPricingOverviewGroupRow = {
  id: string;
  site: TokenGroupPricingOverviewAccount['site'];
  account: TokenGroupPricingOverviewAccount['account'] | null;
  group: string;
  groupName?: string | null;
  description?: string | null;
  ratio: number | null;
  groupSource: TokenGroupPricingOverviewAccount['groupSource'];
  groupError?: string;
  pricingAvailable: boolean;
  modelCount: number;
  modelNames: string[];
  refreshedAt?: string | null;
  tokens: TokenGroupPricingOverviewToken[];
};

export type TokenGroupPricingGroupsOptions = {
  model?: string;
  sortBy?: 'site' | 'group' | 'ratio' | 'modelCount';
  sortOrder?: 'asc' | 'desc';
};

const GROUP_FETCH_TIMEOUT_MS = 8_000;
const TOKEN_SYNC_TIMEOUT_MS = 15_000;

function isSiteDisabled(status?: string | null): boolean {
  return (status || 'active') === 'disabled';
}

function normalizeGroup(value: unknown): string {
  const trimmed = String(value || '').trim();
  return trimmed || 'default';
}

function normalizeTokenGroup(value: unknown, tokenName?: string | null): string {
  const explicit = String(value || '').trim();
  if (explicit) return explicit;
  const name = String(tokenName || '').trim();
  if (!name) return 'default';
  const normalized = name.toLowerCase();
  if (normalized === 'default' || normalized === '默认' || /^default($|[-_\s])/.test(normalized)) return 'default';
  if (/^token-\d+$/.test(normalized)) return 'default';
  return name;
}

function uniqueGroups(groups: unknown[]): string[] {
  const normalized = groups.map(normalizeGroup).filter(Boolean);
  return Array.from(new Set(normalized)).sort((a, b) => a.localeCompare(b));
}

function supportsImplicitDefaultGroup(platform?: string | null): boolean {
  return String(platform || '').toLowerCase() !== 'sub2api';
}

function defaultGroupsForPlatform(platform?: string | null): string[] {
  return supportsImplicitDefaultGroup(platform) ? ['default'] : [];
}

function defaultGroupDetailsForPlatform(platform?: string | null): GroupDetail[] {
  return supportsImplicitDefaultGroup(platform) ? [{ group: 'default' }] : [];
}

function filterGroupsForPlatform(groups: string[], platform?: string | null): string[] {
  if (supportsImplicitDefaultGroup(platform)) return groups;
  return groups.filter((group) => group !== 'default');
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

async function fetchAccountGroups(row: AccountWithSite, refresh: boolean): Promise<{
  groups: string[];
  details: GroupDetail[];
  source: 'upstream' | 'local' | 'default';
  error?: string;
}> {
  const localGroups = uniqueGroups(row.localTokenGroups || []);
  const localDetails = localGroups.map((group) => ({ group }));
  const fallbackGroups = localGroups.length > 0 ? localGroups : defaultGroupsForPlatform(row.sites.platform);
  const fallbackDetails = localDetails.length > 0 ? localDetails : defaultGroupDetailsForPlatform(row.sites.platform);

  if (!refresh) {
    return {
      groups: fallbackGroups,
      details: fallbackDetails,
      source: localGroups.length > 0 ? 'local' : 'default',
    };
  }

  if (isSiteDisabled(row.sites.status)) {
    return { groups: fallbackGroups, details: fallbackDetails, source: localGroups.length > 0 ? 'local' : 'default', error: '站点已禁用' };
  }
  if (!row.accounts.accessToken?.trim()) {
    return { groups: fallbackGroups, details: fallbackDetails, source: localGroups.length > 0 ? 'local' : 'default', error: '账号缺少访问令牌' };
  }

  const adapter = getAdapter(row.sites.platform);
  if (!adapter) {
    return { groups: fallbackGroups, details: fallbackDetails, source: localGroups.length > 0 ? 'local' : 'default', error: `不支持的平台: ${row.sites.platform}` };
  }

  try {
    const platformUserId = resolvePlatformUserId(row.accounts.extraConfig, row.accounts.username);
    const accountProxyUrl = getProxyUrlFromExtraConfig(row.accounts.extraConfig);
    const upstreamDetails = await withTimeout(
      () => withAccountProxyOverride(accountProxyUrl,
        () => adapter.getUserGroupDetails(row.sites.url, row.accounts.accessToken, platformUserId)),
      GROUP_FETCH_TIMEOUT_MS,
      `group fetch timeout (${Math.round(GROUP_FETCH_TIMEOUT_MS / 1000)}s)`,
    );
    const details = normalizeGroupDetails(upstreamDetails);
    const groups = uniqueGroups(details.map((item) => item.group));
    return {
      groups: groups.length > 0 ? groups : defaultGroupsForPlatform(row.sites.platform),
      details: details.length > 0 ? details : defaultGroupDetailsForPlatform(row.sites.platform),
      source: 'upstream',
    };
  } catch (error: any) {
    return {
      groups: fallbackGroups,
      details: fallbackDetails,
      source: localGroups.length > 0 ? 'local' : 'default',
      error: error?.message || '拉取分组失败',
    };
  }
}

function normalizeGroupDetails(details: GroupDetail[]): GroupDetail[] {
  const byGroup = new Map<string, GroupDetail>();
  for (const item of details) {
    const group = normalizeGroup(item?.group);
    if (!group) continue;
    const ratio = Number(item?.ratio);
    const existing = byGroup.get(group) || { group };
    byGroup.set(group, {
      group,
      ratio: Number.isFinite(ratio) && ratio > 0 ? Math.round(ratio * 1_000_000) / 1_000_000 : existing.ratio,
      name: typeof item?.name === 'string' && item.name.trim() ? item.name.trim() : existing.name,
      description: typeof item?.description === 'string' && item.description.trim() ? item.description.trim() : existing.description,
    });
  }
  return Array.from(byGroup.values()).sort((a, b) => a.group.localeCompare(b.group));
}

function buildRatioOverride(details: GroupDetail[]): Record<string, number> {
  const ratio: Record<string, number> = {};
  for (const item of details) {
    const value = Number(item.ratio);
    if (Number.isFinite(value) && value > 0) {
      ratio[normalizeGroup(item.group)] = value;
    }
  }
  return ratio;
}

function parsePublicGroupsPayload(payload: any): { groups: string[]; ratio: Record<string, number> } {
  const data = payload?.data && typeof payload.data === 'object' ? payload.data : {};
  const groups: string[] = [];
  const ratio: Record<string, number> = {};
  for (const [rawGroup, rawValue] of Object.entries(data)) {
    const group = normalizeGroup(rawGroup);
    groups.push(group);
    const value = rawValue && typeof rawValue === 'object'
      ? Number((rawValue as { ratio?: unknown }).ratio)
      : Number(rawValue);
    if (Number.isFinite(value) && value > 0) {
      ratio[group] = value;
    }
  }
  return { groups: uniqueGroups(groups), ratio };
}

async function fetchPublicSiteGroups(site: SiteRow): Promise<{
  groups: string[];
  ratio: Record<string, number>;
  source: 'upstream' | 'default';
  error?: string;
}> {
  if (isSiteDisabled(site.status)) {
    return { groups: [], ratio: {}, source: 'default', error: '站点已禁用' };
  }

  try {
    const endpoint = `${site.url.replace(/\/+$/, '')}/api/user/groups`;
    const response = await withTimeout(
      async () => fetch(endpoint, withSiteRecordProxyRequestInit(site, {
        method: 'GET',
        headers: { accept: 'application/json' },
      })),
      GROUP_FETCH_TIMEOUT_MS,
      `group fetch timeout (${Math.round(GROUP_FETCH_TIMEOUT_MS / 1000)}s)`,
    );
    if (!response.ok) {
      throw new Error(`HTTP ${response.status}`);
    }
    const parsed = parsePublicGroupsPayload(await response.json());
    return {
      groups: parsed.groups,
      ratio: parsed.ratio,
      source: parsed.groups.length > 0 ? 'upstream' : 'default',
    };
  } catch (error: any) {
    return {
      groups: [],
      ratio: {},
      source: 'default',
      error: error?.message || '拉取分组失败',
    };
  }
}

function summarizePricing(catalog: ModelPricingCatalog | null, groups: string[], ratioOverride: Record<string, number> = {}) {
  const ratio = { ...(catalog?.groupRatio || {}), ...ratioOverride };
  return {
    available: !!catalog || Object.keys(ratioOverride).length > 0,
    modelCount: catalog?.models.length || 0,
    groupRatio: groups.reduce<Record<string, number | null>>((acc, group) => {
      const value = ratio[group];
      acc[group] = Number.isFinite(value) && value > 0 ? value : null;
      return acc;
    }, {}),
    allGroupRatio: ratio,
  };
}

function latestTokenFirst(a: TokenGroupPricingOverviewToken, b: TokenGroupPricingOverviewToken): number {
  const aTime = Date.parse(a.createdAt || '') || 0;
  const bTime = Date.parse(b.createdAt || '') || 0;
  return bTime - aTime || b.id - a.id;
}

function newestTokenForGroup(tokens: TokenGroupPricingOverviewToken[], group: string): TokenGroupPricingOverviewToken[] {
  const matched = tokens.filter((token) => token.group === group).sort(latestTokenFirst);
  return matched[0] ? [matched[0]] : [];
}

function createGroupRowsFromAccount(item: TokenGroupPricingOverviewAccount): TokenGroupPricingOverviewGroupRow[] {
  return item.groups.map((group) => ({
    id: `${item.site.id}:${item.account.id}:${group}`,
    site: item.site,
    account: item.account,
    group,
    ratio: item.pricing.groupRatio[group] ?? null,
    groupSource: item.groupSource,
    groupError: item.groupError,
    pricingAvailable: item.pricing.available,
    modelCount: item.pricing.modelCount,
    modelNames: [],
    tokens: newestTokenForGroup(item.tokens, group),
  }));
}

function createGroupRowsFromSite(input: {
  site: SiteRow;
  groupResult: Awaited<ReturnType<typeof fetchPublicSiteGroups>>;
  catalog: ModelPricingCatalog | null;
}): TokenGroupPricingOverviewGroupRow[] {
  const site = {
    id: input.site.id,
    name: input.site.name,
    url: input.site.url,
    platform: input.site.platform,
    status: input.site.status,
  };
  const groups = uniqueGroups(input.groupResult.groups);
  const pricing = summarizePricing(input.catalog, groups, input.groupResult.ratio);
  return groups.map((group) => ({
    id: `${input.site.id}:site:${group}`,
    site,
    account: null,
    group,
    ratio: pricing.groupRatio[group] ?? null,
    groupSource: input.groupResult.source,
    groupError: input.groupResult.error,
    pricingAvailable: pricing.available,
    modelCount: pricing.modelCount,
    modelNames: [],
    tokens: [],
  }));
}

function normalizeStoredSource(value?: string | null): TokenGroupPricingOverviewAccount['groupSource'] {
  return value === 'local' || value === 'default' ? value : 'upstream';
}

function isStoredPricingAvailable(value: unknown): boolean {
  return value === true || value === 1 || value === '1';
}

function buildStoredRowId(row: {
  siteId: number;
  accountId?: number | null;
  sourceKey: string;
  group: string;
}): string {
  if (row.accountId && row.sourceKey === `account:${row.accountId}`) {
    return `${row.siteId}:${row.accountId}:${row.group}`;
  }
  return `${row.siteId}:${row.sourceKey}:${row.group}`;
}

function attachTokensToGroupRow(
  row: TokenGroupPricingOverviewGroupRow,
  tokensByAccountId: Map<number, TokenGroupPricingOverviewToken[]>,
): TokenGroupPricingOverviewGroupRow {
  if (!row.account) return row;
  const tokens = newestTokenForGroup(tokensByAccountId.get(row.account.id) || [], row.group);
  return { ...row, tokens };
}

function withCatalogGroupModels(
  row: TokenGroupPricingOverviewGroupRow,
  catalog: ModelPricingCatalog | null,
): TokenGroupPricingOverviewGroupRow {
  const tokenModelNames = Array.from(new Set(
    row.tokens.flatMap((token) => token.modelNames || []),
  )).sort((a, b) => a.localeCompare(b));
  const modelNameSets = [
    listCatalogModelsForGroup(catalog, row.group),
    row.groupName ? listCatalogModelsForGroup(catalog, row.groupName) : [],
  ];
  const matchedModelNames = Array.from(new Set(modelNameSets.flat())).sort((a, b) => a.localeCompare(b));
  const modelNames = row.tokens.length > 0 ? tokenModelNames : matchedModelNames;
  return {
    ...row,
    modelNames,
    modelCount: modelNames.length,
    pricingAvailable: !!catalog || row.pricingAvailable,
  };
}

async function loadTokenModelNamesByTokenId(): Promise<Map<number, string[]>> {
  const rows = await db.select({
    tokenId: schema.tokenModelAvailability.tokenId,
    modelName: schema.tokenModelAvailability.modelName,
  })
    .from(schema.tokenModelAvailability)
    .where(eq(schema.tokenModelAvailability.available, true))
    .all();

  const modelsByTokenId = new Map<number, Set<string>>();
  for (const row of rows) {
    const modelName = String(row.modelName || '').trim();
    if (!modelName) continue;
    if (!modelsByTokenId.has(row.tokenId)) modelsByTokenId.set(row.tokenId, new Set());
    modelsByTokenId.get(row.tokenId)!.add(modelName);
  }
  return new Map(Array.from(modelsByTokenId.entries()).map(([tokenId, value]) => [
    tokenId,
    Array.from(value).sort((a, b) => a.localeCompare(b)),
  ]));
}

async function applyCatalogModelNamesToStoredRows(
  rows: TokenGroupPricingOverviewGroupRow[],
): Promise<TokenGroupPricingOverviewGroupRow[]> {
  const siteRows = await db.select().from(schema.sites).all();
  const accountRows = await db.select()
    .from(schema.accounts)
    .innerJoin(schema.sites, eq(schema.accounts.siteId, schema.sites.id))
    .all();
  const accountContext = new Map<number, { account: AccountRow; site: SiteRow }>();
  const siteContext = new Map<number, SiteRow>();
  for (const site of siteRows) {
    siteContext.set(site.id, site);
  }
  for (const row of accountRows) {
    accountContext.set(row.accounts.id, { account: row.accounts, site: row.sites });
    siteContext.set(row.sites.id, row.sites);
  }

  const catalogByKey = new Map<string, ModelPricingCatalog | null>();
  const output: TokenGroupPricingOverviewGroupRow[] = [];
  for (const row of rows) {
    const accountRow = row.account ? accountContext.get(row.account.id) : null;
    const site = accountRow?.site || siteContext.get(row.site.id);
    if (!site) {
      output.push(row);
      continue;
    }

    const catalogKey = accountRow ? `account:${accountRow.account.id}` : `site:${site.id}`;
    let catalog = catalogByKey.get(catalogKey);
    if (catalog === undefined) {
      try {
        catalog = await fetchModelPricingCatalog({
          site: {
            id: site.id,
            url: site.url,
            platform: site.platform,
            apiKey: site.apiKey,
          },
          account: {
            id: accountRow?.account.id || 0,
            accessToken: accountRow?.account.accessToken,
            apiToken: accountRow?.account.apiToken,
          },
          modelName: '',
        });
      } catch {
        catalog = null;
      }
      catalogByKey.set(catalogKey, catalog);
    }
    output.push(withCatalogGroupModels(row, catalog));
  }
  return output;
}

function filterAndSortGroupRows(
  rows: TokenGroupPricingOverviewGroupRow[],
  options: TokenGroupPricingGroupsOptions = {},
): TokenGroupPricingOverviewGroupRow[] {
  const modelFilter = String(options.model || '').trim().toLowerCase();
  const filtered = modelFilter
    ? rows.filter((row) => row.modelNames.some((model) => model.toLowerCase().includes(modelFilter)))
    : rows;
  const sortBy = options.sortBy || 'site';
  const direction = options.sortOrder === 'desc' ? -1 : 1;
  const numericValue = (value: unknown, fallback = 0) => {
    const normalized = typeof value === 'number'
      ? value
      : Number(String(value ?? '').trim().replace(/x$/i, ''));
    return Number.isFinite(normalized) ? normalized : fallback;
  };
  return [...filtered].sort((a, b) => {
    let result = 0;
    if (sortBy === 'ratio') {
      const aRatio = numericValue(a.ratio, Number.NaN);
      const bRatio = numericValue(b.ratio, Number.NaN);
      const aKnown = Number.isFinite(aRatio);
      const bKnown = Number.isFinite(bRatio);
      if (!aKnown && !bKnown) result = 0;
      else if (!aKnown) return 1;
      else if (!bKnown) return -1;
      else result = aRatio - bRatio;
    } else if (sortBy === 'modelCount') result = numericValue(a.modelCount) - numericValue(b.modelCount);
    else if (sortBy === 'group') result = a.group.localeCompare(b.group);
    else {
      result = a.site.name.localeCompare(b.site.name)
        || (a.account?.username || '').localeCompare(b.account?.username || '')
        || a.group.localeCompare(b.group);
    }
    return result * direction || a.site.name.localeCompare(b.site.name) || a.group.localeCompare(b.group);
  });
}

async function upsertStoredGroupRow(input: {
  row: TokenGroupPricingOverviewGroupRow;
  sourceKey: string;
}) {
  const now = new Date().toISOString();
  const existing = await db.select({
    id: schema.tokenGroupPricing.id,
    ratio: schema.tokenGroupPricing.ratio,
    pricingAvailable: schema.tokenGroupPricing.pricingAvailable,
  })
    .from(schema.tokenGroupPricing)
    .where(and(
      eq(schema.tokenGroupPricing.siteId, input.row.site.id),
      eq(schema.tokenGroupPricing.sourceKey, input.sourceKey),
      eq(schema.tokenGroupPricing.group, input.row.group),
    ))
    .get();
  const incomingRatio = Number(input.row.ratio);
  const hasIncomingRatio = input.row.pricingAvailable && Number.isFinite(incomingRatio) && incomingRatio > 0;
  const existingRatio = Number(existing?.ratio);
  const canPreserveExistingRatio = existing
    && isStoredPricingAvailable(existing.pricingAvailable)
    && Number.isFinite(existingRatio)
    && existingRatio > 0;
  const values = {
    siteId: input.row.site.id,
    accountId: input.row.account?.id ?? null,
    sourceKey: input.sourceKey,
    group: input.row.group,
    groupName: input.row.groupName || null,
    description: input.row.description || null,
    ratio: hasIncomingRatio ? incomingRatio : (canPreserveExistingRatio ? existingRatio : 0),
    source: input.row.groupSource,
    modelCount: input.row.modelCount,
    pricingAvailable: hasIncomingRatio || canPreserveExistingRatio,
    lastError: input.row.groupError || null,
    refreshedAt: now,
    updatedAt: now,
  };
  if (existing?.id) {
    await db.update(schema.tokenGroupPricing)
      .set(values)
      .where(eq(schema.tokenGroupPricing.id, existing.id))
      .run();
    return;
  }
  await db.insert(schema.tokenGroupPricing)
    .values({
      ...values,
      createdAt: now,
    })
    .run();
}

async function loadStoredGroupRows(
  tokensByAccountId: Map<number, TokenGroupPricingOverviewToken[]>,
): Promise<TokenGroupPricingOverviewGroupRow[]> {
  const rows = await db.select()
    .from(schema.tokenGroupPricing)
    .innerJoin(schema.sites, eq(schema.tokenGroupPricing.siteId, schema.sites.id))
    .leftJoin(schema.accounts, eq(schema.tokenGroupPricing.accountId, schema.accounts.id))
    .all();

  return rows
    .map((row) => {
    const stored = row.token_group_pricing;
    const account = row.accounts
      ? {
        id: row.accounts.id,
        username: row.accounts.username,
        status: row.accounts.status,
      }
      : null;
    const groupRow: TokenGroupPricingOverviewGroupRow = {
      id: buildStoredRowId({
        siteId: stored.siteId,
        accountId: stored.accountId,
        sourceKey: stored.sourceKey,
        group: stored.group,
      }),
      site: {
        id: row.sites.id,
        name: row.sites.name,
        url: row.sites.url,
        platform: row.sites.platform,
        status: row.sites.status,
      },
      account,
      group: stored.group,
      groupName: stored.groupName,
      description: stored.description,
      ratio: isStoredPricingAvailable(stored.pricingAvailable) && Number(stored.ratio) > 0 ? Number(stored.ratio) : null,
      groupSource: normalizeStoredSource(stored.source),
      groupError: stored.lastError || undefined,
      pricingAvailable: isStoredPricingAvailable(stored.pricingAvailable),
      modelCount: stored.modelCount || 0,
      modelNames: [],
      refreshedAt: stored.refreshedAt,
      tokens: [],
    };
    return attachTokensToGroupRow(groupRow, tokensByAccountId);
  })
    .filter((row) => !(row.site.platform === 'sub2api' && row.group === 'default'));
}

function mergeGroupRows(
  liveRows: TokenGroupPricingOverviewGroupRow[],
  storedRows: TokenGroupPricingOverviewGroupRow[],
): TokenGroupPricingOverviewGroupRow[] {
  const merged = new Map<string, TokenGroupPricingOverviewGroupRow>();
  for (const row of liveRows) merged.set(row.id, row);
  for (const row of storedRows) merged.set(row.id, row);
  return Array.from(merged.values()).sort((a, b) => (
    a.site.name.localeCompare(b.site.name)
    || (a.account?.username || '').localeCompare(b.account?.username || '')
    || a.group.localeCompare(b.group)
  ));
}

function removeUnauthenticatedRowsForLoggedInSites(
  rows: TokenGroupPricingOverviewGroupRow[],
): TokenGroupPricingOverviewGroupRow[] {
  const siteIdsWithAccounts = new Set(rows.filter((row) => row.account).map((row) => row.site.id));
  if (siteIdsWithAccounts.size === 0) return rows;
  return rows.filter((row) => row.account || !siteIdsWithAccounts.has(row.site.id));
}

function buildGroupRowsSummary(rows: TokenGroupPricingOverviewGroupRow[], tokenCount: number) {
  return {
    siteCount: new Set(rows.map((item) => item.site.id)).size,
    accountCount: new Set(rows.map((item) => item.account?.id).filter((id): id is number => typeof id === 'number')).size,
    tokenCount,
    groupCount: new Set(rows.map((item) => `${item.site.id}:${item.account?.id || 'site'}:${item.group}`)).size,
    pricingAvailableCount: rows.filter((item) => item.pricingAvailable).length,
    groupErrorCount: rows.filter((item) => item.groupError).length,
  };
}

async function loadTokenGroupsContext() {
  const tokenModelNamesByTokenId = await loadTokenModelNamesByTokenId();
  const tokenRows = await db.select()
    .from(schema.accountTokens)
    .innerJoin(schema.accounts, eq(schema.accountTokens.accountId, schema.accounts.id))
    .innerJoin(schema.sites, eq(schema.accounts.siteId, schema.sites.id))
    .all();

  const tokensByAccountId = new Map<number, TokenGroupPricingOverviewToken[]>();
  for (const row of tokenRows) {
    const list = tokensByAccountId.get(row.accounts.id) || [];
    list.push({
      id: row.account_tokens.id,
      name: row.account_tokens.name,
      tokenMasked: maskToken(row.account_tokens.token, row.sites.platform),
      group: normalizeTokenGroup(row.account_tokens.tokenGroup, row.account_tokens.name),
      modelNames: tokenModelNamesByTokenId.get(row.account_tokens.id) || [],
      enabled: row.account_tokens.enabled === true,
      isDefault: row.account_tokens.isDefault === true,
      source: row.account_tokens.source,
      valueStatus: resolveAccountTokenValueStatus(row.account_tokens),
      createdAt: row.account_tokens.createdAt,
    });
    tokensByAccountId.set(row.accounts.id, list);
  }

  return { tokenRows, tokensByAccountId };
}

async function syncAccountTokensFromLoginRows(rows: Array<{ accounts: AccountRow; sites: SiteRow }>) {
  const summary = {
    total: rows.length,
    synced: 0,
    skipped: 0,
    failed: 0,
    created: 0,
    updated: 0,
    maskedPending: 0,
  };

  for (const row of rows) {
    const accessToken = row.accounts.accessToken?.trim();
    if (isSiteDisabled(row.sites.status) || !accessToken) {
      summary.skipped += 1;
      continue;
    }

    const adapter = getAdapter(row.sites.platform);
    if (!adapter) {
      summary.failed += 1;
      continue;
    }

    try {
      const platformUserId = resolvePlatformUserId(row.accounts.extraConfig, row.accounts.username);
      const accountProxyUrl = getProxyUrlFromExtraConfig(row.accounts.extraConfig);
      let tokens = await withTimeout(
        () => withAccountProxyOverride(accountProxyUrl,
          () => adapter.getApiTokens(row.sites.url, accessToken, platformUserId)),
        TOKEN_SYNC_TIMEOUT_MS,
        `token sync timeout (${Math.round(TOKEN_SYNC_TIMEOUT_MS / 1000)}s)`,
      );

      if (tokens.length === 0) {
        const fallback = await withTimeout(
          () => withAccountProxyOverride(accountProxyUrl,
            () => adapter.getApiToken(row.sites.url, accessToken, platformUserId)),
          TOKEN_SYNC_TIMEOUT_MS,
          `token sync timeout (${Math.round(TOKEN_SYNC_TIMEOUT_MS / 1000)}s)`,
        );
        if (fallback && supportsImplicitDefaultGroup(row.sites.platform)) {
          tokens = [{ name: 'default', key: fallback, enabled: true, tokenGroup: 'default' }];
        }
      }

      if (tokens.length === 0) {
        summary.skipped += 1;
        continue;
      }

      const convergence = await convergeAccountMutation({
        accountId: row.accounts.id,
        upstreamTokens: tokens,
        continueOnError: true,
      });
      const tokenSync = convergence.tokenSync;
      if (!tokenSync) {
        summary.failed += 1;
        continue;
      }

      summary.synced += 1;
      summary.created += tokenSync.created || 0;
      summary.updated += tokenSync.updated || 0;
      summary.maskedPending += tokenSync.maskedPending || 0;
    } catch {
      summary.failed += 1;
    }
  }

  return summary;
}

export async function syncTokenGroupPricingCache() {
  const rows = await db.select()
    .from(schema.accounts)
    .innerJoin(schema.sites, eq(schema.accounts.siteId, schema.sites.id))
    .all();
  const tokenSync = await syncAccountTokensFromLoginRows(rows);
  const overview = await buildTokenGroupPricingOverview({ refresh: true });
  return {
    success: true,
    generatedAt: overview.generatedAt,
    summary: overview.summary,
    tokenSync,
  };
}

export async function listTokenGroupPricingGroups(options: TokenGroupPricingGroupsOptions = {}) {
  const { tokenRows, tokensByAccountId } = await loadTokenGroupsContext();
  const storedRows = await applyCatalogModelNamesToStoredRows(await loadStoredGroupRows(tokensByAccountId));
  const groupRows = filterAndSortGroupRows(removeUnauthenticatedRowsForLoggedInSites(storedRows), options);
  return {
    generatedAt: new Date().toISOString(),
    refreshed: false,
    summary: buildGroupRowsSummary(groupRows, tokenRows.length),
    groupRows,
  };
}

export async function buildTokenGroupPricingOverview(options: TokenGroupPricingOverviewOptions = {}) {
  const refresh = options.refresh === true;
  const siteRows = await db.select().from(schema.sites).all();
  const rows = await db.select()
    .from(schema.accounts)
    .innerJoin(schema.sites, eq(schema.accounts.siteId, schema.sites.id))
    .all();

  const { tokenRows, tokensByAccountId } = await loadTokenGroupsContext();

  const catalogBySiteId = new Map<number, ModelPricingCatalog | null>();
  const accounts: TokenGroupPricingOverviewAccount[] = [];
  const groupRows: TokenGroupPricingOverviewGroupRow[] = [];
  const siteIdsWithAccounts = new Set<number>();
  for (const row of rows) {
    siteIdsWithAccounts.add(row.sites.id);
    const accountTokens = tokensByAccountId.get(row.accounts.id) || [];
    const groupResult = await fetchAccountGroups({
      ...row,
      localTokenGroups: accountTokens.map((token) => token.group),
    }, refresh);
    const groups = filterGroupsForPlatform(
      uniqueGroups([...groupResult.groups, ...accountTokens.map((token) => token.group)]),
      row.sites.platform,
    );
    const groupDetailsByGroup = new Map(groupResult.details.map((item) => [normalizeGroup(item.group), item]));

    let catalog = catalogBySiteId.get(row.sites.id);
    if (catalog === undefined) {
      try {
        const input = {
          site: {
            id: row.sites.id,
            url: row.sites.url,
            platform: row.sites.platform,
            apiKey: row.sites.apiKey,
          },
          account: {
            id: row.accounts.id,
            accessToken: row.accounts.accessToken,
            apiToken: row.accounts.apiToken,
          },
          modelName: '',
        };
        catalog = refresh ? await refreshModelPricingCatalog(input) : await fetchModelPricingCatalog(input);
      } catch {
        catalog = null;
      }
      catalogBySiteId.set(row.sites.id, catalog);
    }

    const accountOverview = {
      account: {
        id: row.accounts.id,
        username: row.accounts.username,
        status: row.accounts.status,
      },
      site: {
        id: row.sites.id,
        name: row.sites.name,
        url: row.sites.url,
        platform: row.sites.platform,
        status: row.sites.status,
      },
      groups,
      groupSource: groupResult.source,
      groupError: groupResult.error,
      pricing: summarizePricing(catalog || null, groups, buildRatioOverride(groupResult.details)),
      tokens: accountTokens.sort((a, b) => Number(b.isDefault) - Number(a.isDefault) || a.name.localeCompare(b.name)),
    };
    accounts.push(accountOverview);
    const accountGroupRows = createGroupRowsFromAccount(accountOverview).map((item) => {
      const detail = groupDetailsByGroup.get(item.group);
      return withCatalogGroupModels({
        ...item,
        groupName: detail?.name,
        description: detail?.description,
      }, catalog || null);
    });
    groupRows.push(...accountGroupRows);
    if (refresh && groupResult.source === 'upstream') {
      await Promise.all(accountGroupRows.map((item) => upsertStoredGroupRow({
        row: item,
        sourceKey: `account:${row.accounts.id}`,
      })));
    }
  }

  for (const site of siteRows) {
    if (siteIdsWithAccounts.has(site.id)) continue;
    const groupResult = refresh ? await fetchPublicSiteGroups(site) : { groups: [], ratio: {}, source: 'default' as const };
    const siteGroupRows = createGroupRowsFromSite({
      site,
      groupResult,
      catalog: catalogBySiteId.get(site.id) || null,
    }).map((item) => withCatalogGroupModels(item, catalogBySiteId.get(site.id) || null));
    groupRows.push(...siteGroupRows);
    if (refresh && groupResult.source === 'upstream') {
      await Promise.all(siteGroupRows.map((item) => upsertStoredGroupRow({
        row: item,
        sourceKey: 'site',
      })));
    }
  }

  const storedGroupRows = await loadStoredGroupRows(tokensByAccountId);
  const mergedGroupRows = removeUnauthenticatedRowsForLoggedInSites(mergeGroupRows(groupRows, storedGroupRows));

  return {
    generatedAt: new Date().toISOString(),
    refreshed: refresh,
    summary: {
      accountCount: accounts.length,
      siteCount: new Set(mergedGroupRows.map((item) => item.site.id)).size,
      tokenCount: tokenRows.length,
      groupCount: new Set(mergedGroupRows.map((item) => `${item.site.id}:${item.group}`)).size,
      pricingAvailableCount: mergedGroupRows.filter((item) => item.pricingAvailable).length,
      groupErrorCount: mergedGroupRows.filter((item) => item.groupError).length,
    },
    accounts,
    groupRows: mergedGroupRows,
  };
}
