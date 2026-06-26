import Fastify, { type FastifyInstance } from 'fastify';
import { describe, expect, it, beforeAll, beforeEach, afterAll, vi } from 'vitest';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { mkdtempSync, rmSync } from 'node:fs';
import { and, eq, sql } from 'drizzle-orm';
import { mergeAccountExtraConfig } from '../../services/accountExtraConfig.js';
import { encryptAccountPassword } from '../../services/accountCredentialService.js';
import { waitForBackgroundTaskToReachTerminalState } from '../../test-fixtures/backgroundTaskTestUtils.js';

const getApiTokensMock = vi.fn();
const getApiTokenMock = vi.fn();
const createApiTokenMock = vi.fn();
const getUserGroupsMock = vi.fn();
const deleteApiTokenMock = vi.fn();
const loginMock = vi.fn();
const getModelsMock = vi.fn();
const fetchModelPricingCatalogMock = vi.fn();
const testAccountTokenModelAvailabilityMock = vi.fn();

type AccountTokenServiceModule = typeof import('../../services/accountTokenService.js');
type BackgroundTaskServiceModule = typeof import('../../services/backgroundTaskService.js');
type HealthCheckServiceModule = typeof import('../../services/accountTokenHealthCheckService.js');

vi.mock('../../services/platforms/index.js', () => ({
  getAdapter: () => ({
    login: (...args: unknown[]) => loginMock(...args),
    getApiTokens: (...args: unknown[]) => getApiTokensMock(...args),
    getApiToken: (...args: unknown[]) => getApiTokenMock(...args),
    createApiToken: (...args: unknown[]) => createApiTokenMock(...args),
    getUserGroups: (...args: unknown[]) => getUserGroupsMock(...args),
    deleteApiToken: (...args: unknown[]) => deleteApiTokenMock(...args),
    getModels: (...args: unknown[]) => getModelsMock(...args),
  }),
}));

vi.mock('../../services/modelPricingService.js', async () => {
  const actual = await vi.importActual<typeof import('../../services/modelPricingService.js')>('../../services/modelPricingService.js');
  return {
    ...actual,
    fetchModelPricingCatalog: (...args: unknown[]) => fetchModelPricingCatalogMock(...args),
  };
});

vi.mock('../../services/accountTokenAvailabilityTestService.js', async () => {
  const actual = await vi.importActual<typeof import('../../services/accountTokenAvailabilityTestService.js')>('../../services/accountTokenAvailabilityTestService.js');
  return {
    ...actual,
    testAccountTokenModelAvailability: (...args: unknown[]) => testAccountTokenModelAvailabilityMock(...args),
  };
});

type DbModule = typeof import('../../db/index.js');

