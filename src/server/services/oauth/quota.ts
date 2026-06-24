import { randomUUID } from 'node:crypto';
import { eq } from 'drizzle-orm';
import { fetch } from 'undici';
import { db, schema } from '../../db/index.js';
import { mergeAccountExtraConfig } from '../accountExtraConfig.js';
import { runWithSiteApiEndpointPool } from '../siteApiEndpointService.js';
import { withExplicitProxyRequestInit } from '../siteProxy.js';
import {
  buildStoredOauthStateFromAccount,
  getOauthInfoFromAccount,
  type OauthInfo,
} from './oauthAccount.js';
import {
  ANTIGRAVITY_INTERNAL_API_VERSION,
  ANTIGRAVITY_LOAD_CODE_ASSIST_USER_AGENT,
  ANTIGRAVITY_UPSTREAM_BASE_URL,
} from './antigravityProvider.js';
import { resolveOauthAccountProxyUrl } from './requestProxy.js';
import type { OauthQuotaSnapshot, OauthQuotaWindowSnapshot } from './quotaTypes.js';

type CodexJwtClaims = {
  'https://api.openai.com/auth'?: {
    chatgpt_plan_type?: unknown;
    chatgpt_subscription_active_start?: unknown;
    chatgpt_subscription_active_until?: unknown;
  };
};

type HeaderSource = {
  get(name: string): string | null;
} | Record<string, unknown>;

type CodexQuotaHeaderSnapshot = {
  primaryUsedPercent?: number;
  primaryResetAfterSeconds?: number;
  primaryWindowMinutes?: number;
  secondaryUsedPercent?: number;
  secondaryResetAfterSeconds?: number;
  secondaryWindowMinutes?: number;
  capturedAt: string;
};

type QuotaHeaderSnapshot = CodexQuotaHeaderSnapshot;

type NormalizedCodexQuotaHeaders = {
  fiveHour?: {
    usedPercent?: number;
    resetAfterSeconds?: number;
    windowMinutes?: number;
  };
  sevenDay?: {
    usedPercent?: number;
    resetAfterSeconds?: number;
    windowMinutes?: number;
  };
};

const CODEX_QUOTA_PROBE_MODEL = 'gpt-5.4';
const CODEX_QUOTA_PROBE_VERSION = '0.101.0';
const CODEX_QUOTA_PROBE_USER_AGENT = 'codex_cli_rs/0.101.0 (Mac OS 26.0.1; arm64) Apple_Terminal/464';
const CODEX_QUOTA_PROBE_BETA = 'responses-2025-03-11';
const CODEX_QUOTA_PROBE_INSTRUCTIONS = 'You are a helpful assistant.';
const CODEX_QUOTA_PROBE_TIMEOUT_MS = 10_000;
const ANTIGRAVITY_QUOTA_PROBE_TIMEOUT_MS = 10_000;
const QUOTA_HEADER_SNAPSHOT_DEDUPE_WINDOW_MS = 30_000;
const recentQuotaHeaderSnapshotByAccount = new Map<number, {
  fingerprint: string;
  recordedAtMs: number;
}>();
const pendingQuotaHeaderSnapshotKeys = new Set<string>();

function asTrimmedString(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined;
  const trimmed = value.trim();
  return trimmed || undefined;
}

function getHeaderValue(headers: HeaderSource, key: string): string | undefined {
  if (typeof (headers as { get?: unknown }).get === 'function') {
    const value = (headers as { get(name: string): string | null }).get(key);
    return asTrimmedString(value);
  }

  for (const [candidateKey, candidateValue] of Object.entries(headers)) {
    if (candidateKey.toLowerCase() !== key.toLowerCase()) continue;
    if (typeof candidateValue === 'string') return asTrimmedString(candidateValue);
    if (Array.isArray(candidateValue)) {
      for (const item of candidateValue) {
        const normalized = asTrimmedString(item);
        if (normalized) return normalized;
      }
    }
  }

  return undefined;
}

function asFiniteNumber(value: unknown): number | undefined {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value !== 'string') return undefined;
  const parsed = Number.parseFloat(value.trim());
  return Number.isFinite(parsed) ? parsed : undefined;
}

function asFiniteInteger(value: unknown): number | undefined {
  if (typeof value === 'number' && Number.isFinite(value)) return Math.trunc(value);
  if (typeof value !== 'string') return undefined;
  const parsed = Number.parseInt(value.trim(), 10);
  return Number.isFinite(parsed) ? parsed : undefined;
}

function asIsoDateTime(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined;
  const trimmed = value.trim();
  if (!trimmed) return undefined;
  const parsed = Date.parse(trimmed);
  return Number.isNaN(parsed) ? undefined : new Date(parsed).toISOString();
}

function parseCodexJwtClaims(idToken?: string): CodexJwtClaims | null {
  if (!idToken) return null;
  const parts = idToken.split('.');
  if (parts.length !== 3) return null;
  try {
    const payload = JSON.parse(Buffer.from(parts[1] || '', 'base64url').toString('utf8')) as unknown;
    if (!payload || typeof payload !== 'object' || Array.isArray(payload)) return null;
    return payload as CodexJwtClaims;
  } catch {
    return null;
  }
}

function buildUnsupportedWindow(message: string): OauthQuotaWindowSnapshot {
  return { supported: false, message };
}

function buildCodexUnsupportedWindows(): OauthQuotaSnapshot['windows'] {
  return {
    fiveHour: buildUnsupportedWindow('official 5h quota window is not exposed by current codex oauth artifacts'),
    sevenDay: buildUnsupportedWindow('official 7d quota window is not exposed by current codex oauth artifacts'),
  };
}

function buildProviderUnsupportedSnapshot(provider: string): OauthQuotaSnapshot {
  return {
    status: 'unsupported',
    source: 'official',
    providerMessage: `official quota windows are not exposed for ${provider} oauth`,
    windows: {
      fiveHour: buildUnsupportedWindow('official 5h quota window is unavailable for this provider'),
      sevenDay: buildUnsupportedWindow('official 7d quota window is unavailable for this provider'),
    },
  };
}

function roundPercent(value: number): number {
  return Math.round(value * 100) / 100;
}

function addSecondsToIso(baseIso: string, seconds?: number): string | undefined {
  if (typeof seconds !== 'number' || !Number.isFinite(seconds)) return undefined;
  const parsed = Date.parse(baseIso);
  if (Number.isNaN(parsed)) return undefined;
  const clampedSeconds = Math.max(0, Math.trunc(seconds));
  return new Date(parsed + clampedSeconds * 1000).toISOString();
}

