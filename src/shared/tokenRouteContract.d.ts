export declare const ROUTE_DECISION_REFRESH_TASK_TYPE = "route-decision.refresh";
export type RouteMode = 'pattern' | 'explicit_group';
export type RouteDecisionScoreBreakdownRow = {
    metric: string;
    value: string;
    formula: string;
    weight: string;
    contribution: string;
    tone?: 'positive' | 'warning' | 'negative' | 'muted';
};
export type RouteDecisionScoreBreakdown = {
    strategy: 'weighted' | 'stable_first' | 'round_robin';
    formula: string;
    contribution: number;
    totalContribution: number;
    probability: number;
    rows: RouteDecisionScoreBreakdownRow[];
};
export type RouteDecisionCandidate = {
    channelId: number;
    accountId: number;
    username: string;
    siteName: string;
    tokenName: string;
    priority: number;
    weight: number;
    eligible: boolean;
    recentlyFailed: boolean;
    avoidedByRecentFailure: boolean;
    probability: number;
    reason: string;
    scoreBreakdown?: RouteDecisionScoreBreakdown;
};
export type RouteDecision = {
    requestedModel: string;
    actualModel: string;
    matched: boolean;
    selectedChannelId?: number;
    selectedLabel?: string;
    summary: string[];
    candidates: RouteDecisionCandidate[];
};
export declare function normalizeTokenRouteMode(routeMode: unknown): RouteMode;
