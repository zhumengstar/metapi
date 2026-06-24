export type OauthQuotaWindowSnapshot = {
  supported: boolean;
  limit?: number | null;
  used?: number | null;
  remaining?: number | null;
  resetAt?: string | null;
  message?: string;
};

export type OauthQuotaWindowsSnapshot = {
  fiveHour: OauthQuotaWindowSnapshot;
  sevenDay: OauthQuotaWindowSnapshot;
};

export type OauthQuotaSnapshot = {
  status: 'supported' | 'unsupported' | 'error';
  source: 'official' | 'reverse_engineered';
  lastSyncAt?: string;
  lastError?: string;
  providerMessage?: string;
  subscription?: {
    planType?: string;
    activeStart?: string;
    activeUntil?: string;
  };
  windows: OauthQuotaWindowsSnapshot;
  antigravity?: {
    credits?: {
      creditType?: string;
      creditAmount?: number | null;
      minimumCreditAmountForUsage?: number | null;
      available?: boolean;
    };
    modelFamilies?: {
      gemini?: {
        label?: string;
        models?: string[];
        windows: OauthQuotaWindowsSnapshot;
      };
      claudeGpt?: {
        label?: string;
        models?: string[];
        windows: OauthQuotaWindowsSnapshot;
      };
    };
  };
  lastLimitResetAt?: string;
};
