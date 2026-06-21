import { eq } from 'drizzle-orm';
import { db, schema } from '../db/index.js';
import { resolveAccountTokenManualEnabledPreference } from './accountTokenService.js';
import { deleteRouteChannelsByTokenIdPreservingStats } from './routeChannelStatsService.js';
import { invalidateTokenRouterCache } from './tokenRouter.js';

export async function removeRouteChannelsForAccountToken(tokenId: number): Promise<void> {
  await deleteRouteChannelsByTokenIdPreservingStats(tokenId);
  invalidateTokenRouterCache();
}

export async function markAccountTokenAutoDisabledForEmptyModels(
  token: typeof schema.accountTokens.$inferSelect,
  checkedAt: string,
): Promise<void> {
  if (token.autoDisabledAt) {
    await db.update(schema.accountTokens)
      .set({
        enabled: false,
        modelSyncedAt: checkedAt,
        autoDisabledReason: '模型拉取为空',
        updatedAt: checkedAt,
      })
      .where(eq(schema.accountTokens.id, token.id))
      .run();
    await removeRouteChannelsForAccountToken(token.id);
    return;
  }

  await db.update(schema.accountTokens)
    .set({
      enabled: false,
      modelSyncedAt: checkedAt,
      autoDisabledAt: checkedAt,
      autoDisabledReason: '模型拉取为空',
      autoDisabledPreviousEnabled: token.enabled === true,
      updatedAt: checkedAt,
    })
    .where(eq(schema.accountTokens.id, token.id))
    .run();
  await removeRouteChannelsForAccountToken(token.id);
}

export async function clearAccountTokenAutoDisabledAfterModels(
  token: typeof schema.accountTokens.$inferSelect,
  checkedAt: string,
): Promise<void> {
  const manualEnabledPreference = await resolveAccountTokenManualEnabledPreference({
    accountId: token.accountId,
    tokenGroup: token.tokenGroup,
    tokenName: token.name,
  });
  const updates: Partial<typeof schema.accountTokens.$inferInsert> = {
    modelSyncedAt: checkedAt,
    autoDisabledAt: null,
    autoDisabledReason: null,
    autoDisabledPreviousEnabled: null,
    updatedAt: checkedAt,
  };
  if (token.autoDisabledAt) {
    updates.enabled = manualEnabledPreference ?? token.autoDisabledPreviousEnabled ?? false;
  }
  await db.update(schema.accountTokens)
    .set(updates)
    .where(eq(schema.accountTokens.id, token.id))
    .run();
}
