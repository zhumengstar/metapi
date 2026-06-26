import React from 'react';
import { createPortal } from 'react-dom';
import CenteredModal from '../../components/CenteredModal.js';
import {
  buildModelAvailabilityTooltipRows,
  isImageOnlySkippedAvailabilityResult,
  type ModelAvailabilityResult,
  type ModelAvailabilityTooltipRow,
} from '../helpers/modelAvailabilityPresentation.js';

export type OAuthModelItem = {
  name: string;
  available?: boolean;
  latencyMs: number | null;
  disabled: boolean;
  isManual?: boolean;
  message?: string | null;
  responseText?: string | null;
  httpStatus?: number | null;
  checkedAt?: string | null;
};

type OAuthModelsModalProps = {
  open: boolean;
  title: string;
  siteName?: string | null;
  loading: boolean;
  refreshing: boolean;
  testStatus?: 'idle' | 'testing' | 'success' | 'warning' | 'error';
  testMessage?: string;
  models: OAuthModelItem[];
  totalCount: number;
  disabledCount: number;
  testingModelName?: string;
  modelTestResults?: Record<string, ModelAvailabilityResult>;
  onClose: () => void;
  onRefresh: () => Promise<void> | void;
  onTestModel?: (model: OAuthModelItem) => Promise<void> | void;
};

const AVAILABILITY_TOOLTIP_WIDTH = 320;

