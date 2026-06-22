import { and, eq, inArray, ne } from 'drizzle-orm';
import { db, schema } from '../db/index.js';
import { getInsertedRowId } from '../db/insertHelpers.js';
import { getCredentialModeFromExtraConfig } from './accountExtraConfig.js';
import {
  hasManualTokenModelTestRecord,
  isSuccessfulManualTokenModelTest,
} from './tokenModelAvailabilityStatus.js';

type UpstreamApiToken = {
  name?: string | null;
  key?: string | null;
  enabled?: boolean | null;
  tokenGroup?: string | null;
};

type AccountTokenRow = typeof schema.accountTokens.$inferSelect;

export const ACCOUNT_TOKEN_VALUE_STATUS_READY = 'ready' as const;
export const ACCOUNT_TOKEN_VALUE_STATUS_MASKED_PENDING = 'masked_pending' as const;
export type AccountTokenValueStatus =
  | typeof ACCOUNT_TOKEN_VALUE_STATUS_READY
  | typeof ACCOUNT_TOKEN_VALUE_STATUS_MASKED_PENDING;

export function normalizeTokenForDisplay(token?: string | null, platform?: string | null): string {
  if (!token) return '';
  const value = token.trim();
  if (!value) return '';
  if (platform !== undefined) {
    // Keep the parameter for route-level compatibility; display rule is now global.
  }
  if (!value.toLowerCase().startsWith('sk-')) {
    return `sk-${value}`;
  }
  return value;
}

export function maskToken(token?: string | null, platform?: string | null): string {
  const value = normalizeTokenForDisplay(token, platform);
  if (!value) return '';
  if (value.toLowerCase().startsWith('sk-')) {
    if (value.length <= 7) return 'sk-***';
    const visibleMiddle = value.slice(3, Math.min(6, value.length));
    if (value.length <= 12) return `sk-${visibleMiddle}***${value.slice(-2)}`;
    return `sk-${visibleMiddle}***${value.slice(-4)}`;
  }
  if (value.length <= 10) return `${value.slice(0, 2)}***${value.slice(-2)}`;
  return `${value.slice(0, 4)}***${value.slice(-4)}`;
}

function normalizeTokenName(name: string | null | undefined, fallbackIndex = 1): string {
  const trimmed = (name || '').trim();
  if (trimmed) return trimmed;
  return fallbackIndex === 1 ? 'default' : `token-${fallbackIndex}`;
}

function normalizeTokenValue(token: string | null | undefined): string | null {
  const trimmed = (token || '').trim();
  return trimmed.length > 0 ? trimmed : null;
}

export function isMaskedTokenValue(token: string | null | undefined): boolean {
  const value = (token || '').trim();
  if (!value) return false;
  return value.includes('*') || value.includes('•');
}

function normalizeMaskedTokenForCompare(token: string | null | undefined): string {
  return normalizeTokenForDisplay(token).replace(/•/g, '*');
}

function matchesMaskedTokenValue(
  fullToken: string | null | undefined,
  maskedToken: string | null | undefined,
): boolean {
  const normalizedFull = normalizeTokenForDisplay(fullToken);
  const normalizedMasked = normalizeMaskedTokenForCompare(maskedToken);
  if (!normalizedFull || !normalizedMasked) return false;

  if (!isMaskedTokenValue(normalizedMasked)) {
    return normalizedFull === normalizedMasked;
  }

  const firstMaskIndex = normalizedMasked.search(/[\*]/);
  const lastMaskIndex = Math.max(
    normalizedMasked.lastIndexOf('*'),
    normalizedMasked.lastIndexOf('•'),
  );
  if (firstMaskIndex < 0 || lastMaskIndex < firstMaskIndex) {
    return normalizedFull === normalizedMasked;
  }

  const prefix = normalizedMasked.slice(0, firstMaskIndex);
  const suffix = normalizedMasked.slice(lastMaskIndex + 1);
  const visiblePrefix = prefix.replace(/^sk-/i, '');
  if (!visiblePrefix && !suffix) return false;
  if (normalizedFull.length < prefix.length + suffix.length) return false;
  if (prefix && !normalizedFull.startsWith(prefix)) return false;
  if (suffix && !normalizedFull.endsWith(suffix)) return false;
  return true;
}

function normalizeTokenValueStatus(value: string | null | undefined): AccountTokenValueStatus {
  const normalized = (value || '').trim().toLowerCase();
  return normalized === ACCOUNT_TOKEN_VALUE_STATUS_MASKED_PENDING
    ? ACCOUNT_TOKEN_VALUE_STATUS_MASKED_PENDING
    : ACCOUNT_TOKEN_VALUE_STATUS_READY;
}