function parseCodexQuotaHeaders(
  headers: HeaderSource,
  capturedAt = new Date().toISOString(),
): CodexQuotaHeaderSnapshot | null {
  const snapshot: CodexQuotaHeaderSnapshot = { capturedAt };
  let hasAnyValue = false;

  const assignField = (
    field: keyof Omit<CodexQuotaHeaderSnapshot, 'capturedAt'>,
    value: number | undefined,
  ) => {
    if (typeof value !== 'number' || !Number.isFinite(value)) return;
    snapshot[field] = value as CodexQuotaHeaderSnapshot[keyof Omit<CodexQuotaHeaderSnapshot, 'capturedAt'>];
    hasAnyValue = true;
  };

  assignField('primaryUsedPercent', asFiniteNumber(getHeaderValue(headers, 'x-codex-primary-used-percent')));
  assignField('primaryResetAfterSeconds', asFiniteInteger(getHeaderValue(headers, 'x-codex-primary-reset-after-seconds')));
  assignField('primaryWindowMinutes', asFiniteInteger(getHeaderValue(headers, 'x-codex-primary-window-minutes')));
  assignField('secondaryUsedPercent', asFiniteNumber(getHeaderValue(headers, 'x-codex-secondary-used-percent')));
  assignField('secondaryResetAfterSeconds', asFiniteInteger(getHeaderValue(headers, 'x-codex-secondary-reset-after-seconds')));
  assignField('secondaryWindowMinutes', asFiniteInteger(getHeaderValue(headers, 'x-codex-secondary-window-minutes')));

  return hasAnyValue ? snapshot : null;
}

function firstHeaderNumber(headers: HeaderSource, keys: string[], integer = false): number | undefined {
  for (const key of keys) {
    const value = integer ? asFiniteInteger(getHeaderValue(headers, key)) : asFiniteNumber(getHeaderValue(headers, key));
    if (typeof value === 'number' && Number.isFinite(value)) return value;
  }
  return undefined;
}

function parseAntigravityQuotaHeaders(
  headers: HeaderSource,
  capturedAt = new Date().toISOString(),
): QuotaHeaderSnapshot | null {
  const snapshot: QuotaHeaderSnapshot = { capturedAt };
  let hasAnyValue = false;

  const assignField = (
    field: keyof Omit<QuotaHeaderSnapshot, 'capturedAt'>,
    value: number | undefined,
  ) => {
    if (typeof value !== 'number' || !Number.isFinite(value)) return;
    snapshot[field] = value as QuotaHeaderSnapshot[keyof Omit<QuotaHeaderSnapshot, 'capturedAt'>];
    hasAnyValue = true;
  };

  assignField('primaryUsedPercent', firstHeaderNumber(headers, [
    'x-antigravity-primary-used-percent',
    'x-goog-primary-used-percent',
    'x-ratelimit-primary-used-percent',
    'x-codex-primary-used-percent',
  ]));
  assignField('primaryResetAfterSeconds', firstHeaderNumber(headers, [
    'x-antigravity-primary-reset-after-seconds',
    'x-goog-primary-reset-after-seconds',
    'x-ratelimit-primary-reset-after-seconds',
    'x-codex-primary-reset-after-seconds',
  ], true));
  assignField('primaryWindowMinutes', firstHeaderNumber(headers, [
    'x-antigravity-primary-window-minutes',
    'x-goog-primary-window-minutes',
    'x-ratelimit-primary-window-minutes',
    'x-codex-primary-window-minutes',
  ], true));
  assignField('secondaryUsedPercent', firstHeaderNumber(headers, [
    'x-antigravity-secondary-used-percent',
    'x-goog-secondary-used-percent',
    'x-ratelimit-secondary-used-percent',
    'x-codex-secondary-used-percent',
  ]));
  assignField('secondaryResetAfterSeconds', firstHeaderNumber(headers, [
    'x-antigravity-secondary-reset-after-seconds',
    'x-goog-secondary-reset-after-seconds',
    'x-ratelimit-secondary-reset-after-seconds',
    'x-codex-secondary-reset-after-seconds',
  ], true));
  assignField('secondaryWindowMinutes', firstHeaderNumber(headers, [
    'x-antigravity-secondary-window-minutes',
    'x-goog-secondary-window-minutes',
    'x-ratelimit-secondary-window-minutes',
    'x-codex-secondary-window-minutes',
  ], true));

  return hasAnyValue ? snapshot : null;
}

function normalizeCodexQuotaHeaders(snapshot: CodexQuotaHeaderSnapshot): NormalizedCodexQuotaHeaders | null {
  const primaryWindow = snapshot.primaryWindowMinutes;
  const secondaryWindow = snapshot.secondaryWindowMinutes;
  const hasPrimaryWindow = typeof primaryWindow === 'number' && Number.isFinite(primaryWindow);
  const hasSecondaryWindow = typeof secondaryWindow === 'number' && Number.isFinite(secondaryWindow);

  let fiveHourSource: 'primary' | 'secondary' | null = null;
  let sevenDaySource: 'primary' | 'secondary' | null = null;

  if (hasPrimaryWindow && hasSecondaryWindow) {
    if ((primaryWindow || 0) < (secondaryWindow || 0)) {
      fiveHourSource = 'primary';
      sevenDaySource = 'secondary';
    } else {
      fiveHourSource = 'secondary';
      sevenDaySource = 'primary';
    }
  } else if (hasPrimaryWindow) {
    if ((primaryWindow || 0) <= 360) {
      fiveHourSource = 'primary';
    } else {
      sevenDaySource = 'primary';
    }
  } else if (hasSecondaryWindow) {
    if ((secondaryWindow || 0) <= 360) {
      fiveHourSource = 'secondary';
    } else {
      sevenDaySource = 'secondary';
    }
  } else {
    sevenDaySource = 'primary';
    fiveHourSource = 'secondary';
  }

  const pickSource = (source: 'primary' | 'secondary' | null) => {
    if (!source) return undefined;
    if (source === 'primary') {
      return {
        usedPercent: snapshot.primaryUsedPercent,
        resetAfterSeconds: snapshot.primaryResetAfterSeconds,
        windowMinutes: snapshot.primaryWindowMinutes,
      };
    }
    return {
      usedPercent: snapshot.secondaryUsedPercent,
      resetAfterSeconds: snapshot.secondaryResetAfterSeconds,
      windowMinutes: snapshot.secondaryWindowMinutes,
    };
  };

  const normalized: NormalizedCodexQuotaHeaders = {
    fiveHour: pickSource(fiveHourSource),
    sevenDay: pickSource(sevenDaySource),
  };

  const hasData = !!(
    normalized.fiveHour?.usedPercent !== undefined
    || normalized.fiveHour?.resetAfterSeconds !== undefined
    || normalized.sevenDay?.usedPercent !== undefined
    || normalized.sevenDay?.resetAfterSeconds !== undefined
  );
  return hasData ? normalized : null;
}

function buildProviderQuotaHeadersFingerprint(provider: string, headers: HeaderSource): string | null {
  const parsed = provider === 'antigravity'
    ? parseAntigravityQuotaHeaders(headers, 'fingerprint')
    : parseCodexQuotaHeaders(headers, 'fingerprint');
  if (!parsed) return null;
  const { capturedAt: _capturedAt, ...stableFields } = parsed;
  return JSON.stringify(stableFields);
}

