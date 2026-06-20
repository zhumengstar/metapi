import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { mkdtempSync, rmSync } from 'node:fs';
import { and, eq } from 'drizzle-orm';

const getUserGroupDetailsMock = vi.fn();

vi.mock('./platforms/index.js', () => ({
  getAdapter: () => ({
    getUserGroupDetails: (...args: unknown[]) => getUserGroupDetailsMock(...args),
  }),
}));

vi.mock('./modelPricingService.js', () => ({
  fetchModelPricingCatalog: vi.fn(async () => ({
    models: [],
    groupRatio: mockCatalogGroupRatio,
  })),
  refreshModelPricingCatalog: vi.fn(async () => ({
    models: [],
    groupRatio: mockCatalogGroupRatio,
  })),
  listCatalogModelsForGroup: vi.fn(() => []),
}));

type DbModule = typeof import('../db/index.js');
type OverviewModule = typeof import('./tokenGroupPricingOverviewService.js');
let mockCatalogGroupRatio: Record<string, number> = {};

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
    mockCatalogGroupRatio = {};
    await db.delete(schema.accountTokens).run();
    await db.delete(schema.tokenGroupPricing).run();
    await db.delete(schema.accounts).run();
    await db.delete(schema.sites).run();
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
  });
});
