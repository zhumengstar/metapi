import type { ButtonHTMLAttributes, ReactNode, RefCallback } from 'react';
import type { BrandInfo } from '../../components/BrandIcon.js';
import type { RouteDecision, RouteDecisionCandidate, RouteMode } from '../../../shared/tokenRouteContract.js';
export type { RouteDecision, RouteDecisionCandidate, RouteMode } from '../../../shared/tokenRouteContract.js';

export type RouteSortBy = 'modelPattern' | 'channelCount' | 'usage';
export type RouteSortDir = 'asc' | 'desc';
export type GroupFilter = null | '__all__' | number;
export type RouteRoutingStrategy = 'weighted' | 'round_robin' | 'stable_first';
export type OAuthRouteUnitStrategy = 'round_robin' | 'stick_until_unavailable';
export type RouteRowKind = 'persisted' | 'zero_channel';
export type RouteChannelDraft = {
  accountId: number;
  tokenId: number;
  sourceModel: string;
};

export type RouteChannelRouteUnitMember = {
  accountId: number;
  username: string | null;
  siteName: string | null;
};

export type RouteChannelRouteUnit = {
  id: number | string;
  name: string | null;
  strategy: OAuthRouteUnitStrategy;
  memberCount: number;
  members?: RouteChannelRouteUnitMember[];
};

export type RouteChannel = {
  id: number;
  routeId?: number;
  accountId: number;
  tokenId: number | null;
  sourceModel?: string | null;
  priority: number;
  weight: number;
  enabled: boolean;
  imageUpscaleEnabled?: boolean;
  manualOverride: boolean;
  successCount: number;
  failCount: number;
  totalCost?: number | null;
  actualTotalCost?: number | null;
  totalInputTokens?: number | null;
  inputCostPerMillion?: number | null;
  pureInputCostPerMillion?: number | null;
  cooldownUntil?: string | null;
  account?: {
    username: string | null;
    accessToken?: string | null;
    extraConfig?: string | null;
    credentialMode?: string | null;
  };
  site?: {
    id: number;
    name: string | null;
    url?: string | null;
    platform: string | null;
  };
  token?: {
    id: number;
    name: string;
    accountId: number;
    enabled: boolean;
    isDefault: boolean;
  } | null;
  oauthRouteUnitId?: number | null;
  routeUnit?: RouteChannelRouteUnit | null;
  modelTestResult?: RouteChannelModelTestResult | null;
};

export type RouteRow = {
  id: number;
  modelPattern: string;
  displayName?: string | null;
  displayIcon?: string | null;
  routeMode?: RouteMode | null;
  sourceRouteIds?: number[];
  modelMapping?: string | null;
  routingStrategy?: RouteRoutingStrategy | null;
  decisionSnapshot?: RouteDecision | null;
  decisionRefreshedAt?: string | null;
  enabled: boolean;
  channels: RouteChannel[];
};

export type RouteSummaryRow = {
  id: number;
  modelPattern: string;
  displayName: string | null;
  displayIcon: string | null;
  routeMode?: RouteMode | null;
  sourceRouteIds?: number[];
  modelMapping: string | null;
  routingStrategy?: RouteRoutingStrategy | null;
  enabled: boolean;
  channelCount: number;
  enabledChannelCount: number;
  successCount?: number | null;
  totalInputTokens?: number | null;
  siteNames: string[];
  decisionSnapshot: RouteDecision | null;
  decisionRefreshedAt: string | null;
  kind?: RouteRowKind;
  readOnly?: boolean;
  isVirtual?: boolean;
};

export type ChannelDecisionState = {
  probability: number;
  showBar: boolean;
  reasonText: string;
  reasonColor: string;
};

export type RouteChannelModelTestResult = {
  tokenId: number | null;
  model: string;
  available: boolean;
  message?: string | null;
  responseText?: string | null;
  httpStatus?: number | null;
  latencyMs?: number | null;
  checkedAt?: string | null;
};

export type RouteTokenOption = {
  id: number;
  name: string;
  isDefault: boolean;
  sourceModel?: string;
};

export type RouteIconOption = {
  value: string;
  label: string;
  description?: string;
  iconNode?: ReactNode;
  iconUrl?: string;
  iconText?: string;
};

export type MissingTokenRouteSiteActionItem = {
  key: string;
  siteName: string;
  accountId: number;
  accountLabel: string;
};

export type MissingTokenGroupRouteSiteActionItem = {
  key: string;
  siteName: string;
  accountId: number;
  accountLabel: string;
  missingGroups: string[];
  requiredGroups: string[];
  availableGroups: string[];
  groupCoverageUncertain?: boolean;
};

export type SortableChannelRowProps = {
  channel: RouteChannel;
  displayPriority?: number;
  showPriorityBadge?: boolean;
  dragging?: boolean;
  dragHandleProps?: ButtonHTMLAttributes<HTMLButtonElement>;
  dragHandleRef?: RefCallback<HTMLButtonElement>;
  decisionCandidate?: RouteDecisionCandidate;
  isSelectedStableFirstChannel?: boolean;
  isManualStableFirstChannel?: boolean;
  isExactRoute: boolean;
  loadingDecision: boolean;
  isSavingPriority: boolean;
  readOnly?: boolean;
  channelManagementDisabled?: boolean;
  dragInProgress?: boolean;
  mobile?: boolean;
  tokenOptions: RouteTokenOption[];
  activeTokenId: number;
  isUpdatingToken: boolean;
  modelName?: string;
  testingModel?: boolean;
  modelTestResult?: RouteChannelModelTestResult | null;
  onTokenDraftChange: (channelId: number, tokenId: number) => void;
  onSaveToken: () => void;
  onDeleteChannel: () => void;
  onToggleEnabled: (enabled: boolean) => void;
  onToggleImageUpscale?: (enabled: boolean) => void;
  onTestModel?: () => void;
  onPinStableFirstChannel?: () => void;
  onSiteBlockModel?: () => void;
};

export type GroupRouteItem = {
  id: number;
  title: string;
  icon: { kind: 'auto' } | { kind: 'none' } | { kind: 'text'; value: string } | { kind: 'brand'; value: string };
  brand: BrandInfo | null;
  modelPattern: string;
  channelCount: number;
  sourceRouteCount: number;
};

export type PriorityRailSection = {
  priority: number;
  channelCount: number;
  channelIds: number[];
};

export type PriorityRailDragTarget =
  | {
    kind: 'existing_layer';
    priority: number;
    highlighted: boolean;
  }
  | {
    kind: 'new_layer';
    priority: number;
    highlighted: boolean;
  };