function buildCodexWindowFromNormalized(input: {
  usedPercent?: number;
  resetAfterSeconds?: number;
  windowMinutes?: number;
  capturedAt: string;
}): OauthQuotaWindowSnapshot | null {
  const usedPercent = typeof input.usedPercent === 'number' && Number.isFinite(input.usedPercent)
    ? roundPercent(input.usedPercent)
    : undefined;
  const resetAt = addSecondsToIso(input.capturedAt, input.resetAfterSeconds);
  if (usedPercent === undefined && !resetAt) {
    return null;
  }

  return {
    supported: true,
    ...(usedPercent !== undefined
      ? {
        used: usedPercent,
        limit: 100,
        remaining: roundPercent(Math.max(0, 100 - usedPercent)),
      }
      : {}),
    ...(resetAt ? { resetAt } : {}),
    message: typeof input.windowMinutes === 'number' && Number.isFinite(input.windowMinutes)
      ? `codex ${Math.max(0, Math.trunc(input.windowMinutes))}m window inferred from rate limit headers`
      : 'codex window inferred from rate limit headers',
  };
}

function buildWindowFromNormalized(input: {
  providerLabel: string;
  usedPercent?: number;
  resetAfterSeconds?: number;
  windowMinutes?: number;
  capturedAt: string;
}): OauthQuotaWindowSnapshot | null {
  const usedPercent = typeof input.usedPercent === 'number' && Number.isFinite(input.usedPercent)
    ? roundPercent(input.usedPercent)
    : undefined;
  const resetAt = addSecondsToIso(input.capturedAt, input.resetAfterSeconds);
  if (usedPercent === undefined && !resetAt) {
    return null;
  }

  return {
    supported: true,
    ...(usedPercent !== undefined
      ? {
        used: usedPercent,
        limit: 100,
        remaining: roundPercent(Math.max(0, 100 - usedPercent)),
      }
      : {}),
    ...(resetAt ? { resetAt } : {}),
    message: typeof input.windowMinutes === 'number' && Number.isFinite(input.windowMinutes)
      ? `${input.providerLabel} ${Math.max(0, Math.trunc(input.windowMinutes))}m window inferred from rate limit headers`
      : `${input.providerLabel} window inferred from rate limit headers`,
  };
}

function normalizeStoredWindow(value: unknown): OauthQuotaWindowSnapshot | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined;
  const raw = value as Record<string, unknown>;
  const supported = typeof raw.supported === 'boolean' ? raw.supported : undefined;
  if (supported === undefined) return undefined;
  const pickNumber = (field: string) => {
    const item = raw[field];
    return typeof item === 'number' && Number.isFinite(item) ? item : undefined;
  };
  const normalized: OauthQuotaWindowSnapshot = {
    supported,
  };
  const limit = pickNumber('limit');
  const used = pickNumber('used');
  const remaining = pickNumber('remaining');
  const resetAt = asIsoDateTime(raw.resetAt);
  const message = asTrimmedString(raw.message);
  if (limit !== undefined) normalized.limit = limit;
  if (used !== undefined) normalized.used = used;
  if (remaining !== undefined) normalized.remaining = remaining;
  if (resetAt) normalized.resetAt = resetAt;
  if (message) normalized.message = message;
  return normalized;
}

function normalizeStoredQuotaSnapshot(value: unknown): OauthQuotaSnapshot | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined;
  const raw = value as Record<string, unknown>;
  const status = raw.status === 'supported' || raw.status === 'unsupported' || raw.status === 'error'
    ? raw.status
    : undefined;
  const source = raw.source === 'official' || raw.source === 'reverse_engineered'
    ? raw.source
    : undefined;
  const windowsRaw = raw.windows;
  if (!status || !source || !windowsRaw || typeof windowsRaw !== 'object' || Array.isArray(windowsRaw)) {
    return undefined;
  }
  const windowsObject = windowsRaw as Record<string, unknown>;
  const fiveHour = normalizeStoredWindow(windowsObject.fiveHour);
  const sevenDay = normalizeStoredWindow(windowsObject.sevenDay);
  if (!fiveHour || !sevenDay) return undefined;

  const subscriptionRaw = raw.subscription;
  const subscription = subscriptionRaw && typeof subscriptionRaw === 'object' && !Array.isArray(subscriptionRaw)
    ? {
      planType: asTrimmedString((subscriptionRaw as Record<string, unknown>).planType),
      activeStart: asIsoDateTime((subscriptionRaw as Record<string, unknown>).activeStart),
      activeUntil: asIsoDateTime((subscriptionRaw as Record<string, unknown>).activeUntil),
    }
    : undefined;

  const antigravity = normalizeStoredAntigravityQuota(raw.antigravity);

  return {
    status,
    source,
    ...(asIsoDateTime(raw.lastSyncAt) ? { lastSyncAt: asIsoDateTime(raw.lastSyncAt)! } : {}),
    ...(asTrimmedString(raw.lastError) ? { lastError: asTrimmedString(raw.lastError)! } : {}),
    ...(asTrimmedString(raw.providerMessage) ? { providerMessage: asTrimmedString(raw.providerMessage)! } : {}),
    ...(subscription && (subscription.planType || subscription.activeStart || subscription.activeUntil)
      ? { subscription }
      : {}),
    windows: { fiveHour, sevenDay },
    ...(antigravity ? { antigravity } : {}),
    ...(asIsoDateTime(raw.lastLimitResetAt) ? { lastLimitResetAt: asIsoDateTime(raw.lastLimitResetAt)! } : {}),
  };
}

function normalizeStoredWindowGroup(value: unknown): OauthQuotaSnapshot['windows'] | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined;
  const raw = value as Record<string, unknown>;
  const fiveHour = normalizeStoredWindow(raw.fiveHour);
  const sevenDay = normalizeStoredWindow(raw.sevenDay);
  if (!fiveHour || !sevenDay) return undefined;
  return { fiveHour, sevenDay };
}

function normalizeStoredAntigravityFamily(value: unknown) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined;
  const raw = value as Record<string, unknown>;
  const windows = normalizeStoredWindowGroup(raw.windows);
  if (!windows) return undefined;
  const models = Array.isArray(raw.models)
    ? raw.models.map((item) => asTrimmedString(item)).filter((item): item is string => !!item)
    : undefined;
  return {
    ...(asTrimmedString(raw.label) ? { label: asTrimmedString(raw.label)! } : {}),
    ...(models && models.length > 0 ? { models } : {}),
    windows,
  };
}

