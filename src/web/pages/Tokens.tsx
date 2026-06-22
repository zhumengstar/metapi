import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { Navigate, useLocation, useNavigate } from 'react-router-dom';
import { api } from '../api.js';
import CenteredModal from '../components/CenteredModal.js';
import ResponsiveFilterPanel from '../components/ResponsiveFilterPanel.js';
import ResponsiveFormGrid from '../components/ResponsiveFormGrid.js';
import ResponsiveBatchActionBar from '../components/ResponsiveBatchActionBar.js';
import { useToast } from '../components/Toast.js';
import { formatDateTimeLocal } from './helpers/checkinLogTime.js';
import {
  isTruthyFlag,
  parsePositiveInt,
  resolveAccountCredentialMode,
} from './helpers/accountConnection.js';
import ModernSelect from '../components/ModernSelect.js';
import { MobileCard, MobileField } from '../components/MobileCard.js';
import { useIsMobile } from '../components/useIsMobile.js';
import DeleteConfirmModal from '../components/DeleteConfirmModal.js';
import { clearFocusParams, readFocusTokenId } from './helpers/navigationFocus.js';
import { shouldIgnoreRowSelectionClick } from './helpers/rowSelection.js';
import { tr } from '../i18n.js';
import { isImageGenerationModel } from '../utils/modelType.js';

type SyncStatus = 'success' | 'skipped' | 'failed';
type TokensPanelProps = {
  embedded?: boolean;
  onEmbeddedActionsChange?: (actions: React.ReactNode | null) => void;
};

type AccountTokenSyncResult = {
  status?: string;
  success?: boolean;
  synced?: boolean;
  message?: string;
  reason?: string;
  created?: number;
  updated?: number;
  maskedPending?: number;
  pendingTokenIds?: number[];
  accountId?: number;
  accountName?: string;
  account?: {
    id?: number;
    username?: string;
  };
};

type SyncableAccount = {
  id: number;
  username?: string | null;
  accessToken?: string | null;
  status?: string | null;
  credentialMode?: string | null;
  capabilities?: {
    proxyOnly?: boolean;
  } | null;
  site?: {
    status?: string | null;
    name?: string | null;
  } | null;
};

type TokenAvailabilityTestResult = {
  tokenId: number;
  model: string;
  available: boolean;
  message?: string;
  responseText?: string | null;
  httpStatus?: number | null;
  latencyMs?: number | null;
  checkedAt?: string | null;
};

type SkippedTokenAvailabilityTestResult = Omit<TokenAvailabilityTestResult, 'available'> & {
  available: false;
};

type AvailabilityTooltipRow = {
  label: string;
  value?: string | number | null;
  tone?: 'success' | 'error' | 'warning' | 'muted';
};

type AvailabilityTooltipState = {
  rows: AvailabilityTooltipRow[];
  left: number;
  top: number;
};

type TokenModelDialogItem = {
  name: string;
  routeEnabled: boolean;
};

type TokenHealthCheckForm = {
  enabled: boolean;
  model: string;
  intervalMinutes: string;
};

const AVAILABILITY_TOOLTIP_WIDTH = 300;
const AVAILABILITY_TOOLTIP_OFFSET = 12;
const MODEL_TEST_CONCURRENCY = 6;

type TokenSortKey =
  | 'account'
  | 'site'
  | 'name'
  | 'token'
  | 'group'
  | 'ratio'
  | 'status'
  | 'availability'
  | 'default'
  | 'updatedAt';
type TokenSortRule = { key: TokenSortKey; order: 'asc' | 'desc' };
type TokenStatusFilter = 'all' | 'enabled' | 'disabled' | 'pending' | 'autoDisabled';
type TokenAvailabilityFilter = 'all' | 'available' | 'unavailable';

const ACCOUNT_SELECT_SEARCH_PLACEHOLDER = '筛选账号（名称 / 站点）';
const DEFAULT_BATCH_TEST_MODEL = 'gpt-5.5';
const IMAGE_MODEL_TEST_SKIPPED_MESSAGE = '只有图片模型，未进行聊天可用性测试';
const TOKEN_RATIO_FILTER_STORAGE_KEY = 'metapi.tokens.maxGroupRatioFilter';
const DEFAULT_TOKEN_SORT_RULES: TokenSortRule[] = [
  { key: 'status', order: 'desc' },
  { key: 'ratio', order: 'asc' },
  { key: 'availability', order: 'desc' },
];

function getDefaultTokenSortOrder(key: TokenSortKey): 'asc' | 'desc' {
  return key === 'status' || key === 'availability' || key === 'default' || key === 'updatedAt'
    ? 'desc'
    : 'asc';
}

function normalizeTokenModelDialogItems(models: unknown, routeStates?: Record<string, boolean> | null): TokenModelDialogItem[] {
  const result: TokenModelDialogItem[] = [];
  const seen = new Set<string>();
  const input = Array.isArray(models) ? models : [];
  for (const item of input) {
    const modelName = typeof item === 'string'
      ? item.trim()
      : String((item as any)?.name ?? (item as any)?.modelName ?? '').trim();
    if (!modelName) continue;
    const key = modelName.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    const itemRouteEnabled = typeof item === 'object' && item !== null
      ? (item as any).routeEnabled === true
      : routeStates?.[modelName] === true;
    result.push({ name: modelName, routeEnabled: itemRouteEnabled });
  }
  return result.sort((left, right) => left.name.localeCompare(right.name));
}

async function runWithConcurrency<T>(
  items: T[],
  concurrency: number,
  worker: (item: T) => Promise<void>,
) {
  let cursor = 0;
  const workerCount = Math.min(Math.max(1, concurrency), items.length);
  await Promise.all(Array.from({ length: workerCount }, async () => {
    while (cursor < items.length) {
      const item = items[cursor++];
      if (item === undefined) continue;
      await worker(item);
    }
  }));
}

function formatGroupRatio(value?: number | null) {
  if (!Number.isFinite(value)) return '';
  const normalized = Number(value);
  return `${Number.isInteger(normalized) ? normalized : normalized.toFixed(3).replace(/0+$/, '').replace(/\.$/, '')}x`;
}

function readStoredTokenRatioFilter() {
  if (typeof window === 'undefined') return '';
  try {
    const value = window.localStorage.getItem(TOKEN_RATIO_FILTER_STORAGE_KEY);
    return typeof value === 'string' ? value : '';
  } catch {
    return '';
  }
}

function normalizeTokenRatioFilterInput(value: string) {
  const normalized = value.replace(/[^\d.]/g, '');
  const firstDotIndex = normalized.indexOf('.');
  if (firstDotIndex < 0) return normalized;
  return `${normalized.slice(0, firstDotIndex + 1)}${normalized.slice(firstDotIndex + 1).replace(/\./g, '')}`;
}

function resolveTokenAvailabilityResult(
  token: any,
  modelSearch: string,
  pendingResult?: TokenAvailabilityTestResult,
): TokenAvailabilityTestResult | null {
  const tokenId = Number(token?.id);
  if (!Number.isInteger(tokenId) || tokenId <= 0) return null;

  const requestedModel = modelSearch.trim().toLowerCase();
  if (pendingResult && (!requestedModel || pendingResult.model.trim().toLowerCase() === requestedModel)) {
    return pendingResult;
  }

  const hasTestRecord = (row: any) => (
    typeof row?.message === 'string' && row.message.trim().length > 0
  ) || row?.httpStatus != null || (
    typeof row?.responseText === 'string' && row.responseText.trim().length > 0
  );
  const rows = (Array.isArray(token?.modelAvailability) ? token.modelAvailability : [])
    .filter(hasTestRecord);
  const matched = requestedModel
    ? rows.find((row: any) => String(row?.modelName || '').trim().toLowerCase() === requestedModel)
    : rows
      .filter((row: any) => row?.available === true || row?.available === false)
      .sort((left: any, right: any) => {
        const leftTime = Date.parse(String(left?.checkedAt || ''));
        const rightTime = Date.parse(String(right?.checkedAt || ''));
        return (Number.isFinite(rightTime) ? rightTime : 0) - (Number.isFinite(leftTime) ? leftTime : 0);
      })[0];

  if (!matched || (matched.available !== true && matched.available !== false)) return null;
  return {
    tokenId,
    model: String(matched.modelName || modelSearch.trim() || ''),
    available: matched.available === true,
    message: String(matched.message || '').trim() || (matched.available ? '请求成功' : '最近测试不可用'),
    responseText: matched.responseText ?? null,
    httpStatus: matched.httpStatus ?? null,
    latencyMs: matched.latencyMs,
    checkedAt: matched.checkedAt,
  };
}

const isAccountSyncable = (account: any) =>
  resolveAccountCredentialMode(account) === 'session'
  && account?.status === 'active'
  && account?.site?.status !== 'disabled';

const resolveSyncStatus = (result: AccountTokenSyncResult | null | undefined): SyncStatus => {
  const raw = String(result?.status || '').toLowerCase();
  if (raw === 'failed' || raw === 'error') return 'failed';
  if (raw === 'skipped' || raw === 'skip') return 'skipped';
  if (raw === 'success' || raw === 'ok' || raw === 'succeeded') return 'success';
  if (result?.success === false) return 'failed';
  if (result?.synced === false) return 'skipped';
  return 'success';
};

const resolveSyncMessage = (result: AccountTokenSyncResult | null | undefined, fallback: string) => {
  const message = typeof result?.message === 'string' ? result.message.trim() : '';
  return message || fallback;
};

const isMaskedPendingToken = (token: any): boolean => token?.valueStatus === 'masked_pending';

const isManuallyDisabledToken = (token: any): boolean => (
  token?.enabled === false
  && token?.enabledPreference?.source === 'manual'
  && token?.enabledPreference?.enabled === false
);

const isAutoDisabledToken = (token: any): boolean => (
  token?.enabled === false
  && typeof token?.autoDisabledAt === 'string'
  && token.autoDisabledAt.trim().length > 0
);

const resolveTokenStatusBadgeClass = (token: any, isPending: boolean): string => {
  if (isPending) return 'badge-warning';
  if (token?.enabled) return 'badge-success';
  if (isAutoDisabledToken(token)) return 'badge-info';
  return isManuallyDisabledToken(token) ? 'badge-danger' : 'badge-muted';
};

const resolveTokenStatusLabel = (token: any, isPending: boolean): string => {
  if (isPending) return '待补全';
  if (token?.enabled) return '启用';
  if (isAutoDisabledToken(token)) return '自动禁用';
  return '禁用';
};

const buildManualEnabledPreferencePatch = (token: any, enabled: boolean) => ({
  enabledPreference: {
    enabled,
    source: 'manual',
    group: token?.tokenGroup || 'default',
    groupRatio: token?.groupRatioAvailable ? token?.groupRatio ?? null : null,
  },
});

const isMaskedPendingSyncResult = (result: AccountTokenSyncResult | null | undefined) =>
  String(result?.reason || '').trim().toLowerCase() === 'upstream_masked_tokens'
  && Number(result?.maskedPending || 0) > 0;

const normalizeTokenModelNames = (token: any): string[] => {
  const seen = new Set<string>();
  return (Array.isArray(token?.modelNames) ? token.modelNames : [])
    .map((item: unknown) => String(item || '').trim())
    .filter((modelName: string) => {
      if (!modelName) return false;
      const key = modelName.toLowerCase();
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });
};

const parseHealthCheckModelList = (value: unknown): string[] => {
  const seen = new Set<string>();
  return String(value || '')
    .split(/[\n,，]+/g)
    .map((item) => item.trim())
    .filter((modelName) => {
      if (!modelName) return false;
      const key = modelName.toLowerCase();
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });
};

const formatHealthCheckModelList = (models: string[]): string => models.join(', ');

const getHealthCheckModelOptions = (token: any): string[] => (
  normalizeTokenModelNames(token)
    .filter((modelName) => !isImageGenerationModel(modelName))
    .sort((left, right) => left.localeCompare(right))
);

const resolveDefaultBatchTestModel = (token: any): string => {
  const modelNames = normalizeTokenModelNames(token);
  const nonImageModels = modelNames.filter((modelName) => !isImageGenerationModel(modelName));
  return nonImageModels.find((modelName) => modelName.toLowerCase() === DEFAULT_BATCH_TEST_MODEL)
    || nonImageModels[0]
    || '';
};

const hasOnlyImageModels = (token: any): boolean => {
  const modelNames = normalizeTokenModelNames(token);
  return modelNames.length > 0 && modelNames.every((modelName) => isImageGenerationModel(modelName));
};

const buildImageOnlySkippedResult = (token: any): SkippedTokenAvailabilityTestResult | null => {
  const tokenId = Number(token?.id);
  if (!Number.isInteger(tokenId) || tokenId <= 0) return null;
  const model = normalizeTokenModelNames(token).find((modelName) => isImageGenerationModel(modelName)) || '图片模型';
  return {
    tokenId,
    model,
    available: false,
    message: IMAGE_MODEL_TEST_SKIPPED_MESSAGE,
    responseText: null,
    httpStatus: null,
    latencyMs: null,
    checkedAt: new Date().toISOString(),
  };
};

const isImageOnlySkippedAvailabilityResult = (result: TokenAvailabilityTestResult | null | undefined): boolean => (
  !result?.available
  && (
    String(result?.message || '').trim() === IMAGE_MODEL_TEST_SKIPPED_MESSAGE
    || String(result?.message || '').includes('图片模型不进行聊天可用性测试')
  )
);

const resolveAccountLabel = (result: AccountTokenSyncResult | null | undefined) => {
  const name = typeof result?.accountName === 'string' ? result.accountName.trim() : '';
  if (name) return name;
  const username = typeof result?.account?.username === 'string' ? result.account.username.trim() : '';
  if (username) return username;
  const accountId = result?.accountId ?? result?.account?.id;
  if (accountId) return `#${accountId}`;
  return '未知账号';
};

async function copyText(text: string) {
  if (navigator.clipboard?.writeText) {
    await navigator.clipboard.writeText(text);
    return;
  }

  const textarea = document.createElement('textarea');
  textarea.value = text;
  textarea.style.position = 'fixed';
  textarea.style.opacity = '0';
  textarea.style.left = '-9999px';
  document.body.appendChild(textarea);
  textarea.focus();
  textarea.select();
  document.execCommand('copy');
  document.body.removeChild(textarea);
}