export function resolveAccountTokenValueStatus(
  value: Pick<AccountTokenRow, 'token' | 'valueStatus'> | string | null | undefined,
): AccountTokenValueStatus {
  if (typeof value === 'string' || value == null) {
    return normalizeTokenValueStatus(value);
  }

  const explicit = normalizeTokenValueStatus(value.valueStatus);
  if (explicit === ACCOUNT_TOKEN_VALUE_STATUS_MASKED_PENDING) {
    return ACCOUNT_TOKEN_VALUE_STATUS_MASKED_PENDING;
  }
  return isMaskedTokenValue(value.token)
    ? ACCOUNT_TOKEN_VALUE_STATUS_MASKED_PENDING
    : ACCOUNT_TOKEN_VALUE_STATUS_READY;
}

export function isReadyAccountToken(token: Pick<AccountTokenRow, 'token' | 'valueStatus'> | null | undefined): boolean {
  if (!token) return false;
  return resolveAccountTokenValueStatus(token) === ACCOUNT_TOKEN_VALUE_STATUS_READY
    && !isMaskedTokenValue(token.token);
}

export function isMaskedPendingAccountToken(token: Pick<AccountTokenRow, 'token' | 'valueStatus'> | null | undefined): boolean {
  if (!token) return false;
  return resolveAccountTokenValueStatus(token) === ACCOUNT_TOKEN_VALUE_STATUS_MASKED_PENDING;
}

export function isUsableAccountToken(token: AccountTokenRow | null | undefined): boolean {
  if (!token) return false;
  return token.enabled === true && isReadyAccountToken(token);
}

function normalizeTokenGroup(value: string | null | undefined, tokenName?: string | null): string | null {
  const explicit = (value || '').trim();
  if (explicit.length > 0) return explicit;

  const name = (tokenName || '').trim();
  if (!name) return null;
  const normalized = name.toLowerCase();
  if (normalized === 'default' || normalized === '默认' || /^default($|[-_\s])/.test(normalized)) {
    return 'default';
  }
  if (/^token-\d+$/.test(normalized)) return null;
  return name;
}

function normalizePricingLookupKey(value: string | null | undefined): string | null {
  const trimmed = (value || '').trim();
  if (!trimmed) return null;
  return trimmed
    .replace(/[（(]/g, '-')
    .replace(/[）)]/g, '')
    .replace(/[–—_/\s]+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '')
    .toLowerCase();
}

type GroupRatioMappingEntry = {
  ratio: number;
  group: string | null;
};

type AccountTokenGroupPreferenceEntry = {
  enabled: boolean;
  group: string;
  ratio: number | null;
  ratioKey: string;
};

function setGroupRatioMapping(
  map: Map<string, GroupRatioMappingEntry>,
  accountId: number,
  value: string | null | undefined,
  ratio: number,
  group: string | null,
  options: { preserveExisting?: boolean } = {},
) {
  const entry = { ratio, group };
  const exact = normalizeTokenGroup(value, null);
  if (exact) {
    const key = `${accountId}:${exact}`;
    if (!options.preserveExisting || !map.has(key)) map.set(key, entry);
  }
  const lookup = normalizePricingLookupKey(value);
  if (lookup) {
    const key = `${accountId}:lookup:${lookup}`;
    if (!options.preserveExisting || !map.has(key)) map.set(key, entry);
  }
}

function resolveGroupRatioMapping(
  map: Map<string, GroupRatioMappingEntry>,
  accountId: number,
  candidates: Array<string | null | undefined>,
): GroupRatioMappingEntry | undefined {
  for (const candidate of candidates) {
    const exact = normalizeTokenGroup(candidate, null);
    if (exact) {
      const value = map.get(`${accountId}:${exact}`);
      if (value !== undefined) return value;
    }
    const lookup = normalizePricingLookupKey(candidate);
    if (lookup) {
      const value = map.get(`${accountId}:lookup:${lookup}`);
      if (value !== undefined) return value;
    }
  }
  return undefined;
}

function isStoredPricingAvailable(value: unknown): boolean {
  return value === true || value === 1 || value === '1';
}

export function normalizeAccountTokenGroupRatioKey(ratio: number | null | undefined): string {
  const value = Number(ratio);
  if (!Number.isFinite(value) || value <= 0) return '';
  return Number(value.toFixed(12)).toString();
}

function buildAccountTokenGroupPreferenceKey(accountId: number, group: string | null | undefined, ratio: number | null | undefined): string {
  return `${accountId}:${normalizeTokenGroup(group, null) || 'default'}:${normalizeAccountTokenGroupRatioKey(ratio)}`;
}