function normalizeStoredAntigravityQuota(value: unknown): OauthQuotaSnapshot['antigravity'] | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined;
  const raw = value as Record<string, unknown>;
  const creditsRaw = raw.credits && typeof raw.credits === 'object' && !Array.isArray(raw.credits)
    ? raw.credits as Record<string, unknown>
    : undefined;
  const creditAmount = creditsRaw ? asFiniteNumber(creditsRaw.creditAmount) : undefined;
  const minimumCreditAmountForUsage = creditsRaw ? asFiniteNumber(creditsRaw.minimumCreditAmountForUsage) : undefined;
  const credits = creditsRaw
    ? {
      ...(asTrimmedString(creditsRaw.creditType) ? { creditType: asTrimmedString(creditsRaw.creditType)! } : {}),
      ...(creditAmount !== undefined ? { creditAmount } : {}),
      ...(minimumCreditAmountForUsage !== undefined ? { minimumCreditAmountForUsage } : {}),
      ...(typeof creditsRaw.available === 'boolean' ? { available: creditsRaw.available } : {}),
    }
    : undefined;
  const familiesRaw = raw.modelFamilies && typeof raw.modelFamilies === 'object' && !Array.isArray(raw.modelFamilies)
    ? raw.modelFamilies as Record<string, unknown>
    : undefined;
  const gemini = normalizeStoredAntigravityFamily(familiesRaw?.gemini);
  const claudeGpt = normalizeStoredAntigravityFamily(familiesRaw?.claudeGpt);
  if (!credits && !gemini && !claudeGpt) return undefined;
  return {
    ...(credits ? { credits } : {}),
    ...((gemini || claudeGpt) ? {
      modelFamilies: {
        ...(gemini ? { gemini } : {}),
        ...(claudeGpt ? { claudeGpt } : {}),
      },
    } : {}),
  };
}

function buildQuotaErrorSnapshot(input: {
  oauth: Pick<OauthInfo, 'provider' | 'planType' | 'idToken' | 'quota'>;
  message: string;
  syncedAt: string;
  lastLimitResetAt?: string;
}): OauthQuotaSnapshot {
  const baseSnapshot = buildQuotaSnapshotFromOauthInfo(input.oauth);
  return {
    ...baseSnapshot,
    status: 'error',
    lastSyncAt: input.syncedAt,
    lastError: input.message,
    providerMessage: input.message,
    ...(input.lastLimitResetAt
      ? { lastLimitResetAt: input.lastLimitResetAt }
      : (baseSnapshot.lastLimitResetAt ? { lastLimitResetAt: baseSnapshot.lastLimitResetAt } : {})),
  };
}

export function buildCodexQuotaSnapshotFromHeaders(
  oauth: Pick<OauthInfo, 'provider' | 'planType' | 'idToken' | 'quota'>,
  headers: HeaderSource,
  capturedAt = new Date().toISOString(),
): OauthQuotaSnapshot | null {
  if (oauth.provider !== 'codex') return null;
  const parsedHeaders = parseCodexQuotaHeaders(headers, capturedAt);
  if (!parsedHeaders) return null;
  const normalizedHeaders = normalizeCodexQuotaHeaders(parsedHeaders);
  if (!normalizedHeaders) return null;

  const baseSnapshot = buildQuotaSnapshotFromOauthInfo(oauth);
  const fiveHour = normalizedHeaders.fiveHour
    ? buildCodexWindowFromNormalized({
      ...normalizedHeaders.fiveHour,
      capturedAt: parsedHeaders.capturedAt,
    })
    : null;
  const sevenDay = normalizedHeaders.sevenDay
    ? buildCodexWindowFromNormalized({
      ...normalizedHeaders.sevenDay,
      capturedAt: parsedHeaders.capturedAt,
    })
    : null;
  if (!fiveHour && !sevenDay) return null;

  const lastLimitResetAt = fiveHour?.resetAt || sevenDay?.resetAt || baseSnapshot.lastLimitResetAt;

  return {
    ...baseSnapshot,
    status: 'supported',
    source: 'reverse_engineered',
    lastSyncAt: parsedHeaders.capturedAt,
    lastError: undefined,
    providerMessage: 'codex usage windows inferred from rate limit response headers',
    windows: {
      fiveHour: fiveHour || baseSnapshot.windows.fiveHour,
      sevenDay: sevenDay || baseSnapshot.windows.sevenDay,
    },
    ...(lastLimitResetAt ? { lastLimitResetAt } : {}),
  };
}

export function buildAntigravityQuotaSnapshotFromHeaders(
  oauth: Pick<OauthInfo, 'provider' | 'planType' | 'idToken' | 'quota'>,
  headers: HeaderSource,
  capturedAt = new Date().toISOString(),
): OauthQuotaSnapshot | null {
  if (oauth.provider !== 'antigravity') return null;
  const parsedHeaders = parseAntigravityQuotaHeaders(headers, capturedAt);
  if (!parsedHeaders) return null;
  const normalizedHeaders = normalizeCodexQuotaHeaders(parsedHeaders);
  if (!normalizedHeaders) return null;

  const baseSnapshot = buildQuotaSnapshotFromOauthInfo(oauth);
  const fiveHour = normalizedHeaders.fiveHour
    ? buildWindowFromNormalized({
      providerLabel: 'antigravity',
      ...normalizedHeaders.fiveHour,
      capturedAt: parsedHeaders.capturedAt,
    })
    : null;
  const sevenDay = normalizedHeaders.sevenDay
    ? buildWindowFromNormalized({
      providerLabel: 'antigravity',
      ...normalizedHeaders.sevenDay,
      capturedAt: parsedHeaders.capturedAt,
    })
    : null;
  if (!fiveHour && !sevenDay) return null;

  const lastLimitResetAt = fiveHour?.resetAt || sevenDay?.resetAt || baseSnapshot.lastLimitResetAt;

  return {
    ...baseSnapshot,
    status: 'supported',
    source: 'reverse_engineered',
    lastSyncAt: parsedHeaders.capturedAt,
    lastError: undefined,
    providerMessage: 'antigravity usage windows inferred from rate limit response headers',
    windows: {
      fiveHour: fiveHour || baseSnapshot.windows.fiveHour,
      sevenDay: sevenDay || baseSnapshot.windows.sevenDay,
    },
    ...(lastLimitResetAt ? { lastLimitResetAt } : {}),
  };
}

function buildStoredCodexSnapshot(oauth: Pick<OauthInfo, 'planType' | 'idToken' | 'quota'>): OauthQuotaSnapshot {
  const claims = parseCodexJwtClaims(oauth.idToken);
  const authClaims = claims?.['https://api.openai.com/auth'];
  const storedQuota = normalizeStoredQuotaSnapshot(oauth.quota);
  const subscription = {
    planType: asTrimmedString(authClaims?.chatgpt_plan_type) || oauth.planType,
    activeStart: asIsoDateTime(authClaims?.chatgpt_subscription_active_start),
    activeUntil: asIsoDateTime(authClaims?.chatgpt_subscription_active_until),
  };

  return {
    status: storedQuota?.status || 'supported',
    source: storedQuota?.source || 'reverse_engineered',
    ...(storedQuota?.lastSyncAt ? { lastSyncAt: storedQuota.lastSyncAt } : {}),
    ...(storedQuota?.lastError ? { lastError: storedQuota.lastError } : {}),
    providerMessage: storedQuota?.providerMessage || 'current codex oauth signals do not expose stable 5h/7d remaining values',
    ...((subscription.planType || subscription.activeStart || subscription.activeUntil) ? { subscription } : {}),
    windows: storedQuota?.windows || buildCodexUnsupportedWindows(),
    ...(storedQuota?.lastLimitResetAt ? { lastLimitResetAt: storedQuota.lastLimitResetAt } : {}),
  };
}

