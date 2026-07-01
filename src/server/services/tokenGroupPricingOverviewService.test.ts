import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { mkdtempSync, rmSync } from 'node:fs';
import { and, eq } from 'drizzle-orm';

const getUserGroupDetailsMock = vi.fn();
const loginMock = vi.fn();
const decryptAccountPasswordMock = vi.fn();

vi.mock('./platforms/index.js', () => ({
  getAdapter: () => ({
    getUserGroupDetails: (...args: unknown[]) => getUserGroupDetailsMock(...args),
    login: (...args: unknown[]) => loginMock(...args),
  }),
}));

vi.mock('./accountCredentialService.js', () => ({
  decryptAccountPassword: (...args: unknown[]) => decryptAccountPasswordMock(...args),
}));

vi.mock('./modelPricingService.js', () => ({
  fetchModelPricingCatalog: vi.fn(async (input: any) => ({
    models: [],
    groupRatio: mockCatalogGroupRatioByAccountId[input?.account?.id] || mockCatalogGroupRatio,
  })),
  refreshModelPricingCatalog: vi.fn(async (input: any) => ({
    models: [],
    groupRatio: mockCatalogGroupRatioByAccountId[input?.account?.id] || mockCatalogGroupRatio,
  })),
  listCatalogModelsForGroup: vi.fn(() => []),
}));

type DbModule = typeof import('../db/index.js');
type OverviewModule = typeof import('./tokenGroupPricingOverviewService.js');
let mockCatalogGroupRatio: Record<string, number> = {};
let mockCatalogGroupRatioByAccountId: Record<number, Record<string, number>> = {};