async function loadStoredGroupRatioMappings(accountId?: number): Promise<Map<string, GroupRatioMappingEntry>> {
  const base = db.select({
    accountId: schema.tokenGroupPricing.accountId,
    group: schema.tokenGroupPricing.group,
    groupName: schema.tokenGroupPricing.groupName,
    ratio: schema.tokenGroupPricing.ratio,
    pricingAvailable: schema.tokenGroupPricing.pricingAvailable,
  }).from(schema.tokenGroupPricing);
  const rows = accountId
    ? await base.where(eq(schema.tokenGroupPricing.accountId, accountId)).all()
    : await base.all();

  const ratioByAccountAndGroup = new Map<string, GroupRatioMappingEntry>();
  for (const row of rows) {
    if (!isStoredPricingAvailable(row.pricingAvailable)) continue;
    const group = normalizeTokenGroup(row.group, null);
    const groupName = normalizeTokenGroup(row.groupName, null);
    const ratio = Number(row.ratio);
    if (!row.accountId || !group || !Number.isFinite(ratio) || ratio <= 0) continue;
    const displayGroup = groupName || group;
    setGroupRatioMapping(ratioByAccountAndGroup, row.accountId, group, ratio, displayGroup);
    if (groupName) setGroupRatioMapping(ratioByAccountAndGroup, row.accountId, groupName, ratio, displayGroup);
  }
  return ratioByAccountAndGroup;
}

async function loadAccountTokenGroupPreferences(accountId?: number): Promise<Map<string, AccountTokenGroupPreferenceEntry>> {
  const base = db.select().from(schema.accountTokenGroupPreferences);
  const rows = accountId
    ? await base.where(eq(schema.accountTokenGroupPreferences.accountId, accountId)).all()
    : await base.all();

  const preferences = new Map<string, AccountTokenGroupPreferenceEntry>();
  for (const row of rows) {
    const group = normalizeTokenGroup(row.tokenGroup, null) || 'default';
    const ratio = Number(row.groupRatio);
    const normalizedRatio = Number.isFinite(ratio) && ratio > 0 ? ratio : null;
    const ratioKey = row.groupRatioKey || normalizeAccountTokenGroupRatioKey(normalizedRatio);
    preferences.set(`${row.accountId}:${group}:${ratioKey}`, {
      enabled: row.enabled === true,
      group,
      ratio: normalizedRatio,
      ratioKey,
    });
  }
  return preferences;
}

function resolveGroupPreferenceEnabled(
  preferences: Map<string, AccountTokenGroupPreferenceEntry>,
  accountId: number,
  group: string | null | undefined,
  ratio: number | null | undefined,
): boolean | undefined {
  return preferences.get(buildAccountTokenGroupPreferenceKey(accountId, group, ratio))?.enabled;
}

function resolveSyncedAccountTokenEnabled(
  preferenceEnabled: boolean | undefined,
  existingToken?: typeof schema.accountTokens.$inferSelect | null,
): boolean {
  if (preferenceEnabled !== undefined) return preferenceEnabled;
  if (existingToken?.source === 'manual' && existingToken.enabled === true) return true;
  return false;
}

export async function resolveAccountTokenManualEnabledPreference(input: {
  accountId: number;
  tokenGroup?: string | null;
  tokenName?: string | null;
  groupRatio?: number | null;
}): Promise<boolean | undefined> {
  const accountId = Number(input.accountId);
  if (!Number.isInteger(accountId) || accountId <= 0) return undefined;
  const group = normalizeTokenGroup(input.tokenGroup, input.tokenName) || 'default';
  const resolvedRatio = input.groupRatio !== undefined
    ? (Number.isFinite(Number(input.groupRatio)) && Number(input.groupRatio) > 0 ? Number(input.groupRatio) : null)
    : (await resolveAccountTokenGroupRatio(accountId, [group, input.tokenName, input.tokenGroup]))?.ratio ?? null;
  const preferences = await loadAccountTokenGroupPreferences(accountId);
  return resolveGroupPreferenceEnabled(preferences, accountId, group, resolvedRatio);
}

async function resolveAccountTokenGroupRatio(
  accountId: number,
  candidates: Array<string | null | undefined>,
): Promise<GroupRatioMappingEntry | undefined> {
  const ratioByAccountAndGroup = await loadStoredGroupRatioMappings(accountId);
  return resolveGroupRatioMapping(ratioByAccountAndGroup, accountId, candidates);
}