function buildAntigravityPendingWindows(): OauthQuotaSnapshot['windows'] {
  return {
    fiveHour: buildUnsupportedWindow('refresh antigravity quota to populate Google One AI credit balance'),
    sevenDay: buildUnsupportedWindow('refresh antigravity quota to populate Google One AI minimum usage amount'),
  };
}

function buildStoredAntigravitySnapshot(oauth: Pick<OauthInfo, 'planType' | 'quota'>): OauthQuotaSnapshot {
  const storedQuota = normalizeStoredQuotaSnapshot(oauth.quota);
  const usableStoredQuota = storedQuota?.providerMessage === 'official quota windows are not exposed for antigravity oauth'
    ? undefined
    : storedQuota;
  return {
    status: usableStoredQuota?.status || 'supported',
    source: usableStoredQuota?.source || 'reverse_engineered',
    ...(usableStoredQuota?.lastSyncAt ? { lastSyncAt: usableStoredQuota.lastSyncAt } : {}),
    ...(usableStoredQuota?.lastError ? { lastError: usableStoredQuota.lastError } : {}),
    providerMessage: usableStoredQuota?.providerMessage || 'antigravity quota requires loadCodeAssist credit lookup',
    ...(oauth.planType ? { subscription: { planType: oauth.planType } } : {}),
    windows: usableStoredQuota?.windows || buildAntigravityPendingWindows(),
    ...(usableStoredQuota?.lastLimitResetAt ? { lastLimitResetAt: usableStoredQuota.lastLimitResetAt } : {}),
  };
}

export function buildQuotaSnapshotFromOauthInfo(oauth: Pick<OauthInfo, 'provider' | 'planType' | 'idToken' | 'quota'>): OauthQuotaSnapshot {
  if (oauth.provider === 'codex') {
    return buildStoredCodexSnapshot(oauth);
  }
  if (oauth.provider === 'antigravity') {
    return buildStoredAntigravitySnapshot(oauth);
  }
  return buildProviderUnsupportedSnapshot(oauth.provider);
}

export function parseCodexQuotaResetHint(
  statusCode: number,
  errorBody: string | null | undefined,
  nowMs = Date.now(),
): { resetAt: string; message: string } | null {
  if (statusCode !== 429 || !errorBody) return null;
  try {
    const parsed = JSON.parse(errorBody) as Record<string, any>;
    const error = parsed?.error;
    if (!error || typeof error !== 'object' || error.type !== 'usage_limit_reached') {
      return null;
    }
    if (typeof error.resets_at === 'number' && Number.isFinite(error.resets_at) && error.resets_at > 0) {
      return {
        resetAt: new Date(error.resets_at * 1000).toISOString(),
        message: 'codex usage_limit_reached reset hint observed from upstream',
      };
    }
    if (typeof error.resets_in_seconds === 'number' && Number.isFinite(error.resets_in_seconds) && error.resets_in_seconds > 0) {
      return {
        resetAt: new Date(nowMs + error.resets_in_seconds * 1000).toISOString(),
        message: 'codex usage_limit_reached reset hint observed from upstream',
      };
    }
  } catch {
    return null;
  }
  return null;
}

async function persistQuotaSnapshot(accountId: number, snapshot: OauthQuotaSnapshot) {
  const account = await db.select().from(schema.accounts).where(eq(schema.accounts.id, accountId)).get();
  if (!account) {
    throw new Error('oauth account not found');
  }
  const oauth = getOauthInfoFromAccount(account);
  if (!oauth) {
    throw new Error('account is not managed by oauth');
  }
  const nextExtraConfig = mergeAccountExtraConfig(account.extraConfig, {
    oauth: buildStoredOauthStateFromAccount(account, {
      quota: snapshot,
    }),
  });
  await db.update(schema.accounts).set({
    extraConfig: nextExtraConfig,
    updatedAt: new Date().toISOString(),
  }).where(eq(schema.accounts.id, accountId)).run();
  return snapshot;
}

export async function recordOauthQuotaHeadersSnapshot(input: {
  accountId: number;
  headers: HeaderSource;
}): Promise<OauthQuotaSnapshot | null> {
  const account = await db.select().from(schema.accounts).where(eq(schema.accounts.id, input.accountId)).get();
  if (!account) return null;
  const oauth = getOauthInfoFromAccount(account);
  if (!oauth || (oauth.provider !== 'codex' && oauth.provider !== 'antigravity')) return null;

  const fingerprint = buildProviderQuotaHeadersFingerprint(oauth.provider, input.headers);
  if (!fingerprint) return null;
  const nowMs = Date.now();
  const lastRecorded = recentQuotaHeaderSnapshotByAccount.get(input.accountId);
  if (
    lastRecorded
    && lastRecorded.fingerprint === fingerprint
    && nowMs - lastRecorded.recordedAtMs < QUOTA_HEADER_SNAPSHOT_DEDUPE_WINDOW_MS
  ) {
    return buildQuotaSnapshotFromOauthInfo(oauth);
  }
  const pendingKey = `${input.accountId}:${fingerprint}`;
  if (pendingQuotaHeaderSnapshotKeys.has(pendingKey)) {
    return buildQuotaSnapshotFromOauthInfo(oauth);
  }

  const snapshot = oauth.provider === 'antigravity'
    ? buildAntigravityQuotaSnapshotFromHeaders(oauth, input.headers)
    : buildCodexQuotaSnapshotFromHeaders(oauth, input.headers);
  if (!snapshot) return null;
  pendingQuotaHeaderSnapshotKeys.add(pendingKey);
  try {
    const persisted = await persistQuotaSnapshot(input.accountId, snapshot);
    recentQuotaHeaderSnapshotByAccount.set(input.accountId, {
      fingerprint,
      recordedAtMs: nowMs,
    });
    return persisted;
  } finally {
    pendingQuotaHeaderSnapshotKeys.delete(pendingKey);
  }
}

function buildAntigravityQuotaProbeUrl(baseUrl: string): string {
  return `${baseUrl.replace(/\/+$/, '')}/${ANTIGRAVITY_INTERNAL_API_VERSION}:loadCodeAssist`;
}

function buildAntigravityQuotaProbeHeaders(accessToken: string): Record<string, string> {
  return {
    Authorization: `Bearer ${accessToken.trim()}`,
    'Content-Type': 'application/json',
    Accept: '*/*',
    'User-Agent': ANTIGRAVITY_LOAD_CODE_ASSIST_USER_AGENT,
  };
}

