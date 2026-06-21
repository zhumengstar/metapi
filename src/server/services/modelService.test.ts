import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { and, eq } from 'drizzle-orm';

type DbModule = typeof import('../db/index.js');
type ModelServiceModule = typeof import('./modelService.js');

describe('rebuildTokenRoutesFromAvailability', () => {
  let db: DbModule['db'];
  let schema: DbModule['schema'];
  let rebuildTokenRoutesFromAvailability: ModelServiceModule['rebuildTokenRoutesFromAvailability'];
  let dataDir = '';

  beforeAll(async () => {
    dataDir = mkdtempSync(join(tmpdir(), 'metapi-model-service-'));
    process.env.DATA_DIR = dataDir;

    await import('../db/migrate.js');
    const dbModule = await import('../db/index.js');
    const modelService = await import('./modelService.js');

    db = dbModule.db;
    schema = dbModule.schema;
    rebuildTokenRoutesFromAvailability = modelService.rebuildTokenRoutesFromAvailability;
  });

  beforeEach(async () => {
    await db.delete(schema.routeChannels).run();
    await db.delete(schema.routeChannelStatSnapshots).run();
    await db.delete(schema.tokenRoutes).run();
    await db.delete(schema.tokenModelAvailability).run();
    await db.delete(schema.modelAvailability).run();
    await db.delete(schema.accountTokens).run();
    await db.delete(schema.accounts).run();
    await db.delete(schema.sites).run();
  });

  afterAll(() => {
    delete process.env.DATA_DIR;
  });

  it('creates an exact route with an account-direct channel for apikey model availability', async () => {
    const site = await db.insert(schema.sites).values({
      name: 'apikey-site',
      url: 'https://apikey-site.example.com',
      platform: 'new-api',
    }).returning().get();

    const account = await db.insert(schema.accounts).values({
      siteId: site.id,
      username: 'apikey-user',
      accessToken: '',
      apiToken: 'sk-apikey-route',
      status: 'active',
      extraConfig: JSON.stringify({ credentialMode: 'apikey' }),
    }).returning().get();

    await db.insert(schema.modelAvailability).values({
      accountId: account.id,
      modelName: 'gpt-5.2-codex',
      available: true,
      latencyMs: 1200,
      checkedAt: '2026-03-08T08:00:00.000Z',
    }).run();

    const rebuild = await rebuildTokenRoutesFromAvailability();

    expect(rebuild.models).toBe(1);

    const route = await db.select().from(schema.tokenRoutes)
      .where(eq(schema.tokenRoutes.modelPattern, 'gpt-5.2-codex'))
      .get();
    expect(route).toBeDefined();
    expect(route?.routingStrategy).toBe('stable_first');

    const channels = await db.select().from(schema.routeChannels)
      .where(and(
        eq(schema.routeChannels.routeId, route!.id),
        eq(schema.routeChannels.accountId, account.id),
      ))
      .all();

    expect(channels).toHaveLength(1);
    expect(channels[0]?.tokenId ?? null).toBeNull();
    expect(channels[0]?.manualOverride).toBe(false);
  });

  it('keeps existing route strategy while new auto-created routes use stable first', async () => {
    const site = await db.insert(schema.sites).values({
      name: 'strategy-site',
      url: 'https://strategy-site.example.com',
      platform: 'new-api',
    }).returning().get();

    const account = await db.insert(schema.accounts).values({
      siteId: site.id,
      username: 'strategy-user',
      accessToken: '',
      apiToken: 'sk-strategy-route',
      status: 'active',
      extraConfig: JSON.stringify({ credentialMode: 'apikey' }),
    }).returning().get();

    await db.insert(schema.tokenRoutes).values({
      modelPattern: 'existing-model',
      routingStrategy: 'weighted',
      enabled: true,
    }).run();

    await db.insert(schema.modelAvailability).values([
      {
        accountId: account.id,
        modelName: 'existing-model',
        available: true,
        latencyMs: 100,
        checkedAt: '2026-03-08T08:00:00.000Z',
      },
      {
        accountId: account.id,
        modelName: 'new-model',
        available: true,
        latencyMs: 120,
        checkedAt: '2026-03-08T08:00:00.000Z',
      },
    ]).run();

    const rebuild = await rebuildTokenRoutesFromAvailability();

    expect(rebuild.createdRoutes).toBe(1);

    const existingRoute = await db.select().from(schema.tokenRoutes)
      .where(eq(schema.tokenRoutes.modelPattern, 'existing-model'))
      .get();
    const newRoute = await db.select().from(schema.tokenRoutes)
      .where(eq(schema.tokenRoutes.modelPattern, 'new-model'))
      .get();

    expect(existingRoute?.routingStrategy).toBe('weighted');
    expect(newRoute?.routingStrategy).toBe('stable_first');
  });

  it('ignores hidden account_tokens for direct apikey connections when rebuilding routes', async () => {
    const site = await db.insert(schema.sites).values({
      name: 'apikey-legacy-site',
      url: 'https://apikey-legacy.example.com',
      platform: 'new-api',
    }).returning().get();

    const account = await db.insert(schema.accounts).values({
      siteId: site.id,
      username: 'apikey-legacy-user',
      accessToken: '',
      apiToken: 'sk-direct-credential',
      status: 'active',
      extraConfig: JSON.stringify({ credentialMode: 'apikey' }),
    }).returning().get();

    const hiddenToken = await db.insert(schema.accountTokens).values({
      accountId: account.id,
      name: 'legacy-hidden',
      token: 'sk-hidden-legacy-token',
      source: 'legacy',
      enabled: true,
      isDefault: true,
    }).returning().get();

    await db.insert(schema.modelAvailability).values({
      accountId: account.id,
      modelName: 'gpt-4.1',
      available: true,
      latencyMs: 200,
      checkedAt: '2026-03-20T08:00:00.000Z',
    }).run();

    await db.insert(schema.tokenModelAvailability).values({
      tokenId: hiddenToken.id,
      modelName: 'gpt-4.1',
      available: true,
      routeEnabled: true,
      latencyMs: 180,
      message: '请求成功',
      httpStatus: 200,
      responseText: 'OK',
      checkedAt: '2026-03-20T08:00:00.000Z',
    }).run();

    const rebuild = await rebuildTokenRoutesFromAvailability();

    expect(rebuild.models).toBe(1);

    const route = await db.select().from(schema.tokenRoutes)
      .where(eq(schema.tokenRoutes.modelPattern, 'gpt-4.1'))
      .get();
    expect(route).toBeDefined();

    const channels = await db.select().from(schema.routeChannels)
      .where(and(
        eq(schema.routeChannels.routeId, route!.id),
        eq(schema.routeChannels.accountId, account.id),
      ))
      .all();

    expect(channels).toHaveLength(1);
    expect(channels[0]?.tokenId ?? null).toBeNull();
  });

  it('does not route account token models until they are explicitly enabled for routing', async () => {
    const site = await db.insert(schema.sites).values({
      name: 'managed-site',
      url: 'https://managed.example.com',
      platform: 'new-api',
    }).returning().get();

    const account = await db.insert(schema.accounts).values({
      siteId: site.id,
      username: 'managed-user',
      accessToken: 'session-token',
      status: 'active',
      extraConfig: JSON.stringify({ credentialMode: 'session' }),
    }).returning().get();

    const token = await db.insert(schema.accountTokens).values({
      accountId: account.id,
      name: 'managed-token',
      token: 'sk-managed-token',
      source: 'synced',
      enabled: true,
      isDefault: true,
    }).returning().get();

    await db.insert(schema.tokenModelAvailability).values({
      tokenId: token.id,
      modelName: 'gpt-5.5',
      available: true,
      routeEnabled: false,
    }).run();

    const rebuild = await rebuildTokenRoutesFromAvailability();

    expect(rebuild.models).toBe(0);
    const route = await db.select().from(schema.tokenRoutes)
      .where(eq(schema.tokenRoutes.modelPattern, 'gpt-5.5'))
      .get();
    expect(route).toBeUndefined();
  });

  it('routes image account token models when route-enabled even without a chat availability success', async () => {
    const site = await db.insert(schema.sites).values({
      name: 'managed-image-site',
      url: 'https://managed-image.example.com',
      platform: 'new-api',
    }).returning().get();

    const account = await db.insert(schema.accounts).values({
      siteId: site.id,
      username: 'managed-image-user',
      accessToken: 'session-token',
      status: 'active',
      extraConfig: JSON.stringify({ credentialMode: 'session' }),
    }).returning().get();

    const token = await db.insert(schema.accountTokens).values({
      accountId: account.id,
      name: 'managed-image-token',
      token: 'sk-managed-image-token',
      source: 'synced',
      enabled: true,
      isDefault: true,
      valueStatus: 'ready' as any,
    }).returning().get();

    await db.insert(schema.tokenModelAvailability).values({
      tokenId: token.id,
      modelName: 'gpt-image-1',
      available: false,
      routeEnabled: true,
      message: '图片模型不进行聊天可用性测试',
      httpStatus: null,
    }).run();

    const rebuild = await rebuildTokenRoutesFromAvailability();

    expect(rebuild.models).toBe(1);
    const route = await db.select().from(schema.tokenRoutes)
      .where(eq(schema.tokenRoutes.modelPattern, 'gpt-image-1'))
      .get();
    expect(route).toBeDefined();

    const channels = await db.select().from(schema.routeChannels)
      .where(and(
        eq(schema.routeChannels.routeId, route!.id),
        eq(schema.routeChannels.accountId, account.id),
      ))
      .all();

    expect(channels).toHaveLength(1);
    expect(channels[0]?.tokenId).toBe(token.id);
  });

  it('creates an exact route with an account-direct channel for oauth model availability', async () => {
    const site = await db.insert(schema.sites).values({
      name: 'codex-site',
      url: 'https://chatgpt.com/backend-api/codex',
      platform: 'codex',
    }).returning().get();

    const account = await db.insert(schema.accounts).values({
      siteId: site.id,
      username: 'codex-user@example.com',
      accessToken: 'oauth-access-token',
      apiToken: null,
      status: 'active',
      extraConfig: JSON.stringify({
        credentialMode: 'session',
        oauth: {
          provider: 'codex',
          accountId: 'chatgpt-account-123',
          email: 'codex-user@example.com',
          planType: 'team',
        },
      }),
    }).returning().get();

    await db.insert(schema.modelAvailability).values({
      accountId: account.id,
      modelName: 'gpt-5.2-codex',
      available: true,
      latencyMs: 320,
      checkedAt: '2026-03-17T00:00:00.000Z',
    }).run();

    const rebuild = await rebuildTokenRoutesFromAvailability();

    expect(rebuild.models).toBe(1);

    const route = await db.select().from(schema.tokenRoutes)
      .where(eq(schema.tokenRoutes.modelPattern, 'gpt-5.2-codex'))
      .get();
    expect(route).toBeDefined();

    const channels = await db.select().from(schema.routeChannels)
      .where(and(
        eq(schema.routeChannels.routeId, route!.id),
        eq(schema.routeChannels.accountId, account.id),
      ))
      .all();

    expect(channels).toHaveLength(1);
    expect(channels[0]?.tokenId ?? null).toBeNull();
    expect(channels[0]?.manualOverride).toBe(false);
  });

  it('creates an exact route with an account-direct channel for oauth accounts stored via structured identity columns', async () => {
    const site = await db.insert(schema.sites).values({
      name: 'codex-site-structured',
      url: 'https://chatgpt.com/backend-api/codex',
      platform: 'codex',
    }).returning().get();

    const account = await db.insert(schema.accounts).values({
      siteId: site.id,
      username: 'codex-structured@example.com',
      accessToken: 'oauth-access-token',
      apiToken: null,
      status: 'active',
      oauthProvider: 'codex',
      oauthAccountKey: 'chatgpt-account-structured-123',
      extraConfig: JSON.stringify({
        credentialMode: 'session',
        oauth: {
          email: 'codex-structured@example.com',
          planType: 'team',
        },
      }),
    }).returning().get();

    await db.insert(schema.modelAvailability).values({
      accountId: account.id,
      modelName: 'gpt-5.2-codex',
      available: true,
      latencyMs: 320,
      checkedAt: '2026-04-01T00:00:00.000Z',
    }).run();

    const rebuild = await rebuildTokenRoutesFromAvailability();

    expect(rebuild.models).toBe(1);

    const route = await db.select().from(schema.tokenRoutes)
      .where(eq(schema.tokenRoutes.modelPattern, 'gpt-5.2-codex'))
      .get();
    expect(route).toBeDefined();

    const channels = await db.select().from(schema.routeChannels)
      .where(and(
        eq(schema.routeChannels.routeId, route!.id),
        eq(schema.routeChannels.accountId, account.id),
      ))
      .all();

    expect(channels).toHaveLength(1);
    expect(channels[0]?.tokenId ?? null).toBeNull();
    expect(channels[0]?.manualOverride).toBe(false);
  });

  it('removes stale exact routes and keeps wildcard routes on rebuild', async () => {
    const site = await db.insert(schema.sites).values({
      name: 'site-1',
      url: 'https://site-1.example.com',
      platform: 'new-api',
    }).returning().get();

    const account = await db.insert(schema.accounts).values({
      siteId: site.id,
      username: 'user-1',
      accessToken: 'access-1',
      status: 'active',
    }).returning().get();

    const token = await db.insert(schema.accountTokens).values({
      accountId: account.id,
      name: 'default',
      token: 'sk-test',
      source: 'manual',
      enabled: true,
      isDefault: true,
    }).returning().get();

    await db.insert(schema.tokenModelAvailability).values({
      tokenId: token.id,
      modelName: 'latest-model',
      available: true,
      routeEnabled: true,
      message: '请求成功',
      httpStatus: 200,
      responseText: 'OK',
    }).run();

    const staleRoute = await db.insert(schema.tokenRoutes).values({
      modelPattern: 'old-model',
      enabled: true,
    }).returning().get();

    await db.insert(schema.routeChannels).values({
      routeId: staleRoute.id,
      accountId: account.id,
      tokenId: token.id,
      priority: 0,
      weight: 10,
      enabled: true,
      manualOverride: false,
    }).run();

    const wildcardRoute = await db.insert(schema.tokenRoutes).values({
      modelPattern: 'gpt-*',
      enabled: true,
    }).returning().get();

    await db.insert(schema.routeChannels).values({
      routeId: wildcardRoute.id,
      accountId: account.id,
      tokenId: token.id,
      priority: 0,
      weight: 10,
      enabled: true,
      manualOverride: false,
    }).run();

    const rebuild = await rebuildTokenRoutesFromAvailability();

    expect(rebuild.models).toBe(1);
    expect(rebuild.removedRoutes).toBe(1);

    const oldRoute = await db.select().from(schema.tokenRoutes).where(eq(schema.tokenRoutes.id, staleRoute.id)).get();
    expect(oldRoute).toBeUndefined();

    const oldChannels = await db.select().from(schema.routeChannels).where(eq(schema.routeChannels.routeId, staleRoute.id)).all();
    expect(oldChannels).toHaveLength(0);

    const latestRoute = await db.select().from(schema.tokenRoutes).where(eq(schema.tokenRoutes.modelPattern, 'latest-model')).get();
    expect(latestRoute).toBeDefined();
    const latestChannels = await db.select().from(schema.routeChannels)
      .where(and(eq(schema.routeChannels.routeId, latestRoute!.id), eq(schema.routeChannels.tokenId, token.id)))
      .all();
    expect(latestChannels.length).toBeGreaterThan(0);

    const wildcardRouteAfter = await db.select().from(schema.tokenRoutes).where(eq(schema.tokenRoutes.id, wildcardRoute.id)).get();
    expect(wildcardRouteAfter).toBeDefined();
  });

  it('restores route channel statistics after automatic route deletion and recreation', async () => {
    const site = await db.insert(schema.sites).values({
      name: 'stats-site',
      url: 'https://stats.example.com',
      platform: 'new-api',
    }).returning().get();

    const account = await db.insert(schema.accounts).values({
      siteId: site.id,
      username: 'stats-user',
      accessToken: 'session-token',
      status: 'active',
      extraConfig: JSON.stringify({ credentialMode: 'session' }),
    }).returning().get();

    const token = await db.insert(schema.accountTokens).values({
      accountId: account.id,
      name: 'stats-token',
      token: 'sk-stats-token',
      source: 'manual',
      enabled: true,
      isDefault: true,
      valueStatus: 'ready' as any,
    }).returning().get();

    await db.insert(schema.tokenModelAvailability).values({
      tokenId: token.id,
      modelName: 'stats-model',
      available: true,
      routeEnabled: true,
      message: '请求成功',
      httpStatus: 200,
      responseText: 'OK',
    }).run();

    await rebuildTokenRoutesFromAvailability();

    const initialRoute = await db.select().from(schema.tokenRoutes)
      .where(eq(schema.tokenRoutes.modelPattern, 'stats-model'))
      .get();
    expect(initialRoute).toBeDefined();
    const initialChannel = await db.select().from(schema.routeChannels)
      .where(and(
        eq(schema.routeChannels.routeId, initialRoute!.id),
        eq(schema.routeChannels.tokenId, token.id),
      ))
      .get();
    expect(initialChannel).toBeDefined();

    await db.update(schema.routeChannels).set({
      successCount: 17,
      failCount: 3,
      totalLatencyMs: 12000,
      totalCost: 0.42,
      totalInputTokens: 9000,
      lastUsedAt: '2026-06-21T01:00:00.000Z',
      lastSelectedAt: '2026-06-21T01:01:00.000Z',
      lastFailAt: '2026-06-21T00:59:00.000Z',
      consecutiveFailCount: 2,
      cooldownLevel: 1,
      cooldownUntil: '2026-06-21T01:05:00.000Z',
    }).where(eq(schema.routeChannels.id, initialChannel!.id)).run();

    await db.update(schema.tokenModelAvailability).set({ routeEnabled: false })
      .where(eq(schema.tokenModelAvailability.tokenId, token.id))
      .run();
    await rebuildTokenRoutesFromAvailability();

    const archived = await db.select().from(schema.routeChannelStatSnapshots).all();
    expect(archived).toHaveLength(1);
    expect(archived[0]?.successCount).toBe(17);
    expect(archived[0]?.failCount).toBe(3);
    expect(archived[0]?.totalInputTokens).toBe(9000);

    await db.update(schema.tokenModelAvailability).set({ routeEnabled: true })
      .where(eq(schema.tokenModelAvailability.tokenId, token.id))
      .run();
    await rebuildTokenRoutesFromAvailability();

    const recreatedRoute = await db.select().from(schema.tokenRoutes)
      .where(eq(schema.tokenRoutes.modelPattern, 'stats-model'))
      .get();
    expect(recreatedRoute).toBeDefined();
    const recreatedChannel = await db.select().from(schema.routeChannels)
      .where(and(
        eq(schema.routeChannels.routeId, recreatedRoute!.id),
        eq(schema.routeChannels.tokenId, token.id),
      ))
      .get();

    expect(recreatedChannel?.successCount).toBe(17);
    expect(recreatedChannel?.failCount).toBe(3);
    expect(recreatedChannel?.totalLatencyMs).toBe(12000);
    expect(recreatedChannel?.totalCost).toBe(0.42);
    expect(recreatedChannel?.totalInputTokens).toBe(9000);
    expect(recreatedChannel?.lastUsedAt).toBe('2026-06-21T01:00:00.000Z');
    expect(recreatedChannel?.lastSelectedAt).toBe('2026-06-21T01:01:00.000Z');
    expect(recreatedChannel?.lastFailAt).toBe('2026-06-21T00:59:00.000Z');
    expect(recreatedChannel?.consecutiveFailCount).toBe(2);
    expect(recreatedChannel?.cooldownLevel).toBe(1);
    expect(recreatedChannel?.cooldownUntil).toBe('2026-06-21T01:05:00.000Z');
  });
});
