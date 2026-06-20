import React, { useCallback, useEffect, useMemo, useState } from "react";
import { api } from "../../api.js";
import { useToast } from "../../components/Toast.js";

type TokenGroupPricingToken = {
  id: number;
  name: string;
  tokenMasked: string;
  group: string;
  modelNames: string[];
  enabled: boolean;
  isDefault: boolean;
  source: string | null;
  valueStatus: string;
  createdAt?: string | null;
};

type TokenGroupPricingAccount = {
  account: {
    id: number;
    username: string | null;
    status: string | null;
  };
  site: {
    id: number;
    name: string;
    url: string;
    platform: string;
    status: string | null;
  };
  groups: string[];
  groupSource: "upstream" | "local" | "default";
  groupError?: string;
  pricing: {
    available: boolean;
    modelCount: number;
    groupRatio: Record<string, number>;
    allGroupRatio: Record<string, number>;
  };
  tokens: TokenGroupPricingToken[];
};

type TokenGroupPricingGroupRow = {
  id: string;
  site: TokenGroupPricingAccount["site"];
  account: TokenGroupPricingAccount["account"] | null;
  group: string;
  groupName?: string | null;
  description?: string | null;
  ratio: number | null;
  groupSource: TokenGroupPricingAccount["groupSource"];
  groupError?: string;
  pricingAvailable: boolean;
  modelCount: number;
  modelNames: string[];
  refreshedAt?: string | null;
  tokens: TokenGroupPricingToken[];
};

type TokenGroupPricingOverview = {
  generatedAt: string;
  refreshed: boolean;
  summary: {
    accountCount: number;
    siteCount: number;
    tokenCount: number;
    groupCount: number;
    pricingAvailableCount: number;
    groupErrorCount: number;
  };
  accounts: TokenGroupPricingAccount[];
  groupRows?: TokenGroupPricingGroupRow[];
};

type RatioSort = "site" | "ratio-asc" | "ratio-desc" | "modelCount-desc";

function formatRatio(value: number | null | undefined) {
  if (!Number.isFinite(value)) return "";
  const normalized = Number(value);
  return `${Number.isInteger(normalized) ? normalized : normalized.toFixed(3).replace(/0+$/, "").replace(/\.$/, "")}x`;
}

function formatStatus(value?: string | null) {
  if (!value || value === "active") return "正常";
  if (value === "disabled") return "禁用";
  if (value === "expired") return "过期";
  return value;
}

function getGroupDisplayName(item: TokenGroupPricingGroupRow) {
  return (item.groupName || item.group || "default").trim();
}

function buildFallbackGroupRows(accounts: TokenGroupPricingAccount[]): TokenGroupPricingGroupRow[] {
  return accounts.flatMap((item) =>
    item.groups.map((group) => ({
      id: `${item.site.id}:${item.account.id}:${group}`,
      site: item.site,
      account: item.account,
      group,
      ratio: item.pricing.groupRatio[group] ?? null,
      groupSource: item.groupSource,
      groupError: item.groupError,
      pricingAvailable: item.pricing.available,
      modelCount: item.pricing.modelCount,
      modelNames: item.tokens
        .filter((token) => token.group === group)
        .flatMap((token) => token.modelNames || []),
      tokens: item.tokens.filter((token) => token.group === group),
    })),
  );
}

