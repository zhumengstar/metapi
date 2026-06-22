import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { and, eq } from 'drizzle-orm';

const probeRuntimeModelMock = vi.fn();
const rebuildRoutesOnlyMock = vi.fn();

vi.mock('./runtimeModelProbe.js', () => ({
  probeRuntimeModel: (...args: unknown[]) => probeRuntimeModelMock(...args),
}));

vi.mock('./routeRefreshWorkflow.js', () => ({
  rebuildRoutesOnly: (...args: unknown[]) => rebuildRoutesOnlyMock(...args),
}));

type DbModule = typeof import('../db/index.js');
type ServiceModule = typeof import('./routeChannelModelTestService.js');

describe('routeChannelModelTestService', () => {
  let db: DbModule['db'];
  let schema: DbModule['schema'];
  let testRouteChannelModelAvailability: ServiceModule['testRouteChannelModelAvailability'];
  let dataDir = '';
  let originalDataDir: string | undefined;

  beforeAll(async () => {
    dataDir = mkdtempSync(join(tmpdir(), 'metapi-route-channel-test-'));
    originalDataDir = process.env.DATA_DIR;
    process.env.DATA_DIR = dataDir;

    await import('../db/migrate.js');
    const dbModule = await import('../db/index.js');
    const serviceModule = await import('./routeChannelModelTestService.js');

    db = dbModule.db;
    schema = dbModule.schema;
    testRouteChannelModelAvailability = serviceModule.testRouteChannelModelAvailability;
  });

  beforeEach(async () => {
    probeRuntimeModelMock.mockReset();
    rebuildRoutesOnlyMock.mockReset();
    rebuildRoutesOnlyMock.mockResolvedValue(undefined);
    probeRuntimeModelMock.mockResolvedValue({
      status: 'supported',
      latencyMs: 42,
      reason: 'probe succeeded',
    });

    await db.delete(schema.routeChannels).run();
    await db.delete(schema.tokenRoutes).run();
    await db.delete(schema.modelAvailability).run();
    await db.delete(schema.tokenModelAvailability).run();
    await db.delete(schema.accountTokens).run();
    await db.delete(schema.accounts).run();
    await db.delete(schema.sites).run();
  });

  afterAll(() => {
    if (originalDataDir === undefined) {
      delete process.env.DATA_DIR;
    } else {
      process.env.DATA_DIR = originalDataDir;
    }
  });

  it('tests an account-backed route channel without requiring an account token', async () => {
    const site = await db.insert(schema.sites).values({
      name: 'oauth-site',
      url: 'https://oauth.example.com',
      platform: 'openai',
      status: 'active',
    }).returning().get();
    const account = await db.insert(schema.accounts).values({
      siteId: site.id,
      username: 'oauth-user',
      accessToken: 'oauth-access-token',
      apiToken: '',
      status: 'active',
    }).returning().get();
    const route = await db.insert(schema.tokenRoutes).values({
      modelPattern: 'gpt-5.5',
      enabled: true,
    }).returning().get();
    const channel = await db.insert(schema.routeChannels).values({
      routeId: route.id,
      accountId: account.id,
      tokenId: null,
      enabled: true,
      sourceModel: 'gpt-5.5',
      cooldownUntil: '2099-01-01T00:00:00.000Z',
      lastFailAt: '2026-06-22T00:00:00.000Z',
      consecutiveFailCount: 3,
      cooldownLevel: 2,
    }).returning().get();

    const result = await testRouteChannelModelAvailability({
      channelId: channel.id,
      model: 'gpt-5.5',
    });

    expect(result).toMatchObject({
      channelId: channel.id,
      accountId: account.id,
      tokenId: null,
      model: 'gpt-5.5',
      available: true,
      message: '请求成功',
      latencyMs: 42,
    });
    expect(probeRuntimeModelMock).toHaveBeenCalledTimes(1);
    expect(probeRuntimeModelMock.mock.calls[0]?.[0]).toMatchObject({
      site: expect.objectContaining({ id: site.id }),
      account: expect.objectContaining({ id: account.id }),
      modelName: 'gpt-5.5',
    });
    expect(rebuildRoutesOnlyMock).toHaveBeenCalledTimes(1);

    const availability = await db.select().from(schema.modelAvailability)
      .where(and(
        eq(schema.modelAvailability.accountId, account.id),
        eq(schema.modelAvailability.modelName, 'gpt-5.5'),
      ))
      .get();
    expect(availability).toMatchObject({
      available: true,
      latencyMs: 42,
    });
    const refreshedChannel = await db.select().from(schema.routeChannels)
      .where(eq(schema.routeChannels.id, channel.id))
      .get();
    expect(refreshedChannel).toMatchObject({
      cooldownUntil: null,
      lastFailAt: null,
      consecutiveFailCount: 0,
      cooldownLevel: 0,
    });
  });
});