export async function upsertAccountTokenGroupEnabledPreference(input: {
  accountId: number;
  tokenGroup?: string | null;
  tokenName?: string | null;
  groupRatio?: number | null;
  enabled: boolean;
}) {
  const accountId = Number(input.accountId);
  if (!Number.isInteger(accountId) || accountId <= 0) return null;

  const group = normalizeTokenGroup(input.tokenGroup, input.tokenName) || 'default';
  const resolvedRatio = input.groupRatio !== undefined
    ? (Number.isFinite(Number(input.groupRatio)) && Number(input.groupRatio) > 0 ? Number(input.groupRatio) : null)
    : (await resolveAccountTokenGroupRatio(accountId, [group, input.tokenName, input.tokenGroup]))?.ratio ?? null;
  const ratioKey = normalizeAccountTokenGroupRatioKey(resolvedRatio);
  const now = new Date().toISOString();

  const existing = await db.select()
    .from(schema.accountTokenGroupPreferences)
    .where(and(
      eq(schema.accountTokenGroupPreferences.accountId, accountId),
      eq(schema.accountTokenGroupPreferences.tokenGroup, group),
      eq(schema.accountTokenGroupPreferences.groupRatioKey, ratioKey),
    ))
    .get();

  if (existing) {
    await db.update(schema.accountTokenGroupPreferences)
      .set({ groupRatio: resolvedRatio, enabled: input.enabled, updatedAt: now })
      .where(eq(schema.accountTokenGroupPreferences.id, existing.id))
      .run();
    return { id: existing.id, accountId, tokenGroup: group, groupRatio: resolvedRatio, groupRatioKey: ratioKey, enabled: input.enabled };
  }

  const inserted = await db.insert(schema.accountTokenGroupPreferences)
    .values({
      accountId,
      tokenGroup: group,
      groupRatio: resolvedRatio,
      groupRatioKey: ratioKey,
      enabled: input.enabled,
      createdAt: now,
      updatedAt: now,
    })
    .run();
  return { id: getInsertedRowId(inserted), accountId, tokenGroup: group, groupRatio: resolvedRatio, groupRatioKey: ratioKey, enabled: input.enabled };
}

async function loadAccountGroupNameAliases(accountId: number): Promise<Map<string, string>> {
  const rows = await db.select({
    group: schema.tokenGroupPricing.group,
    groupName: schema.tokenGroupPricing.groupName,
  })
    .from(schema.tokenGroupPricing)
    .where(eq(schema.tokenGroupPricing.accountId, accountId))
    .all();
  const aliases = new Map<string, string>();
  for (const row of rows) {
    const group = normalizeTokenGroup(row.group, null);
    const groupName = normalizeTokenGroup(row.groupName, null);
    if (!group || !groupName || group === groupName) continue;
    aliases.set(group, groupName);
  }
  return aliases;
}

function sameTokenGroupWithAliases(
  aliases: Map<string, string>,
  leftGroup: string | null | undefined,
  leftName: string | null | undefined,
  rightGroup: string | null | undefined,
  rightName: string | null | undefined,
): boolean {
  const left = normalizeTokenGroup(leftGroup, leftName);
  const right = normalizeTokenGroup(rightGroup, rightName);
  if (left === right) return true;
  return !!left && !!right && (aliases.get(left) === right || aliases.get(right) === left);
}

function sameTokenNameWithAliases(
  aliases: Map<string, string>,
  leftName: string,
  leftGroup: string | null | undefined,
  rightName: string,
  rightGroup: string | null | undefined,
): boolean {
  const left = leftName.trim();
  const right = rightName.trim();
  if (left === right) return true;
  if (!left || !right) return false;

  const leftGroupName = normalizeTokenGroup(leftGroup, leftName);
  const rightGroupName = normalizeTokenGroup(rightGroup, rightName);
  return aliases.get(left) === right
    || aliases.get(right) === left
    || (!!leftGroupName && aliases.get(leftGroupName) === right)
    || (!!rightGroupName && aliases.get(rightGroupName) === left);
}

function sameTokenGroup(
  leftGroup: string | null | undefined,
  leftName: string | null | undefined,
  rightGroup: string | null | undefined,
  rightName: string | null | undefined,
): boolean {
  return normalizeTokenGroup(leftGroup, leftName) === normalizeTokenGroup(rightGroup, rightName);
}

async function updateAccountApiToken(accountId: number, tokenValue: string | null) {
  await db.update(schema.accounts)
    .set({ apiToken: tokenValue || null, updatedAt: new Date().toISOString() })
    .where(eq(schema.accounts.id, accountId))
    .run();
}

function isApiKeyConnection(account: typeof schema.accounts.$inferSelect): boolean {
  const explicit = getCredentialModeFromExtraConfig(account.extraConfig);
  if (explicit && explicit !== 'auto') return explicit === 'apikey';
  return normalizeTokenValue(account.accessToken) === null;
}

export async function getPreferredAccountToken(accountId: number) {
  const tokens = await db.select()
    .from(schema.accountTokens)
    .where(and(eq(schema.accountTokens.accountId, accountId), eq(schema.accountTokens.enabled, true)))
    .all();

  const usableTokens = tokens.filter(isUsableAccountToken);
  if (usableTokens.length === 0) return null;

  const preferred = usableTokens.find((t) => t.isDefault) || usableTokens[0];
  return preferred;
}