function renderModelChips(models: string[], maxInline = 3) {
  const uniqueModels = Array.from(new Set(models.filter(Boolean)));
  if (uniqueModels.length === 0) return null;
  return (
    <div style={{ display: "flex", flexWrap: "wrap", gap: 6, maxWidth: 420 }}>
      {uniqueModels.slice(0, maxInline).map((model) => (
        <code
          key={model}
          style={{
            display: "inline-flex",
            maxWidth: 220,
            overflow: "hidden",
            textOverflow: "ellipsis",
            whiteSpace: "nowrap",
            fontSize: 12,
            padding: "3px 6px",
            borderRadius: 6,
            background: "var(--color-surface-muted)",
            border: "1px solid var(--color-border-light)",
          }}
          title={model}
        >
          {model}
        </code>
      ))}
      {uniqueModels.length > maxInline && (
        <details style={{ flexBasis: "100%", color: "var(--color-text-muted)", fontSize: 12 }}>
          <summary style={{ cursor: "pointer" }}>
            另有 {uniqueModels.length - maxInline} 个模型
          </summary>
          <div style={{ display: "flex", flexWrap: "wrap", gap: 6, marginTop: 6 }}>
            {uniqueModels.slice(maxInline).map((model) => (
              <code
                key={model}
                style={{
                  display: "inline-flex",
                  maxWidth: 220,
                  overflow: "hidden",
                  textOverflow: "ellipsis",
                  whiteSpace: "nowrap",
                  fontSize: 12,
                  padding: "3px 6px",
                  borderRadius: 6,
                  background: "var(--color-surface-muted)",
                  border: "1px solid var(--color-border-light)",
                }}
                title={model}
              >
                {model}
              </code>
            ))}
          </div>
        </details>
      )}
    </div>
  );
}

function groupRowsBySite(rows: TokenGroupPricingGroupRow[], preserveOrder = false) {
  const groups = new Map<number, { site: TokenGroupPricingGroupRow["site"]; rows: TokenGroupPricingGroupRow[] }>();
  for (const row of rows) {
    const existing = groups.get(row.site.id);
    if (existing) {
      existing.rows.push(row);
    } else {
      groups.set(row.site.id, { site: row.site, rows: [row] });
    }
  }
  return Array.from(groups.values())
    .map((siteGroup) => ({
      ...siteGroup,
      rows: preserveOrder
        ? siteGroup.rows
        : siteGroup.rows.sort((a, b) =>
          a.group.localeCompare(b.group) ||
          String(a.account?.username || "").localeCompare(String(b.account?.username || "")),
        ),
    }))
    .sort((a, b) => (preserveOrder ? 0 : a.site.name.localeCompare(b.site.name)));
}

function rowsAsSingleGroups(rows: TokenGroupPricingGroupRow[]) {
  return rows.map((row) => ({ site: row.site, rows: [row] }));
}

const AUTO_REFRESH_STORAGE_KEY = "metapi.tokenGroupPricing.autoRefreshMinutes";

