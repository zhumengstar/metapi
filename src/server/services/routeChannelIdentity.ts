type RouteChannelIdentityInput = {
  accountId: number;
  tokenId?: number | null;
  oauthRouteUnitId?: number | null;
  sourceModel?: string | null;
};

function normalizeOptionalId(value: number | null | undefined): number | null {
  return typeof value === 'number' && Number.isFinite(value) && value > 0 ? Math.trunc(value) : null;
}

export function normalizeRouteChannelSourceModel(sourceModel: string | null | undefined): string {
  return String(sourceModel || '').trim().toLowerCase();
}

export function buildRouteChannelIdentityKey(input: RouteChannelIdentityInput): string {
  const routeUnitId = normalizeOptionalId(input.oauthRouteUnitId);
  const sourceModel = normalizeRouteChannelSourceModel(input.sourceModel);
  if (routeUnitId !== null) return `route-unit:${routeUnitId}:${sourceModel}`;

  const accountId = normalizeOptionalId(input.accountId) ?? 0;
  const tokenId = normalizeOptionalId(input.tokenId);
  return `account:${accountId}:token:${tokenId ?? 'account'}:${sourceModel}`;
}

export function buildRouteChannelStorageIdentityKey(input: RouteChannelIdentityInput): string {
  const routeUnitId = normalizeOptionalId(input.oauthRouteUnitId);
  if (routeUnitId !== null) return `route-unit:${routeUnitId}`;

  const accountId = normalizeOptionalId(input.accountId) ?? 0;
  const tokenId = normalizeOptionalId(input.tokenId);
  return `account:${accountId}:token:${tokenId ?? 'account'}`;
}
