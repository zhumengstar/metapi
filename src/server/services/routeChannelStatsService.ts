import { and, eq, inArray } from 'drizzle-orm';
import { db, schema } from '../db/index.js';
import { buildRouteChannelIdentityKey } from './routeChannelIdentity.js';
import { invalidateTokenRouterCache } from './tokenRouter.js';

type RouteChannelRow = typeof schema.routeChannels.$inferSelect;
type TokenRouteRow = typeof schema.tokenRoutes.$inferSelect;
type RouteChannelStatSnapshotRow = typeof schema.routeChannelStatSnapshots.$inferSelect;

type RouteChannelStatsInput = Pick<RouteChannelRow,
  | 'successCount'
  | 'failCount'
  | 'totalLatencyMs'
  | 'totalCost'
  | 'totalInputTokens'
  | 'lastUsedAt'
  | 'lastSelectedAt'
  | 'lastFailAt'
  | 'consecutiveFailCount'
  | 'cooldownLevel'
  | 'cooldownUntil'
>;

export type RouteChannelStats = Required<Pick<RouteChannelStatsInput,
  | 'successCount'
  | 'failCount'
  | 'totalLatencyMs'
  | 'totalCost'
  | 'totalInputTokens'
  | 'consecutiveFailCount'
  | 'cooldownLevel'
>> & Pick<RouteChannelStatsInput,
  | 'lastUsedAt'
  | 'lastSelectedAt'
  | 'lastFailAt'
  | 'cooldownUntil'
>;

export type RouteChannelStatsCandidate = {
  modelPattern: string;
  accountId: number;
  tokenId?: number | null;
  oauthRouteUnitId?: number | null;
  sourceModel?: string | null;
};

function normalizeModelPattern(value: string | null | undefined): string {
  return String(value || '').trim();
}

function normalizeNullableId(value: number | null | undefined): number | null {
  return typeof value === 'number' && Number.isFinite(value) && value > 0 ? Math.trunc(value) : null;
}

export function buildRouteChannelStatsIdentityKey(input: RouteChannelStatsCandidate): string {
  const modelPattern = normalizeModelPattern(input.modelPattern).toLowerCase();
  return `${modelPattern}::${buildRouteChannelIdentityKey({
    accountId: input.accountId,
    tokenId: input.tokenId,
    oauthRouteUnitId: input.oauthRouteUnitId,
    sourceModel: input.sourceModel,
  })}`;
}

function latestText(left: string | null | undefined, right: string | null | undefined): string | null {
  if (!left) return right || null;
  if (!right) return left;
  return right > left ? right : left;
}

function nonNegativeNumber(value: number | null | undefined): number {
  const numeric = Number(value ?? 0);
  return Number.isFinite(numeric) ? Math.max(0, numeric) : 0;
}

function normalizeStats(input?: Partial<RouteChannelStatsInput> | null): RouteChannelStats {
  return {
    successCount: nonNegativeNumber(input?.successCount),
    failCount: nonNegativeNumber(input?.failCount),
    totalLatencyMs: nonNegativeNumber(input?.totalLatencyMs),
    totalCost: nonNegativeNumber(input?.totalCost),
    totalInputTokens: nonNegativeNumber(input?.totalInputTokens),
    lastUsedAt: input?.lastUsedAt || null,
    lastSelectedAt: input?.lastSelectedAt || null,
    lastFailAt: input?.lastFailAt || null,
    consecutiveFailCount: nonNegativeNumber(input?.consecutiveFailCount),
    cooldownLevel: nonNegativeNumber(input?.cooldownLevel),
    cooldownUntil: input?.cooldownUntil || null,
  };
}