export default function TokenGroupPricingPanel() {
  const toast = useToast();
  const [overview, setOverview] = useState<TokenGroupPricingOverview | null>(null);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [modelFilter, setModelFilter] = useState("");
  const [ratioSort, setRatioSort] = useState<RatioSort>("site");
  const [autoRefreshMinutes, setAutoRefreshMinutes] = useState(() => {
    const value = Number(window.localStorage.getItem(AUTO_REFRESH_STORAGE_KEY) || 0);
    return Number.isFinite(value) && value > 0 ? value : 0;
  });

  const groupRows = useMemo(
    () => overview?.groupRows || buildFallbackGroupRows(overview?.accounts || []),
    [overview],
  );
  const siteGroups = useMemo(
    () => (ratioSort === "site" ? groupRowsBySite(groupRows) : rowsAsSingleGroups(groupRows)),
    [groupRows, ratioSort],
  );

  const groupQuery = useMemo(() => {
    if (ratioSort === "ratio-asc") return { sortBy: "ratio", sortOrder: "asc" };
    if (ratioSort === "ratio-desc") return { sortBy: "ratio", sortOrder: "desc" };
    if (ratioSort === "modelCount-desc") return { sortBy: "modelCount", sortOrder: "desc" };
    return { sortBy: "site", sortOrder: "asc" };
  }, [ratioSort]);

  const load = useCallback(async (refresh = false, options?: { silent?: boolean }) => {
    if (refresh) setRefreshing(true);
    else setLoading(true);
    try {
      if (refresh) {
        await api.syncTokenGroupPricingGroups();
      }
      const result = await api.getTokenGroupPricingGroups({
        model: modelFilter.trim() || undefined,
        ...groupQuery,
      }) as TokenGroupPricingOverview;
      setOverview(result);
      if (refresh && !options?.silent) toast.success("分组倍率已刷新");
    } catch (error: any) {
      toast.error(error?.message || "加载分组倍率失败");
    } finally {
      setLoading(false);
      setRefreshing(false);
    }
  }, [groupQuery, modelFilter, toast]);

  useEffect(() => {
    void load(false);
  }, [load]);

  useEffect(() => {
    window.localStorage.setItem(AUTO_REFRESH_STORAGE_KEY, String(autoRefreshMinutes));
    if (autoRefreshMinutes <= 0) return undefined;
    const timer = window.setInterval(() => {
      void load(true, { silent: true });
    }, autoRefreshMinutes * 60_000);
    return () => window.clearInterval(timer);
  }, [autoRefreshMinutes, load]);

  if (loading && !overview) {
    return (
      <div className="empty-state">
        <div className="empty-state-title">加载中...</div>
        <div className="empty-state-desc">正在读取账号分组与倍率。</div>
      </div>
    );
  }

  if (!overview || groupRows.length === 0) {
    return (
      <div className="empty-state">
        <div className="empty-state-title">暂无分组</div>
        <div className="empty-state-desc">添加连接或刷新上游后将显示分组倍率。</div>
      </div>
    );
  }

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 16 }}>
      <div
        style={{
          display: "flex",
          alignItems: "center",
          justifyContent: "space-between",
          gap: 12,
          flexWrap: "wrap",
        }}
      >
        <div
          style={{
            display: "grid",
            gridTemplateColumns: "repeat(auto-fit, minmax(120px, 1fr))",
            gap: 12,
            flex: "1 1 520px",
          }}
        >
          {[
            ["站点", overview.summary.siteCount],
            ["账号", overview.summary.accountCount],
            ["令牌", overview.summary.tokenCount],
            ["分组", overview.summary.groupCount],
            ["定价可用", overview.summary.pricingAvailableCount],
          ].map(([label, value]) => (
            <div
              key={label}
              className="stat-card"
              style={{ padding: 14, minHeight: 72 }}
            >
              <div style={{ fontSize: 12, color: "var(--color-text-muted)" }}>
                {label}
              </div>
              <div style={{ fontSize: 22, fontWeight: 700, marginTop: 4 }}>
                {value}
              </div>
            </div>
          ))}
        </div>
        <button
          type="button"
          onClick={() => load(true)}
          disabled={refreshing}
          className="btn btn-soft-primary"
        >
          {refreshing ? (
            <>
              <span className="spinner spinner-sm" />
              刷新中...
            </>
          ) : (
            "刷新上游"
          )}
        </button>
        <label
          style={{
            display: "inline-flex",
            alignItems: "center",
            gap: 8,
            color: "var(--color-text-muted)",
            fontSize: 13,
          }}
        >
          模型
          <input
            value={modelFilter}
            onChange={(event) => setModelFilter(event.target.value)}
            className="form-control"
            placeholder="筛选模型"
            style={{ width: 180 }}
          />
        </label>
        <label
          style={{
            display: "inline-flex",
            alignItems: "center",
            gap: 8,
            color: "var(--color-text-muted)",
            fontSize: 13,
          }}
        >
          排序
          <select
            value={ratioSort}
            onChange={(event) => setRatioSort(event.target.value as RatioSort)}
            className="form-control"
            style={{ width: 132 }}
          >
            <option value="site">站点默认</option>
            <option value="ratio-asc">倍率升序</option>
            <option value="ratio-desc">倍率降序</option>
            <option value="modelCount-desc">模型数量</option>
          </select>
        </label>
        <label
          style={{
            display: "inline-flex",
            alignItems: "center",
            gap: 8,
            color: "var(--color-text-muted)",
            fontSize: 13,
          }}
        >
          定时拉取
          <select
            value={autoRefreshMinutes}
            onChange={(event) => setAutoRefreshMinutes(Number(event.target.value))}
            className="form-control"
            style={{ width: 116 }}
          >
            <option value={0}>关闭</option>
            <option value={1}>1 分钟</option>
            <option value={5}>5 分钟</option>
            <option value={15}>15 分钟</option>
            <option value={30}>30 分钟</option>
            <option value={60}>60 分钟</option>
          </select>
        </label>
      </div>

      <div style={{ overflowX: "auto" }}>
        <table className="data-table" style={{ width: "100%" }}>
          <thead>
            <tr>
              <th>站点</th>
              <th>分组</th>
              <th>倍率</th>
              <th>账号</th>
              <th>账号令牌</th>
              <th>模型</th>
            </tr>
          </thead>
          <tbody>
            {siteGroups.flatMap((siteGroup) =>
              siteGroup.rows.map((item) => (
                <tr key={item.id}>
                  <td style={{ verticalAlign: "top", minWidth: 180 }}>
                    <div style={{ display: "flex", flexDirection: "column", gap: 4 }}>
                      <strong>{siteGroup.site.name}</strong>
                      <span style={{ color: "var(--color-text-muted)", fontSize: 12 }}>
                        {siteGroup.site.platform}
                      </span>
                      <span style={{ color: "var(--color-text-muted)", fontSize: 12 }}>
                        {formatStatus(siteGroup.site.status)}
                      </span>
                    </div>
                  </td>
                  <td style={{ minWidth: 180 }}>
                    <strong>{getGroupDisplayName(item)}</strong>
                    {item.description && (
                      <div style={{ marginTop: 4, color: "var(--color-text-muted)", fontSize: 12 }}>
                        {item.description}
                      </div>
                    )}
                  </td>
                  <td style={{ minWidth: 100 }}>
                    <span style={{ color: "var(--color-primary)", fontWeight: 700 }}>
                      {formatRatio(item.ratio)}
                    </span>
                  </td>
                  <td style={{ minWidth: 160 }}>
                    {item.account ? (
                      <div style={{ display: "flex", flexDirection: "column", gap: 4 }}>
                        <strong>{item.account.username || `#${item.account.id}`}</strong>
                        <span style={{ color: "var(--color-text-muted)", fontSize: 12 }}>
                          #{item.account.id} · {formatStatus(item.account.status)}
                        </span>
                      </div>
                    ) : (
                      <span style={{ color: "var(--color-text-muted)" }}>站点公开分组</span>
                    )}
                  </td>
                  <td style={{ minWidth: 260 }}>
                    {item.tokens.length > 0 ? (
                      <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
                        {item.tokens.slice(0, 1).map((token) => (
                          <div key={token.id} style={{ display: "flex", flexDirection: "column", gap: 6 }}>
                            <div style={{ display: "flex", flexWrap: "wrap", gap: 6, alignItems: "center" }}>
                              <span style={{ fontWeight: 600 }}>{token.name}</span>
                              <span style={{ color: "var(--color-text-muted)", fontSize: 12 }}>最新</span>
                              {token.isDefault && (
                                <span style={{ color: "var(--color-primary)", fontSize: 12 }}>默认</span>
                              )}
                              {!token.enabled && (
                                <span style={{ color: "var(--color-danger)", fontSize: 12 }}>禁用</span>
                              )}
                              <code style={{ fontSize: 12 }}>{token.tokenMasked}</code>
                            </div>
                            {token.modelNames.length > 0 ? (
                              renderModelChips(token.modelNames)
                            ) : (
                              <span style={{ color: "var(--color-text-muted)", fontSize: 12 }}>
                                该令牌未同步到模型
                              </span>
                            )}
                          </div>
                        ))}
                      </div>
                    ) : (
                      <span style={{ color: "var(--color-text-muted)" }}>无</span>
                    )}
                  </td>
                  <td style={{ minWidth: 260 }}>
                    <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
                      <span style={{ color: item.modelNames.length > 0 ? "var(--color-text-primary)" : "var(--color-text-muted)", fontSize: 12, fontWeight: item.modelNames.length > 0 ? 600 : 400 }}>
                        {item.modelNames.length > 0 ? item.modelNames.length : item.modelCount} 个模型
                      </span>
                      {item.tokens.length === 0 && renderModelChips(item.modelNames)}
                      {item.modelNames.length === 0 && (
                        <span style={{ color: "var(--color-text-muted)", fontSize: 12 }}>
                          未同步到模型
                        </span>
                      )}
                      {item.groupError && (
                        <span style={{ color: "var(--color-warning, #b45309)", fontSize: 12 }}>
                          {item.groupError}
                        </span>
                      )}
                    </div>
                  </td>
                </tr>
              )),
            )}
          </tbody>
        </table>
      </div>
    </div>
  );
}