function buildAntigravityQuotaProbePayload(): Record<string, unknown> {
  return {
    metadata: {
      ideType: 'ANTIGRAVITY',
    },
  };
}

function parseCreditAmount(value: unknown): number | undefined {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value !== 'string') return undefined;
  const parsed = Number.parseFloat(value.trim());
  return Number.isFinite(parsed) ? parsed : undefined;
}

function findRecordByPath(root: unknown, path: readonly string[]): Record<string, unknown> | undefined {
  let current = root;
  for (const segment of path) {
    if (!current || typeof current !== 'object' || Array.isArray(current)) return undefined;
    current = (current as Record<string, unknown>)[segment];
  }
  return current && typeof current === 'object' && !Array.isArray(current)
    ? current as Record<string, unknown>
    : undefined;
}

function pickNumber(record: Record<string, unknown>, keys: readonly string[]): number | undefined {
  for (const key of keys) {
    const value = asFiniteNumber(record[key]);
    if (value !== undefined) return value;
  }
  return undefined;
}

function pickIsoDate(record: Record<string, unknown>, keys: readonly string[]): string | undefined {
  for (const key of keys) {
    const value = asIsoDateTime(record[key]);
    if (value) return value;
    const epoch = asFiniteNumber(record[key]);
    if (epoch !== undefined && epoch > 0) {
      const millis = epoch > 10_000_000_000 ? epoch : epoch * 1000;
      const parsed = new Date(millis);
      if (!Number.isNaN(parsed.getTime())) return parsed.toISOString();
    }
  }
  return undefined;
}

function pickResetAfterSeconds(record: Record<string, unknown>): number | undefined {
  const direct = pickNumber(record, [
    'resetAfterSeconds',
    'resetInSeconds',
    'resetsInSeconds',
    'secondsUntilReset',
    'remainingSeconds',
  ]);
  if (direct !== undefined) return direct;
  const duration = asTrimmedString(record.resetAfter || record.resetDelay || record.quotaResetDelay);
  if (!duration) return undefined;
  const simple = duration.match(/^(\d+(?:\.\d+)?)(ms|s|m|h|d)$/i);
  if (!simple) return undefined;
  const amount = Number.parseFloat(simple[1]);
  if (!Number.isFinite(amount)) return undefined;
  const unit = simple[2].toLowerCase();
  if (unit === 'ms') return amount / 1000;
  if (unit === 's') return amount;
  if (unit === 'm') return amount * 60;
  if (unit === 'h') return amount * 60 * 60;
  return amount * 24 * 60 * 60;
}

function buildAntigravityWindowFromRecord(record: Record<string, unknown>, capturedAt: string): OauthQuotaWindowSnapshot | undefined {
  const limit = pickNumber(record, ['limit', 'total', 'quota', 'capacity', 'max', 'maximum']);
  const used = pickNumber(record, ['used', 'usage', 'usedCount', 'consumed']);
  const remaining = pickNumber(record, ['remaining', 'remainingCount', 'available', 'availableCount']);
  const usedPercent = pickNumber(record, ['usedPercent', 'usagePercent', 'percentUsed']);
  const remainingPercent = pickNumber(record, ['remainingPercent', 'availablePercent', 'percentRemaining']);
  const resetAt = pickIsoDate(record, ['resetAt', 'resetsAt', 'resetTime', 'resetTimeStamp', 'quotaResetTimeStamp'])
    || (() => {
      const resetAfterSeconds = pickResetAfterSeconds(record);
      if (resetAfterSeconds === undefined) return undefined;
      return new Date(new Date(capturedAt).getTime() + resetAfterSeconds * 1000).toISOString();
    })();
  const message = asTrimmedString(record.message || record.status || record.state);

  if (
    limit === undefined
    && used === undefined
    && remaining === undefined
    && usedPercent === undefined
    && remainingPercent === undefined
    && !resetAt
    && !message
  ) {
    return undefined;
  }

  const normalizedLimit = limit ?? ((usedPercent !== undefined || remainingPercent !== undefined) ? 100 : undefined);
  const normalizedUsed = used ?? (usedPercent !== undefined
    ? Math.max(0, Math.min(100, usedPercent))
    : remainingPercent !== undefined
      ? Math.max(0, Math.min(100, 100 - remainingPercent))
      : undefined);
  const normalizedRemaining = remaining ?? (remainingPercent !== undefined
    ? Math.max(0, Math.min(100, remainingPercent))
    : undefined);

  return {
    supported: true,
    ...(normalizedLimit !== undefined ? { limit: normalizedLimit } : {}),
    ...(normalizedUsed !== undefined ? { used: normalizedUsed } : {}),
    ...(normalizedRemaining !== undefined ? { remaining: normalizedRemaining } : {}),
    ...(resetAt ? { resetAt } : {}),
    ...(message ? { message } : {}),
  };
}

function extractAntigravityModelFamilyWindows(
  payload: unknown,
  capturedAt: string,
): NonNullable<NonNullable<OauthQuotaSnapshot['antigravity']>['modelFamilies']> | undefined {
  const familyPaths = {
    gemini: [
      ['usage', 'gemini'],
      ['quota', 'gemini'],
      ['quotas', 'gemini'],
      ['modelFamilies', 'gemini'],
      ['modelFamilyQuotas', 'gemini'],
      ['paidTier', 'usage', 'gemini'],
      ['paidTier', 'quotas', 'gemini'],
    ],
    claudeGpt: [
      ['usage', 'claudeGpt'],
      ['usage', 'claudeAndGpt'],
      ['quota', 'claudeGpt'],
      ['quotas', 'claudeGpt'],
      ['modelFamilies', 'claudeGpt'],
      ['modelFamilies', 'claudeAndGpt'],
      ['modelFamilyQuotas', 'claudeGpt'],
      ['paidTier', 'usage', 'claudeGpt'],
      ['paidTier', 'quotas', 'claudeGpt'],
    ],
  } as const;

  const buildFamily = (
    records: readonly (readonly string[])[],
    label: string,
    models: string[],
  ) => {
    for (const path of records) {
      const record = findRecordByPath(payload, path);
      if (!record) continue;
      const windowsRecord = record.windows && typeof record.windows === 'object' && !Array.isArray(record.windows)
        ? record.windows as Record<string, unknown>
        : record;
      const fiveHourSource = findRecordByPath(windowsRecord, ['fiveHour'])
        || findRecordByPath(windowsRecord, ['five_hour'])
        || findRecordByPath(windowsRecord, ['fiveHourLimit'])
        || findRecordByPath(windowsRecord, ['short'])
        || findRecordByPath(windowsRecord, ['primary']);
      const sevenDaySource = findRecordByPath(windowsRecord, ['sevenDay'])
        || findRecordByPath(windowsRecord, ['seven_day'])
        || findRecordByPath(windowsRecord, ['weekly'])
        || findRecordByPath(windowsRecord, ['week'])
        || findRecordByPath(windowsRecord, ['secondary']);
      const fiveHour = fiveHourSource ? buildAntigravityWindowFromRecord(fiveHourSource, capturedAt) : undefined;
      const sevenDay = sevenDaySource ? buildAntigravityWindowFromRecord(sevenDaySource, capturedAt) : undefined;
      if (!fiveHour && !sevenDay) continue;
      return {
        label,
        models,
        windows: {
          fiveHour: fiveHour || buildUnsupportedWindow('antigravity 5h quota window was not exposed'),
          sevenDay: sevenDay || buildUnsupportedWindow('antigravity weekly quota window was not exposed'),
        },
      };
    }
    return undefined;
  };

  const gemini = buildFamily(familyPaths.gemini, 'Gemini 模型', ['Gemini Flash', 'Gemini Pro']);
  const claudeGpt = buildFamily(familyPaths.claudeGpt, 'Claude 和 GPT 模型', ['Claude Opus', 'Claude Sonnet', 'GPT-OSS']);
  if (!gemini && !claudeGpt) return undefined;
  return {
    ...(gemini ? { gemini } : {}),
    ...(claudeGpt ? { claudeGpt } : {}),
  };
}