export function mergeRouteChannelStats(
  left?: Partial<RouteChannelStatsInput> | null,
  right?: Partial<RouteChannelStatsInput> | null,
): RouteChannelStats {
  const a = normalizeStats(left);
  const b = normalizeStats(right);
  return {
    successCount: Math.max(nonNegativeNumber(a.successCount), nonNegativeNumber(b.successCount)),
    failCount: Math.max(nonNegativeNumber(a.failCount), nonNegativeNumber(b.failCount)),
    totalLatencyMs: Math.max(nonNegativeNumber(a.totalLatencyMs), nonNegativeNumber(b.totalLatencyMs)),
    totalCost: Math.max(nonNegativeNumber(a.totalCost), nonNegativeNumber(b.totalCost)),
    totalInputTokens: Math.max(nonNegativeNumber(a.totalInputTokens), nonNegativeNumber(b.totalInputTokens)),
    lastUsedAt: latestText(a.lastUsedAt, b.lastUsedAt),
    lastSelectedAt: latestText(a.lastSelectedAt, b.lastSelectedAt),
    lastFailAt: latestText(a.lastFailAt, b.lastFailAt),
    consecutiveFailCount: Math.max(nonNegativeNumber(a.consecutiveFailCount), nonNegativeNumber(b.consecutiveFailCount)),
    cooldownLevel: Math.max(nonNegativeNumber(a.cooldownLevel), nonNegativeNumber(b.cooldownLevel)),
    cooldownUntil: latestText(a.cooldownUntil, b.cooldownUntil),
  };
}

function snapshotToStats(row: RouteChannelStatSnapshotRow | null | undefined): RouteChannelStats | null {
  return row ? normalizeStats(row) : null;
}

function buildSnapshotIdentity(channel: RouteChannelRow, route: Pick<TokenRouteRow, 'modelPattern'>): RouteChannelStatsCandidate {
  return {
    modelPattern: route.modelPattern,
    accountId: channel.accountId,
    tokenId: channel.tokenId,
    oauthRouteUnitId: channel.oauthRouteUnitId,
    sourceModel: channel.sourceModel,
  };
}

async function loadRoutesById(routeIds: number[]): Promise<Map<number, TokenRouteRow>> {
  const normalizedRouteIds = Array.from(new Set(
    routeIds.filter((routeId) => Number.isFinite(routeId) && routeId > 0),
  ));
  if (normalizedRouteIds.length === 0) return new Map();
  const routes = await db.select().from(schema.tokenRoutes)
    .where(inArray(schema.tokenRoutes.id, normalizedRouteIds))
    .all();
  return new Map(routes.map((route) => [route.id, route]));
}

export async function archiveRouteChannelStats(
  channel: RouteChannelRow,
  route?: Pick<TokenRouteRow, 'modelPattern'> | null,
): Promise<void> {
  const resolvedRoute = route || await db.select({ modelPattern: schema.tokenRoutes.modelPattern })
    .from(schema.tokenRoutes)
    .where(eq(schema.tokenRoutes.id, channel.routeId))
    .get();
  if (!resolvedRoute) return;

  const identity = buildSnapshotIdentity(channel, resolvedRoute);
  const modelPattern = normalizeModelPattern(identity.modelPattern);
  if (!modelPattern) return;

  const identityKey = buildRouteChannelStatsIdentityKey(identity);
  const existing = await db.select().from(schema.routeChannelStatSnapshots)
    .where(eq(schema.routeChannelStatSnapshots.identityKey, identityKey))
    .get();
  const merged = mergeRouteChannelStats(existing, channel);
  const now = new Date().toISOString();
  const values = {
    identityKey,
    modelPattern,
    accountId: channel.accountId,
    tokenId: normalizeNullableId(channel.tokenId),
    oauthRouteUnitId: normalizeNullableId(channel.oauthRouteUnitId),
    sourceModel: channel.sourceModel || null,
    ...merged,
    updatedAt: now,
  };

  if (existing) {
    await db.update(schema.routeChannelStatSnapshots)
      .set(values)
      .where(eq(schema.routeChannelStatSnapshots.id, existing.id))
      .run();
    return;
  }

  await db.insert(schema.routeChannelStatSnapshots)
    .values({
      ...values,
      createdAt: now,
    })
    .run();
}

export async function archiveRouteChannelStatsMany(
  channels: RouteChannelRow[],
  routesById?: Map<number, Pick<TokenRouteRow, 'modelPattern'>>,
): Promise<void> {
  if (channels.length === 0) return;
  const routeMap = routesById || await loadRoutesById(channels.map((channel) => channel.routeId));
  for (const channel of channels) {
    await archiveRouteChannelStats(channel, routeMap.get(channel.routeId) || null);
  }
}