export function TokensPanel({ embedded = false, onEmbeddedActionsChange }: TokensPanelProps) {
  const location = useLocation();
  const navigate = useNavigate();
  const isMobile = useIsMobile();
  const initialCreateForm = {
    accountId: 0,
    name: '',
    group: 'default',
    unlimitedQuota: true,
    remainQuota: '',
    expiredTime: '',
    allowIps: '',
  };

  const [tokens, setTokens] = useState<any[]>([]);
  const [accounts, setAccounts] = useState<any[]>([]);
  const [loading, setLoading] = useState(true);
  const [showAdd, setShowAdd] = useState(false);
  const [syncingAccountId, setSyncingAccountId] = useState(0);
  const [syncing, setSyncing] = useState(false);
  const [syncingAll, setSyncingAll] = useState(false);
  const [ensuringGroupTokens, setEnsuringGroupTokens] = useState(false);
  const [saving, setSaving] = useState(false);
  const [savingEdit, setSavingEdit] = useState(false);
  const [editingToken, setEditingToken] = useState<any | null>(null);
  const [editingTokenValueLoading, setEditingTokenValueLoading] = useState(false);
  const [editingTokenPendingMessage, setEditingTokenPendingMessage] = useState('');
  const [createHintModelName, setCreateHintModelName] = useState('');
  const [highlightTokenId, setHighlightTokenId] = useState<number | null>(null);
  const [pendingAutoOpenTokenId, setPendingAutoOpenTokenId] = useState<number | null>(null);
  const [rowLoading, setRowLoading] = useState<Record<string, boolean>>({});
  const [selectedTokenIds, setSelectedTokenIds] = useState<number[]>([]);
  const [expandedTokenIds, setExpandedTokenIds] = useState<number[]>([]);
  const [showMobileTools, setShowMobileTools] = useState(false);
  const [batchActionLoading, setBatchActionLoading] = useState(false);
  const [deleteConfirm, setDeleteConfirm] = useState<null | {
    mode: 'single' | 'batch';
    tokenId?: number;
    tokenName?: string;
    count?: number;
  }>(null);
  const [tokenSortRules, setTokenSortRules] = useState<TokenSortRule[]>(DEFAULT_TOKEN_SORT_RULES);
  const [modelSearch, setModelSearch] = useState('');
  const [tokenStatusFilter, setTokenStatusFilter] = useState<TokenStatusFilter>('all');
  const [tokenAvailabilityFilter, setTokenAvailabilityFilter] = useState<TokenAvailabilityFilter>('all');
  const [maxGroupRatioFilter, setMaxGroupRatioFilter] = useState(readStoredTokenRatioFilter);
  const [testingModelTokens, setTestingModelTokens] = useState(false);
  const [testingAvailabilityTokenIds, setTestingAvailabilityTokenIds] = useState<number[]>([]);
  const [tokenAvailabilityById, setTokenAvailabilityById] = useState<Record<number, TokenAvailabilityTestResult>>({});
  const [availabilityTooltip, setAvailabilityTooltip] = useState<AvailabilityTooltipState | null>(null);
  const [modelDialogToken, setModelDialogToken] = useState<any | null>(null);
  const [modelDialogModels, setModelDialogModels] = useState<TokenModelDialogItem[]>([]);
  const [modelDialogLoading, setModelDialogLoading] = useState(false);
  const [modelDialogError, setModelDialogError] = useState('');
  const [modelDialogSearch, setModelDialogSearch] = useState('');
  const [modelDialogModelLoading, setModelDialogModelLoading] = useState<Record<string, boolean>>({});
  const [healthCheckToken, setHealthCheckToken] = useState<any | null>(null);
  const [healthCheckForm, setHealthCheckForm] = useState<TokenHealthCheckForm>({
    enabled: false,
    model: DEFAULT_BATCH_TEST_MODEL,
    intervalMinutes: '60',
  });
  const [healthCheckCustomModel, setHealthCheckCustomModel] = useState('');
  const [healthCheckSaving, setHealthCheckSaving] = useState(false);
  const [healthCheckRunning, setHealthCheckRunning] = useState(false);
  const [form, setForm] = useState(initialCreateForm);
  const [editForm, setEditForm] = useState({
    name: '',
    token: '',
    group: 'default',
    enabled: true,
    isDefault: false,
  });
  const [groupOptions, setGroupOptions] = useState<string[]>(['default']);
  const [groupLoading, setGroupLoading] = useState(false);
  const [editGroupOptions, setEditGroupOptions] = useState<string[]>(['default']);
  const [editGroupLoading, setEditGroupLoading] = useState(false);
  const rowRefs = useRef<Map<number, HTMLTableRowElement>>(new Map());
  const highlightTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const editingTokenIdRef = useRef<number | null>(null);
  const toast = useToast();

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const [tokenRows, accountSnapshot] = await Promise.all([
        api.getAccountTokens(),
        api.getAccountsSnapshot(),
      ]);
      const nextTokens = tokenRows || [];
      setTokens(nextTokens);
      setSelectedTokenIds((current) => current.filter((id) => nextTokens.some((token: any) => token.id === id)));
      const latestAccounts: SyncableAccount[] = Array.isArray(accountSnapshot?.accounts)
        ? accountSnapshot.accounts
        : [];
      setAccounts(latestAccounts);

      const syncableAccounts = latestAccounts.filter(isAccountSyncable);
      setSyncingAccountId((current) => (
        current && !syncableAccounts.some((account: SyncableAccount) => account.id === current)
          ? 0
          : current
      ));
      return {
        tokens: nextTokens,
        accounts: latestAccounts,
      };
    } catch (e: any) {
      toast.error(e.message || '加载令牌失败');
      return {
        tokens: [] as any[],
        accounts: [] as any[],
      };
    } finally {
      setLoading(false);
    }
  }, [toast]);

  useEffect(() => {
    void load();
  }, [load]);

  useEffect(() => {
    if (typeof window === 'undefined') return;
    try {
      if (maxGroupRatioFilter.trim()) {
        window.localStorage.setItem(TOKEN_RATIO_FILTER_STORAGE_KEY, maxGroupRatioFilter.trim());
      } else {
        window.localStorage.removeItem(TOKEN_RATIO_FILTER_STORAGE_KEY);
      }
    } catch {
      // Ignore storage failures; the current page state still applies the filter.
    }
  }, [maxGroupRatioFilter]);

  useEffect(() => {
    return () => {
      if (highlightTimerRef.current) {
        clearTimeout(highlightTimerRef.current);
      }
    };
  }, []);

  useEffect(() => {
    if (!showAdd || !form.accountId) {
      setGroupLoading(false);
      setGroupOptions(['default']);
      return;
    }

    let cancelled = false;
    setGroupLoading(true);
    api.getAccountTokenGroups(form.accountId)
      .then((res: any) => {
        if (cancelled) return;
        const groups: string[] = Array.isArray(res?.groups)
          ? res.groups.map((item: any) => String(item || '').trim()).filter(Boolean)
          : [];
        const normalized = Array.from(new Set(groups));
        const nextOptions = normalized.length > 0 ? normalized : ['default'];
        setGroupOptions(nextOptions);
        setForm((prev) => {
          if (nextOptions.includes(prev.group)) return prev;
          return { ...prev, group: nextOptions[0] };
        });
      })
      .catch((error: any) => {
        if (cancelled) return;
        setGroupOptions(['default']);
        setForm((prev) => ({ ...prev, group: 'default' }));
        toast.error(error?.message || '拉取分组失败，已回退 default');
      })
      .finally(() => {
        if (cancelled) return;
        setGroupLoading(false);
      });

    return () => {
      cancelled = true;
    };
  }, [showAdd, form.accountId]);

  useEffect(() => {
    if (!editingToken?.id || !editingToken?.accountId) {
      setEditGroupLoading(false);
      setEditGroupOptions(['default']);
      return;
    }

    const currentGroup = (editingToken?.tokenGroup || '').trim() || 'default';
    let cancelled = false;
    setEditGroupLoading(true);
    api.getAccountTokenGroups(editingToken.accountId)
      .then((res: any) => {
        if (cancelled) return;
        const groups = Array.isArray(res?.groups)
          ? res.groups.map((item: any) => String(item || '').trim()).filter(Boolean)
          : [];
        const normalized = Array.from(new Set(groups));
        setEditGroupOptions((current) => {
          const next = normalized.length > 0 ? normalized : ['default'];
          if (next.includes(currentGroup)) return next;
          return [...next, currentGroup];
        });
      })
      .catch((error: any) => {
        if (cancelled) return;
        setEditGroupOptions((current) => (current.includes(currentGroup) ? current : [...current, currentGroup]));
        toast.error(error?.message || '拉取分组失败，已保留当前分组');
      })
      .finally(() => {
        if (cancelled) return;
        setEditGroupLoading(false);
      });

    return () => {
      cancelled = true;
    };
  }, [editingToken?.id, editingToken?.accountId]);

  const accountClusteredTokens = useMemo(() => {
    const accountLabel = (token: any) => String(token?.account?.username || `account-${token?.accountId || 0}`).toLowerCase();
    const siteLabel = (token: any) => String(token?.site?.name || '').toLowerCase();
    const tokenName = (token: any) => String(token?.name || '').toLowerCase();
    const tokenValue = (token: any) => String(token?.tokenMasked || token?.token || '').toLowerCase();
    const groupLabel = (token: any) => String(token?.tokenGroup || '').toLowerCase();
    const normalizedModelSearch = modelSearch.trim().toLowerCase();
    const maxGroupRatio = Number(maxGroupRatioFilter);
    const hasMaxGroupRatioFilter = Number.isFinite(maxGroupRatio) && maxGroupRatio > 0;
    const tokenModelNames = (token: any): string[] => (
      Array.isArray(token?.modelNames)
        ? token.modelNames.map((item: unknown) => String(item || '').trim()).filter(Boolean)
        : []
    );
    const ratioValue = (token: any) => {
      if (!token?.groupRatioAvailable) return Number.POSITIVE_INFINITY;
      const value = Number(token?.groupRatio);
      return Number.isFinite(value) ? value : Number.POSITIVE_INFINITY;
    };
    const statusRank = (token: any) => {
      if (isMaskedPendingToken(token)) return 0;
      return token?.enabled ? 2 : 1;
    };
    const availabilityRank = (token: any) => {
      const tokenId = Number(token?.id);
      const result = resolveTokenAvailabilityResult(token, modelSearch, tokenAvailabilityById[tokenId]);
      if (!result) return 1;
      return result.available ? 2 : 1;
    };
    const defaultRank = (token: any) => (token?.isDefault ? 1 : 0);
    const updatedAtValue = (token: any) => {
      const timestamp = Date.parse(String(token?.updatedAt || ''));
      return Number.isFinite(timestamp) ? timestamp : 0;
    };

    return [...tokens].filter((token) => {
      if (syncingAccountId && Number(token?.accountId || 0) !== syncingAccountId) return false;
      if (tokenStatusFilter === 'enabled' && !token?.enabled) return false;
      if (tokenStatusFilter === 'disabled' && (token?.enabled || isMaskedPendingToken(token) || isAutoDisabledToken(token))) return false;
      if (tokenStatusFilter === 'pending' && !isMaskedPendingToken(token)) return false;
      if (tokenStatusFilter === 'autoDisabled' && !isAutoDisabledToken(token)) return false;
      if (hasMaxGroupRatioFilter && ratioValue(token) >= maxGroupRatio) return false;
      if (tokenAvailabilityFilter !== 'all') {
        const tokenId = Number(token?.id);
        const result = resolveTokenAvailabilityResult(token, modelSearch, tokenAvailabilityById[tokenId]);
        if (tokenAvailabilityFilter === 'available' && result?.available !== true) return false;
        if (tokenAvailabilityFilter === 'unavailable' && result?.available === true) return false;
      }
      if (!normalizedModelSearch) return true;
      return tokenModelNames(token).some((modelName) => modelName.trim().toLowerCase() === normalizedModelSearch);
    }).sort((left, right) => {
      for (const rule of tokenSortRules) {
        let result = 0;
        if (rule.key === 'ratio') {
          result = ratioValue(left) - ratioValue(right);
        } else if (rule.key === 'site') {
          result = siteLabel(left).localeCompare(siteLabel(right));
        } else if (rule.key === 'name') {
          result = tokenName(left).localeCompare(tokenName(right));
        } else if (rule.key === 'token') {
          result = tokenValue(left).localeCompare(tokenValue(right));
        } else if (rule.key === 'group') {
          result = groupLabel(left).localeCompare(groupLabel(right));
        } else if (rule.key === 'status') {
          result = statusRank(left) - statusRank(right);
        } else if (rule.key === 'availability') {
          result = availabilityRank(left) - availabilityRank(right);
        } else if (rule.key === 'default') {
          result = defaultRank(left) - defaultRank(right);
        } else if (rule.key === 'updatedAt') {
          result = updatedAtValue(left) - updatedAtValue(right);
        } else {
          result = accountLabel(left).localeCompare(accountLabel(right));
        }
        if (result !== 0) return rule.order === 'desc' ? -result : result;
      }
      const accountCmp = accountLabel(left).localeCompare(accountLabel(right));
      if (accountCmp !== 0) return accountCmp;
      const siteCmp = siteLabel(left).localeCompare(siteLabel(right));
      if (siteCmp !== 0) return siteCmp;
      const nameCmp = tokenName(left).localeCompare(tokenName(right));
      if (nameCmp !== 0) return nameCmp;
      return Number(left?.id || 0) - Number(right?.id || 0);
    });
  }, [maxGroupRatioFilter, modelSearch, syncingAccountId, tokenAvailabilityById, tokenAvailabilityFilter, tokenSortRules, tokenStatusFilter, tokens]);
  const allVisibleTokensSelected = accountClusteredTokens.length > 0
    && accountClusteredTokens.every((token) => selectedTokenIds.includes(token.id));
  const hasSelectedTokens = selectedTokenIds.length > 0;
  const visibleTokenIdSignature = useMemo(() => (
    accountClusteredTokens
      .map((token: any) => Number(token?.id))
      .filter((id) => Number.isInteger(id) && id > 0)
      .join(',')
  ), [accountClusteredTokens]);

  useEffect(() => {
    const visibleIds = visibleTokenIdSignature
      ? visibleTokenIdSignature.split(',').map((id) => Number(id)).filter((id) => Number.isInteger(id) && id > 0)
      : [];

    setSelectedTokenIds((current) => {
      const visibleIdSet = new Set(visibleIds);
      const next = current.filter((id) => visibleIdSet.has(id));
      if (next.length === current.length) return current;
      return next;
    });
  }, [visibleTokenIdSignature]);

  const activeAccounts = useMemo(() => accounts.filter(isAccountSyncable), [accounts]);
  const activeAccountSelectOptions = useMemo(() => (
    activeAccounts.map((account) => {
      const accountName = account.username || `account-${account.id}`;
      const siteName = account.site?.name || '-';
      return {
        value: String(account.id),
        label: `${accountName} @ ${siteName}`,
        description: siteName,
      };
    })
  ), [activeAccounts]);

  const exactModelSearch = modelSearch.trim();
  const modelTestTokenIds = useMemo(() => (
    exactModelSearch
      ? accountClusteredTokens
        .map((token: any) => Number(token?.id))
        .filter((id) => Number.isInteger(id) && id > 0)
      : []
  ), [accountClusteredTokens, exactModelSearch]);

  useEffect(() => {
    const params = new URLSearchParams(location.search);
    const shouldOpenCreate = isTruthyFlag(params.get('create'));
    const requestedAccountId = parsePositiveInt(params.get('accountId'));
    const requestedModel = (params.get('model') || '').trim();
    if (!shouldOpenCreate || !requestedAccountId) return;

    const preferredAccount = activeAccounts.find((account) => account.id === requestedAccountId);
    const fallbackAccount = preferredAccount || activeAccounts[0] || null;
    if (!fallbackAccount) return;

    setShowAdd(true);
    setCreateHintModelName(requestedModel);
    setSyncingAccountId(fallbackAccount.id);
    setForm((prev) => ({
      ...prev,
      accountId: fallbackAccount.id,
      group: 'default',
    }));

    if (!preferredAccount) {
      toast.info('指定账号不可用，已自动切换到首个可用账号');
    }

    params.delete('create');
    params.delete('accountId');
    params.delete('model');
    params.delete('from');
    const nextSearch = params.toString();
    navigate(
      {
        pathname: location.pathname,
        search: nextSearch ? `?${nextSearch}` : '',
      },
      { replace: true },
    );
  }, [activeAccounts, location.pathname, location.search, navigate, toast]);

  useEffect(() => {
    const focusTokenId = readFocusTokenId(location.search);
    if (!focusTokenId || loading) return;

    const row = rowRefs.current.get(focusTokenId);
    const cleanedSearch = clearFocusParams(location.search);
    if (!row) {
      navigate({ pathname: location.pathname, search: cleanedSearch }, { replace: true });
      return;
    }

    row.scrollIntoView({ behavior: 'smooth', block: 'center' });
    setHighlightTokenId(focusTokenId);
    if (highlightTimerRef.current) clearTimeout(highlightTimerRef.current);
    highlightTimerRef.current = setTimeout(() => {
      setHighlightTokenId((current) => (current === focusTokenId ? null : current));
    }, 2200);

    navigate({ pathname: location.pathname, search: cleanedSearch }, { replace: true });
  }, [loading, location.pathname, location.search, navigate, tokens]);

  const focusTokenRow = useCallback((tokenId: number) => {
    const row = rowRefs.current.get(tokenId);
    if (row) {
      row.scrollIntoView({ behavior: 'smooth', block: 'center' });
    }
    setHighlightTokenId(tokenId);
    if (highlightTimerRef.current) clearTimeout(highlightTimerRef.current);
    highlightTimerRef.current = setTimeout(() => {
      setHighlightTokenId((current) => (current === tokenId ? null : current));
    }, 2200);
  }, []);

  const withRowLoading = async (key: string, fn: () => Promise<void>) => {
    setRowLoading((prev) => ({ ...prev, [key]: true }));
    try {
      await fn();
    } finally {
      setRowLoading((prev) => ({ ...prev, [key]: false }));
    }
  };

  const markTokenAsDefault = useCallback((token: any) => {
    const accountId = Number(token?.accountId || 0);
    const tokenId = Number(token?.id || 0);
    if (!accountId || !tokenId) return;
    setTokens((current) => current.map((item) => (
      Number(item?.accountId || 0) === accountId
        ? { ...item, isDefault: Number(item?.id || 0) === tokenId }
        : item
    )));
  }, []);

  const handleSetDefaultToken = useCallback(async (token: any) => {
    const loadingKey = `token-${token.id}-default`;
    try {
      await withRowLoading(loadingKey, async () => {
        const res = await api.setDefaultAccountToken(token.id);
        const returnedTokens = Array.isArray(res?.accountTokens) ? res.accountTokens : [];
        if (returnedTokens.length > 0) {
          const stateById = new Map<number, { isDefault?: boolean; enabled?: boolean; updatedAt?: string }>(
            returnedTokens.map((item: any) => [Number(item?.id), item]),
          );
          setTokens((current) => current.map((item) => {
            const nextState = stateById.get(Number(item?.id));
            if (!nextState) return item;
            return {
              ...item,
              isDefault: nextState.isDefault === true,
              enabled: nextState.enabled ?? item.enabled,
              updatedAt: nextState.updatedAt || item.updatedAt,
            };
          }));
        } else {
          markTokenAsDefault(token);
        }
        toast.success('默认令牌已更新');
      });
    } catch (error) {
      toast.error(error instanceof Error ? error.message : '默认令牌更新失败');
    }
  }, [markTokenAsDefault, toast]);

  const patchTokenRow = useCallback((tokenId: number, patch: Record<string, unknown>) => {
    setTokens((current) => current.map((item) => (
      Number(item?.id || 0) === tokenId ? { ...item, ...patch } : item
    )));
  }, []);

  const patchTokenFromHealthCheckResponse = useCallback((
    tokenId: number,
    responseToken: any,
    result?: TokenAvailabilityTestResult | null,
    results?: TokenAvailabilityTestResult[] | null,
  ) => {
    const resultList = (Array.isArray(results) && results.length > 0)
      ? results
      : (result ? [result] : []);
    const patch: Record<string, unknown> = {
      healthCheckEnabled: responseToken?.healthCheckEnabled,
      healthCheckIntervalMinutes: responseToken?.healthCheckIntervalMinutes,
      healthCheckModel: responseToken?.healthCheckModel,
      healthCheckLastRunAt: responseToken?.healthCheckLastRunAt,
      healthCheckNextRunAt: responseToken?.healthCheckNextRunAt,
      healthCheckLastAvailable: responseToken?.healthCheckLastAvailable,
      healthCheckLastMessage: responseToken?.healthCheckLastMessage,
      healthCheckLastLatencyMs: responseToken?.healthCheckLastLatencyMs,
      updatedAt: responseToken?.updatedAt || new Date().toISOString(),
    };
    setTokens((current) => current.map((item) => {
      if (Number(item?.id || 0) !== tokenId) return item;
      const next: any = { ...item, ...patch };
      if (resultList.length > 0) {
        const existingAvailability = Array.isArray(item.modelAvailability) ? item.modelAvailability : [];
        const resultModelKeys = new Set(resultList
          .map((entry) => String(entry?.model || '').trim().toLowerCase())
          .filter(Boolean));
        next.modelAvailability = [
          ...existingAvailability.filter((entry: any) => (
            !resultModelKeys.has(String(entry?.modelName || entry?.model || '').trim().toLowerCase())
          )),
          ...resultList.map((entry) => {
            const model = String(entry?.model || '').trim();
            return {
              modelName: model,
              model,
              available: entry.available,
              message: entry.message || '',
              responseText: entry.responseText || null,
              httpStatus: entry.httpStatus ?? null,
              latencyMs: entry.latencyMs ?? null,
              checkedAt: entry.checkedAt || null,
            };
          }),
        ].filter((entry) => String(entry?.modelName || entry?.model || '').trim());
        const nextModelNames = normalizeTokenModelNames(item);
        for (const entry of resultList) {
          const model = String(entry?.model || '').trim();
          if (model && !nextModelNames.some((name) => name.toLowerCase() === model.toLowerCase())) {
            nextModelNames.push(model);
          }
        }
        if (nextModelNames.length !== normalizeTokenModelNames(item).length) {
          next.modelNames = nextModelNames.sort((left, right) => left.localeCompare(right));
          next.modelCount = next.modelNames.length;
        }
        const routeStates = { ...(item.modelRouteStates || {}) };
        for (const entry of resultList) {
          const model = String(entry?.model || '').trim();
          if (model && entry.available) routeStates[model] = true;
        }
        next.modelRouteStates = routeStates;
      }
      return next;
    }));
  }, []);

  const handleToggleTokenEnabled = useCallback(async (token: any) => {
    const loadingKey = `token-${token.id}-toggle`;
    await withRowLoading(loadingKey, async () => {
      const nextEnabled = !token.enabled;
      await api.updateAccountToken(token.id, { enabled: nextEnabled });
      toast.success(token.enabled ? '令牌已禁用' : '令牌已启用');
      patchTokenRow(token.id, {
        enabled: nextEnabled,
        autoDisabledAt: null,
        autoDisabledReason: null,
        autoDisabledPreviousEnabled: null,
        ...buildManualEnabledPreferencePatch(token, nextEnabled),
        updatedAt: new Date().toISOString(),
      });
    });
  }, [patchTokenRow, toast]);

  const resolveHealthCheckDefaultModel = useCallback((token: any) => {
    const searched = modelSearch.trim();
    if (searched) return searched;
    const configured = String(token?.healthCheckModel || '').trim();
    if (configured) return configured;
    const nonImageModel = normalizeTokenModelNames(token).find((modelName) => !isImageGenerationModel(modelName));
    return nonImageModel || DEFAULT_BATCH_TEST_MODEL;
  }, [modelSearch]);

  const openHealthCheckPanel = useCallback((token: any) => {
    setHealthCheckToken(token);
    setHealthCheckCustomModel('');
    setHealthCheckForm({
      enabled: token?.healthCheckEnabled === true,
      model: resolveHealthCheckDefaultModel(token),
      intervalMinutes: String(token?.healthCheckIntervalMinutes || 60),
    });
  }, [resolveHealthCheckDefaultModel]);

  const closeHealthCheckPanel = useCallback(() => {
    if (healthCheckSaving || healthCheckRunning) return;
    setHealthCheckToken(null);
  }, [healthCheckRunning, healthCheckSaving]);

  const saveHealthCheckPanel = useCallback(async () => {
    if (!healthCheckToken) return;
    const model = formatHealthCheckModelList(parseHealthCheckModelList(healthCheckForm.model));
    const intervalMinutes = Number.parseInt(healthCheckForm.intervalMinutes, 10);
    if (healthCheckForm.enabled && !model) {
      toast.error('开启定时测活时必须填写模型');
      return;
    }
    if (!Number.isFinite(intervalMinutes) || intervalMinutes <= 0) {
      toast.error('测活间隔必须是正数分钟');
      return;
    }
    setHealthCheckSaving(true);
    try {
      const res = await api.updateAccountTokenHealthCheck(healthCheckToken.id, {
        enabled: healthCheckForm.enabled,
        model,
        intervalMinutes,
      });
      if (res?.token) {
        patchTokenFromHealthCheckResponse(Number(healthCheckToken.id), res.token, null);
        setHealthCheckToken((current: any | null) => (
          current && Number(current.id) === Number(healthCheckToken.id)
            ? { ...current, ...res.token }
            : current
        ));
      }
      toast.success(healthCheckForm.enabled ? '定时测活已保存' : '定时测活已关闭');
    } catch (error: any) {
      toast.error(error?.message || '保存测活配置失败');
    } finally {
      setHealthCheckSaving(false);
    }
  }, [healthCheckForm.enabled, healthCheckForm.intervalMinutes, healthCheckForm.model, healthCheckToken, patchTokenFromHealthCheckResponse, toast]);

  const runHealthCheckNow = useCallback(async () => {
    if (!healthCheckToken) return;
    const tokenId = Number(healthCheckToken.id);
    const model = formatHealthCheckModelList(parseHealthCheckModelList(healthCheckForm.model));
    if (!model) {
      toast.error('请至少选择一个测活模型');
      return;
    }
    setHealthCheckRunning(true);
    setTestingAvailabilityTokenIds((current) => Array.from(new Set([...current, tokenId])));
    try {
      const shouldSaveFirst = (
        model !== formatHealthCheckModelList(parseHealthCheckModelList(healthCheckToken.healthCheckModel))
        || Number.parseInt(healthCheckForm.intervalMinutes, 10) !== Number(healthCheckToken.healthCheckIntervalMinutes || 60)
        || healthCheckForm.enabled !== (healthCheckToken.healthCheckEnabled === true)
      );
      let tokenForRun = healthCheckToken;
      if (shouldSaveFirst) {
        const intervalMinutes = Number.parseInt(healthCheckForm.intervalMinutes, 10);
        const res = await api.updateAccountTokenHealthCheck(tokenId, {
          enabled: healthCheckForm.enabled,
          model,
          intervalMinutes: Number.isFinite(intervalMinutes) && intervalMinutes > 0 ? intervalMinutes : 60,
        });
        if (res?.token) tokenForRun = { ...tokenForRun, ...res.token };
      }
      const queuedRun = await api.runAccountTokenHealthCheck(tokenId, { async: true });
      const res = queuedRun?.jobId
        ? await api.waitForTaskResult(queuedRun.jobId, { timeoutMs: 10 * 60_000, pollMs: 1_000 })
        : queuedRun;
      const result = res?.result as TokenAvailabilityTestResult | undefined;
      const results = Array.isArray(res?.results) ? res.results as TokenAvailabilityTestResult[] : [];
      const responseToken = res?.token || tokenForRun;
      if (responseToken) {
        patchTokenFromHealthCheckResponse(tokenId, responseToken, result || null, results);
        setHealthCheckToken((current: any | null) => (
          current && Number(current.id) === tokenId
            ? {
              ...current,
              ...responseToken,
              healthCheckLastRunAt: result?.checkedAt || responseToken.healthCheckLastRunAt,
              healthCheckLastAvailable: result?.available ?? responseToken.healthCheckLastAvailable,
              healthCheckLastMessage: result?.message || responseToken.healthCheckLastMessage,
              healthCheckLastLatencyMs: result?.latencyMs ?? responseToken.healthCheckLastLatencyMs,
            }
            : current
        ));
      }
      const latestResult = result || results.find((item) => item.available) || results[0];
      if (latestResult) {
        setTokenAvailabilityById((current) => ({ ...current, [tokenId]: latestResult }));
      }
      const successCount = results.length > 0 ? results.filter((item) => item.available).length : (result?.available ? 1 : 0);
      const totalCount = results.length > 0 ? results.length : (result ? 1 : 0);
      if (successCount > 0) {
        toast.success(`测活成功 ${successCount}/${totalCount}，已加入路由`);
      } else {
        toast.error(`测活失败：${result?.message || '未知错误'}`);
      }
    } catch (error: any) {
      toast.error(error?.message || '立即测活失败');
    } finally {
      setTestingAvailabilityTokenIds((current) => current.filter((id) => id !== tokenId));
      setHealthCheckRunning(false);
    }
  }, [healthCheckForm.enabled, healthCheckForm.intervalMinutes, healthCheckForm.model, healthCheckToken, patchTokenFromHealthCheckResponse, toast]);

  const removeTokenRows = useCallback((tokenIds: number[]) => {
    const idSet = new Set(tokenIds.map((id) => Number(id)).filter((id) => Number.isFinite(id) && id > 0));
    if (idSet.size === 0) return;
    setTokens((current) => current.filter((item) => !idSet.has(Number(item?.id || 0))));
    setSelectedTokenIds((current) => current.filter((id) => !idSet.has(id)));
    setExpandedTokenIds((current) => current.filter((id) => !idSet.has(id)));
  }, []);

  const toggleTokenSelection = (tokenId: number, checked: boolean) => {
    setSelectedTokenIds((current) => (
      checked
        ? Array.from(new Set([...current, tokenId]))
        : current.filter((id) => id !== tokenId)
    ));
  };

  const toggleSelectAllTokens = (checked: boolean) => {
    if (!checked) {
      setSelectedTokenIds((current) => current.filter((id) => !accountClusteredTokens.some((token) => token.id === id)));
      return;
    }
    setSelectedTokenIds((current) => Array.from(new Set([...current, ...accountClusteredTokens.map((token) => token.id)])));
  };

  const toggleTokenSort = useCallback((key: TokenSortKey) => {
    setTokenSortRules((current) => {
      const existing = current.find((rule) => rule.key === key);
      if (existing) {
        return current.map((rule) => (
          rule.key === key
            ? { ...rule, order: rule.order === 'asc' ? 'desc' : 'asc' }
            : rule
        ));
      }
      return [...current, { key, order: getDefaultTokenSortOrder(key) }];
    });
  }, []);

  const renderTokenSortLabel = useCallback((label: string, key: TokenSortKey) => {
    const sortIndex = tokenSortRules.findIndex((rule) => rule.key === key);
    const sortRule = sortIndex >= 0 ? tokenSortRules[sortIndex] : null;
    return (
      <button
        type="button"
        onClick={() => toggleTokenSort(key)}
        className="btn btn-link"
        style={{ padding: 0, fontWeight: 700, color: 'inherit' }}
        title={sortRule ? `排序优先级 ${sortIndex + 1}` : '点击加入排序'}
      >
        {label}{sortRule ? ` ${sortRule.order === 'asc' ? '↑' : '↓'}${sortIndex + 1}` : ''}
      </button>
    );
  }, [toggleTokenSort, tokenSortRules]);

  const toggleTokenDetails = (tokenId: number) => {
    setExpandedTokenIds((current) => (
      current.includes(tokenId)
        ? current.filter((id) => id !== tokenId)
        : [...current, tokenId]
    ));
  };

  const runBatchTokenAction = async (action: 'enable' | 'disable' | 'delete', skipDeleteConfirm = false) => {
    if (selectedTokenIds.length === 0) return;
    if (action === 'delete' && !skipDeleteConfirm) {
      setDeleteConfirm({ mode: 'batch', count: selectedTokenIds.length });
      return;
    }

    setBatchActionLoading(true);
    try {
      const result = await api.batchUpdateAccountTokens({
        ids: selectedTokenIds,
        action,
      });
      const successIds = Array.isArray(result?.successIds) ? result.successIds.map((id: unknown) => Number(id)) : [];
      const failedItems = Array.isArray(result?.failedItems) ? result.failedItems : [];
      if (failedItems.length > 0) {
        toast.info(`批量操作完成：成功 ${successIds.length}，失败 ${failedItems.length}`);
      } else {
        toast.success(`批量操作完成：成功 ${successIds.length}`);
      }
      if (action === 'delete') {
        removeTokenRows(successIds);
      } else {
        setTokens((current) => current.map((item) => (
          successIds.includes(Number(item?.id || 0))
            ? {
              ...item,
              enabled: action === 'enable',
              ...buildManualEnabledPreferencePatch(item, action === 'enable'),
              updatedAt: new Date().toISOString(),
            }
            : item
        )));
      }
      setSelectedTokenIds(failedItems.map((item: any) => Number(item.id)).filter((id: number) => Number.isFinite(id) && id > 0));
    } catch (e: any) {
      toast.error(e.message || '批量操作失败');
    } finally {
      setBatchActionLoading(false);
    }
  };

  const confirmDelete = async () => {
    const target = deleteConfirm;
    if (!target) return;

    setDeleteConfirm(null);
    if (target.mode === 'single' && target.tokenId) {
      try {
        await withRowLoading(`token-${target.tokenId}-delete`, async () => {
          await api.deleteAccountToken(target.tokenId!);
          toast.success('令牌已删除');
          removeTokenRows([target.tokenId!]);
        });
      } catch (e: any) {
        toast.error(e?.message || '删除令牌失败');
      }
      return;
    }

    await runBatchTokenAction('delete', true);
  };

  const openEditPanel = useCallback((token: any) => {
    setShowAdd(false);
    setCreateHintModelName('');
    setEditingToken(token);
    editingTokenIdRef.current = token.id;
    setEditingTokenPendingMessage(
      isMaskedPendingToken(token)
        ? '请粘贴完整明文 token；当前本地仅保存了上游返回的脱敏占位值。'
        : '',
    );
    setEditForm({
      name: token?.name || '',
      token: '',
      group: (token?.tokenGroup || '').trim() || 'default',
      enabled: isMaskedPendingToken(token) ? true : token?.enabled !== false,
      isDefault: !!token?.isDefault,
    });

    if (isMaskedPendingToken(token)) {
      setEditingTokenValueLoading(false);
      return;
    }

    setEditingTokenValueLoading(true);

    void api.getAccountTokenValue(token.id)
      .then((res: any) => {
        if (editingTokenIdRef.current !== token.id) return;
        setEditForm((prev) => ({
          ...prev,
          token: typeof res?.token === 'string' ? res.token : prev.token,
        }));
      })
      .catch((error: any) => {
        if (editingTokenIdRef.current !== token.id) return;
        toast.error(error?.message || '加载令牌详情失败');
      })
      .finally(() => {
        if (editingTokenIdRef.current !== token.id) return;
        setEditingTokenValueLoading(false);
      });
  }, [toast]);

  const closeEditPanel = useCallback(() => {
    editingTokenIdRef.current = null;
    setEditingToken(null);
    setSavingEdit(false);
    setEditingTokenValueLoading(false);
    setEditingTokenPendingMessage('');
    setEditForm({
      name: '',
      token: '',
      group: 'default',
      enabled: true,
      isDefault: false,
    });
  }, []);

  const saveEditPanel = async () => {
    if (!editingToken) return;
    if (isMaskedPendingToken(editingToken) && !editForm.token.trim()) {
      toast.error('请粘贴完整明文 token 后再保存');
      return;
    }
    setSavingEdit(true);
    try {
      const res = await api.updateAccountToken(editingToken.id, {
        name: editForm.name.trim() || editingToken.name,
        token: editForm.token.trim() || undefined,
        group: editForm.group || 'default',
        enabled: editForm.enabled,
        isDefault: editForm.isDefault,
      });
      const latest = res?.token || {};
      patchTokenRow(editingToken.id, {
        name: latest.name ?? editForm.name.trim() ?? editingToken.name,
        tokenGroup: latest.tokenGroup ?? editForm.group ?? 'default',
        enabled: latest.enabled ?? editForm.enabled,
        ...buildManualEnabledPreferencePatch(
          { ...editingToken, tokenGroup: latest.tokenGroup ?? editForm.group ?? editingToken.tokenGroup },
          latest.enabled ?? editForm.enabled,
        ),
        isDefault: latest.isDefault ?? editForm.isDefault,
        valueStatus: latest.valueStatus || (editForm.token.trim() ? 'ready' : editingToken.valueStatus),
        updatedAt: latest.updatedAt || new Date().toISOString(),
      });
      if (latest.isDefault || editForm.isDefault) {
        markTokenAsDefault({ ...editingToken, id: editingToken.id, accountId: editingToken.accountId });
      }
      toast.success('令牌已更新');
      closeEditPanel();
    } catch (e: any) {
      toast.error(e.message || '更新令牌失败');
    } finally {
      setSavingEdit(false);
    }
  };

  useEffect(() => {
    if (!pendingAutoOpenTokenId || loading) return;
    const token = tokens.find((item: any) => item.id === pendingAutoOpenTokenId);
    if (!token) return;
    focusTokenRow(token.id);
    openEditPanel(token);
    setPendingAutoOpenTokenId(null);
  }, [focusTokenRow, loading, openEditPanel, pendingAutoOpenTokenId, tokens]);

  const handleTokenRowClick = (tokenId: number, event: React.MouseEvent<HTMLTableRowElement>) => {
    if (shouldIgnoreRowSelectionClick(event.target)) return;
    const isSelected = selectedTokenIds.includes(tokenId);
    toggleTokenSelection(tokenId, !isSelected);
  };

  const handleCopyToken = async (tokenId: number, tokenName: string) => {
    try {
      await withRowLoading(`token-${tokenId}-copy`, async () => {
        const res = await api.getAccountTokenValue(tokenId);
        const tokenValue = (res?.token || '').trim();
        if (!tokenValue) {
          toast.error('令牌为空，无法复制');
          return;
        }

        await copyText(tokenValue);
        toast.success(`已复制令牌：${tokenName || `token-${tokenId}`}`);
      });
    } catch (error: any) {
      toast.error(error?.message || '复制令牌失败');
    }
  };

  const handleAccountFilterChange = useCallback((nextValue: string) => {
    setSyncingAccountId(Number.parseInt(nextValue, 10) || 0);
  }, []);

  const openTokenModels = useCallback((token: any) => {
    const cachedModels = normalizeTokenModelDialogItems(token?.modelNames, token?.modelRouteStates);
    setModelDialogToken(token);
    setModelDialogModels(cachedModels);
    setModelDialogSearch('');
    setModelDialogError('');
    setModelDialogLoading(true);
    setModelDialogModelLoading({});
    api.getAccountTokenModels(token.id, { refresh: false })
      .then((res: any) => {
        const serverModels = normalizeTokenModelDialogItems(res?.models, token?.modelRouteStates);
        setModelDialogModels(serverModels);
        const routeStates = Object.fromEntries(serverModels.map((item) => [item.name, item.routeEnabled]));
        setModelDialogToken((current: any | null) => (
          current && Number(current.id) === Number(token.id)
            ? {
              ...current,
              modelNames: serverModels.map((item) => item.name),
              modelRouteStates: routeStates,
              modelSyncedAt: res?.checkedAt || current.modelSyncedAt || null,
            }
            : current
        ));
        setTokens((current) => current.map((item) => (
          Number(item?.id) === Number(token.id)
            ? {
              ...item,
              modelNames: serverModels.map((model) => model.name),
              modelRouteStates: routeStates,
              modelCount: serverModels.length,
              modelSyncedAt: res?.checkedAt || item.modelSyncedAt || null,
            }
            : item
        )));
        setModelDialogError('');
      })
      .catch((error: any) => {
        setModelDialogError(error?.message || '读取令牌模型缓存失败');
      })
      .finally(() => {
        setModelDialogLoading(false);
      });
  }, []);

  const closeModelDialog = useCallback(() => {
    setModelDialogToken(null);
    setModelDialogModels([]);
    setModelDialogError('');
    setModelDialogSearch('');
    setModelDialogLoading(false);
    setModelDialogModelLoading({});
  }, []);

  const toggleModelRouteEnabled = useCallback(async (model: TokenModelDialogItem) => {
    if (!modelDialogToken) return;
    const tokenId = Number(modelDialogToken.id);
    if (!Number.isInteger(tokenId) || tokenId <= 0) return;
    const nextRouteEnabled = !model.routeEnabled;
    const loadingKey = model.name.toLowerCase();
    setModelDialogModelLoading((current) => ({ ...current, [loadingKey]: true }));
    try {
      const res = await api.setAccountTokenModelRouteEnabled(tokenId, {
        modelName: model.name,
        routeEnabled: nextRouteEnabled,
      });
      const serverModels = normalizeTokenModelDialogItems(res?.models, null);
      const nextModels = serverModels.length > 0
        ? serverModels
        : modelDialogModels.map((item) => (
          item.name.toLowerCase() === model.name.toLowerCase()
            ? { ...item, routeEnabled: nextRouteEnabled }
            : item
        ));
      const nextRouteStates = Object.fromEntries(nextModels.map((item) => [item.name, item.routeEnabled]));
      setModelDialogModels(nextModels);
      setTokens((current) => current.map((token) => {
        if (Number(token?.id) !== tokenId) return token;
        return {
          ...token,
          modelNames: nextModels.map((item) => item.name),
          modelRouteStates: nextRouteStates,
          modelCount: nextModels.length,
          modelSyncedAt: res?.checkedAt || token.modelSyncedAt || null,
        };
      }));
      setModelDialogToken((current: any | null) => {
        if (!current || Number(current.id) !== tokenId) return current;
        return {
          ...current,
          modelNames: nextModels.map((item) => item.name),
          modelRouteStates: nextRouteStates,
          modelSyncedAt: res?.checkedAt || current.modelSyncedAt || null,
        };
      });
      toast.success(nextRouteEnabled ? '模型已点亮，可用于路由' : '模型已取消点亮');
    } catch (error: any) {
      toast.error(error?.message || '更新模型路由状态失败');
    } finally {
      setModelDialogModelLoading((current) => ({ ...current, [loadingKey]: false }));
    }
  }, [modelDialogModels, modelDialogToken, toast]);

  const applyModelAvailabilityResults = useCallback((model: string, results: TokenAvailabilityTestResult[]) => {
    const nextModel = model.trim();
    if (!nextModel) return;

    setTokenAvailabilityById((current) => {
      const next = { ...current };
      for (const result of results) {
        const tokenId = Number(result?.tokenId);
        if (!Number.isInteger(tokenId) || tokenId <= 0) continue;
        next[tokenId] = {
          tokenId,
          model: nextModel,
          available: !!result.available,
          message: result.message,
          responseText: result.responseText,
          httpStatus: result.httpStatus,
          latencyMs: result.latencyMs,
          checkedAt: result.checkedAt,
        };
      }
      return next;
    });

    setTokens((current) => current.map((token) => {
      const tokenId = Number(token?.id);
      const result = results.find((item) => Number(item?.tokenId) === tokenId);
      if (!result) return token;

        const existingRows = Array.isArray(token?.modelAvailability) ? token.modelAvailability : [];
        const nextAvailabilityRows = existingRows.filter((row: any) => (
          String(row?.modelName || '').trim().toLowerCase() !== nextModel.toLowerCase()
        ));
        nextAvailabilityRows.push({
          modelName: nextModel,
          available: !!result.available,
          message: result.message,
          responseText: result.responseText,
          httpStatus: result.httpStatus,
          latencyMs: result.latencyMs,
          checkedAt: result.checkedAt,
        });
        nextAvailabilityRows.sort((left: any, right: any) => (
          String(left?.modelName || '').localeCompare(String(right?.modelName || ''))
        ));

        const existingModels = Array.isArray(token?.modelNames)
          ? token.modelNames.map((item: unknown) => String(item || '').trim()).filter(Boolean)
          : [];
        const existingRouteStates = token?.modelRouteStates && typeof token.modelRouteStates === 'object'
          ? token.modelRouteStates
          : {};
        const existingRouteStateEntry = Object.entries(existingRouteStates)
          .find(([modelName]) => modelName.trim().toLowerCase() === nextModel.toLowerCase());
        const hasModel = existingModels.some((item: string) => item.toLowerCase() === nextModel.toLowerCase());
        const nextModelNames = hasModel
          ? existingModels
          : [...existingModels, nextModel].sort((left, right) => left.localeCompare(right));

        return {
          ...token,
          modelNames: nextModelNames,
          modelRouteStates: {
            ...existingRouteStates,
            [nextModel]: existingRouteStateEntry?.[1] === true,
          },
          modelCount: nextModelNames.length,
          modelAvailability: nextAvailabilityRows,
          modelSyncedAt: result.checkedAt || token.modelSyncedAt || null,
          updatedAt: result.checkedAt || new Date().toISOString(),
        };
    }));
  }, []);

  const testModelTokens = useCallback(async (tokenIds: number[], emptyMessage: string) => {
    const model = modelSearch.trim();
    if (!model) {
      toast.error('请先输入完整模型名称');
      return;
    }
    const normalizedTokenIds = Array.from(new Set(tokenIds
      .map((id) => Number(id))
      .filter((id) => Number.isInteger(id) && id > 0)));
    if (normalizedTokenIds.length === 0) {
      toast.info(emptyMessage);
      return;
    }

    setTestingModelTokens(true);
    setTestingAvailabilityTokenIds(normalizedTokenIds);
    try {
      let availableCount = 0;
      let finishedCount = 0;
      await runWithConcurrency(normalizedTokenIds, MODEL_TEST_CONCURRENCY, async (tokenId) => {
        try {
          const queuedTest = await api.testAccountTokenModelAvailability({
            model,
            tokenIds: [tokenId],
            async: true,
          });
          const res = queuedTest?.jobId
            ? await api.waitForTaskResult(queuedTest.jobId, { timeoutMs: 10 * 60_000, pollMs: 1_000 })
            : queuedTest;
          const results: TokenAvailabilityTestResult[] = Array.isArray(res?.results) ? res.results : [];
          applyModelAvailabilityResults(model, results);
          if (Array.isArray(res?.healthCheckTokens)) {
            for (const responseToken of res.healthCheckTokens) {
              const tokenId = Number(responseToken?.id);
              if (!Number.isInteger(tokenId) || tokenId <= 0) continue;
              const tokenResults = results.filter((item) => Number(item?.tokenId) === tokenId);
              patchTokenFromHealthCheckResponse(tokenId, responseToken, null, tokenResults);
            }
          }
          availableCount += results.filter((result) => result.available).length;
          finishedCount += results.length;
        } finally {
          setTestingAvailabilityTokenIds((current) => current.filter((id) => id !== tokenId));
        }
      });
      toast.success(`测试完成：可用 ${availableCount}，不可用 ${Math.max(finishedCount - availableCount, 0)}`);
    } catch (error: any) {
      toast.error(error?.message || '测试令牌可用性失败');
    } finally {
      setTestingModelTokens(false);
      setTestingAvailabilityTokenIds([]);
    }
  }, [applyModelAvailabilityResults, modelSearch, patchTokenFromHealthCheckResponse, toast]);

  const handleTestFilteredModelTokens = useCallback(async () => {
    await testModelTokens(modelTestTokenIds, '没有匹配该模型的令牌');
  }, [modelTestTokenIds, testModelTokens]);

  const handleBatchTestSelectedTokens = useCallback(async () => {
    const model = modelSearch.trim();
    if (model) {
      await testModelTokens(selectedTokenIds, '请先选择需要检测的令牌');
      return;
    }

    const selectedIdSet = new Set(selectedTokenIds);
    const selectedTokens = tokens.filter((token) => selectedIdSet.has(Number(token?.id)));
    const groupedTokenIds = new Map<string, number[]>();
    const imageOnlySkippedResults: SkippedTokenAvailabilityTestResult[] = [];
    const skippedCount = selectedTokens.reduce((count, token) => {
      const tokenId = Number(token?.id);
      if (!Number.isInteger(tokenId) || tokenId <= 0) return count + 1;
      const testModel = resolveDefaultBatchTestModel(token);
      if (!testModel && hasOnlyImageModels(token)) {
        const skippedResult = buildImageOnlySkippedResult(token);
        if (skippedResult) imageOnlySkippedResults.push(skippedResult);
        return count;
      }
      if (!testModel) return count + 1;
      const group = groupedTokenIds.get(testModel) || [];
      group.push(tokenId);
      groupedTokenIds.set(testModel, group);
      return count;
    }, 0);

    const testGroups = Array.from(groupedTokenIds.entries());
    if (testGroups.length === 0 && imageOnlySkippedResults.length === 0) {
      toast.info(selectedTokenIds.length > 0 ? '所选令牌没有可检测的模型列表' : '请先选择需要检测的令牌');
      return;
    }

    const testingTokenIds = Array.from(groupedTokenIds.values()).flat();
    setTestingModelTokens(true);
    setTestingAvailabilityTokenIds(testingTokenIds);
    try {
      let total = 0;
      let availableCount = 0;
      if (imageOnlySkippedResults.length > 0) {
        const skippedRes = await api.saveSkippedAccountTokenModelAvailability({ results: imageOnlySkippedResults });
        const resultsByModel = new Map<string, TokenAvailabilityTestResult[]>();
        for (const result of imageOnlySkippedResults) {
          const group = resultsByModel.get(result.model) || [];
          group.push(result);
          resultsByModel.set(result.model, group);
        }
        for (const [skippedModel, results] of resultsByModel) {
          applyModelAvailabilityResults(skippedModel, results);
        }
        if (Array.isArray(skippedRes?.healthCheckTokens)) {
          for (const responseToken of skippedRes.healthCheckTokens) {
            const tokenId = Number(responseToken?.id);
            if (!Number.isInteger(tokenId) || tokenId <= 0) continue;
            const tokenResults = imageOnlySkippedResults.filter((item) => Number(item?.tokenId) === tokenId);
            patchTokenFromHealthCheckResponse(tokenId, responseToken, null, tokenResults);
          }
        }
        total += imageOnlySkippedResults.length;
      }
      const testJobs = testGroups.flatMap(([testModel, tokenIds]) => tokenIds.map((tokenId) => ({ testModel, tokenId })));
      await runWithConcurrency(testJobs, MODEL_TEST_CONCURRENCY, async ({ testModel, tokenId }) => {
        try {
          const queuedTest = await api.testAccountTokenModelAvailability({
            model: testModel,
            tokenIds: [tokenId],
            async: true,
          });
          const res = queuedTest?.jobId
            ? await api.waitForTaskResult(queuedTest.jobId, { timeoutMs: 10 * 60_000, pollMs: 1_000 })
            : queuedTest;
          const results: TokenAvailabilityTestResult[] = Array.isArray(res?.results) ? res.results : [];
          applyModelAvailabilityResults(testModel, results);
          if (Array.isArray(res?.healthCheckTokens)) {
            for (const responseToken of res.healthCheckTokens) {
              const tokenId = Number(responseToken?.id);
              if (!Number.isInteger(tokenId) || tokenId <= 0) continue;
              const tokenResults = results.filter((item) => Number(item?.tokenId) === tokenId);
              patchTokenFromHealthCheckResponse(tokenId, responseToken, null, tokenResults);
            }
          }
          total += results.length;
          availableCount += results.filter((result) => result.available).length;
        } finally {
          setTestingAvailabilityTokenIds((current) => current.filter((id) => id !== tokenId));
        }
      });
      const skippedParts = [
        skippedCount > 0 ? `跳过 ${skippedCount} 个无模型令牌` : '',
        imageOnlySkippedResults.length > 0 ? `${imageOnlySkippedResults.length} 个仅图片模型` : '',
      ].filter(Boolean);
      const skippedText = skippedParts.length > 0 ? `，${skippedParts.join('，')}` : '';
      toast.success(`测试完成：可用 ${availableCount}，不可用 ${Math.max(total - availableCount, 0)}${skippedText}`);
    } catch (error: any) {
      toast.error(error?.message || '测试令牌可用性失败');
    } finally {
      setTestingModelTokens(false);
      setTestingAvailabilityTokenIds([]);
    }
  }, [applyModelAvailabilityResults, modelSearch, patchTokenFromHealthCheckResponse, selectedTokenIds, testModelTokens, toast, tokens]);

  const showAvailabilityTooltip = useCallback((
    event: React.MouseEvent<HTMLElement> | React.FocusEvent<HTMLElement>,
    rows: AvailabilityTooltipRow[],
  ) => {
    const visibleRows = rows.filter((row) => (
      row.value !== undefined
      && row.value !== null
      && String(row.value).trim()
    ));
    if (visibleRows.length === 0 || typeof window === 'undefined') {
      setAvailabilityTooltip(null);
      return;
    }

    const rect = event.currentTarget.getBoundingClientRect();
    const pointerEvent = 'clientX' in event ? event : null;
    const rawLeft = pointerEvent
      ? pointerEvent.clientX + AVAILABILITY_TOOLTIP_OFFSET
      : rect.right + AVAILABILITY_TOOLTIP_OFFSET;
    const rawTop = pointerEvent
      ? pointerEvent.clientY - AVAILABILITY_TOOLTIP_OFFSET
      : rect.top - AVAILABILITY_TOOLTIP_OFFSET;
    const left = Math.max(
      8,
      Math.min(rawLeft, window.innerWidth - AVAILABILITY_TOOLTIP_WIDTH - 8),
    );
    const top = Math.max(8, rawTop);
    setAvailabilityTooltip({ rows: visibleRows, left, top });
  }, []);

  const hideAvailabilityTooltip = useCallback(() => {
    setAvailabilityTooltip(null);
  }, []);

  useEffect(() => {
    if (!availabilityTooltip || typeof window === 'undefined') return;
    const hide = () => setAvailabilityTooltip(null);
    window.addEventListener('scroll', hide, true);
    window.addEventListener('resize', hide);
    return () => {
      window.removeEventListener('scroll', hide, true);
      window.removeEventListener('resize', hide);
    };
  }, [availabilityTooltip]);

  const renderAvailabilityBadge = useCallback((token: any) => {
    const tokenId = Number(token?.id);
    if (testingAvailabilityTokenIds.includes(tokenId)) {
      return <span className="badge badge-info" style={{ fontSize: 11 }}><span className="spinner spinner-sm" /> 检测中</span>;
    }
    const model = modelSearch.trim().toLowerCase();
    const pendingResult = tokenAvailabilityById[tokenId];
    const result = resolveTokenAvailabilityResult(token, model, pendingResult);
    if (!result) {
      const rows: AvailabilityTooltipRow[] = [
        { label: '模型', value: model || '-' },
        { label: '结果', value: '未拉取到模型或没有测试记录', tone: 'error' },
      ];
      return (
        <span
          className="badge badge-error token-availability-badge"
          style={{ fontSize: 11 }}
          tabIndex={0}
          onMouseEnter={(event) => showAvailabilityTooltip(event, rows)}
          onMouseLeave={hideAvailabilityTooltip}
          onFocus={(event) => showAvailabilityTooltip(event, rows)}
          onBlur={hideAvailabilityTooltip}
        >
          否
        </span>
      );
    }
    const checkedAt = result.checkedAt ? formatDateTimeLocal(result.checkedAt) : '';
    const imageOnlySkipped = isImageOnlySkippedAvailabilityResult(result);
    const rows: AvailabilityTooltipRow[] = [
      { label: '模型', value: result.model || '-' },
      {
        label: '结果',
        value: result.available ? '可用' : (imageOnlySkipped ? '未测试：仅图片模型' : '不可用'),
        tone: result.available ? 'success' : (imageOnlySkipped ? 'warning' : 'error'),
      },
      { label: '说明', value: result.available ? result.message : '' },
      {
        label: imageOnlySkipped ? '说明' : '上游报错',
        value: result.available ? '' : result.message,
        tone: result.available ? undefined : (imageOnlySkipped ? 'warning' : 'error'),
      },
      { label: '模型答复', value: result.responseText || '' },
      { label: '耗时', value: Number.isFinite(Number(result.latencyMs)) ? `${result.latencyMs}ms` : '' },
      { label: '检测时间', value: checkedAt },
    ];
    return (
      <span
        className={`badge ${result.available ? 'badge-success' : (imageOnlySkipped ? 'badge-warning' : 'badge-info')} token-availability-badge`}
        style={{ fontSize: 11 }}
        tabIndex={0}
        onMouseEnter={(event) => showAvailabilityTooltip(event, rows)}
        onMouseLeave={hideAvailabilityTooltip}
        onFocus={(event) => showAvailabilityTooltip(event, rows)}
        onBlur={hideAvailabilityTooltip}
      >
        {result.available ? '是' : '否'}
      </span>
    );
  }, [hideAvailabilityTooltip, modelSearch, showAvailabilityTooltip, testingAvailabilityTokenIds, tokenAvailabilityById]);

  const renderStatusAction = useCallback((token: any, isPending: boolean, loadingPrefix: string) => {
    if (isPending) {
      return <span className="badge badge-warning" style={{ fontSize: 11 }}>待补全</span>;
    }
    const loading = !!rowLoading[`${loadingPrefix}-toggle`];
    return (
      <button
        type="button"
        className={`badge ${resolveTokenStatusBadgeClass(token, isPending)} token-inline-action`}
        style={{ fontSize: 11 }}
        disabled={loading}
        title={token.enabled ? '点击禁用' : '点击启用'}
        onClick={(event) => {
          event.stopPropagation();
          void handleToggleTokenEnabled(token);
        }}
      >
        {loading ? <span className="spinner spinner-sm" /> : resolveTokenStatusLabel(token, isPending)}
      </button>
    );
  }, [handleToggleTokenEnabled, rowLoading]);

  const renderDefaultAction = useCallback((token: any, isPending: boolean, loadingPrefix: string) => {
    if (isPending) return '-';
    const loading = !!rowLoading[`${loadingPrefix}-default`];
    return (
      <button
        type="button"
        className={`badge ${token.isDefault ? 'badge-warning' : 'badge-muted'} token-inline-action`}
        style={{ fontSize: 11 }}
        disabled={loading || token.isDefault}
        title={token.isDefault ? '当前默认' : '点击设为默认'}
        onClick={(event) => {
          event.stopPropagation();
          if (token.isDefault) return;
          void handleSetDefaultToken(token);
        }}
      >
        {loading ? <span className="spinner spinner-sm" /> : (token.isDefault ? '默认' : '设默认')}
      </button>
    );
  }, [handleSetDefaultToken, rowLoading]);

  const handleAddToken = async () => {
    if (!form.accountId) return;
    if (!form.unlimitedQuota) {
      const remainQuota = Number.parseInt(form.remainQuota, 10);
      if (!Number.isFinite(remainQuota) || remainQuota <= 0) {
        toast.error('有限额度令牌请填写正整数额度');
        return;
      }
    }
    setSaving(true);
    try {
      const remainQuota = form.unlimitedQuota
        ? undefined
        : Number.parseInt(form.remainQuota, 10);
      await api.addAccountToken({
        accountId: form.accountId,
        name: form.name,
        group: form.group || 'default',
        unlimitedQuota: form.unlimitedQuota,
        remainQuota,
        expiredTime: form.expiredTime || undefined,
        allowIps: form.allowIps,
      });
      toast.success('已在站点创建并同步令牌');
      setForm(initialCreateForm);
      setShowAdd(false);
      setCreateHintModelName('');
      await load();
    } catch (e: any) {
      toast.error(e.message || '创建令牌失败');
    } finally {
      setSaving(false);
    }
  };

  const handleSync = useCallback(async () => {
    if (!syncingAccountId) return;
    setSyncing(true);
    try {
      const res = await api.syncAccountTokens(syncingAccountId) as AccountTokenSyncResult;
      const status = resolveSyncStatus(res);
      if (status === 'failed') {
        toast.error(`同步失败：${resolveSyncMessage(res, '请检查账号令牌或站点状态')}`);
      } else if (isMaskedPendingSyncResult(res)) {
        toast.info(resolveSyncMessage(res, '上游返回了脱敏令牌，请补全明文 token'));
        const loaded = await load();
        const pendingIds = Array.isArray(res.pendingTokenIds)
          ? res.pendingTokenIds.map((id) => Number(id)).filter((id) => Number.isFinite(id) && id > 0)
          : [];
        const nextTokens = Array.isArray(loaded?.tokens) ? loaded.tokens : [];
        if (pendingIds.length === 1) {
          const pendingToken = nextTokens.find((token: any) => token.id === pendingIds[0]);
          if (pendingToken) {
            focusTokenRow(pendingToken.id);
            openEditPanel(pendingToken);
          } else {
            setPendingAutoOpenTokenId(pendingIds[0] || null);
          }
        } else if (pendingIds.length > 1) {
          focusTokenRow(pendingIds[0]!);
        }
        return;
      } else if (status === 'skipped') {
        toast.info(`同步已跳过：${resolveSyncMessage(res, '账号缺少可用 Session Cookie')}`);
      } else {
        toast.success(`同步完成：新增 ${res.created || 0}，更新 ${res.updated || 0}`);
      }
      await load();
    } catch (e: any) {
      toast.error(e.message || '同步令牌失败');
    } finally {
      setSyncing(false);
    }
  }, [focusTokenRow, load, openEditPanel, syncingAccountId, toast]);

  const handleSyncAll = useCallback(async () => {
    setSyncingAll(true);
    try {
      const res = await api.syncAllAccountTokens();
      if (res?.queued) {
        toast.info(res.message || '令牌同步进行中，请稍后查看日志');
        await load();
        return;
      }

      const syncResults = (
        Array.isArray(res?.results) ? res.results
          : Array.isArray(res?.items) ? res.items
            : Array.isArray(res?.accounts) ? res.accounts
              : []
      ) as AccountTokenSyncResult[];

      if (syncResults.length === 0) {
        const status = resolveSyncStatus(res as AccountTokenSyncResult);
        if (status === 'failed') {
          toast.error(`全部同步失败：${resolveSyncMessage(res, '请稍后重试')}`);
        } else if (status === 'skipped') {
          toast.info(`全部同步已跳过：${resolveSyncMessage(res, '没有可同步的账号')}`);
        } else {
          toast.success('全部账号同步完成');
        }
      } else {
        const failedRows = syncResults.filter((item) => resolveSyncStatus(item) === 'failed');
        const skippedRows = syncResults.filter((item) => resolveSyncStatus(item) === 'skipped');
        const successRows = syncResults.filter((item) => resolveSyncStatus(item) === 'success');
        const maskedRows = syncResults.filter((item) => isMaskedPendingSyncResult(item));

        toast.success(`全部同步完成：成功 ${successRows.length}，跳过 ${skippedRows.length}，失败 ${failedRows.length}`);

        failedRows.slice(0, 3).forEach((item) => {
          toast.error(`${resolveAccountLabel(item)} 同步失败：${resolveSyncMessage(item, '请检查账号配置')}`);
        });
        maskedRows.slice(0, 3).forEach((item) => {
          toast.info(`${resolveAccountLabel(item)} 需要补全明文 token：${resolveSyncMessage(item, '上游返回脱敏令牌')}`);
        });
        skippedRows.slice(0, 3).forEach((item) => {
          toast.info(`${resolveAccountLabel(item)} 已跳过：${resolveSyncMessage(item, '不满足同步条件')}`);
        });

        if (failedRows.length > 3) {
          toast.error(`另有 ${failedRows.length - 3} 个失败账号，请查看日志`);
        }
        if (skippedRows.length > 3) {
          toast.info(`另有 ${skippedRows.length - 3} 个跳过账号，请查看日志`);
        }
      }

      await load();
    } catch (e: any) {
      toast.error(e.message || '全部同步失败');
    } finally {
      setSyncingAll(false);
    }
  }, [load, toast]);

  const handleEnsureGroupTokens = useCallback(async () => {
    setEnsuringGroupTokens(true);
    try {
      const res = await api.ensureAllAccountGroupTokens();
      if (res?.queued) {
        toast.info(res.message || '获取分组并补齐令牌进行中，请稍后查看日志');
        await load();
        return;
      }

      const summary = res?.summary || {};
      toast.success(`分组补齐完成：补齐 ${summary.created || 0}，禁用 ${summary.disabled || 0}，失败 ${summary.failed || 0}`);
      await load();
    } catch (e: any) {
      toast.error(e.message || '获取分组并补齐令牌失败');
    } finally {
      setEnsuringGroupTokens(false);
    }
  }, [load, toast]);

  const handleToggleAdd = useCallback(() => {
    setShowAdd((prev) => {
      const nextOpen = !prev;
      if (!nextOpen) setCreateHintModelName('');
      return nextOpen;
    });
  }, []);

  const accountFilterOptions = useMemo(() => ([
    { value: '0', label: '全部账号令牌' },
    ...activeAccountSelectOptions,
  ]), [activeAccountSelectOptions]);

  const statusFilterOptions = useMemo(() => ([
    { value: 'all', label: '全部状态' },
    { value: 'enabled', label: '仅启用' },
    { value: 'disabled', label: '仅禁用' },
    { value: 'autoDisabled', label: '自动禁用' },
    { value: 'pending', label: '待补全' },
  ]), []);

  const availabilityFilterOptions = useMemo(() => ([
    { value: 'all', label: '全部可用' },
    { value: 'available', label: '可用：是' },
    { value: 'unavailable', label: '可用：否' },
  ]), []);

  const inputStyle: React.CSSProperties = {
    width: '100%',
    padding: '10px 14px',
    border: '1px solid var(--color-border)',
    borderRadius: 'var(--radius-sm)',
    fontSize: 13,
    outline: 'none',
    background: 'var(--color-bg)',
    color: 'var(--color-text-primary)',
  };

  const renderModelFilterControl = useCallback((compact = false) => (
    <div
      style={{
        display: 'flex',
        alignItems: compact ? 'stretch' : 'center',
        gap: 8,
        flexWrap: compact ? 'nowrap' : 'wrap',
        flexDirection: compact ? 'column' : 'row',
        width: '100%',
      }}
    >
      <input
        value={modelSearch}
        onChange={(event) => setModelSearch(event.target.value)}
        placeholder="输入完整模型名称精准筛选"
        style={{ ...inputStyle, flex: compact ? undefined : '1 1 260px', minWidth: compact ? undefined : 220 }}
      />
      <button
        type="button"
        onClick={() => void handleTestFilteredModelTokens()}
        disabled={testingModelTokens || !modelSearch.trim() || modelTestTokenIds.length === 0}
        className="btn btn-ghost"
        title={modelTestTokenIds.length > 0 ? `将测试 ${modelTestTokenIds.length} 个令牌` : undefined}
        style={{ border: '1px solid var(--color-border)', whiteSpace: 'nowrap' }}
      >
        {testingModelTokens ? <><span className="spinner spinner-sm" /> 测试中...</> : `测试筛选令牌${modelTestTokenIds.length > 0 ? ` (${modelTestTokenIds.length})` : ''}`}
      </button>
      <div style={{ minWidth: compact ? undefined : 220, flex: compact ? undefined : '0 1 260px', position: 'relative', zIndex: 20 }}>
        <ModernSelect
          size="sm"
          value={String(syncingAccountId || 0)}
          onChange={handleAccountFilterChange}
          options={accountFilterOptions}
          placeholder="选择账号筛选令牌"
          searchable
          searchPlaceholder={ACCOUNT_SELECT_SEARCH_PLACEHOLDER}
        />
      </div>
      <div style={{ minWidth: compact ? undefined : 132, flex: compact ? undefined : '0 0 132px', position: 'relative', zIndex: 19 }}>
        <ModernSelect
          size="sm"
          value={tokenStatusFilter}
          onChange={(nextValue) => {
            setTokenStatusFilter((nextValue || 'all') as TokenStatusFilter);
            setSelectedTokenIds([]);
          }}
          options={statusFilterOptions}
          placeholder="筛选状态"
        />
      </div>
      <div style={{ minWidth: compact ? undefined : 132, flex: compact ? undefined : '0 0 132px', position: 'relative', zIndex: 18 }}>
        <ModernSelect
          size="sm"
          value={tokenAvailabilityFilter}
          onChange={(nextValue) => {
            setTokenAvailabilityFilter((nextValue || 'all') as TokenAvailabilityFilter);
            setSelectedTokenIds([]);
          }}
          options={availabilityFilterOptions}
          placeholder="筛选可用"
        />
      </div>
    </div>
  ), [
    accountFilterOptions,
    availabilityFilterOptions,
    handleAccountFilterChange,
    handleTestFilteredModelTokens,
    inputStyle,
    modelSearch,
    modelTestTokenIds.length,
    statusFilterOptions,
    syncingAccountId,
    testingModelTokens,
    tokenAvailabilityFilter,
    tokenStatusFilter,
  ]);

  const sectionCardStyle: React.CSSProperties = {
    display: 'flex',
    flexDirection: 'column',
    gap: 12,
    padding: 14,
    border: '1px solid var(--color-border-light)',
    borderRadius: 'var(--radius-md)',
    background: 'var(--color-bg-card)',
  };

  const sectionLabelStyle: React.CSSProperties = {
    fontSize: 12,
    fontWeight: 600,
    color: 'var(--color-text-secondary)',
    letterSpacing: '0.02em',
  };

  const toggleCardStyle: React.CSSProperties = {
    display: 'flex',
    alignItems: 'flex-start',
    gap: 10,
    padding: '12px 14px',
    border: '1px solid var(--color-border)',
    borderRadius: 'var(--radius-sm)',
    background: 'var(--color-bg)',
    color: 'var(--color-text-primary)',
  };

  const headerActions = useMemo(() => (
    <div className={`page-actions ${embedded ? 'accounts-page-actions' : ''}`.trim()}>
      {isMobile ? (
        <>
          <button
            type="button"
            onClick={() => setShowMobileTools(true)}
            className="btn btn-ghost"
            style={{ border: '1px solid var(--color-border)' }}
          >
            同步与筛选
          </button>
          <button
            type="button"
            data-testid="tokens-mobile-select-all"
            onClick={() => toggleSelectAllTokens(!allVisibleTokensSelected)}
            className="btn btn-ghost"
            style={{ border: '1px solid var(--color-border)' }}
          >
            {allVisibleTokensSelected ? '取消全选' : '全选可见项'}
          </button>
        </>
      ) : (
        <>
          <button
            onClick={handleSync}
            disabled={syncing || syncingAll || ensuringGroupTokens || !syncingAccountId}
            className="btn btn-ghost"
            style={{ border: '1px solid var(--color-border)', padding: '8px 14px' }}
          >
            {syncing ? <><span className="spinner spinner-sm" /> 同步中...</> : '同步站点令牌'}
          </button>
          <button
            onClick={handleSyncAll}
            disabled={syncing || syncingAll || ensuringGroupTokens || activeAccounts.length === 0}
            className="btn btn-ghost"
            style={{ border: '1px solid var(--color-border)', padding: '8px 14px' }}
          >
            {syncingAll ? <><span className="spinner spinner-sm" /> 同步中...</> : '同步全部账号'}
          </button>
          <button
            onClick={handleEnsureGroupTokens}
            disabled={syncing || syncingAll || ensuringGroupTokens || activeAccounts.length === 0}
            className="btn btn-ghost"
            style={{ border: '1px solid var(--color-border)', padding: '8px 14px' }}
          >
            {ensuringGroupTokens ? <><span className="spinner spinner-sm" /> 获取中...</> : '获取所有账号分组'}
          </button>
        </>
      )}
      <button
        onClick={handleToggleAdd}
        className="btn btn-primary"
      >
        {showAdd ? '取消' : '+ 新增令牌'}
      </button>
    </div>
  ), [activeAccounts.length, allVisibleTokensSelected, embedded, ensuringGroupTokens, handleEnsureGroupTokens, handleSync, handleSyncAll, handleToggleAdd, isMobile, showAdd, syncing, syncingAccountId, syncingAll]);

  useEffect(() => {
    if (!embedded || !onEmbeddedActionsChange) return;
    onEmbeddedActionsChange(headerActions);
    return () => {
      onEmbeddedActionsChange(null);
    };
  }, [embedded, headerActions, onEmbeddedActionsChange]);

  return (
    <div className={embedded ? '' : 'animate-fade-in'}>
      {(!embedded || !onEmbeddedActionsChange) && (
        <div className="page-header">
          {!embedded ? <h2 className="page-title">{tr('账号令牌')}</h2> : <div />}
          {headerActions}
        </div>
      )}

      <ResponsiveFilterPanel
        isMobile={isMobile}
        mobileOpen={showMobileTools}
        onMobileClose={() => setShowMobileTools(false)}
        mobileTitle="令牌同步与筛选"
        mobileContent={(
          <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
            <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
              <div style={{ fontSize: 12, color: 'var(--color-text-muted)' }}>模型 / 账号 / 状态筛选</div>
              {renderModelFilterControl(true)}
            </div>
            <button
              onClick={handleSync}
              disabled={syncing || syncingAll || ensuringGroupTokens || !syncingAccountId}
              className="btn btn-ghost"
              style={{ border: '1px solid var(--color-border)' }}
            >
              {syncing ? <><span className="spinner spinner-sm" /> 同步中...</> : '同步站点令牌'}
            </button>
            <button
              onClick={handleSyncAll}
              disabled={syncing || syncingAll || ensuringGroupTokens || activeAccounts.length === 0}
              className="btn btn-ghost"
              style={{ border: '1px solid var(--color-border)' }}
            >
              {syncingAll ? <><span className="spinner spinner-sm" /> 同步中...</> : '同步全部账号'}
            </button>
            <button
              onClick={handleEnsureGroupTokens}
              disabled={syncing || syncingAll || ensuringGroupTokens || activeAccounts.length === 0}
              className="btn btn-ghost"
              style={{ border: '1px solid var(--color-border)' }}
            >
              {ensuringGroupTokens ? <><span className="spinner spinner-sm" /> 获取中...</> : '获取所有账号分组'}
            </button>
          </div>
        )}
      />

      <div className="info-tip" style={{ marginBottom: 12 }}>
        新增令牌会调用站点 API 创建新密钥，再自动同步到本地。支持设置分组、额度、过期时间和 IP 白名单；已存在密钥可直接用“同步站点令牌”读取。
      </div>

      <DeleteConfirmModal
        open={Boolean(deleteConfirm)}
        onClose={() => setDeleteConfirm(null)}
        onConfirm={confirmDelete}
        title="确认删除令牌"
        confirmText="确认删除"
        loading={batchActionLoading || (deleteConfirm?.mode === 'single' && !!rowLoading[`token-${deleteConfirm?.tokenId}-delete`])}
        description={deleteConfirm?.mode === 'single'
          ? <>确定要删除令牌 <strong>{deleteConfirm.tokenName || `#${deleteConfirm.tokenId}`}</strong> 吗？</>
          : <>确定要删除选中的 <strong>{deleteConfirm?.count || 0}</strong> 个令牌吗？</>}
      />

      <CenteredModal
        open={Boolean(modelDialogToken)}
        onClose={closeModelDialog}
        title="令牌模型"
        maxWidth={780}
        closeOnBackdrop
        bodyStyle={{ display: 'flex', flexDirection: 'column', gap: 12 }}
        footer={(
          <button onClick={closeModelDialog} className="btn btn-ghost">关闭</button>
        )}
      >
        {modelDialogToken ? (
          <>
            <div
              style={{
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'space-between',
                gap: 10,
                flexWrap: 'wrap',
                fontSize: 12,
                color: 'var(--color-text-secondary)',
                background: 'var(--color-bg)',
                border: '1px solid var(--color-border-light)',
                borderRadius: 'var(--radius-sm)',
                padding: '8px 10px',
              }}
            >
              <span>{modelDialogToken.name || `token-${modelDialogToken.id}`} @ {modelDialogToken.site?.name || '-'}</span>
              <span>
                {`${modelDialogModels.length} 个模型`}
                {modelDialogToken.modelSyncedAt ? ` · 拉取时间 ${formatDateTimeLocal(modelDialogToken.modelSyncedAt)}` : ' · 未拉取'}
              </span>
            </div>
            <input
              value={modelDialogSearch}
              onChange={(event) => setModelDialogSearch(event.target.value)}
              placeholder="筛选弹窗内模型"
              style={inputStyle}
            />
            {modelDialogError ? (
              <div
                style={{
                  fontSize: 12,
                  color: 'var(--color-danger)',
                  background: 'color-mix(in srgb, var(--color-danger) 8%, var(--color-bg))',
                  border: '1px solid color-mix(in srgb, var(--color-danger) 20%, transparent)',
                  borderRadius: 'var(--radius-sm)',
                  padding: '8px 10px',
                }}
              >
                {modelDialogError}
              </div>
            ) : null}
            <div
              style={{
                maxHeight: 420,
                overflow: 'auto',
                border: '1px solid var(--color-border-light)',
                borderRadius: 'var(--radius-sm)',
                padding: 10,
                background: 'var(--color-bg-card)',
              }}
            >
              {(() => {
                const keyword = modelDialogSearch.trim().toLowerCase();
                const visibleModels = modelDialogModels.filter((model) => (
                  !keyword || model.name.toLowerCase().includes(keyword)
                ));
                if (modelDialogLoading) {
                  return <div style={{ padding: 20, color: 'var(--color-text-muted)' }}><span className="spinner spinner-sm" /> 读取模型中...</div>;
                }
                if (visibleModels.length === 0) {
                  return <div style={{ padding: 20, color: 'var(--color-text-muted)' }}>暂无模型</div>;
                }
                return (
                  <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8 }}>
                    {visibleModels.map((model) => {
                      const loadingKey = model.name.toLowerCase();
                      const loading = !!modelDialogModelLoading[loadingKey];
                      return (
                      <button
                        key={model.name}
                        type="button"
                        className={`badge ${model.routeEnabled ? 'badge-success' : 'badge-muted'} token-model-route-toggle`}
                        style={{ fontSize: 12, maxWidth: '100%', wordBreak: 'break-all' }}
                        disabled={loading}
                        title={model.routeEnabled ? '点击取消路由点亮' : '点击点亮后可用于路由'}
                        onClick={() => void toggleModelRouteEnabled(model)}
                      >
                        {loading ? <span className="spinner spinner-sm" /> : null}
                        <span>{model.name}</span>
                      </button>
                      );
                    })}
                  </div>
                );
              })()}
            </div>
          </>
        ) : null}
      </CenteredModal>

      <CenteredModal
        open={Boolean(healthCheckToken)}
        onClose={closeHealthCheckPanel}
        title="令牌测活"
        maxWidth={760}
        closeOnBackdrop
        bodyStyle={{ display: 'flex', flexDirection: 'column', gap: 12 }}
        footer={(
          <>
            <button onClick={closeHealthCheckPanel} disabled={healthCheckSaving || healthCheckRunning} className="btn btn-ghost">关闭</button>
            <button onClick={() => void saveHealthCheckPanel()} disabled={healthCheckSaving || healthCheckRunning} className="btn btn-ghost" style={{ border: '1px solid var(--color-border)' }}>
              {healthCheckSaving ? <><span className="spinner spinner-sm" /> 保存中...</> : '保存配置'}
            </button>
            <button onClick={() => void runHealthCheckNow()} disabled={healthCheckSaving || healthCheckRunning || parseHealthCheckModelList(healthCheckForm.model).length === 0} className="btn btn-primary">
              {healthCheckRunning ? <><span className="spinner spinner-sm" style={{ borderTopColor: 'white', borderColor: 'rgba(255,255,255,0.3)' }} /> 测活中...</> : '立即测活'}
            </button>
          </>
        )}
      >
        {healthCheckToken ? (
          (() => {
            const selectedModels = parseHealthCheckModelList(healthCheckForm.model);
            const selectedModelKeys = new Set(selectedModels.map((modelName) => modelName.toLowerCase()));
            const modelOptions = getHealthCheckModelOptions(healthCheckToken);
            const updateSelectedModels = (models: string[]) => {
              setHealthCheckForm((current) => ({
                ...current,
                model: formatHealthCheckModelList(models),
              }));
            };
            const addModel = (modelName: string) => {
              const normalized = modelName.trim();
              if (!normalized) return;
              if (selectedModelKeys.has(normalized.toLowerCase())) return;
              updateSelectedModels([...selectedModels, normalized]);
            };
            const removeModel = (modelName: string) => {
              updateSelectedModels(selectedModels.filter((item) => item.toLowerCase() !== modelName.toLowerCase()));
            };
            const lastLatency = Number(healthCheckToken.healthCheckLastLatencyMs);
            const hasLastLatency = Number.isFinite(lastLatency) && lastLatency >= 0;
            return (
              <>
                <div
                  style={{
                    border: '1px solid var(--color-border-light)',
                    borderRadius: 'var(--radius-md)',
                    background: 'linear-gradient(180deg, color-mix(in srgb, var(--color-primary) 7%, var(--color-bg-card)), var(--color-bg-card))',
                    padding: 14,
                    display: 'grid',
                    gap: 8,
                  }}
                >
                  <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 10, flexWrap: 'wrap' }}>
                    <div style={{ minWidth: 0 }}>
                      <div style={{ fontWeight: 700, color: 'var(--color-text-primary)', wordBreak: 'break-word' }}>
                        {healthCheckToken.name || `token-${healthCheckToken.id}`}
                      </div>
                      <div style={{ fontSize: 12, color: 'var(--color-text-secondary)', marginTop: 3 }}>
                        {healthCheckToken.site?.name || '-'} · {healthCheckToken.account?.username || `account-${healthCheckToken.accountId}`}
                      </div>
                    </div>
                    <span className={`badge ${healthCheckForm.enabled ? 'badge-success' : 'badge-muted'}`} style={{ fontSize: 12 }}>
                      {healthCheckForm.enabled ? '定时开启' : '定时关闭'}
                    </span>
                  </div>
                </div>

                <label style={{ ...toggleCardStyle, alignItems: 'center', borderRadius: 'var(--radius-md)' }}>
                  <input
                    type="checkbox"
                    checked={healthCheckForm.enabled}
                    onChange={(event) => setHealthCheckForm((current) => ({ ...current, enabled: event.target.checked }))}
                  />
                  <span>
                    <span style={{ display: 'block', fontWeight: 700, color: 'var(--color-text-primary)' }}>开启定时测活</span>
                    <span style={{ display: 'block', fontSize: 12, color: 'var(--color-text-muted)', lineHeight: 1.5 }}>成功后点亮对应模型并自动重建路由；测活模型支持多选。</span>
                  </span>
                </label>

                <div style={{ ...sectionCardStyle, gap: 12 }}>
                  <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 10, flexWrap: 'wrap' }}>
                    <div>
                      <div style={sectionLabelStyle}>测活模型</div>
                      <div style={{ fontSize: 12, color: 'var(--color-text-muted)' }}>已选 {selectedModels.length} 个，仅展示非图片模型。</div>
                    </div>
                    <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                      <span style={{ fontSize: 12, color: 'var(--color-text-muted)' }}>间隔</span>
                      <input
                        type="number"
                        min={1}
                        max={10080}
                        value={healthCheckForm.intervalMinutes}
                        onChange={(event) => setHealthCheckForm((current) => ({ ...current, intervalMinutes: event.target.value }))}
                        style={{ ...inputStyle, width: 110, textAlign: 'center' }}
                      />
                      <span style={{ fontSize: 12, color: 'var(--color-text-muted)' }}>分钟</span>
                    </div>
                  </div>

                  <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8, minHeight: 30 }}>
                    {selectedModels.length > 0 ? selectedModels.map((modelName) => (
                      <button
                        key={modelName}
                        type="button"
                        className="badge badge-info"
                        style={{ fontSize: 12, border: '1px solid color-mix(in srgb, var(--color-primary) 24%, transparent)' }}
                        onClick={() => removeModel(modelName)}
                        title="点击移除"
                      >
                        {modelName} ×
                      </button>
                    )) : (
                      <span style={{ fontSize: 12, color: 'var(--color-text-muted)' }}>请选择或添加至少一个模型</span>
                    )}
                  </div>

                  <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
                    <input
                      value={healthCheckCustomModel}
                      onChange={(event) => setHealthCheckCustomModel(event.target.value)}
                      placeholder="添加自定义模型"
                      style={inputStyle}
                      onKeyDown={(event) => {
                        if (event.key !== 'Enter') return;
                        event.preventDefault();
                        addModel(healthCheckCustomModel);
                        setHealthCheckCustomModel('');
                      }}
                    />
                    <button
                      type="button"
                      className="btn btn-ghost"
                      style={{ border: '1px solid var(--color-border)', whiteSpace: 'nowrap' }}
                      onClick={() => {
                        addModel(healthCheckCustomModel);
                        setHealthCheckCustomModel('');
                      }}
                    >
                      添加
                    </button>
                  </div>

                  <div
                    style={{
                      maxHeight: 190,
                      overflow: 'auto',
                      border: '1px solid var(--color-border-light)',
                      borderRadius: 'var(--radius-sm)',
                      padding: 10,
                      background: 'var(--color-bg)',
                    }}
                  >
                    {modelOptions.length > 0 ? (
                      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(190px, 1fr))', gap: 8 }}>
                        {modelOptions.map((modelName) => (
                          <label
                            key={modelName}
                            style={{
                              display: 'flex',
                              alignItems: 'center',
                              gap: 8,
                              minWidth: 0,
                              fontSize: 13,
                              padding: '7px 8px',
                              border: '1px solid var(--color-border-light)',
                              borderRadius: 'var(--radius-sm)',
                              background: selectedModelKeys.has(modelName.toLowerCase()) ? 'color-mix(in srgb, var(--color-primary) 8%, var(--color-bg-card))' : 'var(--color-bg-card)',
                              cursor: 'pointer',
                            }}
                          >
                            <input
                              type="checkbox"
                              checked={selectedModelKeys.has(modelName.toLowerCase())}
                              onChange={(event) => {
                                if (event.target.checked) {
                                  addModel(modelName);
                                } else {
                                  removeModel(modelName);
                                }
                              }}
                            />
                            <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{modelName}</span>
                          </label>
                        ))}
                      </div>
                    ) : (
                      <div style={{ padding: 8, color: 'var(--color-text-muted)', fontSize: 13 }}>暂无可选模型，可手动添加。</div>
                    )}
                  </div>
                </div>

                <div style={{ ...sectionCardStyle, gap: 12 }}>
                  <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 10, flexWrap: 'wrap' }}>
                    <div style={sectionLabelStyle}>最近测活</div>
                    <span className={`badge ${healthCheckToken.healthCheckLastAvailable === true ? 'badge-success' : (healthCheckToken.healthCheckLastAvailable === false ? 'badge-info' : 'badge-muted')}`} style={{ fontSize: 12 }}>
                      {healthCheckToken.healthCheckLastAvailable === true ? '成功' : (healthCheckToken.healthCheckLastAvailable === false ? '失败' : '未测')}
                    </span>
                  </div>
                  <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(150px, 1fr))', gap: 10, fontSize: 13 }}>
                    <div>
                      <div style={{ color: 'var(--color-text-muted)', fontSize: 12 }}>上次时间</div>
                      <div>{healthCheckToken.healthCheckLastRunAt ? formatDateTimeLocal(healthCheckToken.healthCheckLastRunAt) : '-'}</div>
                    </div>
                    <div>
                      <div style={{ color: 'var(--color-text-muted)', fontSize: 12 }}>下次时间</div>
                      <div>{healthCheckToken.healthCheckNextRunAt ? formatDateTimeLocal(healthCheckToken.healthCheckNextRunAt) : '-'}</div>
                    </div>
                    <div>
                      <div style={{ color: 'var(--color-text-muted)', fontSize: 12 }}>耗时</div>
                      <div>{hasLastLatency ? `${lastLatency}ms` : '-'}</div>
                    </div>
                  </div>
                  {healthCheckToken.healthCheckLastMessage ? (
                    <div
                      style={{
                        fontSize: 12,
                        color: 'var(--color-text-secondary)',
                        lineHeight: 1.6,
                        wordBreak: 'break-word',
                        borderTop: '1px solid var(--color-border-light)',
                        paddingTop: 10,
                      }}
                    >
                      {healthCheckToken.healthCheckLastMessage}
                    </div>
                  ) : null}
                </div>
              </>
            );
          })()
        ) : null}
      </CenteredModal>

      <CenteredModal
        open={Boolean(editingToken)}
        onClose={closeEditPanel}
        title="编辑令牌"
        maxWidth={760}
        bodyStyle={{ display: 'flex', flexDirection: 'column', gap: 12 }}
        footer={(
          <>
            <button onClick={closeEditPanel} className="btn btn-ghost">取消</button>
            <button onClick={saveEditPanel} disabled={savingEdit || editingTokenValueLoading} className="btn btn-primary">
              {savingEdit ? <><span className="spinner spinner-sm" style={{ borderTopColor: 'white', borderColor: 'rgba(255,255,255,0.3)' }} /> 保存中...</> : '保存修改'}
            </button>
          </>
        )}
      >
        {editingToken ? (
          <>
            <div
              style={{
                fontSize: 12,
                color: 'var(--color-text-secondary)',
                background: 'color-mix(in srgb, var(--color-primary) 8%, var(--color-bg))',
                border: '1px solid color-mix(in srgb, var(--color-primary) 18%, transparent)',
                borderRadius: 'var(--radius-sm)',
                padding: '8px 10px',
              }}
            >
              账号: {editingToken.account?.username || `account-${editingToken.accountId}`} @ {editingToken.site?.name || '-'}
            </div>
            {editingTokenPendingMessage ? (
              <div
                style={{
                  fontSize: 12,
                  color: 'var(--color-text-secondary)',
                  background: 'color-mix(in srgb, var(--color-warning) 12%, var(--color-bg))',
                  border: '1px solid color-mix(in srgb, var(--color-warning) 28%, transparent)',
                  borderRadius: 'var(--radius-sm)',
                  padding: '8px 10px',
                }}
              >
                {editingTokenPendingMessage}
              </div>
            ) : null}
            <div style={sectionCardStyle}>
              <div style={sectionLabelStyle}>基本信息</div>
              <ResponsiveFormGrid>
                <div>
                  <div style={{ fontSize: 12, color: 'var(--color-text-muted)', marginBottom: 6 }}>令牌名称</div>
                  <input
                    placeholder="令牌名称"
                    value={editForm.name}
                    onChange={(e) => setEditForm((prev) => ({ ...prev, name: e.target.value }))}
                    style={inputStyle}
                  />
                </div>
                <div>
                  <div style={{ fontSize: 12, color: 'var(--color-text-muted)', marginBottom: 6 }}>分组</div>
                  <ModernSelect
                    value={editForm.group || 'default'}
                    onChange={(nextValue) => setEditForm((prev) => ({ ...prev, group: nextValue || 'default' }))}
                    options={(editGroupOptions.length > 0 ? editGroupOptions : ['default']).map((group) => ({
                      value: group,
                      label: group,
                    }))}
                    placeholder={editGroupLoading ? '分组加载中...' : '选择分组'}
                    disabled={editGroupLoading}
                  />
                </div>
                <div style={{ gridColumn: '1 / -1' }}>
                  <div style={{ fontSize: 12, color: 'var(--color-text-muted)', marginBottom: 6 }}>令牌值</div>
                  <textarea
                    placeholder={editingTokenValueLoading ? '令牌加载中...' : '令牌值'}
                    value={editForm.token}
                    onChange={(e) => setEditForm((prev) => ({ ...prev, token: e.target.value }))}
                    style={{
                      ...inputStyle,
                      minHeight: 96,
                      resize: 'vertical',
                      fontFamily: 'var(--font-mono)',
                      lineHeight: 1.5,
                    }}
                    disabled={editingTokenValueLoading}
                  />
                </div>
              </ResponsiveFormGrid>
            </div>
            <div style={sectionCardStyle}>
              <div style={sectionLabelStyle}>状态设置</div>
              <ResponsiveFormGrid>
                <label style={toggleCardStyle}>
                  <input
                    type="checkbox"
                    checked={editForm.enabled}
                    onChange={(e) => setEditForm((prev) => ({ ...prev, enabled: e.target.checked }))}
                    style={{ marginTop: 2 }}
                  />
                  <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
                    <span style={{ fontSize: 13, fontWeight: 600 }}>启用令牌</span>
                    <span style={{ fontSize: 12, color: 'var(--color-text-muted)' }}>关闭后令牌不会参与分发</span>
                  </div>
                </label>
                <label style={toggleCardStyle}>
                  <input
                    type="checkbox"
                    checked={editForm.isDefault}
                    onChange={(e) => setEditForm((prev) => ({ ...prev, isDefault: e.target.checked }))}
                    style={{ marginTop: 2 }}
                  />
                  <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
                    <span style={{ fontSize: 13, fontWeight: 600 }}>设为默认令牌</span>
                    <span style={{ fontSize: 12, color: 'var(--color-text-muted)' }}>优先作为该账号的默认转发令牌</span>
                  </div>
                </label>
              </ResponsiveFormGrid>
            </div>
          </>
        ) : null}
      </CenteredModal>

      <div
        style={{
          display: 'flex',
          justifyContent: 'flex-start',
          marginBottom: 12,
        }}
      >
        {renderModelFilterControl(false)}
      </div>

      <ResponsiveBatchActionBar
        isMobile={isMobile}
        info={hasSelectedTokens ? `已选 ${selectedTokenIds.length} 项` : '未选择令牌'}
        desktopStyle={{ marginBottom: 12 }}
      >
        <button onClick={() => runBatchTokenAction('enable')} disabled={!hasSelectedTokens || batchActionLoading || testingModelTokens} className="btn btn-ghost" style={{ border: '1px solid var(--color-border)' }}>
          批量启用
        </button>
        <button onClick={() => runBatchTokenAction('disable')} disabled={!hasSelectedTokens || batchActionLoading || testingModelTokens} className="btn btn-ghost" style={{ border: '1px solid var(--color-border)' }}>
          批量禁用
        </button>
        <button
          onClick={() => void handleBatchTestSelectedTokens()}
          disabled={!hasSelectedTokens || batchActionLoading || testingModelTokens}
          className="btn btn-ghost"
          style={{ border: '1px solid var(--color-border)' }}
          title={!hasSelectedTokens
            ? '请先选择需要检测的令牌'
            : modelSearch.trim()
              ? `检测已选 ${selectedTokenIds.length} 个令牌的 ${modelSearch.trim()}`
              : `未输入模型时默认检测 ${DEFAULT_BATCH_TEST_MODEL}，没有则检测令牌的第一个模型`}
        >
          {testingModelTokens ? <><span className="spinner spinner-sm" /> 检测中...</> : '批量检测'}
        </button>
        <button data-testid="tokens-batch-delete" onClick={() => runBatchTokenAction('delete')} disabled={!hasSelectedTokens || batchActionLoading || testingModelTokens} className="btn btn-link btn-link-danger">
          批量删除
        </button>
        <label
          style={{
            display: 'inline-flex',
            alignItems: 'center',
            gap: 8,
            minWidth: 0,
            color: 'var(--color-text-muted)',
            fontSize: 13,
            whiteSpace: 'nowrap',
          }}
          title="只展示分组倍率小于该数字的令牌；空白时不过滤"
        >
          <span>倍率小于</span>
          <input
            type="number"
            min="0"
            step="0.001"
            inputMode="decimal"
            value={maxGroupRatioFilter}
            onChange={(event) => setMaxGroupRatioFilter(normalizeTokenRatioFilterInput(event.target.value))}
            placeholder="不限制"
            aria-label="只展示小于该倍率的令牌"
            style={{
              width: 104,
              height: 34,
              borderRadius: 8,
              border: '1px solid var(--color-border)',
              background: 'var(--color-surface)',
              color: 'var(--color-text)',
              padding: '0 10px',
              textAlign: 'center',
            }}
          />
        </label>
      </ResponsiveBatchActionBar>

      {availabilityTooltip && typeof document !== 'undefined'
        ? createPortal((
          <div
            className="token-availability-tooltip token-availability-tooltip-portal"
            role="tooltip"
            style={{
              left: availabilityTooltip.left,
              top: availabilityTooltip.top,
            }}
          >
            {availabilityTooltip.rows.map((row) => (
              <span className="token-availability-tooltip-row" key={row.label}>
                <span className="token-availability-tooltip-label">{row.label}</span>
                <span className={`token-availability-tooltip-value ${row.tone ? `is-${row.tone}` : ''}`.trim()}>
                  {row.value}
                </span>
              </span>
            ))}
          </div>
        ), document.body)
        : null}

      <CenteredModal
        open={showAdd}
        onClose={handleToggleAdd}
        title="新增令牌"
        maxWidth={820}
        bodyStyle={{ display: 'flex', flexDirection: 'column', gap: 12 }}
      >
        <ResponsiveFormGrid>
          <div style={{ gridColumn: '1 / -1' }}>
            <div style={{ fontSize: 12, color: 'var(--color-text-muted)', marginBottom: 6 }}>所属账号</div>
            <ModernSelect
              value={String(form.accountId || 0)}
              onChange={(nextValue) => {
                setForm((prev) => ({
                  ...prev,
                  accountId: Number.parseInt(nextValue, 10) || 0,
                  group: '',
                }));
              }}
              options={[
                { value: '0', label: '选择账号' },
                ...activeAccountSelectOptions,
              ]}
              placeholder="选择账号"
              searchable
              searchPlaceholder={ACCOUNT_SELECT_SEARCH_PLACEHOLDER}
            />
          </div>
          {createHintModelName ? (
            <div
              style={{
                gridColumn: '1 / -1',
                fontSize: 12,
                color: 'var(--color-text-secondary)',
                background: 'color-mix(in srgb, var(--color-info) 10%, var(--color-bg))',
                border: '1px solid color-mix(in srgb, var(--color-info) 30%, transparent)',
                borderRadius: 'var(--radius-sm)',
                padding: '6px 8px',
              }}
            >
              来自路由提醒：为模型 <code style={{ fontSize: 11 }}>{createHintModelName}</code> 补充该账号令牌后，可自动生成对应通道。
            </div>
          ) : null}
          <div>
            <div style={{ fontSize: 12, color: 'var(--color-text-muted)', marginBottom: 6 }}>令牌名称（可选）</div>
            <input
              value={form.name}
              onChange={(e) => setForm((prev) => ({ ...prev, name: e.target.value }))}
              placeholder="例如 metapi"
              style={inputStyle}
            />
          </div>
          <div>
            <div style={{ fontSize: 12, color: 'var(--color-text-muted)', marginBottom: 6 }}>分组</div>
            <ModernSelect
              value={form.group || ''}
              onChange={(nextValue) => setForm((prev) => ({ ...prev, group: nextValue }))}
              options={(groupOptions.length > 0 ? groupOptions : ['default']).map((group) => ({
                value: group,
                label: group,
              }))}
              placeholder={groupLoading ? '分组加载中...' : '选择分组'}
              disabled={!form.accountId || groupLoading}
            />
          </div>
          <div style={{ gridColumn: '1 / -1', display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
            <label style={{ display: 'inline-flex', alignItems: 'center', gap: 8, fontSize: 13, color: 'var(--color-text-secondary)' }}>
              <input
                type="checkbox"
                checked={form.unlimitedQuota}
                onChange={(e) => setForm((prev) => ({ ...prev, unlimitedQuota: e.target.checked }))}
              />
              不限额度
            </label>
            {!form.unlimitedQuota && (
              <input
                value={form.remainQuota}
                onChange={(e) => setForm((prev) => ({ ...prev, remainQuota: e.target.value.replace(/[^\d]/g, '') }))}
                placeholder="额度（正整数）"
                style={{ ...inputStyle, maxWidth: 220 }}
              />
            )}
          </div>
          <div>
            <div style={{ fontSize: 12, color: 'var(--color-text-muted)', marginBottom: 6 }}>过期时间（可选）</div>
            <input
              type="datetime-local"
              value={form.expiredTime}
              onChange={(e) => setForm((prev) => ({ ...prev, expiredTime: e.target.value }))}
              style={inputStyle}
            />
          </div>
          <div>
            <div style={{ fontSize: 12, color: 'var(--color-text-muted)', marginBottom: 6 }}>IP 白名单（可选）</div>
            <input
              value={form.allowIps}
              onChange={(e) => setForm((prev) => ({ ...prev, allowIps: e.target.value }))}
              placeholder="多个用英文逗号分隔"
              style={inputStyle}
            />
          </div>
          <div style={{ gridColumn: '1 / -1', display: 'flex', alignItems: 'center', fontSize: 12, color: 'var(--color-text-muted)' }}>
            将在选中账号所属站点直接创建新密钥
          </div>
        </ResponsiveFormGrid>

        <div style={{ display: 'flex', justifyContent: 'space-between', gap: 8, marginTop: 8 }}>
          <button onClick={handleToggleAdd} className="btn btn-ghost">取消</button>
          <button
            onClick={handleAddToken}
            disabled={saving || !form.accountId}
            className="btn btn-primary"
          >
            {saving ? <><span className="spinner spinner-sm" style={{ borderTopColor: 'white', borderColor: 'rgba(255,255,255,0.3)' }} /> 创建中...</> : '创建并同步令牌'}
          </button>
        </div>
      </CenteredModal>

      <div className="card token-table-card">
        {loading ? (
          <div style={{ padding: 20 }}>
            <div className="skeleton" style={{ width: '100%', height: 34, marginBottom: 8 }} />
            <div className="skeleton" style={{ width: '100%', height: 34, marginBottom: 8 }} />
            <div className="skeleton" style={{ width: '100%', height: 34 }} />
          </div>
        ) : tokens.length > 0 ? (
          isMobile ? (
            <div className="mobile-card-list">
              {accountClusteredTokens.map((token: any) => {
                const loadingPrefix = `token-${token.id}`;
                const isPending = isMaskedPendingToken(token);
                const isExpanded = expandedTokenIds.includes(token.id);
                return (
                  <MobileCard
                    key={token.id}
                    title={token.name || '-'}
                    headerActions={(
                      <input
                        type="checkbox"
                        aria-label={`选择令牌 ${token.name || token.id}`}
                        checked={selectedTokenIds.includes(token.id)}
                        onChange={(event) => toggleTokenSelection(token.id, event.target.checked)}
                      />
                    )}
                    footerActions={(
                      <>
                        <button
                          type="button"
                          onClick={() => toggleTokenDetails(token.id)}
                          className="btn btn-link"
                        >
                          {isExpanded ? '收起' : '详情'}
                        </button>
                        {!isPending ? (
                          <button
                            onClick={(event) => {
                              event.stopPropagation();
                              void handleCopyToken(token.id, token.name || '');
                            }}
                            disabled={!!rowLoading[`${loadingPrefix}-copy`]}
                            className="btn btn-link btn-link-primary"
                            data-testid={`token-copy-${token.id}`}
                          >
                            {rowLoading[`${loadingPrefix}-copy`] ? <span className="spinner spinner-sm" /> : '复制'}
                          </button>
                        ) : null}
                        {!isPending ? (
                          <button
                            onClick={(event) => {
                              event.stopPropagation();
                              void openTokenModels(token);
                            }}
                            className="btn btn-link btn-link-info"
                          >
                            模型
                          </button>
                        ) : null}
                        {!isPending ? (
                          <button
                            onClick={(event) => {
                              event.stopPropagation();
                              openHealthCheckPanel(token);
                            }}
                            className="btn btn-link btn-link-info"
                          >
                            测活
                          </button>
                        ) : null}
                        <button
                          onClick={(event) => {
                            event.stopPropagation();
                            openEditPanel(token);
                          }}
                          className="btn btn-link btn-link-info"
                        >
                          {isPending ? '编辑补全' : '编辑'}
                        </button>
                      </>
                    )}
                  >
                    <MobileField label="账号" value={token.account?.username || `account-${token.accountId}`} />
                    <MobileField label="分组" value={token.tokenGroup || 'default'} />
                    <MobileField label="倍率" value={formatGroupRatio(token.groupRatio) || '-'} />
                    <MobileField
                      label="状态"
                      value={renderStatusAction(token, isPending, loadingPrefix)}
                    />
                    <MobileField label="可用" value={renderAvailabilityBadge(token)} />
                    {isExpanded ? (
                      <div className="mobile-card-extra">
                        <MobileField
                          label="令牌值"
                          stacked
                          value={<span style={{ fontFamily: 'var(--font-mono)', fontSize: 12, wordBreak: 'break-all' }}>{token.tokenMasked || '***'}</span>}
                        />
                        <MobileField
                          label="来源站点"
                          value={token.site?.url ? (
                            <a
                              href={token.site.url}
                              target="_blank"
                              rel="noopener noreferrer"
                              className="badge-link"
                            >
                              <span className="badge badge-muted" style={{ fontSize: 11 }}>
                                {token.site?.name || 'unknown'}
                              </span>
                            </a>
                          ) : (
                            <span className="badge badge-muted" style={{ fontSize: 11 }}>
                              {token.site?.name || 'unknown'}
                            </span>
                          )}
                        />
                        <MobileField
                          label="默认"
                          value={renderDefaultAction(token, isPending, loadingPrefix)}
                        />
                        <MobileField label="更新时间" value={formatDateTimeLocal(token.updatedAt)} />
                        <div className="mobile-card-actions">
                          <button
                            onClick={(event) => {
                              event.stopPropagation();
                              setDeleteConfirm({ mode: 'single', tokenId: token.id, tokenName: token.name || '' });
                            }}
                            disabled={!!rowLoading[`${loadingPrefix}-delete`]}
                            className="btn btn-link btn-link-danger"
                          >
                            {rowLoading[`${loadingPrefix}-delete`] ? <span className="spinner spinner-sm" /> : '删除'}
                          </button>
                        </div>
                      </div>
                    ) : null}
                  </MobileCard>
                );
              })}
            </div>
          ) : (
            <table className="data-table token-table">
            <thead>
              <tr>
                <th style={{ width: 44 }}>
                  <input
                    type="checkbox"
                    checked={allVisibleTokensSelected}
                    onChange={(e) => toggleSelectAllTokens(e.target.checked)}
                  />
                </th>
                <th className="token-table-name-col">{renderTokenSortLabel('令牌名称', 'name')}</th>
                <th className="token-table-token-col">{renderTokenSortLabel('令牌值', 'token')}</th>
                <th className="token-table-site-col">{renderTokenSortLabel('来源站点', 'site')}</th>
                <th className="token-table-account-col">{renderTokenSortLabel('账号', 'account')}</th>
                <th className="token-table-group-col">{renderTokenSortLabel('分组', 'group')}</th>
                <th className="token-table-ratio-col">{renderTokenSortLabel('倍率', 'ratio')}</th>
                <th className="token-table-status-col">{renderTokenSortLabel('状态', 'status')}</th>
                <th className="token-table-availability-col">{renderTokenSortLabel('可用', 'availability')}</th>
                <th className="token-table-default-col">{renderTokenSortLabel('默认', 'default')}</th>
                <th className="token-table-updated-col">{renderTokenSortLabel('更新时间', 'updatedAt')}</th>
                <th className="token-table-actions-col">操作</th>
              </tr>
            </thead>
            <tbody>
              {accountClusteredTokens.map((token: any, i: number) => {
                const loadingPrefix = `token-${token.id}`;
                const isPending = isMaskedPendingToken(token);
                return (
                  <tr
                    key={token.id}
                    data-testid={`token-row-${token.id}`}
                    ref={(node) => {
                      if (node) rowRefs.current.set(token.id, node);
                      else rowRefs.current.delete(token.id);
                    }}
                    onClick={(event) => handleTokenRowClick(token.id, event)}
                    className={`animate-slide-up stagger-${Math.min(i + 1, 5)} row-selectable ${selectedTokenIds.includes(token.id) ? 'row-selected' : ''} ${highlightTokenId === token.id ? 'row-focus-highlight' : ''}`.trim()}
                  >
                    <td>
                      <input
                        data-testid={`token-select-${token.id}`}
                        type="checkbox"
                        checked={selectedTokenIds.includes(token.id)}
                        onChange={(e) => toggleTokenSelection(token.id, e.target.checked)}
                        onClick={(e) => e.stopPropagation()}
                      />
                    </td>
                    <td style={{ fontWeight: 600 }}>{token.name || '-'}</td>
                    <td style={{ fontFamily: 'var(--font-mono)', fontSize: 12 }}>{token.tokenMasked || '***'}</td>
                    <td>
                      {token.site?.url ? (
                        <a
                          href={token.site.url}
                          target="_blank"
                          rel="noopener noreferrer"
                          className="badge-link"
                          onClick={(e) => e.stopPropagation()}
                        >
                          <span className="badge badge-muted" style={{ fontSize: 11 }}>
                            {token.site?.name || 'unknown'}
                          </span>
                        </a>
                      ) : (
                        <span className="badge badge-muted" style={{ fontSize: 11 }}>
                          {token.site?.name || 'unknown'}
                        </span>
                      )}
                    </td>
                    <td className="token-account-cell">
                      <span className="token-account-name">{token.account?.username || `account-${token.accountId}`}</span>
                      <span className="token-account-meta">#{token.account?.id || token.accountId}</span>
                    </td>
                    <td>{token.tokenGroup || 'default'}</td>
                    <td>
                      <span style={{ color: token.groupRatioAvailable ? 'var(--color-primary)' : 'var(--color-text-muted)', fontWeight: token.groupRatioAvailable ? 700 : 400 }}>
                        {formatGroupRatio(token.groupRatio)}
                      </span>
                    </td>
                    <td>
                      {renderStatusAction(token, isPending, loadingPrefix)}
                    </td>
                    <td>{renderAvailabilityBadge(token)}</td>
                    <td>{renderDefaultAction(token, isPending, loadingPrefix)}</td>
                    <td style={{ fontSize: 12, color: 'var(--color-text-muted)' }}>{formatDateTimeLocal(token.updatedAt)}</td>
                    <td className="token-actions-cell">
                      <div className="token-table-actions">
                        {!isPending ? (
                          <button
                            onClick={(event) => {
                              event.stopPropagation();
                              void handleCopyToken(token.id, token.name || '');
                            }}
                            disabled={!!rowLoading[`${loadingPrefix}-copy`]}
                            className="btn btn-link btn-link-primary token-table-action-btn"
                            data-testid={`token-copy-${token.id}`}
                          >
                            {rowLoading[`${loadingPrefix}-copy`] ? <span className="spinner spinner-sm" /> : '复制'}
                          </button>
                        ) : null}
                        {!isPending ? (
                          <button
                            onClick={(event) => {
                              event.stopPropagation();
                              void openTokenModels(token);
                            }}
                            className="btn btn-link btn-link-info token-table-action-btn"
                          >
                            模型
                          </button>
                        ) : null}
                        {!isPending ? (
                          <button
                            onClick={(event) => {
                              event.stopPropagation();
                              openHealthCheckPanel(token);
                            }}
                            className="btn btn-link btn-link-info token-table-action-btn"
                          >
                            测活
                          </button>
                        ) : null}
                        <button
                          onClick={(event) => {
                            event.stopPropagation();
                            openEditPanel(token);
                          }}
                          className="btn btn-link btn-link-info token-table-action-btn"
                        >
                          {isPending ? '编辑补全' : '编辑'}
                        </button>
                        <button
                          onClick={(event) => {
                            event.stopPropagation();
                            setDeleteConfirm({ mode: 'single', tokenId: token.id, tokenName: token.name || '' });
                          }}
                          disabled={!!rowLoading[`${loadingPrefix}-delete`]}
                          className="btn btn-link btn-link-danger token-table-action-btn"
                        >
                          {rowLoading[`${loadingPrefix}-delete`] ? <span className="spinner spinner-sm" /> : '删除'}
                        </button>
                      </div>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
          )
        ) : (
          <div className="empty-state">
            <svg className="empty-state-icon" fill="none" viewBox="0 0 24 24" stroke="currentColor"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1} d="M15 7a2 2 0 012 2m4 0a6 6 0 01-7.743 5.743L11 17H9v2H7v2H4a1 1 0 01-1-1v-2.586a1 1 0 01.293-.707l5.964-5.964A6 6 0 1121 9z" /></svg>
            <div className="empty-state-title">暂无令牌</div>
            <div className="empty-state-desc">可先同步站点令牌，或直接在站点创建新令牌。</div>
          </div>
        )}
      </div>
    </div>
  );
}

export default function Tokens() {
  const location = useLocation();
  const params = new URLSearchParams(location.search);
  params.set('segment', 'tokens');
  const nextSearch = params.toString();
  return <Navigate to={`/accounts${nextSearch ? `?${nextSearch}` : ''}`} replace />;
}