describe('account tokens sync routes with site status', () => {
  let app: FastifyInstance;
  let db: DbModule['db'];
  let schema: DbModule['schema'];
  let maskToken: AccountTokenServiceModule['maskToken'];
  let getBackgroundTask: BackgroundTaskServiceModule['getBackgroundTask'];
  let resetBackgroundTasks: BackgroundTaskServiceModule['__resetBackgroundTasksForTests'];
  let runDueAccountTokenHealthChecks: HealthCheckServiceModule['runDueAccountTokenHealthChecks'];
  let dataDir = '';
  let previousDataDir: string | undefined;
  let seedId = 0;

  const nextSeed = () => {
    seedId += 1;
    return seedId;
  };

  async function waitForRouteChannel(input: { model: string; accountId: number; tokenId: number }) {
    const deadline = Date.now() + 4_000;
    let route: typeof schema.tokenRoutes.$inferSelect | undefined;
    while (Date.now() < deadline) {
      route = await db.select()
        .from(schema.tokenRoutes)
        .where(eq(schema.tokenRoutes.modelPattern, input.model))
        .get();
      if (route) {
        const channel = await db.select()
          .from(schema.routeChannels)
          .where(and(
            eq(schema.routeChannels.routeId, route.id),
            eq(schema.routeChannels.accountId, input.accountId),
            eq(schema.routeChannels.tokenId, input.tokenId),
          ))
          .get();
        if (channel) return { route, channel };
      }
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    return { route, channel: undefined };
  }

  async function persistMockedModelTestResults(results: Array<{
    tokenId: number;
    model: string;
    available: boolean;
    message: string;
    responseText?: string | null;
    httpStatus?: number | null;
    latencyMs?: number | null;
    checkedAt?: string;
  }>) {
    for (const result of results) {
      await db.insert(schema.tokenModelAvailability)
        .values({
          tokenId: result.tokenId,
          modelName: result.model,
          available: result.available,
          message: result.message,
          responseText: result.responseText ?? null,
          httpStatus: result.httpStatus ?? null,
          latencyMs: result.latencyMs ?? null,
          checkedAt: result.checkedAt || '2026-06-21T00:00:00.000Z',
        })
        .onConflictDoUpdate({
          target: [schema.tokenModelAvailability.tokenId, schema.tokenModelAvailability.modelName],
          set: {
            available: result.available,
            message: result.message,
            responseText: result.responseText ?? null,
            httpStatus: result.httpStatus ?? null,
            latencyMs: result.latencyMs ?? null,
            checkedAt: result.checkedAt || '2026-06-21T00:00:00.000Z',
          },
        })
        .run();
    }
  }

  const seedAccount = async (input: {
    siteStatus?: 'active' | 'disabled';
    accountStatus?: string;
    accessToken?: string | null;
    accountExtraConfig?: string | null;
  }) => {
    const id = nextSeed();
    const site = await db.insert(schema.sites).values({
      name: `site-${id}`,
      url: `https://site-${id}.example.com`,
      platform: 'new-api',
    }).returning().get();
    if (input.siteStatus === 'disabled') {
      await db.run(sql`update sites set status = 'disabled' where id = ${site.id}`);
    }

    const account = await db.insert(schema.accounts).values({
      siteId: site.id,
      username: `user-${id}`,
      accessToken: input.accessToken ?? `access-token-${id}`,
      status: input.accountStatus ?? 'active',
      extraConfig: input.accountExtraConfig ?? null,
    }).returning().get();

    return { site, account };
  };

  beforeAll(async () => {
    previousDataDir = process.env.DATA_DIR;
    dataDir = mkdtempSync(join(tmpdir(), 'metapi-account-tokens-sync-'));
    vi.resetModules();
    process.env.DATA_DIR = dataDir;
    vi.resetModules();

    await import('../../db/migrate.js');
    const dbModule = await import('../../db/index.js');
    const accountTokenServiceModule = await import('../../services/accountTokenService.js');
    const backgroundTaskServiceModule = await import('../../services/backgroundTaskService.js');
    const healthCheckServiceModule = await import('../../services/accountTokenHealthCheckService.js');
    const routesModule = await import('./accountTokens.js');
    db = dbModule.db;
    schema = dbModule.schema;
    maskToken = accountTokenServiceModule.maskToken;
    getBackgroundTask = backgroundTaskServiceModule.getBackgroundTask;
    resetBackgroundTasks = backgroundTaskServiceModule.__resetBackgroundTasksForTests;
    runDueAccountTokenHealthChecks = healthCheckServiceModule.runDueAccountTokenHealthChecks;

    app = Fastify();
    await app.register(routesModule.accountTokensRoutes);
  });

  beforeEach(async () => {
    getApiTokensMock.mockReset();
    getApiTokenMock.mockReset();
    createApiTokenMock.mockReset();
    getUserGroupsMock.mockReset();
    deleteApiTokenMock.mockReset();
    loginMock.mockReset();
    getModelsMock.mockReset();
    getModelsMock.mockResolvedValue(['gpt-5.5']);
    fetchModelPricingCatalogMock.mockReset();
    fetchModelPricingCatalogMock.mockResolvedValue(null);
    testAccountTokenModelAvailabilityMock.mockReset();
    testAccountTokenModelAvailabilityMock.mockImplementation(async (options: { model: string; tokenIds: number[] }) => ({
      model: options.model,
      total: options.tokenIds.length,
      results: await (async () => {
        const results = options.tokenIds.map((tokenId) => ({
        tokenId,
        model: options.model,
        available: true,
        message: '请求成功',
        responseText: '我是测试模型',
        httpStatus: 200,
        latencyMs: 12,
        checkedAt: '2026-06-21T00:00:00.000Z',
        }));
        await persistMockedModelTestResults(results);
        return results;
      })(),
    }));
    resetBackgroundTasks();
    seedId = 0;

    await db.delete(schema.events).run();
    await db.delete(schema.accountTokenGroupPreferences).run();
    await db.delete(schema.accountTokens).run();
    await db.delete(schema.routeChannels).run();
    await db.delete(schema.tokenRoutes).run();
    await db.delete(schema.tokenModelAvailability).run();
    await db.delete(schema.modelAvailability).run();
    await db.delete(schema.checkinLogs).run();
    await db.delete(schema.accounts).run();
    await db.delete(schema.sites).run();
  });

  afterAll(async () => {
    await app.close();
    if (previousDataDir === undefined) {
      delete process.env.DATA_DIR;
    } else {
      process.env.DATA_DIR = previousDataDir;
    }
    rmSync(dataDir, { recursive: true, force: true });
  });

  it('returns skipped for single-account sync when site is disabled', async () => {
    const { account } = await seedAccount({ siteStatus: 'disabled' });

    const response = await app.inject({
      method: 'POST',
      url: `/api/account-tokens/sync/${account.id}`,
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({
      success: true,
      synced: false,
      status: 'skipped',
      reason: 'site_disabled',
    });
    expect(getApiTokensMock).not.toHaveBeenCalled();
    expect(getApiTokenMock).not.toHaveBeenCalled();
  });

  it('returns skipped when upstream has no api tokens', async () => {
    const { account } = await seedAccount({ siteStatus: 'active' });
    getApiTokensMock.mockResolvedValue([]);
    getApiTokenMock.mockResolvedValue(null);

    const response = await app.inject({
      method: 'POST',
      url: `/api/account-tokens/sync/${account.id}`,
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({
      success: true,
      synced: false,
      status: 'skipped',
      reason: 'no_upstream_tokens',
    });

    const tokenRows = await db.select()
      .from(schema.accountTokens)
      .where(eq(schema.accountTokens.accountId, account.id))
      .all();
    expect(tokenRows.length).toBe(0);
  });

  it('clears local account tokens when upstream returns an empty token list', async () => {
    const { account } = await seedAccount({ siteStatus: 'active' });
    const staleToken = await db.insert(schema.accountTokens).values({
      accountId: account.id,
      name: 'default',
      token: 'sk-local-default-only',
      source: 'legacy',
      enabled: true,
      isDefault: true,
      tokenGroup: 'default',
      valueStatus: 'ready' as any,
    }).returning().get();
    const route = await db.insert(schema.tokenRoutes).values({
      modelPattern: 'gpt-5.5',
      enabled: true,
    }).returning().get();
    await db.insert(schema.routeChannels).values({
      routeId: route.id,
      accountId: account.id,
      tokenId: staleToken.id,
      enabled: true,
    }).run();
    getApiTokensMock.mockResolvedValue([]);
    getApiTokenMock.mockResolvedValue('sk-account-level-fallback');

    const response = await app.inject({
      method: 'POST',
      url: `/api/account-tokens/sync/${account.id}`,
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({
      success: true,
      synced: true,
      status: 'synced',
      reason: 'no_upstream_tokens',
      deleted: 1,
    });

    const tokenRows = await db.select()
      .from(schema.accountTokens)
      .where(eq(schema.accountTokens.accountId, account.id))
      .all();
    expect(tokenRows).toHaveLength(0);
    expect(await db.select().from(schema.routeChannels).all()).toHaveLength(0);
  });

  it('stores masked upstream token values as masked_pending placeholders', async () => {
    const { account } = await seedAccount({ siteStatus: 'active' });
    getApiTokensMock.mockResolvedValue([
      { name: 'masked-only', key: 'sk-abc***xyz', enabled: true },
    ]);
    getApiTokenMock.mockResolvedValue(null);

    const response = await app.inject({
      method: 'POST',
      url: `/api/account-tokens/sync/${account.id}`,
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({
      success: true,
      synced: true,
      status: 'synced',
      reason: 'upstream_masked_tokens',
      maskedPending: 1,
      pendingTokenIds: [expect.any(Number)],
      total: 1,
      created: 1,
      updated: 0,
    });

    const tokenRows = await db.select()
      .from(schema.accountTokens)
      .where(eq(schema.accountTokens.accountId, account.id))
      .all();
    expect(tokenRows).toHaveLength(1);
    expect(tokenRows[0]).toMatchObject({
      name: 'masked-only',
      token: 'sk-abc***xyz',
      source: 'sync',
      enabled: false,
      isDefault: false,
    });
    expect((tokenRows[0] as any).valueStatus).toBe('masked_pending');

    const owner = await db.select()
      .from(schema.accounts)
      .where(eq(schema.accounts.id, account.id))
      .get();
    expect(owner?.apiToken ?? null).toBeNull();

    const listResponse = await app.inject({
      method: 'GET',
      url: '/api/account-tokens',
    });
    expect(listResponse.statusCode).toBe(200);
    expect(listResponse.json()).toMatchObject([
      expect.objectContaining({
        id: tokenRows[0].id,
        valueStatus: 'masked_pending',
      }),
    ]);
  });

  it('reuses an existing ready token when upstream only returns the matching masked token', async () => {
    const { account } = await seedAccount({ siteStatus: 'active' });
    const fullToken = 'sk-real-token-1234';
    await db.insert(schema.accountTokens).values({
      accountId: account.id,
      name: 'masked-only',
      token: fullToken,
      source: 'manual',
      enabled: true,
      isDefault: true,
      tokenGroup: 'default',
      valueStatus: 'ready' as any,
    }).run();

    getApiTokensMock.mockResolvedValue([
      { name: 'masked-only', key: maskToken(fullToken), enabled: true, tokenGroup: 'default' },
    ]);
    getApiTokenMock.mockResolvedValue(null);

    const response = await app.inject({
      method: 'POST',
      url: `/api/account-tokens/sync/${account.id}`,
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({
      success: true,
      synced: true,
      status: 'synced',
      created: 0,
      updated: 1,
      maskedPending: 0,
      total: 1,
    });

    const tokenRows = await db.select()
      .from(schema.accountTokens)
      .where(eq(schema.accountTokens.accountId, account.id))
      .all();
    expect(tokenRows).toHaveLength(1);
    expect(tokenRows[0]).toMatchObject({
      name: 'masked-only',
      token: fullToken,
      source: 'sync',
      enabled: true,
      isDefault: true,
      tokenGroup: 'default',
    });
    expect((tokenRows[0] as any).valueStatus).toBe('ready');
  });

  it('updates numeric token names and groups to upstream Chinese group names when reusing masked tokens', async () => {
    const { site, account } = await seedAccount({ siteStatus: 'active' });
    const fullToken = 'sk-real-token-1234';
    await db.insert(schema.tokenGroupPricing).values({
      siteId: site.id,
      accountId: account.id,
      sourceKey: `account:${account.id}`,
      group: '2',
      groupName: '纯pro倍率',
      ratio: 1.5,
      source: 'upstream',
      pricingAvailable: true,
    }).run();
    await db.insert(schema.accountTokens).values({
      accountId: account.id,
      name: '2',
      token: fullToken,
      source: 'manual',
      enabled: true,
      isDefault: true,
      tokenGroup: '2',
      valueStatus: 'ready' as any,
    }).run();

    getApiTokensMock.mockResolvedValue([
      { name: '纯pro倍率', key: maskToken(fullToken), enabled: true, tokenGroup: '纯pro倍率' },
    ]);
    getApiTokenMock.mockResolvedValue(null);

    const response = await app.inject({
      method: 'POST',
      url: `/api/account-tokens/sync/${account.id}`,
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({
      success: true,
      synced: true,
      status: 'synced',
      created: 0,
      updated: 1,
      maskedPending: 0,
      total: 1,
    });

    const tokenRows = await db.select()
      .from(schema.accountTokens)
      .where(eq(schema.accountTokens.accountId, account.id))
      .all();
    expect(tokenRows).toHaveLength(1);
    expect(tokenRows[0]).toMatchObject({
      name: '纯pro倍率',
      token: fullToken,
      source: 'sync',
      enabled: true,
      isDefault: true,
      tokenGroup: '纯pro倍率',
    });
    expect((tokenRows[0] as any).valueStatus).toBe('ready');
  });

  it('shows group ratio for tokens matched by stored Chinese group name aliases', async () => {
    const { site, account } = await seedAccount({ siteStatus: 'active' });
    await db.insert(schema.tokenGroupPricing).values({
      siteId: site.id,
      accountId: account.id,
      sourceKey: `account:${account.id}`,
      group: '2',
      groupName: '纯pro倍率',
      ratio: 2.5,
      source: 'upstream',
      pricingAvailable: true,
    }).run();
    await db.insert(schema.accountTokens).values({
      accountId: account.id,
      name: '纯pro倍率',
      token: 'sk-real-token-1234',
      source: 'sync',
      enabled: true,
      isDefault: true,
      tokenGroup: '纯pro倍率',
      valueStatus: 'ready' as any,
    }).run();

    const response = await app.inject({
      method: 'GET',
      url: '/api/account-tokens',
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual([
      expect.objectContaining({
        name: '纯pro倍率',
        groupRatio: 2.5,
        groupRatioAvailable: true,
      }),
    ]);
  });

  it('keeps stored account group ratios without fetching the public pricing catalog', async () => {
    const { site, account } = await seedAccount({ siteStatus: 'active' });
    await db.insert(schema.tokenGroupPricing).values({
      siteId: site.id,
      accountId: account.id,
      sourceKey: `account:${account.id}`,
      group: '生图专用分组',
      ratio: 0.9,
      source: 'upstream',
      pricingAvailable: true,
    }).run();
    await db.insert(schema.accountTokens).values({
      accountId: account.id,
      name: '生图专用分组',
      token: 'sk-image-token-1234',
      source: 'sync',
      enabled: true,
      isDefault: true,
      tokenGroup: '生图专用分组',
      valueStatus: 'ready' as any,
    }).run();

    fetchModelPricingCatalogMock.mockResolvedValue({
      models: [],
      groupRatio: {
        '生图专用分组': 1,
        default: 1,
      },
    });

    const response = await app.inject({
      method: 'GET',
      url: '/api/account-tokens',
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual([
      expect.objectContaining({
        name: '生图专用分组',
        groupRatio: 0.9,
        groupRatioAvailable: true,
        tokenGroupRatioGroup: '生图专用分组',
      }),
    ]);
    expect(fetchModelPricingCatalogMock).not.toHaveBeenCalled();
  });

  it('uses stored numeric group aliases to show ratios for synced tokens', async () => {
    const { site, account } = await seedAccount({ siteStatus: 'active' });
    await db.insert(schema.tokenGroupPricing).values({
      siteId: site.id,
      accountId: account.id,
      sourceKey: `account:${account.id}`,
      group: '2',
      groupName: '纯pro倍率',
      ratio: 2.5,
      source: 'upstream',
      pricingAvailable: true,
    }).run();
    await db.insert(schema.accountTokens).values({
      accountId: account.id,
      name: 'team渠道',
      token: 'sk-team-token-1234',
      source: 'sync',
      enabled: true,
      isDefault: true,
      tokenGroup: '2',
      valueStatus: 'ready' as any,
    }).run();

    const response = await app.inject({
      method: 'GET',
      url: '/api/account-tokens',
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual([
      expect.objectContaining({
        name: 'team渠道',
        tokenGroup: '2',
        groupRatio: 2.5,
        groupRatioAvailable: true,
        tokenGroupRatioGroup: '纯pro倍率',
      }),
    ]);
  });

  it('matches short latin group prefixes from token names when numeric token group ids are stale', async () => {
    const { site, account } = await seedAccount({ siteStatus: 'active' });
    await db.insert(schema.tokenGroupPricing).values({
      siteId: site.id,
      accountId: account.id,
      sourceKey: `account:${account.id}`,
      group: 'pro',
      groupName: 'pro',
      ratio: 0.25,
      source: 'upstream',
      pricingAvailable: true,
    }).run();
    await db.insert(schema.accountTokens).values({
      accountId: account.id,
      name: 'pro包稳不可能掉',
      token: 'sk-pro-token-1234',
      source: 'sync',
      enabled: true,
      isDefault: true,
      tokenGroup: '14',
      valueStatus: 'ready' as any,
    }).run();

    const response = await app.inject({
      method: 'GET',
      url: '/api/account-tokens',
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual([
      expect.objectContaining({
        name: 'pro包稳不可能掉',
        tokenGroup: '14',
        groupRatio: 0.25,
        groupRatioAvailable: true,
        tokenGroupRatioGroup: 'pro',
      }),
    ]);
  });

  it('matches short Chinese group prefixes from token names when numeric token group ids are stale', async () => {
    const { site, account } = await seedAccount({ siteStatus: 'active' });
    await db.insert(schema.tokenGroupPricing).values({
      siteId: site.id,
      accountId: account.id,
      sourceKey: `account:${account.id}`,
      group: '生图',
      groupName: '生图',
      ratio: 0.12,
      source: 'upstream',
      pricingAvailable: true,
    }).run();
    await db.insert(schema.accountTokens).values({
      accountId: account.id,
      name: '生图-adobe原生4k',
      token: 'sk-image-token-1234',
      source: 'sync',
      enabled: true,
      isDefault: true,
      tokenGroup: '16',
      valueStatus: 'ready' as any,
    }).run();

    const response = await app.inject({
      method: 'GET',
      url: '/api/account-tokens',
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual([
      expect.objectContaining({
        name: '生图-adobe原生4k',
        tokenGroup: '16',
        groupRatio: 0.12,
        groupRatioAvailable: true,
        tokenGroupRatioGroup: '生图',
      }),
    ]);
  });

  it('matches stored group ratios when the token group adds an unambiguous suffix', async () => {
    const { site, account } = await seedAccount({ siteStatus: 'active' });
    await db.insert(schema.tokenGroupPricing).values([
      {
        siteId: site.id,
        accountId: account.id,
        sourceKey: `account:${account.id}`,
        group: 'AWS',
        ratio: 3,
        source: 'upstream',
        pricingAvailable: true,
      },
      {
        siteId: site.id,
        accountId: account.id,
        sourceKey: `account:${account.id}`,
        group: 'AWS-Platform',
        ratio: 2,
        source: 'upstream',
        pricingAvailable: true,
      },
    ]).run();
    await db.insert(schema.accountTokens).values({
      accountId: account.id,
      name: 'AWS-Platform-夜间',
      token: 'sk-aws-platform-night',
      source: 'sync',
      enabled: true,
      isDefault: true,
      tokenGroup: 'AWS-Platform-夜间',
      valueStatus: 'ready' as any,
    }).run();

    const response = await app.inject({
      method: 'GET',
      url: '/api/account-tokens',
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual([
      expect.objectContaining({
        name: 'AWS-Platform-夜间',
        groupRatio: 2,
        groupRatioAvailable: true,
        tokenGroupRatioGroup: 'AWS-Platform',
      }),
    ]);
  });

  it('does not guess stored group ratios when the longest suffix match is ambiguous', async () => {
    const { site, account } = await seedAccount({ siteStatus: 'active' });
    await db.insert(schema.tokenGroupPricing).values([
      {
        siteId: site.id,
        accountId: account.id,
        sourceKey: `account:${account.id}`,
        group: 'Plus',
        groupName: 'Plus',
        ratio: 0.1,
        source: 'upstream',
        pricingAvailable: true,
      },
      {
        siteId: site.id,
        accountId: account.id,
        sourceKey: `account:${account.id}`,
        group: 'plus',
        groupName: 'plus',
        ratio: 0.2,
        source: 'upstream',
        pricingAvailable: true,
      },
    ]).run();
    await db.insert(schema.accountTokens).values({
      accountId: account.id,
      name: 'Plus夜间',
      token: 'sk-plus-night',
      source: 'sync',
      enabled: true,
      isDefault: true,
      tokenGroup: 'Plus夜间',
      valueStatus: 'ready' as any,
    }).run();

    const response = await app.inject({
      method: 'GET',
      url: '/api/account-tokens',
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual([
      expect.objectContaining({
        name: 'Plus夜间',
        groupRatio: null,
        groupRatioAvailable: false,
        tokenGroupRatioGroup: null,
      }),
    ]);
  });

  it('deletes local tokens that are no longer present upstream and removes their route channels', async () => {
    const { account } = await seedAccount({ siteStatus: 'active' });
    const staleToken = await db.insert(schema.accountTokens).values({
      accountId: account.id,
      name: 'stale',
      token: 'sk-stale-token',
      source: 'sync',
      enabled: true,
      isDefault: false,
      tokenGroup: 'stale',
      valueStatus: 'ready' as any,
    }).returning().get();
    await db.insert(schema.accountTokens).values({
      accountId: account.id,
      name: 'kept',
      token: 'sk-kept-token',
      source: 'sync',
      enabled: true,
      isDefault: true,
      tokenGroup: 'kept',
      valueStatus: 'ready' as any,
    }).run();
    const route = await db.insert(schema.tokenRoutes).values({
      modelPattern: 'gpt-5.5',
      enabled: true,
    }).returning().get();
    await db.insert(schema.routeChannels).values({
      routeId: route.id,
      accountId: account.id,
      tokenId: staleToken.id,
      enabled: true,
    }).run();

    getApiTokensMock.mockResolvedValue([
      { name: 'kept', key: 'sk-kept-token', enabled: true, tokenGroup: 'kept' },
    ]);
    getApiTokenMock.mockResolvedValue(null);

    const response = await app.inject({
      method: 'POST',
      url: `/api/account-tokens/sync/${account.id}`,
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({
      success: true,
      synced: true,
      status: 'synced',
      deleted: 1,
    });

    const tokenRows = await db.select()
      .from(schema.accountTokens)
      .where(eq(schema.accountTokens.accountId, account.id))
      .all();
    expect(tokenRows.map((row) => row.name)).toEqual(['kept']);
    const routeChannels = await db.select().from(schema.routeChannels).all();
    expect(routeChannels.some((row) => row.tokenId === staleToken.id)).toBe(false);
  });

  it('keeps manual group enabled preferences across upstream sync and removes disabled route channels', async () => {
    const { site, account } = await seedAccount({ siteStatus: 'active' });
    const token = await db.insert(schema.accountTokens).values({
      accountId: account.id,
      name: 'pro-token',
      token: 'sk-pro-token',
      source: 'sync',
      enabled: true,
      isDefault: true,
      tokenGroup: 'pro',
      valueStatus: 'ready' as any,
    }).returning().get();
    await db.insert(schema.tokenGroupPricing).values({
      siteId: site.id,
      accountId: account.id,
      sourceKey: `account:${account.id}`,
      group: 'pro',
      groupName: 'pro',
      ratio: 0.05,
      source: 'upstream',
      pricingAvailable: true,
    }).run();
    await db.insert(schema.accountTokenGroupPreferences).values({
      accountId: account.id,
      tokenGroup: 'pro',
      groupRatio: 0.05,
      groupRatioKey: '0.05',
      enabled: false,
    }).run();
    const route = await db.insert(schema.tokenRoutes).values({
      modelPattern: 'gpt-5.5',
      enabled: true,
    }).returning().get();
    await db.insert(schema.routeChannels).values({
      routeId: route.id,
      accountId: account.id,
      tokenId: token.id,
      enabled: true,
    }).run();

    getApiTokensMock.mockResolvedValue([
      { name: 'pro-token', key: 'sk-pro-token', enabled: true, tokenGroup: 'pro' },
    ]);
    getApiTokenMock.mockResolvedValue(null);

    const response = await app.inject({
      method: 'POST',
      url: `/api/account-tokens/sync/${account.id}`,
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({
      success: true,
      synced: true,
      status: 'synced',
    });

    const tokenRows = await db.select()
      .from(schema.accountTokens)
      .where(eq(schema.accountTokens.accountId, account.id))
      .all();
    expect(tokenRows).toHaveLength(1);
    expect(tokenRows[0]).toMatchObject({
      name: 'pro-token',
      enabled: false,
      tokenGroup: 'pro',
    });
    expect(await db.select().from(schema.routeChannels).all()).toHaveLength(0);

    const listResponse = await app.inject({
      method: 'GET',
      url: '/api/account-tokens',
    });
    expect(listResponse.statusCode).toBe(200);
    expect(listResponse.json()).toEqual([
      expect.objectContaining({
        name: 'pro-token',
        enabled: false,
        groupRatio: 0.05,
        enabledPreference: expect.objectContaining({
          enabled: false,
          source: 'manual',
          groupRatio: 0.05,
        }),
      }),
    ]);
  });

  it('removes matching masked_pending placeholders after reusing a ready token', async () => {
    const { account } = await seedAccount({ siteStatus: 'active' });
    const fullToken = 'sk-real-token-1234';
    const maskedToken = maskToken(fullToken);

    await db.insert(schema.accountTokens).values({
      accountId: account.id,
      name: 'masked-only',
      token: fullToken,
      source: 'manual',
      enabled: true,
      isDefault: true,
      tokenGroup: 'default',
      valueStatus: 'ready' as any,
    }).run();
    await db.insert(schema.accountTokens).values({
      accountId: account.id,
      name: 'masked-only',
      token: maskedToken,
      source: 'sync',
      enabled: false,
      isDefault: false,
      tokenGroup: 'default',
      valueStatus: 'masked_pending' as any,
    }).run();

    getApiTokensMock.mockResolvedValue([
      { name: 'masked-only', key: maskedToken, enabled: true, tokenGroup: 'default' },
    ]);
    getApiTokenMock.mockResolvedValue(null);

    const response = await app.inject({
      method: 'POST',
      url: `/api/account-tokens/sync/${account.id}`,
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({
      success: true,
      synced: true,
      status: 'synced',
      created: 0,
      updated: 1,
      maskedPending: 0,
      total: 1,
    });

    const tokenRows = await db.select()
      .from(schema.accountTokens)
      .where(eq(schema.accountTokens.accountId, account.id))
      .all();
    expect(tokenRows).toHaveLength(1);
    expect(tokenRows[0]).toMatchObject({
      name: 'masked-only',
      token: fullToken,
      source: 'sync',
      enabled: true,
      isDefault: true,
      tokenGroup: 'default',
    });
    expect((tokenRows[0] as any).valueStatus).toBe('ready');
  });

  it('does not reuse a different ready token when another logical token shares the same masked value', async () => {
    const { account } = await seedAccount({ siteStatus: 'active' });
    const firstFullToken = 'sk-real-token-1234';
    const secondFullToken = 'sk-real-zzzzz-1234';
    const sharedMaskedToken = maskToken(firstFullToken);

    expect(maskToken(secondFullToken)).toBe(sharedMaskedToken);

    await db.insert(schema.accountTokens).values({
      accountId: account.id,
      name: 'first-token',
      token: firstFullToken,
      source: 'manual',
      enabled: true,
      isDefault: true,
      tokenGroup: 'default',
      valueStatus: 'ready' as any,
    }).run();
    await db.insert(schema.accountTokens).values({
      accountId: account.id,
      name: 'second-token',
      token: sharedMaskedToken,
      source: 'sync',
      enabled: false,
      isDefault: false,
      tokenGroup: 'default',
      valueStatus: 'masked_pending' as any,
    }).run();

    getApiTokensMock.mockResolvedValue([
      { name: 'second-token', key: sharedMaskedToken, enabled: true, tokenGroup: 'default' },
    ]);
    getApiTokenMock.mockResolvedValue(null);

    const response = await app.inject({
      method: 'POST',
      url: `/api/account-tokens/sync/${account.id}`,
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({
      success: true,
      synced: true,
      status: 'synced',
      created: 0,
      updated: 1,
      maskedPending: 1,
      total: 2,
    });

    const tokenRows = await db.select()
      .from(schema.accountTokens)
      .where(eq(schema.accountTokens.accountId, account.id))
      .all();
    expect(tokenRows).toHaveLength(1);
    expect(tokenRows.find((row) => row.token === firstFullToken)).toBeUndefined();
    const maskedRow = tokenRows.find((row) => row.name === 'second-token');
    expect(maskedRow).toMatchObject({
      token: sharedMaskedToken,
      source: 'sync',
      enabled: false,
      isDefault: false,
      tokenGroup: 'default',
    });
    expect((maskedRow as any)?.valueStatus).toBe('masked_pending');
  });

  it('keeps fully ambiguous short masks as masked_pending instead of reusing a ready token', async () => {
    const { account } = await seedAccount({ siteStatus: 'active' });
    const fullToken = 'sk-abcd';
    await db.insert(schema.accountTokens).values({
      accountId: account.id,
      name: 'short-token',
      token: fullToken,
      source: 'manual',
      enabled: true,
      isDefault: true,
      tokenGroup: 'default',
      valueStatus: 'ready' as any,
    }).run();

    getApiTokensMock.mockResolvedValue([
      { name: 'short-token', key: maskToken(fullToken), enabled: true, tokenGroup: 'default' },
    ]);
    getApiTokenMock.mockResolvedValue(null);

    const response = await app.inject({
      method: 'POST',
      url: `/api/account-tokens/sync/${account.id}`,
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({
      success: true,
      synced: true,
      status: 'synced',
      reason: 'upstream_masked_tokens',
      created: 1,
      updated: 0,
      maskedPending: 1,
      total: 2,
    });

    const tokenRows = await db.select()
      .from(schema.accountTokens)
      .where(eq(schema.accountTokens.accountId, account.id))
      .all();
    expect(tokenRows).toHaveLength(2);
    expect(tokenRows.find((row) => row.token === fullToken)).toBeDefined();
    const maskedRow = tokenRows.find((row) => row.token === 'sk-***');
    expect(maskedRow).toMatchObject({
      name: 'short-token',
      source: 'sync',
      enabled: false,
      isDefault: false,
      tokenGroup: 'default',
    });
    expect((maskedRow as any)?.valueStatus).toBe('masked_pending');
  });

  it('rejects sync and token management for apikey connections', async () => {
    const { account } = await seedAccount({ siteStatus: 'active', accessToken: '' });
    await db.update(schema.accounts)
      .set({
        apiToken: 'sk-proxy-only',
        checkinEnabled: false,
        extraConfig: mergeAccountExtraConfig(null, { credentialMode: 'apikey' }),
      })
      .where(eq(schema.accounts.id, account.id))
      .run();

    const syncResponse = await app.inject({
      method: 'POST',
      url: `/api/account-tokens/sync/${account.id}`,
    });
    expect(syncResponse.statusCode).toBe(400);
    expect(syncResponse.json()).toMatchObject({
      success: false,
      message: 'API Key 连接不支持同步账号令牌',
    });

    const createResponse = await app.inject({
      method: 'POST',
      url: '/api/account-tokens',
      payload: {
        accountId: account.id,
        name: 'should-fail',
      },
    });
    expect(createResponse.statusCode).toBe(400);
    expect(createResponse.json()).toMatchObject({
      success: false,
      message: 'API Key 连接不支持创建账号令牌',
    });

    const groupsResponse = await app.inject({
      method: 'GET',
      url: `/api/account-tokens/groups/${account.id}`,
    });
    expect(groupsResponse.statusCode).toBe(400);
    expect(groupsResponse.json()).toMatchObject({
      success: false,
      message: 'API Key 连接不支持拉取账号令牌分组',
    });
  });

  it('hides legacy mirrored tokens for apikey connections from list API', async () => {
    const { account } = await seedAccount({ siteStatus: 'active', accessToken: '' });
    await db.update(schema.accounts)
      .set({
        apiToken: 'sk-hidden-legacy',
        checkinEnabled: false,
        extraConfig: mergeAccountExtraConfig(null, { credentialMode: 'apikey' }),
      })
      .where(eq(schema.accounts.id, account.id))
      .run();

    await db.insert(schema.accountTokens).values({
      accountId: account.id,
      name: 'default',
      token: 'sk-hidden-legacy',
      enabled: true,
      isDefault: true,
    }).run();

    const response = await app.inject({
      method: 'GET',
      url: '/api/account-tokens',
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual([]);
  });

  it('loads token group ratios from stored account pricing only', async () => {
    const { site, account } = await seedAccount({ siteStatus: 'active' });
    await db.update(schema.sites)
      .set({ platform: 'sub2api' })
      .where(eq(schema.sites.id, site.id))
      .run();
    await db.insert(schema.tokenGroupPricing).values([
      {
        siteId: site.id,
        accountId: account.id,
        sourceKey: `account:${account.id}`,
        group: '生图（1k）',
        ratio: 0.12,
        source: 'upstream',
        pricingAvailable: true,
      },
      {
        siteId: site.id,
        accountId: account.id,
        sourceKey: `account:${account.id}`,
        group: '生图（2k4k）',
        ratio: 0.25,
        source: 'upstream',
        pricingAvailable: true,
      },
    ]).run();

    await db.insert(schema.accountTokens).values([
      {
        accountId: account.id,
        name: '生图-1k',
        token: 'sk-image-1k',
        tokenGroup: '生图-1k',
        enabled: true,
        isDefault: true,
      },
      {
        accountId: account.id,
        name: '生图-2k4k',
        token: 'sk-image-2k4k',
        tokenGroup: '生图-2k4k',
        enabled: true,
        isDefault: false,
      },
    ]).run();

    fetchModelPricingCatalogMock.mockResolvedValue({
      models: [],
      groupRatio: {
        '生图（1k）': 0.12,
        '生图（2k4k）': 0.25,
        default: 1,
      },
    });

    const response = await app.inject({
      method: 'GET',
      url: '/api/account-tokens',
    });

    expect(response.statusCode).toBe(200);
    const body = response.json() as Array<{
      name: string;
      tokenGroupRatio: number | null;
      tokenGroupRatioGroup: string | null;
    }>;
    expect(body).toEqual([
      expect.objectContaining({
        name: '生图-1k',
        tokenGroupRatio: 0.12,
        tokenGroupRatioGroup: '生图（1k）',
      }),
      expect.objectContaining({
        name: '生图-2k4k',
        tokenGroupRatio: 0.25,
        tokenGroupRatioGroup: '生图（2k4k）',
      }),
    ]);
    expect(fetchModelPricingCatalogMock).not.toHaveBeenCalled();
  });

  it('sync-all activates expired accounts before syncing and still skips disabled-site accounts', async () => {
    const disabled = await seedAccount({ siteStatus: 'disabled' });
    const expired = await seedAccount({ siteStatus: 'active', accountStatus: 'expired', accountExtraConfig: JSON.stringify({
      autoRelogin: {
        username: 'admin',
        passwordCipher: encryptAccountPassword('plain-password'),
      },
    }) });

    loginMock.mockResolvedValue({
      success: true,
      accessToken: 'refreshed-access-token',
    });
    getApiTokensMock.mockResolvedValue([
      { name: 'default', key: 'sk-synced-token', enabled: true },
    ]);

    const response = await app.inject({
      method: 'POST',
      url: '/api/account-tokens/sync-all',
      payload: { wait: true },
    });

    expect(response.statusCode).toBe(200);

    const body = response.json() as {
      success: boolean;
      summary: {
        total: number;
        synced: number;
        skipped: number;
        failed: number;
      };
      results: Array<{ accountId: number; status: string; reason?: string; synced?: boolean }>;
    };

    expect(body.success).toBe(true);
    expect(body.summary).toMatchObject({
      total: 2,
      synced: 1,
      skipped: 1,
      failed: 0,
    });

    const skipped = body.results.find((item) => item.accountId === disabled.account.id);
    const synced = body.results.find((item) => item.accountId === expired.account.id);

    expect(skipped).toMatchObject({
      accountId: disabled.account.id,
      status: 'skipped',
      reason: 'site_disabled',
    });
    expect(synced).toMatchObject({
      accountId: expired.account.id,
      status: 'synced',
      synced: true,
    });

    expect(loginMock).toHaveBeenCalledTimes(1);

    const syncedTokens = await db.select()
      .from(schema.accountTokens)
      .where(eq(schema.accountTokens.accountId, expired.account.id))
      .all();
    expect(syncedTokens).toHaveLength(1);
    expect(syncedTokens[0]).toMatchObject({
      token: 'sk-synced-token',
      enabled: false,
      isDefault: false,
    });
  });

  it('activates expired account before deleting all upstream tokens', async () => {
    const { account } = await seedAccount({
      siteStatus: 'active',
      accountStatus: 'expired',
      accountExtraConfig: JSON.stringify({
        autoRelogin: {
          username: 'admin',
        passwordCipher: encryptAccountPassword('plain-password'),
        },
      }),
    });
    await db.insert(schema.accountTokens).values([
      {
        accountId: account.id,
        name: 'token-a',
        token: 'sk-token-a',
        source: 'sync',
        enabled: true,
      },
      {
        accountId: account.id,
        name: 'token-b',
        token: 'sk-token-b',
        source: 'sync',
        enabled: true,
      },
    ]).run();
    getApiTokensMock.mockResolvedValue([
      { name: 'token-a', key: 'sk-token-a', enabled: true },
      { name: 'token-b', key: 'sk-token-b', enabled: true },
    ]);
    loginMock.mockResolvedValue({
      success: true,
      accessToken: 'refreshed-access-token',
    });
    deleteApiTokenMock.mockResolvedValue(true);

    const response = await app.inject({
      method: 'POST',
      url: `/api/account-tokens/delete-upstream/${account.id}`,
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({
      success: true,
      status: 'deleted',
      deleted: 2,
      total: 2,
    });

    expect(loginMock).toHaveBeenCalledTimes(1);
    const remaining = await db.select().from(schema.accountTokens).where(eq(schema.accountTokens.accountId, account.id)).all();
    expect(remaining).toHaveLength(0);
    expect(deleteApiTokenMock).toHaveBeenCalledTimes(2);
  });

  it('rejects non-boolean wait when syncing all account tokens', async () => {
    const response = await app.inject({
      method: 'POST',
      url: '/api/account-tokens/sync-all',
      payload: {
        wait: 'true',
      },
    });

    expect(response.statusCode).toBe(400);
    expect(response.json()).toMatchObject({
      success: false,
      message: 'Invalid wait. Expected boolean.',
    });
  });

  it('creates all groups then syncs all account tokens in the combined flow', async () => {
    const { account } = await seedAccount({ siteStatus: 'active' });
    getUserGroupsMock.mockResolvedValue(['default']);
    getApiTokensMock.mockResolvedValue([
      { name: 'default', key: 'sk-combined-token', enabled: true },
    ]);

    const response = await app.inject({
      method: 'POST',
      url: '/api/account-tokens/groups/ensure-all-sync-all',
      payload: { wait: true },
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({
      success: true,
      ensureResult: expect.objectContaining({
        summary: expect.objectContaining({
          synced: 1,
        }),
      }),
      syncResult: expect.objectContaining({
        summary: expect.objectContaining({
          synced: 1,
        }),
      }),
    });

    expect(getUserGroupsMock).toHaveBeenCalledTimes(1);
    expect(getApiTokensMock).toHaveBeenCalledTimes(2);
    const tokenRows = await db.select().from(schema.accountTokens).where(eq(schema.accountTokens.accountId, account.id)).all();
    expect(tokenRows.some((row) => row.token === 'sk-combined-token')).toBe(true);
  });

  it('returns the refreshed default state after creating the first manual token', async () => {
    const { account } = await seedAccount({ siteStatus: 'active' });

    const response = await app.inject({
      method: 'POST',
      url: '/api/account-tokens',
      payload: {
        accountId: account.id,
        name: 'manual-default',
        token: 'sk-manual-default-token',
      },
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({
      success: true,
      token: expect.objectContaining({
        name: 'manual-default',
        isDefault: true,
        enabled: true,
      }),
    });
  });

  it('creates token via upstream api and syncs into local store when manual token is omitted', async () => {
    const { account, site } = await seedAccount({ siteStatus: 'active' });
    createApiTokenMock.mockResolvedValue(true);
    getApiTokensMock.mockResolvedValue([
      { name: 'created-from-upstream', key: 'sk-created-upstream-token', enabled: true },
    ]);

    const response = await app.inject({
      method: 'POST',
      url: '/api/account-tokens',
      payload: {
        accountId: account.id,
        name: 'created-from-upstream',
      },
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({
      success: true,
      createdViaUpstream: true,
      synced: true,
      status: 'synced',
    });
    expect(createApiTokenMock).toHaveBeenCalledTimes(1);
    expect(createApiTokenMock.mock.calls[0][0]).toBe(site.url);
    expect(createApiTokenMock.mock.calls[0][1]).toBe(account.accessToken);

    const tokenRows = await db.select()
      .from(schema.accountTokens)
      .where(eq(schema.accountTokens.accountId, account.id))
      .all();

    expect(tokenRows.length).toBe(1);
    expect(tokenRows[0].name).toBe('created-from-upstream');
    expect(tokenRows[0].token).toBe('sk-created-upstream-token');
    expect(tokenRows[0].source).toBe('sync');
  });

  it('selects the captured upstream-created token as the new default', async () => {
    const { account } = await seedAccount({ siteStatus: 'active' });
    await db.insert(schema.accountTokens).values({
      accountId: account.id,
      name: 'old-default',
      token: 'sk-old-default-token',
      source: 'manual',
      enabled: true,
      isDefault: true,
      tokenGroup: 'default',
      valueStatus: 'ready' as any,
    }).run();
    createApiTokenMock.mockImplementation(async (
      _baseUrl: unknown,
      _accessToken: unknown,
      _platformUserId: unknown,
      options?: { onCreatedToken?: (token: { name: string; key: string; enabled?: boolean; tokenGroup?: string | null }) => void },
    ) => {
      options?.onCreatedToken?.({
        name: 'created-from-upstream',
        key: 'sk-created-upstream-token',
        enabled: true,
        tokenGroup: 'vip',
      });
      return true;
    });
    getApiTokensMock.mockResolvedValue([]);

    const response = await app.inject({
      method: 'POST',
      url: '/api/account-tokens',
      payload: {
        accountId: account.id,
        name: 'created-from-upstream',
        group: 'vip',
      },
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({
      success: true,
      createdViaUpstream: true,
      token: expect.objectContaining({
        name: 'created-from-upstream',
        token: 'sk-created-upstream-token',
        isDefault: true,
      }),
    });

    const tokenRows = await db.select()
      .from(schema.accountTokens)
      .where(eq(schema.accountTokens.accountId, account.id))
      .all();
    const oldDefault = tokenRows.find((token) => token.name === 'old-default');
    const created = tokenRows.find((token) => token.name === 'created-from-upstream');
    expect(oldDefault?.isDefault).toBe(false);
    expect(created).toMatchObject({
      token: 'sk-created-upstream-token',
      tokenGroup: 'vip',
      isDefault: true,
    });
  });

  it('passes token creation options to upstream adapter', async () => {
    const { account } = await seedAccount({ siteStatus: 'active' });
    createApiTokenMock.mockResolvedValue(true);
    getApiTokensMock.mockResolvedValue([
      { name: 'custom-token', key: 'sk-created-upstream-token', enabled: true },
    ]);

    const response = await app.inject({
      method: 'POST',
      url: '/api/account-tokens',
      payload: {
        accountId: account.id,
        name: 'custom-token',
        group: 'vip',
        unlimitedQuota: false,
        remainQuota: 123456,
        expiredTime: 2_000_000_000,
        allowIps: '1.1.1.1,2.2.2.2',
      },
    });

    expect(response.statusCode).toBe(200);
    expect(createApiTokenMock).toHaveBeenCalledTimes(1);
    expect(createApiTokenMock.mock.calls[0][3]).toMatchObject({
      name: 'custom-token',
      group: 'vip',
      unlimitedQuota: false,
      remainQuota: 123456,
      expiredTime: 2_000_000_000,
      allowIps: '1.1.1.1,2.2.2.2',
    });
  });

  it('rejects non-string token payload when creating manual account token', async () => {
    const { account } = await seedAccount({ siteStatus: 'active' });

    const response = await app.inject({
      method: 'POST',
      url: '/api/account-tokens',
      payload: {
        accountId: account.id,
        token: { value: 'bad-token' },
      },
    });

    expect(response.statusCode).toBe(400);
    expect((response.json() as { message?: string }).message).toContain('token');
  });

  it('rejects non-boolean unlimitedQuota payload when creating upstream account token', async () => {
    const { account } = await seedAccount({ siteStatus: 'active' });

    const response = await app.inject({
      method: 'POST',
      url: '/api/account-tokens',
      payload: {
        accountId: account.id,
        name: 'typed-token',
        unlimitedQuota: 'false',
      },
    });

    expect(response.statusCode).toBe(400);
    expect((response.json() as { message?: string }).message).toContain('unlimitedQuota');
    expect(createApiTokenMock).not.toHaveBeenCalled();
  });

  it('returns 400 when limited token misses remainQuota', async () => {
    const { account } = await seedAccount({ siteStatus: 'active' });

    const response = await app.inject({
      method: 'POST',
      url: '/api/account-tokens',
      payload: {
        accountId: account.id,
        name: 'bad-token',
        unlimitedQuota: false,
      },
    });

    expect(response.statusCode).toBe(400);
    expect(response.json()).toMatchObject({
      success: false,
      message: '有限额度令牌必须填写 remainQuota',
    });
    expect(createApiTokenMock).not.toHaveBeenCalled();
  });

  it('returns 502 when upstream token creation fails', async () => {
    const { account } = await seedAccount({ siteStatus: 'active' });
    createApiTokenMock.mockResolvedValue(false);

    const response = await app.inject({
      method: 'POST',
      url: '/api/account-tokens',
      payload: {
        accountId: account.id,
        name: 'created-from-upstream',
      },
    });

    expect(response.statusCode).toBe(502);
    expect(response.json()).toMatchObject({
      success: false,
      message: '站点创建令牌失败',
    });
  });

  it('fetches account token groups from upstream', async () => {
    const { account } = await seedAccount({ siteStatus: 'active' });
    getUserGroupsMock.mockResolvedValue(['default', 'vip']);

    const response = await app.inject({
      method: 'GET',
      url: `/api/account-tokens/groups/${account.id}`,
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({
      success: true,
      groups: ['default', 'vip'],
    });
    expect(getUserGroupsMock).toHaveBeenCalledTimes(1);
  });

  it('does not synthesize a default group when upstream groups are empty', async () => {
    const { account } = await seedAccount({ siteStatus: 'active' });
    getUserGroupsMock.mockResolvedValue([]);

    const response = await app.inject({
      method: 'GET',
      url: `/api/account-tokens/groups/${account.id}`,
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({
      success: true,
      groups: [],
    });
    expect(getUserGroupsMock).toHaveBeenCalledTimes(1);
  });

  it('keeps token group empty when an upstream default-named token has no explicit group', async () => {
    const { account } = await seedAccount({ siteStatus: 'active' });
    getApiTokensMock.mockResolvedValue([
      { name: 'default', key: 'sk-upstream-default-without-group', enabled: true },
    ]);

    const response = await app.inject({
      method: 'POST',
      url: `/api/account-tokens/sync/${account.id}`,
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({
      success: true,
      synced: true,
      created: 1,
      updated: 0,
    });

    const tokenRows = await db.select()
      .from(schema.accountTokens)
      .where(eq(schema.accountTokens.accountId, account.id))
      .all();
    expect(tokenRows).toHaveLength(1);
    expect(tokenRows[0]).toMatchObject({
      name: 'default',
      source: 'sync',
      tokenGroup: null,
    });

    const listResponse = await app.inject({
      method: 'GET',
      url: '/api/account-tokens',
    });
    expect(listResponse.statusCode).toBe(200);
    const listed = listResponse.json() as Array<{ id: number; tokenGroup?: string | null }>;
    expect(listed.find((item) => item.id === tokenRows[0].id)?.tokenGroup).toBeNull();
  });

  it('activates expired account before deleting upstream token', async () => {
    const { account, site } = await seedAccount({
      siteStatus: 'active',
      accountStatus: 'expired',
      accountExtraConfig: JSON.stringify({
        autoRelogin: {
          username: 'admin',
          passwordCipher: encryptAccountPassword('plain-password'),
        },
      }),
    });
    const token = await db.insert(schema.accountTokens).values({
      accountId: account.id,
      name: 'upstream-token',
      token: 'sk-upstream-token',
      source: 'sync',
      enabled: true,
      isDefault: false,
    }).returning().get();
    loginMock.mockResolvedValue({
      success: true,
      accessToken: 'refreshed-access-token',
    });
    deleteApiTokenMock.mockResolvedValue(true);

    const response = await app.inject({
      method: 'DELETE',
      url: `/api/account-tokens/${token.id}`,
    });

    expect(response.statusCode).toBe(202);
    const body = response.json() as { jobId: string; queued: boolean };
    expect(body.queued).toBe(true);

    const task = await waitForBackgroundTaskToReachTerminalState(getBackgroundTask, body.jobId);
    expect(task?.status).toBe('succeeded');
    expect(deleteApiTokenMock).toHaveBeenCalledTimes(1);
    expect(loginMock).toHaveBeenCalledTimes(1);
    expect(deleteApiTokenMock.mock.calls[0][0]).toBe(site.url);
    expect(deleteApiTokenMock.mock.calls[0][1]).toBe('refreshed-access-token');
    expect(deleteApiTokenMock.mock.calls[0][2]).toBe('sk-upstream-token');

    const removed = await db.select().from(schema.accountTokens).where(eq(schema.accountTokens.id, token.id)).get();
    expect(removed).toBeUndefined();
    expect(task?.logs.some((entry) => entry.message.includes('原站点删除成功'))).toBe(true);
    const events = await db.select().from(schema.events).where(eq(schema.events.type, 'token')).all();
    expect(events).toEqual(expect.arrayContaining([
      expect.objectContaining({
        title: '账号令牌删除成功',
        message: expect.stringContaining('原站点删除成功'),
        relatedType: 'account_token',
      }),
    ]));
  });

  it('keeps local token when upstream deletion fails', async () => {
    const { account } = await seedAccount({ siteStatus: 'active' });
    const token = await db.insert(schema.accountTokens).values({
      accountId: account.id,
      name: 'upstream-token',
      token: 'sk-upstream-token',
      source: 'sync',
      enabled: true,
      isDefault: false,
    }).returning().get();
    deleteApiTokenMock.mockResolvedValue(false);

    const response = await app.inject({
      method: 'DELETE',
      url: `/api/account-tokens/${token.id}`,
    });

    expect(response.statusCode).toBe(202);
    const body = response.json() as { jobId: string; queued: boolean };
    expect(body.queued).toBe(true);

    const task = await waitForBackgroundTaskToReachTerminalState(getBackgroundTask, body.jobId);
    expect(task?.status).toBe('failed');
    expect(task?.error).toBe('站点删除令牌失败，本地未删除');

    const existing = await db.select().from(schema.accountTokens).where(eq(schema.accountTokens.id, token.id)).get();
    expect(existing).toBeDefined();
    const events = await db.select().from(schema.events).where(eq(schema.events.type, 'token')).all();
    expect(events).toEqual(expect.arrayContaining([
      expect.objectContaining({
        title: '账号令牌删除失败',
        message: expect.stringContaining('本地未删除'),
        relatedType: 'account_token',
      }),
    ]));
  });

  it('rejects retrieving token value when stored token is masked', async () => {
    const { account } = await seedAccount({ siteStatus: 'active' });
    const token = await db.insert(schema.accountTokens).values({
      accountId: account.id,
      name: 'masked-token',
      token: 'sk-mask***tail',
      source: 'sync',
      enabled: true,
      isDefault: false,
      valueStatus: 'masked_pending' as any,
    }).returning().get();

    const response = await app.inject({
      method: 'GET',
      url: `/api/account-tokens/${token.id}/value`,
    });

    expect(response.statusCode).toBe(409);
    expect(response.json()).toMatchObject({
      success: false,
    });
  });

  it('upgrades an existing masked_pending placeholder when upstream later returns the full token', async () => {
    const { account } = await seedAccount({ siteStatus: 'active' });
    await db.insert(schema.accountTokens).values({
      accountId: account.id,
      name: 'masked-only',
      token: 'sk-abc***xyz',
      source: 'sync',
      enabled: false,
      isDefault: false,
      tokenGroup: 'default',
      valueStatus: 'masked_pending' as any,
    }).run();

    getApiTokensMock.mockResolvedValue([
      { name: 'masked-only', key: 'sk-real-token-1234', enabled: true, tokenGroup: 'default' },
    ]);
    getApiTokenMock.mockResolvedValue(null);

    const response = await app.inject({
      method: 'POST',
      url: `/api/account-tokens/sync/${account.id}`,
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({
      success: true,
      synced: true,
      status: 'synced',
      total: 1,
      created: 0,
      updated: 1,
    });

    const tokenRows = await db.select()
      .from(schema.accountTokens)
      .where(eq(schema.accountTokens.accountId, account.id))
      .all();
    expect(tokenRows).toHaveLength(1);
    expect(tokenRows[0]).toMatchObject({
      name: 'masked-only',
      token: 'sk-real-token-1234',
      enabled: false,
    });
    expect((tokenRows[0] as any).valueStatus).toBe('ready');
  });

  it('applies manual enabled group preferences when upstream sync returns a new ready token', async () => {
    const { site, account } = await seedAccount({ siteStatus: 'active' });
    await db.insert(schema.tokenGroupPricing).values({
      siteId: site.id,
      accountId: account.id,
      sourceKey: `account:${account.id}`,
      group: 'pro',
      groupName: 'pro',
      ratio: 0.5,
      source: 'upstream',
      pricingAvailable: true,
    }).run();
    await db.insert(schema.accountTokenGroupPreferences).values({
      accountId: account.id,
      tokenGroup: 'pro',
      groupRatio: 0.5,
      groupRatioKey: '0.5',
      enabled: true,
    }).run();

    getApiTokensMock.mockResolvedValue([
      { name: 'pro', key: 'sk-new-pro-token', enabled: false, tokenGroup: 'pro' },
    ]);
    getApiTokenMock.mockResolvedValue(null);

    const response = await app.inject({
      method: 'POST',
      url: `/api/account-tokens/sync/${account.id}`,
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({
      success: true,
      synced: true,
      status: 'synced',
      created: 1,
    });

    const tokenRows = await db.select()
      .from(schema.accountTokens)
      .where(eq(schema.accountTokens.accountId, account.id))
      .all();
    expect(tokenRows).toHaveLength(1);
    expect(tokenRows[0]).toMatchObject({
      name: 'pro',
      token: 'sk-new-pro-token',
      enabled: true,
      isDefault: true,
      tokenGroup: 'pro',
    });
  });

  it('does not allow setting a masked_pending placeholder as default', async () => {
    const { account } = await seedAccount({ siteStatus: 'active' });
    const token = await db.insert(schema.accountTokens).values({
      accountId: account.id,
      name: 'masked-token',
      token: 'sk-mask***tail',
      source: 'sync',
      enabled: false,
      isDefault: false,
      valueStatus: 'masked_pending' as any,
    }).returning().get();

    const response = await app.inject({
      method: 'POST',
      url: `/api/account-tokens/${token.id}/default`,
    });

    expect(response.statusCode).toBe(400);
    expect(response.json()).toMatchObject({
      success: false,
      message: expect.stringContaining('待补全令牌'),
    });
  });

  it('returns account token default states after setting a token as default', async () => {
    const { account } = await seedAccount({ siteStatus: 'active' });
    await db.insert(schema.accountTokens).values({
      accountId: account.id,
      name: 'old-default',
      token: 'sk-old-default',
      source: 'manual',
      enabled: true,
      isDefault: true,
      valueStatus: 'ready' as any,
    }).returning().get();
    const nextDefault = await db.insert(schema.accountTokens).values({
      accountId: account.id,
      name: 'next-default',
      token: 'sk-next-default',
      source: 'manual',
      enabled: true,
      isDefault: false,
      valueStatus: 'ready' as any,
    }).returning().get();

    const response = await app.inject({
      method: 'POST',
      url: `/api/account-tokens/${nextDefault.id}/default`,
    });

    expect(response.statusCode).toBe(200);
    const body = response.json() as {
      success: boolean;
      token: { id: number; isDefault: boolean } | null;
      accountTokens: Array<{ id: number; isDefault: boolean }>;
    };
    expect(body.success).toBe(true);
    expect(body.token).toMatchObject({ id: nextDefault.id, isDefault: true });
    expect(body.accountTokens.filter((token) => token.isDefault).map((token) => token.id)).toEqual([nextDefault.id]);
  });

  it('enables a ready token when setting it as default', async () => {
    const { account } = await seedAccount({ siteStatus: 'active' });
    await db.insert(schema.accountTokens).values({
      accountId: account.id,
      name: 'old-default',
      token: 'sk-old-default',
      source: 'manual',
      enabled: true,
      isDefault: true,
      valueStatus: 'ready' as any,
    }).returning().get();
    const disabledReady = await db.insert(schema.accountTokens).values({
      accountId: account.id,
      name: 'disabled-ready',
      token: 'sk-disabled-ready',
      source: 'manual',
      enabled: false,
      isDefault: false,
      valueStatus: 'ready' as any,
    }).returning().get();

    const response = await app.inject({
      method: 'POST',
      url: `/api/account-tokens/${disabledReady.id}/default`,
    });

    expect(response.statusCode).toBe(200);
    const body = response.json() as {
      success: boolean;
      token: { id: number; isDefault: boolean; enabled: boolean } | null;
      accountTokens: Array<{ id: number; isDefault: boolean; enabled: boolean }>;
    };
    expect(body.success).toBe(true);
    expect(body.token).toMatchObject({ id: disabledReady.id, isDefault: true, enabled: true });
    expect(body.accountTokens.filter((token) => token.isDefault).map((token) => token.id)).toEqual([disabledReady.id]);

    const accountRow = await db.select().from(schema.accounts).where(eq(schema.accounts.id, account.id)).get();
    expect(accountRow?.apiToken).toBe('sk-disabled-ready');
  });

  it('promotes a masked_pending placeholder to ready when a full token is saved', async () => {
    const { account } = await seedAccount({ siteStatus: 'active' });
    const token = await db.insert(schema.accountTokens).values({
      accountId: account.id,
      name: 'masked-token',
      token: 'sk-mask***tail',
      source: 'sync',
      enabled: false,
      isDefault: false,
      valueStatus: 'masked_pending' as any,
    }).returning().get();

    const response = await app.inject({
      method: 'PUT',
      url: `/api/account-tokens/${token.id}`,
      payload: {
        token: 'sk-real-token-updated',
        enabled: true,
      },
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({
      success: true,
      token: expect.objectContaining({
        id: token.id,
        enabled: true,
        valueStatus: 'ready',
      }),
    });

    const latest = await db.select()
      .from(schema.accountTokens)
      .where(eq(schema.accountTokens.id, token.id))
      .get();
    expect(latest).toMatchObject({
      token: 'sk-real-token-updated',
      enabled: true,
    });
    expect((latest as any)?.valueStatus).toBe('ready');
  });

  it('returns the refreshed default state after promoting an existing token to default', async () => {
    const { account } = await seedAccount({ siteStatus: 'active' });
    await db.insert(schema.accountTokens).values({
      accountId: account.id,
      name: 'default-token',
      token: 'sk-default-token',
      source: 'manual',
      enabled: true,
      isDefault: true,
    }).run();
    const secondary = await db.insert(schema.accountTokens).values({
      accountId: account.id,
      name: 'secondary-token',
      token: 'sk-secondary-token',
      source: 'manual',
      enabled: true,
      isDefault: false,
    }).returning().get();

    const response = await app.inject({
      method: 'PUT',
      url: `/api/account-tokens/${secondary.id}`,
      payload: {
        isDefault: true,
      },
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({
      success: true,
      token: expect.objectContaining({
        id: secondary.id,
        isDefault: true,
      }),
    });
  });

  it('rejects non-string name payload when updating account token', async () => {
    const { account } = await seedAccount({ siteStatus: 'active' });
    const token = await db.insert(schema.accountTokens).values({
      accountId: account.id,
      name: 'typed-token',
      token: 'sk-real-token',
      source: 'manual',
      enabled: true,
      isDefault: false,
    }).returning().get();

    const response = await app.inject({
      method: 'PUT',
      url: `/api/account-tokens/${token.id}`,
      payload: {
        name: 123,
      },
    });

    expect(response.statusCode).toBe(400);
    expect((response.json() as { message?: string }).message).toContain('name');
  });

  it('keeps masked_pending placeholders locally because upstream deletion cannot be confirmed', async () => {
    const { account } = await seedAccount({ siteStatus: 'active' });
    const token = await db.insert(schema.accountTokens).values({
      accountId: account.id,
      name: 'masked-token',
      token: 'sk-mask***tail',
      source: 'sync',
      enabled: false,
      isDefault: false,
      valueStatus: 'masked_pending' as any,
    }).returning().get();

    const response = await app.inject({
      method: 'DELETE',
      url: `/api/account-tokens/${token.id}`,
    });

    expect(response.statusCode).toBe(202);
    const body = response.json() as { jobId: string; queued: boolean };
    expect(body.queued).toBe(true);

    const task = await waitForBackgroundTaskToReachTerminalState(getBackgroundTask, body.jobId);
    expect(task?.status).toBe('failed');
    expect(task?.error).toContain('本地未删除');
    expect(deleteApiTokenMock).not.toHaveBeenCalled();
    const existing = await db.select().from(schema.accountTokens).where(eq(schema.accountTokens.id, token.id)).get();
    expect(existing).toBeDefined();
    expect(task?.logs.some((entry) => entry.message.includes('原站点未删除'))).toBe(true);
    const events = await db.select().from(schema.events).where(eq(schema.events.type, 'token')).all();
    expect(events).toEqual(expect.arrayContaining([
      expect.objectContaining({
        title: '账号令牌删除失败',
        message: expect.stringContaining('原站点未删除'),
        relatedType: 'account_token',
      }),
    ]));
  });

  it('auto-disables tokens when model discovery is empty and restores previous state when models return', async () => {
    const { account } = await seedAccount({ siteStatus: 'active' });
    const token = await db.insert(schema.accountTokens).values({
      accountId: account.id,
      name: 'model-empty-token',
      token: 'sk-real-token',
      source: 'manual',
      enabled: true,
      isDefault: true,
      valueStatus: 'ready' as any,
    }).returning().get();

    getModelsMock.mockResolvedValueOnce([]);
    const emptyResponse = await app.inject({
      method: 'GET',
      url: `/api/account-tokens/${token.id}/models`,
    });

    expect(emptyResponse.statusCode).toBe(200);
    const autoDisabled = await db.select().from(schema.accountTokens).where(eq(schema.accountTokens.id, token.id)).get();
    expect(autoDisabled).toMatchObject({
      enabled: false,
      autoDisabledReason: '模型拉取为空',
      autoDisabledPreviousEnabled: true,
    });
    expect(autoDisabled?.autoDisabledAt).toBeTruthy();
    expect(autoDisabled?.modelSyncedAt).toBeTruthy();

    getModelsMock.mockResolvedValueOnce(['gpt-5.5']);
    const restoredResponse = await app.inject({
      method: 'GET',
      url: `/api/account-tokens/${token.id}/models`,
    });

    expect(restoredResponse.statusCode).toBe(200);
    const restored = await db.select().from(schema.accountTokens).where(eq(schema.accountTokens.id, token.id)).get();
    expect(restored).toMatchObject({
      enabled: true,
      autoDisabledAt: null,
      autoDisabledReason: null,
      autoDisabledPreviousEnabled: null,
    });
    const modelRows = await db.select().from(schema.tokenModelAvailability)
      .where(eq(schema.tokenModelAvailability.tokenId, token.id))
      .all();
    expect(modelRows.map((row) => row.modelName)).toEqual(['gpt-5.5']);
  });

  it('returns persisted route-enabled model state after toggling a token model', async () => {
    const { account } = await seedAccount({ siteStatus: 'active' });
    const token = await db.insert(schema.accountTokens).values({
      accountId: account.id,
      name: 'route-toggle-token',
      token: 'sk-route-toggle',
      source: 'manual',
      enabled: true,
      isDefault: true,
      valueStatus: 'ready' as any,
    }).returning().get();

    await db.insert(schema.tokenModelAvailability).values({
      tokenId: token.id,
      modelName: 'gpt-5.5',
      available: true,
      routeEnabled: false,
    }).run();

    const response = await app.inject({
      method: 'POST',
      url: `/api/account-tokens/${token.id}/models/route-enabled`,
      payload: {
        modelName: 'gpt-5.5',
        routeEnabled: true,
      },
    });

    expect(response.statusCode).toBe(200);
    const body = response.json() as {
      routeEnabled: boolean;
      models: Array<{ name: string; routeEnabled: boolean }>;
      modelNames: string[];
    };
    expect(body.routeEnabled).toBe(true);
    expect(body.models).toEqual([
      expect.objectContaining({ name: 'gpt-5.5', routeEnabled: true }),
    ]);
    expect(body.modelNames).toEqual(['gpt-5.5']);

    const row = await db.select().from(schema.tokenModelAvailability)
      .where(eq(schema.tokenModelAvailability.tokenId, token.id))
      .get();
    expect(row?.routeEnabled).toBe(true);
  });

  it('keeps failed token test result unavailable even when discovery marks the model available', async () => {
    const { account } = await seedAccount({ siteStatus: 'active' });
    const token = await db.insert(schema.accountTokens).values({
      accountId: account.id,
      name: 'failed-test-token',
      token: 'sk-failed-test',
      source: 'manual',
      enabled: true,
      isDefault: true,
      valueStatus: 'ready' as any,
    }).returning().get();

    await db.insert(schema.tokenModelAvailability).values({
      tokenId: token.id,
      modelName: 'gpt-5.5',
      available: true,
      message: '请求失败：HTTP 401',
      httpStatus: 401,
      responseText: null,
      checkedAt: '2026-06-20T00:00:00.000Z',
    }).run();

    const response = await app.inject({
      method: 'GET',
      url: '/api/account-tokens',
    });

    expect(response.statusCode).toBe(200);
    const body = response.json() as Array<any>;
    const returned = body.find((row) => row.id === token.id);
    expect(returned?.modelAvailability).toEqual([
      expect.objectContaining({
        modelName: 'gpt-5.5',
        available: false,
        httpStatus: 401,
        message: '请求失败：HTTP 401',
      }),
    ]);
  });

  it('keeps manual model availability test from changing token enabled state', async () => {
    const { account } = await seedAccount({ siteStatus: 'active' });
    const token = await db.insert(schema.accountTokens).values({
      accountId: account.id,
      name: 'manual-disabled',
      token: 'sk-manual-disabled',
      source: 'manual',
      enabled: false,
      isDefault: false,
      valueStatus: 'ready' as any,
    }).returning().get();

    await db.insert(schema.tokenModelAvailability).values({
      tokenId: token.id,
      modelName: 'gpt-5.5',
      available: true,
      routeEnabled: true,
      message: '请求成功',
      checkedAt: '2026-06-20T00:00:00.000Z',
    }).run();

    const response = await app.inject({
      method: 'POST',
      url: '/api/account-tokens/models/test',
      payload: {
        model: 'gpt-5.5',
        tokenIds: [token.id],
      },
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).not.toHaveProperty('routeRebuild');
    expect(response.json()).not.toHaveProperty('routeEnabledModels');

    const latestToken = await db.select()
      .from(schema.accountTokens)
      .where(eq(schema.accountTokens.id, token.id))
      .get();
    expect(latestToken?.enabled).toBe(false);

    const availability = await db.select()
      .from(schema.tokenModelAvailability)
      .where(and(
        eq(schema.tokenModelAvailability.tokenId, token.id),
        eq(schema.tokenModelAvailability.modelName, 'gpt-5.5'),
      ))
      .get();
    expect(availability?.routeEnabled).toBe(true);
    expect(await db.select().from(schema.routeChannels).all()).toHaveLength(0);
  });

  it('does not add an enabled successful token model to routing after manual availability test', async () => {
    const { account } = await seedAccount({ siteStatus: 'active' });
    const token = await db.insert(schema.accountTokens).values({
      accountId: account.id,
      name: 'manual-route-enabled',
      token: 'sk-manual-route-enabled',
      source: 'manual',
      enabled: true,
      isDefault: false,
      valueStatus: 'ready' as any,
    }).returning().get();

    const response = await app.inject({
      method: 'POST',
      url: '/api/account-tokens/models/test',
      payload: {
        model: 'gpt-5.5',
        tokenIds: [token.id],
      },
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).not.toHaveProperty('routeRebuild');
    expect(response.json()).not.toHaveProperty('routeEnabledModels');

    const availability = await db.select()
      .from(schema.tokenModelAvailability)
      .where(and(
        eq(schema.tokenModelAvailability.tokenId, token.id),
        eq(schema.tokenModelAvailability.modelName, 'gpt-5.5'),
      ))
      .get();
    expect(availability).toMatchObject({
      available: true,
      routeEnabled: false,
      httpStatus: 200,
      message: '请求成功',
    });

    expect(await db.select().from(schema.routeChannels).all()).toHaveLength(0);
  });

  it('queues manual model availability tests as background tasks when requested', async () => {
    const { account } = await seedAccount({ siteStatus: 'active' });
    const token = await db.insert(schema.accountTokens).values({
      accountId: account.id,
      name: 'manual-route-enabled-async',
      token: 'sk-manual-route-enabled-async',
      source: 'manual',
      enabled: true,
      isDefault: false,
      valueStatus: 'ready' as any,
    }).returning().get();

    const response = await app.inject({
      method: 'POST',
      url: '/api/account-tokens/models/test',
      payload: {
        model: 'gpt-5.5',
        tokenIds: [token.id],
        async: true,
      },
    });

    expect(response.statusCode).toBe(202);
    const body = response.json() as { queued: boolean; jobId: string; taskId: string };
    expect(body.queued).toBe(true);
    expect(body.jobId).toBeTruthy();
    expect(body.taskId).toBe(body.jobId);

    const task = await waitForBackgroundTaskToReachTerminalState(getBackgroundTask, body.jobId);
    expect(task?.status).toBe('succeeded');
    expect(task?.result).not.toHaveProperty('routeRebuild');
    expect(task?.result).not.toHaveProperty('routeEnabledModels');

    const availability = await db.select()
      .from(schema.tokenModelAvailability)
      .where(and(
        eq(schema.tokenModelAvailability.tokenId, token.id),
        eq(schema.tokenModelAvailability.modelName, 'gpt-5.5'),
      ))
      .get();
    expect(availability).toMatchObject({
      available: true,
      routeEnabled: false,
    });
  });

  it('updates health check metadata after manual model availability test', async () => {
    const { account } = await seedAccount({ siteStatus: 'active' });
    const token = await db.insert(schema.accountTokens).values({
      accountId: account.id,
      name: 'manual-health-check',
      token: 'sk-manual-health-check',
      source: 'manual',
      enabled: true,
      isDefault: true,
      valueStatus: 'ready' as any,
      healthCheckEnabled: true,
      healthCheckIntervalMinutes: 30,
      healthCheckModel: '',
      healthCheckNextRunAt: '2026-06-20T00:00:00.000Z',
    }).returning().get();

    const response = await app.inject({
      method: 'POST',
      url: '/api/account-tokens/models/test',
      payload: {
        model: 'gpt-5.5',
        tokenIds: [token.id],
      },
    });

    expect(response.statusCode).toBe(200);
    const body = response.json();
    expect(body.healthCheckTokens).toEqual([
      expect.objectContaining({
        id: token.id,
        healthCheckModel: 'gpt-5.5',
        healthCheckLastRunAt: '2026-06-21T00:00:00.000Z',
        healthCheckLastAvailable: true,
        healthCheckLastMessage: '成功 1/1：gpt-5.5',
        healthCheckLastLatencyMs: 12,
        healthCheckNextRunAt: '2026-06-21T00:30:00.000Z',
      }),
    ]);

    const latestToken = await db.select()
      .from(schema.accountTokens)
      .where(eq(schema.accountTokens.id, token.id))
      .get();
    expect(latestToken).toMatchObject({
      healthCheckModel: 'gpt-5.5',
      healthCheckLastRunAt: '2026-06-21T00:00:00.000Z',
      healthCheckLastAvailable: true,
      healthCheckLastMessage: '成功 1/1：gpt-5.5',
      healthCheckLastLatencyMs: 12,
      healthCheckNextRunAt: '2026-06-21T00:30:00.000Z',
    });
  });

  it('preserves route-enabled model state when saving skipped image-only test result', async () => {
    const { account } = await seedAccount({ siteStatus: 'active' });
    const token = await db.insert(schema.accountTokens).values({
      accountId: account.id,
      name: 'image-only',
      token: 'sk-image-only',
      source: 'manual',
      enabled: true,
      isDefault: true,
      valueStatus: 'ready' as any,
    }).returning().get();

    await db.insert(schema.tokenModelAvailability).values({
      tokenId: token.id,
      modelName: 'gpt-image-2',
      available: true,
      routeEnabled: true,
      message: '已点亮',
      checkedAt: '2026-06-20T00:00:00.000Z',
    }).run();

    const response = await app.inject({
      method: 'POST',
      url: '/api/account-tokens/models/test-skipped',
      payload: {
        results: [{
          tokenId: token.id,
          model: 'gpt-image-2',
          message: '图片模型跳过文本测活',
          checkedAt: '2026-06-21T00:00:00.000Z',
        }],
      },
    });

    expect(response.statusCode).toBe(200);
    const body = response.json();
    expect(body).not.toHaveProperty('routeRebuild');
    expect(body.healthCheckTokens).toEqual([
      expect.objectContaining({
        id: token.id,
        healthCheckModel: 'gpt-image-2',
        healthCheckLastRunAt: '2026-06-21T00:00:00.000Z',
        healthCheckLastAvailable: false,
        healthCheckLastMessage: '全部失败：gpt-image-2: 图片模型跳过文本测活',
        healthCheckLastLatencyMs: null,
      }),
    ]);

    const availability = await db.select()
      .from(schema.tokenModelAvailability)
      .where(and(
        eq(schema.tokenModelAvailability.tokenId, token.id),
        eq(schema.tokenModelAvailability.modelName, 'gpt-image-2'),
      ))
      .get();
    expect(availability?.available).toBe(false);
    expect(availability?.routeEnabled).toBe(true);
    expect(await db.select().from(schema.routeChannels).all()).toHaveLength(0);

    const latestToken = await db.select()
      .from(schema.accountTokens)
      .where(eq(schema.accountTokens.id, token.id))
      .get();
    expect(latestToken?.healthCheckLastAvailable).toBe(false);
    expect(latestToken?.healthCheckLastMessage).toBe('全部失败：gpt-image-2: 图片模型跳过文本测活');
  });

  it('runs manual health checks for multiple configured models without enabling successful models for routing', async () => {
    const { account } = await seedAccount({ siteStatus: 'active' });
    const token = await db.insert(schema.accountTokens).values({
      accountId: account.id,
      name: 'multi-health-check',
      token: 'sk-multi-health-check',
      source: 'manual',
      enabled: false,
      isDefault: false,
      valueStatus: 'ready' as any,
    }).returning().get();

    const configResponse = await app.inject({
      method: 'PUT',
      url: `/api/account-tokens/${token.id}/health-check`,
      payload: {
        enabled: true,
        models: ['gpt-5.5', 'gpt-5.4', 'gpt-5.5'],
        intervalMinutes: 30,
      },
    });

    expect(configResponse.statusCode).toBe(200);
    expect(configResponse.json().token.healthCheckModel).toBe('gpt-5.5, gpt-5.4');

    await db.insert(schema.tokenModelAvailability).values([
      {
        tokenId: token.id,
        modelName: 'gpt-5.5',
        available: false,
        routeEnabled: false,
        message: '待测活',
        checkedAt: '2026-06-20T00:00:00.000Z',
      },
      {
        tokenId: token.id,
        modelName: 'gpt-5.4',
        available: false,
        routeEnabled: false,
        message: '待测活',
        checkedAt: '2026-06-20T00:00:00.000Z',
      },
    ]).run();

    testAccountTokenModelAvailabilityMock.mockImplementation(async (options: { model: string; tokenIds: number[] }) => {
      const results = options.tokenIds.map((tokenId) => ({
        tokenId,
        model: options.model,
        available: options.model === 'gpt-5.5',
        message: options.model === 'gpt-5.5' ? '请求成功' : '请求失败',
        responseText: options.model === 'gpt-5.5' ? '我是测试模型' : null,
        httpStatus: options.model === 'gpt-5.5' ? 200 : 500,
        latencyMs: 10,
        checkedAt: '2026-06-21T00:00:00.000Z',
      }));
      await persistMockedModelTestResults(results);
      return {
        model: options.model,
        total: options.tokenIds.length,
        results,
      };
    });

    const runResponse = await app.inject({
      method: 'POST',
      url: `/api/account-tokens/${token.id}/health-check/run`,
    });

    expect(runResponse.statusCode).toBe(200);
    const body = runResponse.json();
    expect(body.result).toMatchObject({
      available: true,
      message: '成功 1/2：gpt-5.5',
    });
    expect(body.results).toEqual([
      expect.objectContaining({ model: 'gpt-5.5', available: true }),
      expect.objectContaining({ model: 'gpt-5.4', available: false }),
    ]);
    expect(testAccountTokenModelAvailabilityMock).toHaveBeenCalledTimes(2);

    const latestToken = await db.select()
      .from(schema.accountTokens)
      .where(eq(schema.accountTokens.id, token.id))
      .get();
    expect(latestToken?.enabled).toBe(false);
    expect(latestToken?.healthCheckLastAvailable).toBe(true);
    expect(latestToken?.healthCheckLastMessage).toBe('成功 1/2：gpt-5.5');

    const availability = await db.select()
      .from(schema.tokenModelAvailability)
      .where(eq(schema.tokenModelAvailability.tokenId, token.id))
      .all();
    expect(availability).toEqual(expect.arrayContaining([
      expect.objectContaining({ modelName: 'gpt-5.5', routeEnabled: false }),
      expect.objectContaining({ modelName: 'gpt-5.4', available: false, routeEnabled: false }),
    ]));
    expect(await db.select().from(schema.routeChannels).all()).toHaveLength(0);
  });

  it('auto-enables successful models for routing after repeated scheduled health check success', async () => {
    const { account } = await seedAccount({ siteStatus: 'active', accessToken: null });
    await db.update(schema.accounts)
      .set({ extraConfig: mergeAccountExtraConfig(null, { credentialMode: 'session' }) })
      .where(eq(schema.accounts.id, account.id))
      .run();
    const token = await db.insert(schema.accountTokens).values({
      accountId: account.id,
      name: 'scheduled-health-check',
      token: 'sk-scheduled-health-check',
      source: 'manual',
      enabled: true,
      isDefault: false,
      valueStatus: 'ready' as any,
      healthCheckEnabled: true,
      healthCheckIntervalMinutes: 30,
      healthCheckModel: 'gpt-5.5, gpt-5.4',
      healthCheckNextRunAt: '2026-06-20T00:00:00.000Z',
    }).returning().get();

    await db.insert(schema.tokenModelAvailability).values([
      {
        tokenId: token.id,
        modelName: 'gpt-5.5',
        available: false,
        routeEnabled: false,
        message: '待测活',
        checkedAt: '2026-06-20T00:00:00.000Z',
      },
      {
        tokenId: token.id,
        modelName: 'gpt-5.4',
        available: false,
        routeEnabled: false,
        message: '待测活',
        checkedAt: '2026-06-20T00:00:00.000Z',
      },
    ]).run();

    testAccountTokenModelAvailabilityMock.mockImplementation(async (options: { model: string; tokenIds: number[] }) => {
      const results = options.tokenIds.map((tokenId) => ({
        tokenId,
        model: options.model,
        available: options.model === 'gpt-5.5',
        message: options.model === 'gpt-5.5' ? '请求成功' : '请求失败',
        responseText: options.model === 'gpt-5.5' ? '我是测试模型' : null,
        httpStatus: options.model === 'gpt-5.5' ? 200 : 500,
        latencyMs: 10,
        checkedAt: '2026-06-21T00:00:00.000Z',
      }));
      await persistMockedModelTestResults(results);
      return {
        model: options.model,
        total: options.tokenIds.length,
        results,
      };
    });

    const scheduled = await runDueAccountTokenHealthChecks();

    expect(scheduled.skipped).toBe(false);
    expect(scheduled.total).toBe(1);
    expect(scheduled.results[0]?.routeRebuilt).toBe(false);

    let availability = await db.select()
      .from(schema.tokenModelAvailability)
      .where(eq(schema.tokenModelAvailability.tokenId, token.id))
      .all();
    expect(availability).toEqual(expect.arrayContaining([
      expect.objectContaining({
        modelName: 'gpt-5.5',
        available: true,
        routeEnabled: false,
        healthCheckSuccessStreak: 1,
      }),
      expect.objectContaining({ modelName: 'gpt-5.4', available: false, routeEnabled: false }),
    ]));

    for (let index = 0; index < 2; index += 1) {
      await db.update(schema.accountTokens)
        .set({ healthCheckNextRunAt: '2026-06-20T00:00:00.000Z' })
        .where(eq(schema.accountTokens.id, token.id))
        .run();
      await runDueAccountTokenHealthChecks();
    }

    availability = await db.select()
      .from(schema.tokenModelAvailability)
      .where(eq(schema.tokenModelAvailability.tokenId, token.id))
      .all();
    expect(availability).toEqual(expect.arrayContaining([
      expect.objectContaining({
        modelName: 'gpt-5.5',
        available: true,
        routeEnabled: true,
        routeEnabledSource: 'health_check',
        healthCheckSuccessStreak: 3,
        routeManualDisabledAt: null,
      }),
      expect.objectContaining({
        modelName: 'gpt-5.4',
        available: false,
        routeEnabled: false,
        healthCheckSuccessStreak: 0,
      }),
    ]));

    const { channel } = await waitForRouteChannel({
      model: 'gpt-5.5',
      accountId: account.id,
      tokenId: token.id,
    });
    expect(channel).toMatchObject({
      enabled: true,
    });
  });

  it('does not auto-enable scheduled health check models after manual route disable', async () => {
    const { account } = await seedAccount({ siteStatus: 'active', accessToken: null });
    await db.update(schema.accounts)
      .set({ extraConfig: mergeAccountExtraConfig(null, { credentialMode: 'session' }) })
      .where(eq(schema.accounts.id, account.id))
      .run();
    const token = await db.insert(schema.accountTokens).values({
      accountId: account.id,
      name: 'manual-disabled-health-check',
      token: 'sk-manual-disabled-health-check',
      source: 'manual',
      enabled: true,
      isDefault: false,
      valueStatus: 'ready' as any,
      healthCheckEnabled: true,
      healthCheckIntervalMinutes: 30,
      healthCheckModel: 'gpt-5.5',
      healthCheckNextRunAt: '2026-06-20T00:00:00.000Z',
    }).returning().get();

    await db.insert(schema.tokenModelAvailability).values({
      tokenId: token.id,
      modelName: 'gpt-5.5',
      available: true,
      routeEnabled: true,
      routeEnabledSource: 'health_check',
      healthCheckSuccessStreak: 3,
      message: '请求成功',
      checkedAt: '2026-06-20T00:00:00.000Z',
    }).run();

    const disableResponse = await app.inject({
      method: 'POST',
      url: `/api/account-tokens/${token.id}/models/route-enabled`,
      payload: {
        modelName: 'gpt-5.5',
        routeEnabled: false,
      },
    });
    expect(disableResponse.statusCode).toBe(200);

    testAccountTokenModelAvailabilityMock.mockImplementation(async (options: { model: string; tokenIds: number[] }) => {
      const results = options.tokenIds.map((tokenId) => ({
        tokenId,
        model: options.model,
        available: true,
        message: '请求成功',
        responseText: '我是测试模型',
        httpStatus: 200,
        latencyMs: 10,
        checkedAt: '2026-06-21T00:00:00.000Z',
      }));
      await persistMockedModelTestResults(results);
      return {
        model: options.model,
        total: options.tokenIds.length,
        results,
      };
    });

    for (let index = 0; index < 3; index += 1) {
      await db.update(schema.accountTokens)
        .set({ healthCheckNextRunAt: '2026-06-20T00:00:00.000Z' })
        .where(eq(schema.accountTokens.id, token.id))
        .run();
      await runDueAccountTokenHealthChecks();
    }

    const availability = await db.select()
      .from(schema.tokenModelAvailability)
      .where(and(
        eq(schema.tokenModelAvailability.tokenId, token.id),
        eq(schema.tokenModelAvailability.modelName, 'gpt-5.5'),
      ))
      .get();
    expect(availability).toMatchObject({
      available: true,
      routeEnabled: false,
      routeEnabledSource: 'manual',
    });
    expect(availability?.routeManualDisabledAt).toBeTruthy();
    expect(availability?.healthCheckSuccessStreak).toBeGreaterThanOrEqual(3);
  });

  it('queues immediate token health checks as background tasks when requested', async () => {
    const { account } = await seedAccount({ siteStatus: 'active' });
    const token = await db.insert(schema.accountTokens).values({
      accountId: account.id,
      name: 'health-check-async',
      token: 'sk-health-check-async',
      source: 'manual',
      enabled: true,
      isDefault: false,
      valueStatus: 'ready' as any,
      healthCheckEnabled: true,
      healthCheckIntervalMinutes: 30,
      healthCheckModel: 'gpt-5.5',
      healthCheckNextRunAt: '2026-06-20T00:00:00.000Z',
    }).returning().get();

    const response = await app.inject({
      method: 'POST',
      url: `/api/account-tokens/${token.id}/health-check/run`,
      payload: { async: true },
    });

    expect(response.statusCode).toBe(202);
    const body = response.json() as { queued: boolean; jobId: string; taskId: string };
    expect(body.queued).toBe(true);
    expect(body.taskId).toBe(body.jobId);

    const task = await waitForBackgroundTaskToReachTerminalState(getBackgroundTask, body.jobId);
    expect(task?.status).toBe('succeeded');
    expect(task?.result).toMatchObject({
      success: true,
      result: expect.objectContaining({
        available: true,
        model: 'gpt-5.5',
      }),
    });
  });
});