export default function OAuthModelsModal({
  open,
  title,
  siteName,
  loading,
  refreshing,
  testStatus = 'idle',
  testMessage,
  models,
  totalCount,
  disabledCount,
  testingModelName = '',
  modelTestResults = {},
  onClose,
  onRefresh,
  onTestModel,
}: OAuthModelsModalProps) {
  const enabledCount = Math.max(0, totalCount - disabledCount);
  const [tooltip, setTooltip] = React.useState<{
    rows: ModelAvailabilityTooltipRow[];
    left: number;
    top: number;
  } | null>(null);

  const showTooltip = React.useCallback((
    event: React.MouseEvent<HTMLElement> | React.FocusEvent<HTMLElement>,
    rows: ModelAvailabilityTooltipRow[],
  ) => {
    if (typeof window === 'undefined') return;
    const visibleRows = rows.filter((row) => row.value !== undefined && row.value !== null && String(row.value).trim() !== '');
    if (visibleRows.length <= 0) return;
    const rect = event.currentTarget.getBoundingClientRect();
    const rawLeft = rect.left + rect.width / 2 - AVAILABILITY_TOOLTIP_WIDTH / 2;
    setTooltip({
      rows: visibleRows,
      left: Math.max(8, Math.min(rawLeft, window.innerWidth - AVAILABILITY_TOOLTIP_WIDTH - 8)),
      top: Math.max(8, rect.bottom + 8),
    });
  }, []);

  const hideTooltip = React.useCallback(() => setTooltip(null), []);

  React.useEffect(() => {
    if (!tooltip || typeof window === 'undefined') return;
    const hide = () => setTooltip(null);
    window.addEventListener('scroll', hide, true);
    window.addEventListener('resize', hide);
    return () => {
      window.removeEventListener('scroll', hide, true);
      window.removeEventListener('resize', hide);
    };
  }, [tooltip]);

  const resolveModelResult = React.useCallback((model: OAuthModelItem): ModelAvailabilityResult => {
    const pending = modelTestResults[model.name];
    if (pending) return pending;
    return {
      model: model.name,
      available: model.available !== false,
      message: model.message || (model.available === false ? '最近测试不可用' : '请求成功'),
      responseText: model.responseText ?? null,
      httpStatus: model.httpStatus ?? null,
      latencyMs: model.latencyMs,
      checkedAt: model.checkedAt ?? null,
    };
  }, [modelTestResults]);

  const renderAvailabilityBadge = React.useCallback((model: OAuthModelItem) => {
    if (testingModelName === model.name) {
      return <span className="badge badge-info token-availability-badge oauth-models-availability-badge"><span className="spinner spinner-sm" /> 检测中</span>;
    }
    const result = resolveModelResult(model);
    const imageOnlySkipped = isImageOnlySkippedAvailabilityResult(result);
    const rows = buildModelAvailabilityTooltipRows(model.name, result);
    return (
      <span
        className={`badge ${result.available ? 'badge-success' : (imageOnlySkipped ? 'badge-warning' : 'badge-info')} token-availability-badge oauth-models-availability-badge`}
        tabIndex={0}
        onMouseEnter={(event) => showTooltip(event, rows)}
        onMouseLeave={hideTooltip}
        onFocus={(event) => showTooltip(event, rows)}
        onBlur={hideTooltip}
      >
        {result.available ? '是' : '否'}
      </span>
    );
  }, [hideTooltip, resolveModelResult, showTooltip, testingModelName]);

  return (
    <>
      <CenteredModal
        open={open}
        onClose={onClose}
        title={title}
        maxWidth={680}
        footer={(
          <>
            <button type="button" className="btn btn-ghost" onClick={onClose}>
              关闭
            </button>
            <button
              type="button"
              className="btn btn-primary"
              onClick={() => void onRefresh()}
              disabled={loading || refreshing}
            >
              {refreshing ? <><span className="spinner spinner-sm" />测试中...</> : '测试全部'}
            </button>
          </>
        )}
      >
      {loading ? (
        <div className="oauth-models-empty">
          <span className="spinner" />
          <span className="oauth-models-empty-copy">正在加载模型列表...</span>
        </div>
      ) : (
        <div className="oauth-models-layout">
          <div className="oauth-models-summary">
            <div className="oauth-models-summary-title">
              {siteName ? `${siteName} · 共 ${totalCount} 个模型` : `共 ${totalCount} 个模型`}
            </div>
            <div className="oauth-models-summary-copy">
              已启用 {enabledCount} 个，已禁用 {disabledCount} 个。点击“测试模型”会重新验证账号是否仍可访问上游模型；失败仅展示不可用，通过后可激活该连接。
            </div>
          </div>

          <div className={`oauth-models-test-state ${testStatus !== 'idle' ? `is-${testStatus}` : ''}`.trim()}>
            <span className={`badge ${
              testStatus === 'success'
                ? 'badge-success'
                : testStatus === 'warning'
                  ? 'badge-warning'
                  : testStatus === 'error'
                    ? 'badge-danger'
                    : 'badge-info'
            }`}>
              {testStatus === 'success'
                ? '可用'
                : testStatus === 'warning'
                  ? '不可用'
                  : testStatus === 'error'
                    ? '异常'
                    : testStatus === 'testing'
                      ? '测试中'
                      : '待测试'}
            </span>
            <span className="oauth-models-test-copy">
              {testMessage || '可点击“测试模型”检查该账号是否还能正常访问模型。'}
            </span>
          </div>

          {models.length === 0 ? (
            <div className="oauth-models-empty">
              <div className="oauth-models-empty-title">暂无模型</div>
              <div className="oauth-models-empty-copy">当前账号还没有同步到可用模型，可点击右下角“测试模型”重试。</div>
            </div>
          ) : (
            <div className="oauth-models-list">
              {models.map((model) => (
                <div key={model.name} className={`oauth-models-item ${model.disabled || model.available === false ? 'is-disabled' : ''}`.trim()}>
                  <div className="oauth-models-item-main">
                    <div className="oauth-models-item-name">{model.name}</div>
                    <div className="oauth-models-item-meta">
                      {renderAvailabilityBadge(model)}
                      {model.latencyMs != null ? <span>{model.latencyMs}ms</span> : null}
                      {model.isManual ? <span className="badge badge-info oauth-models-badge">手动</span> : null}
                      {model.available === false ? <span className="badge badge-info oauth-models-badge">不可用</span> : null}
                      {model.disabled ? <span className="badge badge-warning oauth-models-badge">禁用</span> : null}
                      {onTestModel ? (
                        <button
                          type="button"
                          className="btn btn-link btn-link-info oauth-models-test-button"
                          onClick={() => void onTestModel(model)}
                          disabled={testingModelName === model.name || loading || refreshing}
                        >
                          {testingModelName === model.name ? '测试中...' : '测试模型'}
                        </button>
                      ) : null}
                    </div>
                  </div>
                </div>
              ))}
            </div>
          )}
        </div>
      )}
      </CenteredModal>
      {tooltip && typeof document !== 'undefined'
        ? createPortal((
          <div
            className="token-availability-tooltip token-availability-tooltip-portal"
            role="tooltip"
            style={{
              left: tooltip.left,
              top: tooltip.top,
            }}
          >
            {tooltip.rows.map((row) => (
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
    </>
  );
}
