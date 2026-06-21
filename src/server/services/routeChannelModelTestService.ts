import { eq } from 'drizzle-orm';
import { config } from '../config.js';
import { db, schema } from '../db/index.js';
import {
  testAccountTokenModelAvailability,
  type AccountTokenModelTestResult,
} from './accountTokenAvailabilityTestService.js';
import { isUsableAccountToken } from './accountTokenService.js';
import { probeRuntimeModel } from './runtimeModelProbe.js';
import * as routeRefreshWorkflow from './routeRefreshWorkflow.js';

export type RouteChannelModelTestResult = Omit<AccountTokenModelTestResult, 'tokenId'> & {
  channelId: number;
  accountId: number;
  tokenId: number | null;
};

function buildTokenResultForChannel(
  channel: typeof schema.routeChannels.$inferSelect,
  result: AccountTokenModelTestResult,
): RouteChannelModelTestResult {
  return {
    ...result,
    channelId: channel.id,
    accountId: channel.accountId,
    tokenId: result.tokenId,
  };
}

function buildAccountProbeResult(input: {
  channel: typeof schema.routeChannels.$inferSelect;
  model: string;
  available: boolean;
  message: string;
  latencyMs: number | null;
  checkedAt: string;
}): RouteChannelModelTestResult {
  return {
    channelId: input.channel.id,
    accountId: input.channel.accountId,
    tokenId: null,
    model: input.model,
    available: input.available,
    message: input.message,
    responseText: null,
    httpStatus: null,
    latencyMs: input.latencyMs,
    checkedAt: input.checkedAt,
  };
}

export async function testRouteChannelModelAvailability(input: {
  channelId: number;
  model: string;
}): Promise<RouteChannelModelTestResult | null> {
  const channelId = Number(input.channelId);
  const model = String(input.model || '').trim();
  if (!Number.isInteger(channelId) || channelId <= 0 || !model) return null;

  const row = await db.select()
    .from(schema.routeChannels)
    .innerJoin(schema.accounts, eq(schema.routeChannels.accountId, schema.accounts.id))
    .innerJoin(schema.sites, eq(schema.accounts.siteId, schema.sites.id))
    .leftJoin(schema.accountTokens, eq(schema.routeChannels.tokenId, schema.accountTokens.id))
    .where(eq(schema.routeChannels.id, channelId))
    .get();
  if (!row) return null;

  const channel = row.route_channels;
  const checkedAt = new Date().toISOString();

  if ((row.accounts.status || 'active') !== 'active' || (row.sites.status || 'active') !== 'active') {
    return buildAccountProbeResult({
      channel,
      model,
      available: false,
      message: '账号或站点已禁用',
      latencyMs: null,
      checkedAt,
    });
  }

  if (channel.tokenId) {
    const token = row.account_tokens;
    if (!token || !isUsableAccountToken(token)) {
      return buildAccountProbeResult({
        channel,
        model,
        available: false,
        message: '通道令牌不可用',
        latencyMs: null,
        checkedAt,
      });
    }
    const test = await testAccountTokenModelAvailability({ model, tokenIds: [channel.tokenId] });
    const result = test.results[0];
    if (result) return buildTokenResultForChannel(channel, result);
    return buildAccountProbeResult({
      channel,
      model,
      available: false,
      message: '测活未返回结果',
      latencyMs: null,
      checkedAt,
    });
  }

  const probe = await probeRuntimeModel({
    site: row.sites,
    account: row.accounts,
    modelName: model,
    timeoutMs: config.modelAvailabilityProbeTimeoutMs,
  });
  const available = probe.status === 'supported';
  const message = available ? '请求成功' : probe.reason;

  await db.insert(schema.modelAvailability)
    .values({
      accountId: channel.accountId,
      modelName: model,
      available,
      latencyMs: probe.latencyMs,
      checkedAt,
    })
    .onConflictDoUpdate({
      target: [schema.modelAvailability.accountId, schema.modelAvailability.modelName],
      set: {
        available,
        latencyMs: probe.latencyMs,
        checkedAt,
      },
    })
    .run();

  if (available) {
    await routeRefreshWorkflow.rebuildRoutesOnly();
  }

  return buildAccountProbeResult({
    channel,
    model,
    available,
    message,
    latencyMs: probe.latencyMs,
    checkedAt,
  });
}