export async function ensureDefaultTokenForAccount(
  accountId: number,
  tokenValue: string,
  options?: { name?: string; source?: string; enabled?: boolean; tokenGroup?: string | null },
): Promise<number | null> {
  const normalizedToken = normalizeTokenValue(tokenValue);
  if (!normalizedToken) return null;
  if (isMaskedTokenValue(normalizedToken)) return null;
  const tokenGroup = normalizeTokenGroup(options?.tokenGroup, options?.name) || 'default';

  const now = new Date().toISOString();
  const tokens = await db.select()
    .from(schema.accountTokens)
    .where(eq(schema.accountTokens.accountId, accountId))
    .all();

  let target = tokens.find((t) => t.token === normalizedToken) || null;
  if (!target) {
    const inserted = await db.insert(schema.accountTokens)
      .values({
        accountId,
        name: normalizeTokenName(options?.name, tokens.length + 1),
        token: normalizedToken,
        tokenGroup,
        valueStatus: ACCOUNT_TOKEN_VALUE_STATUS_READY,
        source: options?.source || 'manual',
        enabled: options?.enabled ?? true,
        isDefault: true,
        createdAt: now,
        updatedAt: now,
      })
      .run();
    const insertedId = getInsertedRowId(inserted);
    target = insertedId != null
      ? (await db.select().from(schema.accountTokens).where(eq(schema.accountTokens.id, insertedId)).get()) ?? null
      : null;
    if (!target) return null;
  } else {
    await db.update(schema.accountTokens)
      .set({
        name: options?.name ? normalizeTokenName(options.name) : target.name,
        tokenGroup,
        valueStatus: ACCOUNT_TOKEN_VALUE_STATUS_READY,
        source: options?.source || target.source || 'manual',
        enabled: options?.enabled ?? target.enabled,
        isDefault: true,
        updatedAt: now,
      })
      .where(eq(schema.accountTokens.id, target.id))
      .run();
  }

  await db.update(schema.accountTokens)
    .set({ isDefault: false, updatedAt: now })
    .where(and(eq(schema.accountTokens.accountId, accountId), ne(schema.accountTokens.id, target.id)))
    .run();

  await updateAccountApiToken(accountId, normalizedToken);
  return target.id;
}

export async function setDefaultToken(tokenId: number): Promise<boolean> {
  const target = await db.select().from(schema.accountTokens).where(eq(schema.accountTokens.id, tokenId)).get();
  if (!target || !isReadyAccountToken(target)) return false;

  const now = new Date().toISOString();
  await db.update(schema.accountTokens)
    .set({ isDefault: false, updatedAt: now })
    .where(eq(schema.accountTokens.accountId, target.accountId))
    .run();

  await db.update(schema.accountTokens)
    .set({ isDefault: true, enabled: true, updatedAt: now })
    .where(eq(schema.accountTokens.id, tokenId))
    .run();

  await updateAccountApiToken(target.accountId, target.token);
  return true;
}

export async function repairDefaultToken(accountId: number) {
  const tokens = await db.select()
    .from(schema.accountTokens)
    .where(eq(schema.accountTokens.accountId, accountId))
    .all();

  const enabled = tokens.filter(isUsableAccountToken);
  if (enabled.length === 0) {
    await updateAccountApiToken(accountId, null);
    return null;
  }

  const currentDefault = enabled.find((t) => t.isDefault) || enabled[0];
  const now = new Date().toISOString();

  await db.update(schema.accountTokens)
    .set({ isDefault: false, updatedAt: now })
    .where(eq(schema.accountTokens.accountId, accountId))
    .run();

  await db.update(schema.accountTokens)
    .set({ isDefault: true, enabled: true, updatedAt: now })
    .where(eq(schema.accountTokens.id, currentDefault.id))
    .run();

  await updateAccountApiToken(accountId, currentDefault.token);
  return currentDefault;
}