function extractAntigravityCreditSnapshot(
  oauth: Pick<OauthInfo, 'provider' | 'planType' | 'idToken' | 'quota'>,
  payload: unknown,
  capturedAt: string,
): OauthQuotaSnapshot | null {
  if (oauth.provider !== 'antigravity' || !payload || typeof payload !== 'object' || Array.isArray(payload)) {
    return null;
  }
  const paidTier = (payload as Record<string, unknown>).paidTier;
  if (!paidTier || typeof paidTier !== 'object' || Array.isArray(paidTier)) return null;
  const paidTierRecord = paidTier as Record<string, unknown>;
  const credits = Array.isArray(paidTierRecord.availableCredits) ? paidTierRecord.availableCredits : [];
  let selectedCredit: Record<string, unknown> | undefined;
  for (const rawCredit of credits) {
    if (!rawCredit || typeof rawCredit !== 'object' || Array.isArray(rawCredit)) continue;
    const credit = rawCredit as Record<string, unknown>;
    const creditType = asTrimmedString(credit.creditType);
    if (creditType === 'GOOGLE_ONE_AI') {
      selectedCredit = credit;
      break;
    }
    if (!selectedCredit) selectedCredit = credit;
  }
  if (!selectedCredit) return null;

  const creditAmount = parseCreditAmount(selectedCredit.creditAmount);
  const minimumCreditAmount = parseCreditAmount(selectedCredit.minimumCreditAmountForUsage);
  if (creditAmount === undefined && minimumCreditAmount === undefined) return null;

  const tierId = asTrimmedString(paidTierRecord.id);
  const creditType = asTrimmedString(selectedCredit.creditType) || 'GOOGLE_ONE_AI';
  const baseSnapshot = buildQuotaSnapshotFromOauthInfo(oauth);
  const modelFamilies = extractAntigravityModelFamilyWindows(payload, capturedAt);
  const windows = modelFamilies?.gemini?.windows || modelFamilies?.claudeGpt?.windows || buildAntigravityPendingWindows();
  const creditAvailable = creditAmount !== undefined && minimumCreditAmount !== undefined
    ? creditAmount >= minimumCreditAmount
    : undefined;

  return {
    ...baseSnapshot,
    status: 'supported',
    source: 'official',
    lastSyncAt: capturedAt,
    lastError: undefined,
    providerMessage: modelFamilies
      ? 'antigravity quota windows loaded from loadCodeAssist'
      : 'antigravity Google One AI credits loaded from loadCodeAssist',
    windows,
    antigravity: {
      credits: {
        creditType,
        ...(creditAmount !== undefined ? { creditAmount } : {}),
        ...(minimumCreditAmount !== undefined ? { minimumCreditAmountForUsage: minimumCreditAmount } : {}),
        ...(creditAvailable !== undefined ? { available: creditAvailable } : {}),
      },
      ...(modelFamilies ? { modelFamilies } : {}),
    },
  };
}

function buildCodexQuotaProbePayload(): Record<string, unknown> {
  return {
    model: CODEX_QUOTA_PROBE_MODEL,
    input: [
      {
        role: 'user',
        content: [
          {
            type: 'input_text',
            text: 'hi',
          },
        ],
      },
    ],
    stream: true,
    store: false,
    instructions: CODEX_QUOTA_PROBE_INSTRUCTIONS,
  };
}

function buildCodexQuotaProbeUrl(baseUrl: string): string {
  return `${baseUrl.replace(/\/+$/, '')}/responses`;
}

function buildCodexQuotaProbeHeaders(input: {
  accessToken: string;
  accountId?: string;
}): Record<string, string> {
  return {
    Authorization: `Bearer ${input.accessToken.trim()}`,
    'Content-Type': 'application/json',
    Accept: 'text/event-stream',
    Connection: 'Keep-Alive',
    Originator: 'codex_cli_rs',
    Version: CODEX_QUOTA_PROBE_VERSION,
    'User-Agent': CODEX_QUOTA_PROBE_USER_AGENT,
    'OpenAI-Beta': CODEX_QUOTA_PROBE_BETA,
    Session_id: randomUUID(),
    ...(input.accountId ? { 'Chatgpt-Account-Id': input.accountId } : {}),
  };
}

async function probeCodexQuotaSnapshot(input: {
  account: typeof schema.accounts.$inferSelect;
  oauth: OauthInfo;
  syncedAt: string;
}): Promise<OauthQuotaSnapshot> {
  const site = await db.select().from(schema.sites).where(eq(schema.sites.id, input.account.siteId)).get();
  if (!site) {
    throw new Error('oauth site not found');
  }
  const accessToken = (input.account.accessToken || '').trim();
  if (!accessToken) {
    throw new Error('codex oauth access token missing');
  }
  const proxyUrl = await resolveOauthAccountProxyUrl({
    siteId: input.account.siteId,
    extraConfig: input.account.extraConfig,
  });
  const requestBody = JSON.stringify(buildCodexQuotaProbePayload());

  return runWithSiteApiEndpointPool(site, async (target) => {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), CODEX_QUOTA_PROBE_TIMEOUT_MS);
    let response: Awaited<ReturnType<typeof fetch>>;
    try {
      response = await fetch(
        buildCodexQuotaProbeUrl(target.baseUrl),
        withExplicitProxyRequestInit(proxyUrl, {
          method: 'POST',
          headers: buildCodexQuotaProbeHeaders({
            accessToken,
            accountId: input.oauth.accountId || input.oauth.accountKey,
          }),
          body: requestBody,
          signal: controller.signal,
        }),
      );
    } catch (error) {
      if (controller.signal.aborted) {
        throw new Error(`codex quota probe timeout (${Math.round(CODEX_QUOTA_PROBE_TIMEOUT_MS / 1000)}s)`);
      }
      throw error;
    } finally {
      clearTimeout(timeout);
    }

    const snapshot = buildCodexQuotaSnapshotFromHeaders(input.oauth, response.headers, input.syncedAt);
    if (snapshot) {
      const responseBody = response as { body?: { cancel?: () => Promise<void> | void } };
      void Promise.resolve(responseBody.body?.cancel?.()).catch(() => {});
      return snapshot;
    }

    const errorText = await response.text().catch(() => '');
    if (!response.ok) {
      const resetHint = parseCodexQuotaResetHint(response.status, errorText, Date.now());
      return buildQuotaErrorSnapshot({
        oauth: input.oauth,
        message: errorText || `codex quota probe failed with status ${response.status}`,
        syncedAt: input.syncedAt,
        ...(resetHint ? { lastLimitResetAt: resetHint.resetAt } : {}),
      });
    }

    return buildQuotaErrorSnapshot({
      oauth: input.oauth,
      message: 'codex quota probe response did not expose x-codex rate limit headers',
      syncedAt: input.syncedAt,
    });
  });
}