export async function getArchivedRouteChannelStats(
  candidate: RouteChannelStatsCandidate,
): Promise<RouteChannelStats | null> {
  const identityKey = buildRouteChannelStatsIdentityKey(candidate);
  const row = await db.select().from(schema.routeChannelStatSnapshots)
    .where(eq(schema.routeChannelStatSnapshots.identityKey, identityKey))
    .get();
  return snapshotToStats(row);
}

export async function resolveRouteChannelStats(
  candidate: RouteChannelStatsCandidate,
  usageSource?: Partial<RouteChannelStatsInput> | null,
): Promise<RouteChannelStats> {
  const archived = await getArchivedRouteChannelStats(candidate);
  return mergeRouteChannelStats(usageSource || null, archived);
}

export async function deleteRouteChannelPreservingStats(channelId: number): Promise<number> {
  if (!Number.isFinite(channelId) || channelId <= 0) return 0;
  const channel = await db.select().from(schema.routeChannels)
    .where(eq(schema.routeChannels.id, Math.trunc(channelId)))
    .get();
  if (!channel) return 0;
  await archiveRouteChannelStats(channel);
  return (await db.delete(schema.routeChannels)
    .where(eq(schema.routeChannels.id, channel.id))
    .run()).changes;
}

export async function deleteRouteChannelsPreservingStats(channels: RouteChannelRow[]): Promise<number> {
  if (channels.length === 0) return 0;
  await archiveRouteChannelStatsMany(channels);
  const ids = channels.map((channel) => channel.id).filter((id) => Number.isFinite(id) && id > 0);
  if (ids.length === 0) return 0;
  const result = await db.delete(schema.routeChannels)
    .where(inArray(schema.routeChannels.id, ids))
    .run();
  invalidateTokenRouterCache();
  return result.changes;
}

export async function deleteRouteChannelsByTokenIdsPreservingStats(tokenIds: number[]): Promise<number> {
  const ids = Array.from(new Set(
    tokenIds.map((id) => Number(id)).filter((id) => Number.isInteger(id) && id > 0),
  ));
  if (ids.length === 0) return 0;
  const channels = await db.select().from(schema.routeChannels)
    .where(inArray(schema.routeChannels.tokenId, ids))
    .all();
  return deleteRouteChannelsPreservingStats(channels);
}

export async function deleteRouteChannelsByTokenIdPreservingStats(tokenId: number): Promise<number> {
  return deleteRouteChannelsByTokenIdsPreservingStats([tokenId]);
}

export async function deleteRouteChannelsByOauthRouteUnitIdPreservingStats(routeUnitId: number): Promise<number> {
  if (!Number.isFinite(routeUnitId) || routeUnitId <= 0) return 0;
  const channels = await db.select().from(schema.routeChannels)
    .where(eq(schema.routeChannels.oauthRouteUnitId, Math.trunc(routeUnitId)))
    .all();
  return deleteRouteChannelsPreservingStats(channels);
}

export async function deleteRoutePreservingChannelStats(routeId: number): Promise<number> {
  if (!Number.isFinite(routeId) || routeId <= 0) return 0;
  const route = await db.select().from(schema.tokenRoutes)
    .where(eq(schema.tokenRoutes.id, Math.trunc(routeId)))
    .get();
  if (!route) return 0;
  const channels = await db.select().from(schema.routeChannels)
    .where(eq(schema.routeChannels.routeId, route.id))
    .all();
  await archiveRouteChannelStatsMany(channels, new Map([[route.id, route]]));
  return (await db.delete(schema.tokenRoutes)
    .where(eq(schema.tokenRoutes.id, route.id))
    .run()).changes;
}

export async function deleteRouteChannelsByOauthRouteUnitIdsPreservingStats(routeUnitIds: number[]): Promise<number> {
  const ids = Array.from(new Set(
    routeUnitIds.map((id) => Number(id)).filter((id) => Number.isInteger(id) && id > 0),
  ));
  if (ids.length === 0) return 0;
  const channels = await db.select().from(schema.routeChannels)
    .where(inArray(schema.routeChannels.oauthRouteUnitId, ids))
    .all();
  return deleteRouteChannelsPreservingStats(channels);
}