describe('tokenGroupPricingOverviewService', () => {
  let db: DbModule['db'];
  let schema: DbModule['schema'];
  let buildTokenGroupPricingOverview: OverviewModule['buildTokenGroupPricingOverview'];
  let dataDir = '';
  let previousDataDir: string | undefined;

  beforeAll(async () => {
    previousDataDir = process.env.DATA_DIR;
    dataDir = mkdtempSync(join(tmpdir(), 'metapi-token-group-pricing-'));
    process.env.DATA_DIR = dataDir;
    vi.resetModules();

    await import('../db/migrate.js');
    const dbModule = await import('../db/index.js');
    const overviewModule = await import('./tokenGroupPricingOverviewService.js');
    db = dbModule.db;
    schema = dbModule.schema;
    buildTokenGroupPricingOverview = overviewModule.buildTokenGroupPricingOverview;
  });

  beforeEach(async () => {
    getUserGroupDetailsMock.mockReset();
    loginMock.mockReset();
    decryptAccountPasswordMock.mockReset();
    mockCatalogGroupRatio = {};
    mockCatalogGroupRatioByAccountId = {};
    await db.delete(schema.accountTokens).run();
    await db.delete(schema.tokenGroupPricing).run();
    await db.delete(schema.accounts).run();
    await db.delete(schema.sites).run();
  });

  it('relogs an expired account before refreshing upstream group ratios', async () => {
    const site = await db.insert(schema.sites).values({
      name: 'expired-sub2api',
      url: 'https://sub2api.example.com',
      platform: 'sub2api',
    }).returning().get();
    const account = await db.insert(schema.accounts).values({
      siteId: site.id,
      username: 'expired-user',
      accessToken: 'expired-token',
      status: 'expired',
      extraConfig: JSON.stringify({
        autoRelogin: { username: 'expired-user', passwordCipher: 'encrypted-password' },
      }),
    }).returning().get();
    decryptAccountPasswordMock.mockReturnValue('plain-password');
    loginMock.mockResolvedValue({ success: true, accessToken: 'fresh-token' });
    getUserGroupDetailsMock.mockResolvedValue([{ group: 'pro', ratio: 2 }]);

    const overview = await buildTokenGroupPricingOverview({ refresh: true });

    expect(loginMock).toHaveBeenCalledWith(site.url, 'expired-user', 'plain-password');
    expect(getUserGroupDetailsMock).toHaveBeenCalledWith(site.url, 'fresh-token', undefined);
    expect(overview.groupRows.find((row) => row.account?.id === account.id && row.group === 'pro')).toMatchObject({ ratio: 2 });
    expect(await db.select().from(schema.accounts).where(eq(schema.accounts.id, account.id)).get()).toMatchObject({
      accessToken: 'fresh-token',
      status: 'active',
    });
  });

  it('relogs and retries once when an active session is rejected upstream', async () => {
    const site = await db.insert(schema.sites).values({
      name: 'stale-session',
      url: 'https://new-api.example.com',
      platform: 'new-api',
    }).returning().get();
    await db.insert(schema.accounts).values({
      siteId: site.id,
      username: 'active-user',
      accessToken: 'stale-token',
      status: 'active',
      extraConfig: JSON.stringify({
        autoRelogin: { username: 'active-user', passwordCipher: 'encrypted-password' },
      }),
    }).run();
    decryptAccountPasswordMock.mockReturnValue('plain-password');
    loginMock.mockResolvedValue({ success: true, accessToken: 'renewed-token' });
    getUserGroupDetailsMock
      .mockRejectedValueOnce(new Error('401 token expired'))
      .mockResolvedValueOnce([{ group: 'default', ratio: 1 }]);

    const overview = await buildTokenGroupPricingOverview({ refresh: true });

    expect(loginMock).toHaveBeenCalledTimes(1);
    expect(getUserGroupDetailsMock).toHaveBeenNthCalledWith(1, site.url, 'stale-token', undefined);
    expect(getUserGroupDetailsMock).toHaveBeenNthCalledWith(2, site.url, 'renewed-token', undefined);
    expect(overview.groupRows.find((row) => row.group === 'default')).toMatchObject({ ratio: 1 });
  });

  afterAll(() => {
    if (previousDataDir === undefined) {
      delete process.env.DATA_DIR;
    } else {
      process.env.DATA_DIR = previousDataDir;
    }
    rmSync(dataDir, { recursive: true, force: true });
  });

  it('removes stored group rows that are no longer returned by upstream refresh', async () => {
    const site = await db.insert(schema.sites).values({
      name: 'sub2api',
      url: 'https://sub2api.example.com',
      platform: 'sub2api',
    }).returning().get();
    const account = await db.insert(schema.accounts).values({
      siteId: site.id,
      username: 'mikoto',
      accessToken: 'access-token',
      status: 'active',
    }).returning().get();
    await db.insert(schema.accountTokens).values({
      accountId: account.id,
      name: '2',
      token: 'sk-existing-token',
      source: 'sync',
      enabled: true,
      isDefault: true,
      tokenGroup: '2',
      valueStatus: 'ready' as any,
    }).run();
    await db.insert(schema.tokenGroupPricing).values({
      siteId: site.id,
      accountId: account.id,
      sourceKey: `account:${account.id}`,
      group: '2',
      groupName: '已删除分组',
      ratio: 3,
      source: 'upstream',
      pricingAvailable: true,
    }).run();

    getUserGroupDetailsMock.mockResolvedValue([
      { group: '纯pro倍率', name: '纯pro倍率', ratio: 1.5 },
    ]);

    const overview = await buildTokenGroupPricingOverview({ refresh: true });

    expect(overview.groupRows.map((row) => row.group)).toContain('纯pro倍率');
    expect(overview.groupRows.map((row) => row.group)).not.toContain('2');

    const storedRows = await db.select()
      .from(schema.tokenGroupPricing)
      .where(and(
        eq(schema.tokenGroupPricing.siteId, site.id),
        eq(schema.tokenGroupPricing.sourceKey, `account:${account.id}`),
      ))
      .all();
    expect(storedRows).toHaveLength(1);
    expect(storedRows[0]).toMatchObject({
      group: '纯pro倍率',
      groupName: '纯pro倍率',
      ratio: 1.5,
      pricingAvailable: true,
    });
  });

  it('does not mark upstream groups as ratio available when no ratio is returned', async () => {
    const site = await db.insert(schema.sites).values({
      name: 'sub2api',
      url: 'https://sub2api.example.com',
      platform: 'sub2api',
    }).returning().get();
    const account = await db.insert(schema.accounts).values({
      siteId: site.id,
      username: 'hlcpbbb',
      accessToken: 'access-token',
      status: 'active',
    }).returning().get();

    getUserGroupDetailsMock.mockResolvedValue([
      { group: '纯pro倍率', name: '纯pro倍率' },
    ]);

    const overview = await buildTokenGroupPricingOverview({ refresh: true });
    const row = overview.groupRows.find((item) => item.account?.id === account.id && item.group === '纯pro倍率');

    expect(row).toMatchObject({
      ratio: null,
      pricingAvailable: false,
    });

    const storedRow = await db.select()
      .from(schema.tokenGroupPricing)
      .where(and(
        eq(schema.tokenGroupPricing.siteId, site.id),
        eq(schema.tokenGroupPricing.sourceKey, `account:${account.id}`),
        eq(schema.tokenGroupPricing.group, '纯pro倍率'),
      ))
      .get();
    expect(storedRow).toMatchObject({
      ratio: 0,
      pricingAvailable: false,
    });
  });

  it('uses numeric group aliases to show ratios for Chinese upstream group names', async () => {
    const site = await db.insert(schema.sites).values({
      name: 'sub2api',
      url: 'https://sub2api.example.com',
      platform: 'sub2api',
    }).returning().get();
    const account = await db.insert(schema.accounts).values({
      siteId: site.id,
      username: 'mikoto',
      accessToken: 'access-token',
      status: 'active',
    }).returning().get();
    mockCatalogGroupRatio = { default: 1, '2': 2.5 };
    getUserGroupDetailsMock.mockResolvedValue([
      { group: '纯pro倍率', groupKey: '2', name: '纯pro倍率' },
    ]);

    const overview = await buildTokenGroupPricingOverview({ refresh: true });
    const row = overview.groupRows.find((item) => item.account?.id === account.id && item.group === '纯pro倍率');

    expect(row).toMatchObject({
      ratio: 2.5,
      pricingAvailable: true,
      groupName: '纯pro倍率',
    });

    const storedAliasRow = await db.select()
      .from(schema.tokenGroupPricing)
      .where(and(
        eq(schema.tokenGroupPricing.siteId, site.id),
        eq(schema.tokenGroupPricing.sourceKey, `account:${account.id}`),
        eq(schema.tokenGroupPricing.group, '2'),
      ))
      .get();
    expect(storedAliasRow).toMatchObject({
      group: '2',
      groupName: '纯pro倍率',
      ratio: 2.5,
      pricingAvailable: true,
    });
    expect(overview.groupRows.some((item) => item.account?.id === account.id && item.group === '2')).toBe(false);
  });

  it('stores local numeric token group aliases from the pricing catalog when upstream group details omit ids', async () => {
    const site = await db.insert(schema.sites).values({
      name: 'sub2api',
      url: 'https://sub2api.example.com',
      platform: 'sub2api',
    }).returning().get();
    const account = await db.insert(schema.accounts).values({
      siteId: site.id,
      username: 'mikoto',
      accessToken: 'access-token',
      status: 'active',
    }).returning().get();
    await db.insert(schema.accountTokens).values({
      accountId: account.id,
      name: 'team渠道',
      token: 'sk-team-token',
      source: 'sync',
      enabled: true,
      isDefault: true,
      tokenGroup: '2',
      valueStatus: 'ready' as any,
    }).run();
    mockCatalogGroupRatio = { default: 1, '2': 2.5, '纯pro倍率': 2.5 };
    getUserGroupDetailsMock.mockResolvedValue([
      { group: '纯pro倍率', name: '纯pro倍率' },
    ]);

    const overview = await buildTokenGroupPricingOverview({ refresh: true });

    const storedAliasRow = await db.select()
      .from(schema.tokenGroupPricing)
      .where(and(
        eq(schema.tokenGroupPricing.siteId, site.id),
        eq(schema.tokenGroupPricing.sourceKey, `account:${account.id}`),
        eq(schema.tokenGroupPricing.group, '2'),
      ))
      .get();
    expect(storedAliasRow).toMatchObject({
      group: '2',
      groupName: '纯pro倍率',
      ratio: 2.5,
      pricingAvailable: true,
    });
    expect(overview.groupRows.some((item) => item.account?.id === account.id && item.group === '2')).toBe(false);
  });

  it('refreshes pricing with each logged-in account instead of reusing the first site catalog', async () => {
    const site = await db.insert(schema.sites).values({
      name: 'shared-sub2api',
      url: 'https://shared-sub2api.example.com',
      platform: 'sub2api',
    }).returning().get();
    const firstAccount = await db.insert(schema.accounts).values({
      siteId: site.id,
      username: 'first@example.com',
      accessToken: 'first-access-token',
      status: 'active',
    }).returning().get();
    const secondAccount = await db.insert(schema.accounts).values({
      siteId: site.id,
      username: 'second@example.com',
      accessToken: 'second-access-token',
      status: 'active',
    }).returning().get();

    mockCatalogGroupRatioByAccountId = {
      [firstAccount.id]: { default: 1, vip: 0.2 },
      [secondAccount.id]: { default: 1, vip: 0.7 },
    };
    getUserGroupDetailsMock.mockResolvedValue([
      { group: 'vip', name: 'vip' },
    ]);

    const overview = await buildTokenGroupPricingOverview({ refresh: true });
    const firstRow = overview.groupRows.find((item) => item.account?.id === firstAccount.id && item.group === 'vip');
    const secondRow = overview.groupRows.find((item) => item.account?.id === secondAccount.id && item.group === 'vip');

    expect(firstRow).toMatchObject({ ratio: 0.2, pricingAvailable: true });
    expect(secondRow).toMatchObject({ ratio: 0.7, pricingAvailable: true });

    const storedRows = await db.select()
      .from(schema.tokenGroupPricing)
      .where(eq(schema.tokenGroupPricing.siteId, site.id))
      .all();
    expect(storedRows).toEqual(expect.arrayContaining([
      expect.objectContaining({
        accountId: firstAccount.id,
        sourceKey: `account:${firstAccount.id}`,
        group: 'vip',
        ratio: 0.2,
        pricingAvailable: true,
      }),
      expect.objectContaining({
        accountId: secondAccount.id,
        sourceKey: `account:${secondAccount.id}`,
        group: 'vip',
        ratio: 0.7,
        pricingAvailable: true,
      }),
    ]));
  });
});