export async function syncTokensFromUpstream(accountId: number, upstreamTokens: UpstreamApiToken[]) {
  const now = new Date().toISOString();
  const existing = await db.select()
    .from(schema.accountTokens)
    .where(eq(schema.accountTokens.accountId, accountId))
    .all();

  let created = 0;
  let updated = 0;
  let maskedPending = 0;
  const pendingTokenIds: number[] = [];
  const groupNameAliases = await loadAccountGroupNameAliases(accountId);
  const ratioByAccountAndGroup = await loadStoredGroupRatioMappings(accountId);
  const groupEnabledPreferences = await loadAccountTokenGroupPreferences(accountId);
  let index = existing.length + 1;

  for (const upstream of upstreamTokens) {
    const tokenValue = normalizeTokenValue(upstream.key);
    if (!tokenValue) continue;
    const tokenName = normalizeTokenName(upstream.name, index);
    const tokenGroup = normalizeTokenGroup(upstream.tokenGroup, tokenName);
    const groupRatio = resolveGroupRatioMapping(ratioByAccountAndGroup, accountId, [
      tokenGroup,
      tokenName,
      upstream.tokenGroup,
    ])?.ratio ?? null;
    const preferenceEnabled = resolveGroupPreferenceEnabled(groupEnabledPreferences, accountId, tokenGroup, groupRatio);
    const nextValueStatus = isMaskedTokenValue(tokenValue)
      ? ACCOUNT_TOKEN_VALUE_STATUS_MASKED_PENDING
      : ACCOUNT_TOKEN_VALUE_STATUS_READY;

    const byToken = existing.find((row) => (
      row.token === tokenValue
      && resolveAccountTokenValueStatus(row) === ACCOUNT_TOKEN_VALUE_STATUS_READY
    ));
    if (byToken) {
      const enabled = resolveSyncedAccountTokenEnabled(preferenceEnabled, byToken);
      await db.update(schema.accountTokens)
        .set({
          name: tokenName,
          tokenGroup,
          valueStatus: ACCOUNT_TOKEN_VALUE_STATUS_READY,
          source: 'sync',
          enabled,
          updatedAt: now,
        })
        .where(eq(schema.accountTokens.id, byToken.id))
        .run();
      byToken.name = tokenName;
      byToken.tokenGroup = tokenGroup;
      byToken.valueStatus = ACCOUNT_TOKEN_VALUE_STATUS_READY;
      byToken.enabled = enabled;
      byToken.source = 'sync';
      byToken.updatedAt = now;
      updated++;
      continue;
    }

    const matchingPendingByClearValue = nextValueStatus === ACCOUNT_TOKEN_VALUE_STATUS_READY
      ? existing.filter((row) => (
        isMaskedPendingAccountToken(row)
        && matchesMaskedTokenValue(tokenValue, row.token)
      ))
      : [];
    const pendingClearMatch = matchingPendingByClearValue.length === 1
      ? matchingPendingByClearValue[0]
      : null;
    if (pendingClearMatch) {
      const enabled = resolveSyncedAccountTokenEnabled(preferenceEnabled, pendingClearMatch);
      await db.update(schema.accountTokens)
        .set({
          name: tokenName,
          token: tokenValue,
          tokenGroup,
          valueStatus: ACCOUNT_TOKEN_VALUE_STATUS_READY,
          source: 'sync',
          enabled,
          isDefault: false,
          updatedAt: now,
        })
        .where(eq(schema.accountTokens.id, pendingClearMatch.id))
        .run();
      pendingClearMatch.name = tokenName;
      pendingClearMatch.token = tokenValue;
      pendingClearMatch.tokenGroup = tokenGroup;
      pendingClearMatch.valueStatus = ACCOUNT_TOKEN_VALUE_STATUS_READY;
      pendingClearMatch.source = 'sync';
      pendingClearMatch.enabled = enabled;
      pendingClearMatch.isDefault = false;
      pendingClearMatch.updatedAt = now;
      updated++;
      continue;
    }

    const matchingReadyByMaskedValue = nextValueStatus === ACCOUNT_TOKEN_VALUE_STATUS_MASKED_PENDING
      ? existing.filter((row) => (
        resolveAccountTokenValueStatus(row) === ACCOUNT_TOKEN_VALUE_STATUS_READY
        && matchesMaskedTokenValue(row.token, tokenValue)
        && sameTokenNameWithAliases(groupNameAliases, row.name, row.tokenGroup, tokenName, tokenGroup)
        && sameTokenGroupWithAliases(groupNameAliases, row.tokenGroup, row.name, tokenGroup, tokenName)
      ))
      : [];
    const readyMaskedMatch = matchingReadyByMaskedValue.length === 1
      ? matchingReadyByMaskedValue[0]
      : null;
    if (readyMaskedMatch) {
      const enabled = resolveSyncedAccountTokenEnabled(preferenceEnabled, readyMaskedMatch);
      const staleMaskedPlaceholders = existing.filter((row) => (
        row.id !== readyMaskedMatch.id
        && resolveAccountTokenValueStatus(row) === ACCOUNT_TOKEN_VALUE_STATUS_MASKED_PENDING
        && matchesMaskedTokenValue(row.token, tokenValue)
        && sameTokenNameWithAliases(groupNameAliases, row.name, row.tokenGroup, tokenName, tokenGroup)
        && sameTokenGroupWithAliases(groupNameAliases, row.tokenGroup, row.name, tokenGroup, tokenName)
      ));

      await db.update(schema.accountTokens)
        .set({
          name: tokenName,
          tokenGroup,
          valueStatus: ACCOUNT_TOKEN_VALUE_STATUS_READY,
          source: 'sync',
          enabled,
          updatedAt: now,
        })
        .where(eq(schema.accountTokens.id, readyMaskedMatch.id))
        .run();
      readyMaskedMatch.name = tokenName;
      readyMaskedMatch.tokenGroup = tokenGroup;
      readyMaskedMatch.valueStatus = ACCOUNT_TOKEN_VALUE_STATUS_READY;
      readyMaskedMatch.enabled = enabled;
      readyMaskedMatch.source = 'sync';
      readyMaskedMatch.updatedAt = now;

      if (staleMaskedPlaceholders.length > 0) {
        for (const placeholder of staleMaskedPlaceholders) {
          await db.delete(schema.accountTokens)
            .where(eq(schema.accountTokens.id, placeholder.id))
            .run();
        }
        for (const placeholder of staleMaskedPlaceholders) {
          const placeholderIndex = existing.findIndex((row) => row.id === placeholder.id);
          if (placeholderIndex >= 0) {
            existing.splice(placeholderIndex, 1);
          }
        }
      }

      updated++;
      continue;
    }

    const matchingPlaceholder = existing.find((row) => (
      isMaskedPendingAccountToken(row)
      && sameTokenNameWithAliases(groupNameAliases, row.name, row.tokenGroup, tokenName, tokenGroup)
      && sameTokenGroupWithAliases(groupNameAliases, row.tokenGroup, row.name, tokenGroup, tokenName)
    ));

    if (matchingPlaceholder) {
      const enabled = resolveSyncedAccountTokenEnabled(preferenceEnabled, matchingPlaceholder);
      const nextEnabled = nextValueStatus === ACCOUNT_TOKEN_VALUE_STATUS_READY ? enabled : false;
      await db.update(schema.accountTokens)
        .set({
          name: tokenName,
          token: tokenValue,
          tokenGroup,
          valueStatus: nextValueStatus,
          source: 'sync',
          enabled: nextEnabled,
          isDefault: false,
          updatedAt: now,
        })
        .where(eq(schema.accountTokens.id, matchingPlaceholder.id))
        .run();
      matchingPlaceholder.name = tokenName;
      matchingPlaceholder.token = tokenValue;
      matchingPlaceholder.tokenGroup = tokenGroup;
      matchingPlaceholder.valueStatus = nextValueStatus;
      matchingPlaceholder.source = 'sync';
      matchingPlaceholder.enabled = nextEnabled;
      matchingPlaceholder.isDefault = false;
      matchingPlaceholder.updatedAt = now;
      updated++;
      if (nextValueStatus === ACCOUNT_TOKEN_VALUE_STATUS_MASKED_PENDING) {
        maskedPending++;
        pendingTokenIds.push(matchingPlaceholder.id);
      }
      continue;
    }

    const inserted = await db.insert(schema.accountTokens)
      .values({
        accountId,
        name: tokenName,
        token: tokenValue,
        tokenGroup,
        valueStatus: nextValueStatus,
        source: 'sync',
        enabled: nextValueStatus === ACCOUNT_TOKEN_VALUE_STATUS_READY
          ? resolveSyncedAccountTokenEnabled(preferenceEnabled)
          : false,
        isDefault: false,
        createdAt: now,
        updatedAt: now,
      })
      .run();
    const insertedId = getInsertedRowId(inserted);
    if (insertedId == null) continue;
    const createdRow = await db.select().from(schema.accountTokens).where(eq(schema.accountTokens.id, insertedId)).get();
    if (!createdRow) continue;

    existing.push(createdRow);
    created++;
    index++;
    if (nextValueStatus === ACCOUNT_TOKEN_VALUE_STATUS_MASKED_PENDING) {
      maskedPending++;
      pendingTokenIds.push(createdRow.id);
    }
  }

  const repaired = await repairDefaultToken(accountId);

  return {
    created,
    updated,
    maskedPending,
    pendingTokenIds,
    total: existing.length,
    defaultTokenId: repaired?.id || null,
  };
}