async function probeAntigravityQuotaSnapshot(input: {
  account: typeof schema.accounts.$inferSelect;
  oauth: OauthInfo;
  syncedAt: string;
}): Promise<OauthQuotaSnapshot> {
  const accessToken = (input.account.accessToken || '').trim();
  if (!accessToken) {
    throw new Error('antigravity oauth access token missing');
  }
  const proxyUrl = await resolveOauthAccountProxyUrl({
    siteId: input.account.siteId,
    extraConfig: input.account.extraConfig,
  });
  const requestBody = JSON.stringify(buildAntigravityQuotaProbePayload());
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), ANTIGRAVITY_QUOTA_PROBE_TIMEOUT_MS);
  let response: Awaited<ReturnType<typeof fetch>>;
  try {
    response = await fetch(
      buildAntigravityQuotaProbeUrl(ANTIGRAVITY_UPSTREAM_BASE_URL),
      withExplicitProxyRequestInit(proxyUrl, {
        method: 'POST',
        headers: buildAntigravityQuotaProbeHeaders(accessToken),
        body: requestBody,
        signal: controller.signal,
      }),
    );
  } catch (error) {
    if (controller.signal.aborted) {
      return buildQuotaErrorSnapshot({
        oauth: input.oauth,
        message: `antigravity quota probe timeout (${Math.round(ANTIGRAVITY_QUOTA_PROBE_TIMEOUT_MS / 1000)}s)`,
        syncedAt: input.syncedAt,
      });
    }
    return buildQuotaErrorSnapshot({
      oauth: input.oauth,
      message: error instanceof Error ? (error.message || error.name) : String(error || 'antigravity quota probe failed'),
      syncedAt: input.syncedAt,
    });
  } finally {
    clearTimeout(timeout);
  }

  const text = await response.text().catch(() => '');
  if (!response.ok) {
    return buildQuotaErrorSnapshot({
      oauth: input.oauth,
      message: text || `antigravity loadCodeAssist quota probe failed with status ${response.status}`,
      syncedAt: input.syncedAt,
    });
  }

  let payload: unknown;
  try {
    payload = text ? JSON.parse(text) : null;
  } catch {
    return buildQuotaErrorSnapshot({
      oauth: input.oauth,
      message: 'antigravity loadCodeAssist quota response was not valid JSON',
      syncedAt: input.syncedAt,
    });
  }
  const snapshot = extractAntigravityCreditSnapshot(input.oauth, payload, input.syncedAt);
  return snapshot || buildQuotaErrorSnapshot({
    oauth: input.oauth,
    message: 'antigravity loadCodeAssist response did not expose Google One AI credits',
    syncedAt: input.syncedAt,
  });
}

export async function refreshOauthQuotaSnapshot(accountId: number): Promise<OauthQuotaSnapshot> {
  const account = await db.select().from(schema.accounts).where(eq(schema.accounts.id, accountId)).get();
  if (!account) {
    throw new Error('oauth account not found');
  }
  const oauth = getOauthInfoFromAccount(account);
  if (!oauth) {
    throw new Error('account is not managed by oauth');
  }
  if (oauth.provider === 'codex') {
    const syncedAt = new Date().toISOString();
    try {
      const snapshot = await probeCodexQuotaSnapshot({
        account,
        oauth,
        syncedAt,
      });
      return persistQuotaSnapshot(accountId, snapshot);
    } catch (error) {
      const message = error instanceof Error
        ? (error.message || error.name)
        : String(error || 'codex quota probe failed');
      return persistQuotaSnapshot(accountId, buildQuotaErrorSnapshot({
        oauth,
        message,
        syncedAt,
      }));
    }
  }
  if (oauth.provider === 'antigravity') {
    const syncedAt = new Date().toISOString();
    try {
      const snapshot = await probeAntigravityQuotaSnapshot({
        account,
        oauth,
        syncedAt,
      });
      return persistQuotaSnapshot(accountId, snapshot);
    } catch (error) {
      const message = error instanceof Error
        ? (error.message || error.name)
        : String(error || 'antigravity quota probe failed');
      return persistQuotaSnapshot(accountId, buildQuotaErrorSnapshot({
        oauth,
        message,
        syncedAt,
      }));
    }
  }
  const baseSnapshot = buildQuotaSnapshotFromOauthInfo(oauth);
  const snapshot: OauthQuotaSnapshot = {
    ...baseSnapshot,
    lastSyncAt: new Date().toISOString(),
    ...(baseSnapshot.status === 'error' ? {} : { lastError: undefined }),
  };
  return persistQuotaSnapshot(accountId, snapshot);
}

export async function recordOauthQuotaResetHint(input: {
  accountId: number;
  statusCode: number;
  errorText?: string | null;
}): Promise<OauthQuotaSnapshot | null> {
  const resetHint = parseCodexQuotaResetHint(input.statusCode, input.errorText);
  if (!resetHint) return null;

  const account = await db.select().from(schema.accounts).where(eq(schema.accounts.id, input.accountId)).get();
  if (!account) return null;
  const oauth = getOauthInfoFromAccount(account);
  if (!oauth || oauth.provider !== 'codex') return null;

  const baseSnapshot = buildQuotaSnapshotFromOauthInfo({
    ...oauth,
    quota: {
      ...normalizeStoredQuotaSnapshot(oauth.quota),
      status: 'supported',
      source: 'reverse_engineered',
      lastLimitResetAt: resetHint.resetAt,
      providerMessage: 'current codex oauth signals do not expose stable 5h/7d remaining values',
      windows: normalizeStoredQuotaSnapshot(oauth.quota)?.windows || buildCodexUnsupportedWindows(),
    },
  });

  return persistQuotaSnapshot(input.accountId, {
    ...baseSnapshot,
    lastSyncAt: new Date().toISOString(),
    lastLimitResetAt: resetHint.resetAt,
  });
}