export async function listTokensWithRelations(accountId?: number) {
  const base = db.select()
    .from(schema.accountTokens)
    .innerJoin(schema.accounts, eq(schema.accountTokens.accountId, schema.accounts.id))
    .innerJoin(schema.sites, eq(schema.accounts.siteId, schema.sites.id));

  const rows = accountId
    ? await base.where(eq(schema.accountTokens.accountId, accountId)).all()
    : await base.all();

  const ratioByAccountAndGroup = await loadStoredGroupRatioMappings(accountId);
  const groupEnabledPreferences = await loadAccountTokenGroupPreferences(accountId);

  const tokenIds = rows.map((row) => row.account_tokens.id);
  const tokenModelRows = tokenIds.length > 0
    ? await db.select({
      tokenId: schema.tokenModelAvailability.tokenId,
      modelName: schema.tokenModelAvailability.modelName,
      available: schema.tokenModelAvailability.available,
      routeEnabled: schema.tokenModelAvailability.routeEnabled,
      routeEnabledSource: schema.tokenModelAvailability.routeEnabledSource,
      healthCheckSuccessStreak: schema.tokenModelAvailability.healthCheckSuccessStreak,
      routeManualDisabledAt: schema.tokenModelAvailability.routeManualDisabledAt,
      message: schema.tokenModelAvailability.message,
      httpStatus: schema.tokenModelAvailability.httpStatus,
      responseText: schema.tokenModelAvailability.responseText,
      latencyMs: schema.tokenModelAvailability.latencyMs,
      checkedAt: schema.tokenModelAvailability.checkedAt,
    })
      .from(schema.tokenModelAvailability)
      .where(inArray(schema.tokenModelAvailability.tokenId, tokenIds))
      .all()
    : [];
  const modelsByTokenId = new Map<number, string[]>();
  const modelRouteStatesByTokenId = new Map<number, Record<string, boolean>>();
  const modelAvailabilityByTokenId = new Map<number, Array<{
    modelName: string;
    available: boolean | null;
    message: string | null;
    httpStatus: number | null;
    responseText: string | null;
    latencyMs: number | null;
    checkedAt: string | null;
  }>>();
  const seenModelKeysByTokenId = new Map<number, Set<string>>();
  for (const row of tokenModelRows) {
    const modelName = (row.modelName || '').trim();
    if (!modelName) continue;
    if (hasManualTokenModelTestRecord(row)) {
      const availabilityRows = modelAvailabilityByTokenId.get(row.tokenId) || [];
      availabilityRows.push({
        modelName,
        available: isSuccessfulManualTokenModelTest(row),
        message: row.message,
        httpStatus: row.httpStatus,
        responseText: row.responseText,
        latencyMs: row.latencyMs,
        checkedAt: row.checkedAt,
      });
      modelAvailabilityByTokenId.set(row.tokenId, availabilityRows);
    }

    const seen = seenModelKeysByTokenId.get(row.tokenId) || new Set<string>();
    const key = modelName.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    seenModelKeysByTokenId.set(row.tokenId, seen);
    const models = modelsByTokenId.get(row.tokenId) || [];
    models.push(modelName);
    modelsByTokenId.set(row.tokenId, models);
    const routeStates = modelRouteStatesByTokenId.get(row.tokenId) || {};
    routeStates[modelName] = row.routeEnabled === true;
    modelRouteStatesByTokenId.set(row.tokenId, routeStates);
  }
  for (const models of modelsByTokenId.values()) {
    models.sort((left, right) => left.localeCompare(right));
  }
  for (const rows of modelAvailabilityByTokenId.values()) {
    rows.sort((left, right) => left.modelName.localeCompare(right.modelName));
  }

  return rows
    .filter((row) => !isApiKeyConnection(row.accounts))
    .map((row) => {
    const { token, ...tokenMeta } = row.account_tokens;
    const group = normalizeTokenGroup(row.account_tokens.tokenGroup, row.account_tokens.name) || 'default';
    const groupRatioEntry = resolveGroupRatioMapping(ratioByAccountAndGroup, row.accounts.id, [
      group,
      row.account_tokens.name,
      row.account_tokens.tokenGroup,
    ]);
    const groupRatio = groupRatioEntry?.ratio;
    const enabledPreference = groupEnabledPreferences.get(buildAccountTokenGroupPreferenceKey(row.accounts.id, group, groupRatio));
    const modelNames = modelsByTokenId.get(row.account_tokens.id) || [];
    const modelRouteStates = modelRouteStatesByTokenId.get(row.account_tokens.id) || {};
    const modelAvailability = modelAvailabilityByTokenId.get(row.account_tokens.id) || [];
    return {
      ...tokenMeta,
      valueStatus: resolveAccountTokenValueStatus(row.account_tokens),
      tokenMasked: maskToken(token, row.sites.platform),
      groupRatio: groupRatio ?? null,
      groupRatioAvailable: groupRatio !== undefined,
      tokenGroupRatio: groupRatio ?? null,
      tokenGroupRatioGroup: groupRatioEntry?.group ?? null,
      enabledPreference: enabledPreference
        ? {
          enabled: enabledPreference.enabled,
          source: 'manual',
          group: enabledPreference.group,
          groupRatio: enabledPreference.ratio,
        }
        : null,
      modelNames,
      modelRouteStates,
      modelCount: modelNames.length,
      modelAvailability,
      modelSyncedAt: row.account_tokens.modelSyncedAt ?? null,
      autoDisabledAt: row.account_tokens.autoDisabledAt ?? null,
      autoDisabledReason: row.account_tokens.autoDisabledReason ?? null,
      autoDisabledPreviousEnabled: row.account_tokens.autoDisabledPreviousEnabled ?? null,
      healthCheckEnabled: row.account_tokens.healthCheckEnabled === true,
      healthCheckIntervalMinutes: row.account_tokens.healthCheckIntervalMinutes ?? 60,
      healthCheckModel: row.account_tokens.healthCheckModel ?? '',
      healthCheckLastRunAt: row.account_tokens.healthCheckLastRunAt ?? null,
      healthCheckNextRunAt: row.account_tokens.healthCheckNextRunAt ?? null,
      healthCheckLastAvailable: row.account_tokens.healthCheckLastAvailable ?? null,
      healthCheckLastMessage: row.account_tokens.healthCheckLastMessage ?? null,
      healthCheckLastLatencyMs: row.account_tokens.healthCheckLastLatencyMs ?? null,
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
      },
    };
    });
}
