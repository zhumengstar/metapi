import { useEffect, useState, type CSSProperties, type MouseEvent } from 'react';
import { createPortal } from 'react-dom';
import ModernSelect from '../../components/ModernSelect.js';
import { isImageGenerationModel } from '../../utils/modelType.js';
import type { RouteChannel, RouteChannelModelTestResult, SortableChannelRowProps } from './types.js';
import {
  buildModelAvailabilityTooltipRows,
  type ModelAvailabilityTooltipRow,
} from '../helpers/modelAvailabilityPresentation.js';
import {
  buildFixedTokenOptionDescription,
  buildFixedTokenOptionLabel,
  describeTokenBinding,
  resolveTokenBindingConnectionMode,
} from './tokenBindingPresentation.js';
import { getChannelDecisionState, getPriorityTagStyle, getProbabilityColor } from './utils.js';
import type { RouteDecisionScoreBreakdownRow } from '../../../shared/tokenRouteContract.js';

function getRouteUnitStrategyLabel(strategy: string | null | undefined): string {
  return strategy === 'stick_until_unavailable' ? '单个用到不可用再切' : '轮询';
}

function formatRouteUnitMemberLabel(member: { accountId: number; username: string | null; siteName: string | null }): string {
  const accountLabel = member.username?.trim() || `account-${member.accountId}`;
  const siteLabel = member.siteName?.trim();
  return siteLabel ? `${accountLabel} @ ${siteLabel}` : accountLabel;
}

function normalizeExternalSiteUrl(value: string | null | undefined): string | null {
  const raw = String(value || '').trim();
  if (!raw) return null;
  try {
    const url = /^https?:\/\//i.test(raw) ? new URL(raw) : new URL(`https://${raw}`);
    return url.toString();
  } catch {
    return null;
  }
}

function SiteBadge({ site, fontSize = 10 }: { site: RouteChannel['site']; fontSize?: number }) {
  const label = site?.name?.trim() || 'unknown';
  const href = normalizeExternalSiteUrl(site?.url);
  const badge = (
    <span className="badge badge-muted" style={{ fontSize }}>
      {label}
    </span>
  );

  if (!href) return badge;

  return (
    <a
      className="badge-link"
      href={href}
      target="_blank"
      rel="noopener noreferrer"
      title={`打开 ${label}`}
      onClick={(event) => event.stopPropagation()}
      onMouseDown={(event) => event.stopPropagation()}
    >
      {badge}
    </a>
  );
}

function formatCompactCost(value: number | null | undefined): string {
  const amount = Number(value);
  if (!Number.isFinite(amount) || amount <= 0) return '0';
  if (amount >= 1000) return amount.toFixed(0);
  if (amount >= 1) return amount.toFixed(2);
  if (amount >= 0.01) return amount.toFixed(4);
  return amount.toFixed(6);
}

function formatInputCostPerMillion(value: number | null | undefined): string {
  const amount = Number(value);
  if (!Number.isFinite(amount) || amount <= 0) return '--';
  return formatCompactCost(amount);
}

type ModelTestTooltipState = {
  left: number;
  top: number;
  rows: ModelAvailabilityTooltipRow[];
};

const MODEL_TEST_TOOLTIP_WIDTH = 300;
const MODEL_TEST_TOOLTIP_OFFSET = 12;

function getTooltipRowColor(tone: ModelAvailabilityTooltipRow['tone']): string {
  if (tone === 'success') return 'var(--color-success)';
  if (tone === 'warning') return 'var(--color-warning)';
  if (tone === 'error') return 'var(--color-danger)';
  if (tone === 'muted') return 'var(--color-text-muted)';
  return 'var(--color-text-primary)';
}

function getDecisionBreakdownToneColor(tone: RouteDecisionScoreBreakdownRow['tone']): string {
  if (tone === 'positive') return 'var(--color-success)';
  if (tone === 'warning') return 'var(--color-warning)';
  if (tone === 'negative') return 'var(--color-danger)';
  if (tone === 'muted') return 'var(--color-text-muted)';
  return 'var(--color-text-primary)';
}

function buildFallbackDecisionBreakdown(reason: string): RouteDecisionScoreBreakdownRow[] {
  const trimmed = String(reason || '').trim();
  if (!trimmed) return [];
  return [
    {
      metric: '说明',
      value: trimmed,
      formula: '后端未返回结构化计算明细',
      weight: '--',
      contribution: '--',
      tone: 'muted',
    },
  ];
}

export function SortableChannelRow({
  channel,
  displayPriority,
  showPriorityBadge = true,
  dragging = false,
  dragHandleProps,
  dragHandleRef,
  decisionCandidate,
  isSelectedStableFirstChannel = false,
  isManualStableFirstChannel = false,
  isExactRoute,
  loadingDecision,
  isSavingPriority,
  readOnly = false,
  channelManagementDisabled = false,
  dragInProgress = false,
  mobile = false,
  tokenOptions,
  activeTokenId,
  isUpdatingToken,
  modelName,
  testingModel = false,
  modelTestResult = null,
  onTokenDraftChange,
  onSaveToken,
  onDeleteChannel,
  onToggleEnabled,
  onToggleImageUpscale,
  onTestModel,
  onPinStableFirstChannel,
  onSiteBlockModel,
}: SortableChannelRowProps) {
  const resolvedPriority = displayPriority ?? channel.priority ?? 0;
  const managementLocked = readOnly || channelManagementDisabled;
  const suppressTooltips = dragInProgress || dragging;
  const rowTransition = [
    'box-shadow 180ms ease',
    'background-color 180ms ease',
    'border-color 180ms ease',
    'opacity 180ms ease',
  ].filter(Boolean).join(', ');
  const dragHandleStyle: CSSProperties = {
    width: 22,
    minWidth: 22,
    height: 22,
    padding: 0,
    border: `1px solid ${dragging ? 'color-mix(in srgb, var(--color-info) 34%, var(--color-border-light))' : 'var(--color-border-light)'}`,
    borderRadius: 10,
    backgroundColor: dragging
      ? 'color-mix(in srgb, var(--color-bg-card) 80%, var(--color-info) 20%)'
      : 'color-mix(in srgb, var(--color-bg-card) 90%, white 10%)',
    boxShadow: 'inset 0 1px 0 rgba(255, 255, 255, 0.62)',
    color: dragging ? 'var(--color-text-primary)' : 'var(--color-text-muted)',
    cursor: isSavingPriority || managementLocked ? 'not-allowed' : 'grab',
    opacity: managementLocked ? 0.65 : 1,
    transition: 'background-color 0.16s ease, border-color 0.16s ease, box-shadow 0.16s ease, color 0.16s ease',
  };

  const rowStyle: CSSProperties = {
    transition: rowTransition || undefined,
    opacity: dragging ? 0.92 : channel.enabled === false ? 0.56 : 1,
    display: 'grid',
    gridTemplateColumns: 'minmax(0, 1fr)',
    alignItems: mobile ? 'stretch' : 'center',
    gap: mobile ? 8 : 7,
    padding: mobile ? '8px 9px' : '7px 8px',
    border: `1px solid ${dragging ? 'color-mix(in srgb, var(--color-info) 38%, var(--color-border-light))' : 'color-mix(in srgb, var(--color-border-light) 92%, transparent)'}`,
    borderRadius: 14,
    backgroundColor: dragging
      ? 'color-mix(in srgb, var(--color-bg-card) 82%, var(--color-info) 18%)'
      : 'color-mix(in srgb, var(--color-bg-card) 96%, white 4%)',
    boxShadow: dragging
      ? '0 18px 34px rgba(15, 23, 42, 0.12)'
      : '0 10px 22px rgba(15, 23, 42, 0.04), inset 0 1px 0 rgba(255, 255, 255, 0.7)',
  };

  const decisionState = getChannelDecisionState(decisionCandidate, channel, isExactRoute, loadingDecision);
  const decisionReasonText = decisionCandidate?.reason || decisionState.reasonText || '';
  const decisionReasonTooltip = suppressTooltips
    ? undefined
    : (decisionReasonText || undefined);
  const decisionBreakdown = decisionCandidate?.scoreBreakdown ?? null;
  const decisionBreakdownRows = decisionBreakdown?.rows?.length
    ? decisionBreakdown.rows
    : buildFallbackDecisionBreakdown(decisionReasonText);
  const actualTotalCost = channel.actualTotalCost ?? channel.totalCost ?? 0;
  const inputCostPerMillion = channel.inputCostPerMillion ?? null;
  const pureInputCostPerMillion = channel.pureInputCostPerMillion ?? null;
  const costStatsTooltip = suppressTooltips
    ? undefined
    : `余额实际消耗：${formatCompactCost(actualTotalCost)}；输入 token：${channel.totalInputTokens || 0}；摊销/M：${formatInputCostPerMillion(inputCostPerMillion)}；纯输入/M：${formatInputCostPerMillion(pureInputCostPerMillion)}`;
  const tokenBinding = describeTokenBinding(
    tokenOptions,
    activeTokenId,
    channel.token?.name ?? null,
    {
      connectionMode: resolveTokenBindingConnectionMode(channel.account),
      accountName: channel.account?.username || `account-${channel.accountId}`,
    },
  );
  const routeUnit = channel.routeUnit ?? null;
  const routeUnitName = routeUnit?.name?.trim() || 'OAuth 路由池';
  const routeUnitStrategyLabel = routeUnit ? getRouteUnitStrategyLabel(routeUnit.strategy) : '';
  const routeUnitMemberSummary = routeUnit?.members?.length
    ? routeUnit.members.map((member) => formatRouteUnitMemberLabel(member)).join('、')
    : null;
  const routeUnitMemberSummaryText = routeUnitMemberSummary ? `成员：${routeUnitMemberSummary}` : null;
  const channelEnabled = channel.enabled !== false;
  const canToggleChannelStatus = !managementLocked && !isUpdatingToken;
  const channelStatusText = channelEnabled ? '已启用' : '已禁用';
  const channelStatusActionText = channelEnabled ? '点击禁用此通道' : '点击启用此通道';
  const channelStatusButtonStyle: CSSProperties = {
    fontSize: 8.5,
    border: 0,
    appearance: 'none',
    lineHeight: 1.2,
    padding: '2px 6px',
    cursor: canToggleChannelStatus ? 'pointer' : 'not-allowed',
    opacity: canToggleChannelStatus ? 1 : 0.72,
  };
  const renderChannelStatusToggle = () => (
    <button
      type="button"
      className={channelEnabled ? 'badge badge-success' : 'badge badge-muted'}
      style={channelStatusButtonStyle}
      disabled={!canToggleChannelStatus}
      onClick={(event) => {
        event.stopPropagation();
        if (!canToggleChannelStatus) return;
        onToggleEnabled(!channelEnabled);
      }}
      data-tooltip={suppressTooltips ? undefined : (canToggleChannelStatus ? channelStatusActionText : '该通道当前不可编辑')}
      aria-label={channelStatusActionText}
    >
      {channelStatusText}
    </button>
  );
  const resolvedModelName = String(modelName || channel.sourceModel || '').trim();
  const imageRouteModel = isImageGenerationModel(resolvedModelName);
  const imageUpscaleEnabled = channel.imageUpscaleEnabled === true;
  const canToggleImageUpscale = imageRouteModel && Boolean(onToggleImageUpscale) && !managementLocked && !isUpdatingToken;
  const canTestModel = Boolean(onTestModel && resolvedModelName && Number(channel.accountId || 0) > 0);
  const canPinStableFirstChannel = Boolean(onPinStableFirstChannel) && !managementLocked && !isUpdatingToken;
  const testModelBadgeClass = testingModel
    ? 'badge badge-info'
    : modelTestResult
      ? (modelTestResult.available ? 'badge badge-success' : 'badge badge-info')
      : 'badge badge-muted';
  const testModelText = testingModel ? '测试中' : '测模型';
  const [modelTestTooltip, setModelTestTooltip] = useState<ModelTestTooltipState | null>(null);
  const showModelTestTooltip = (event: MouseEvent<HTMLElement>) => {
    if (suppressTooltips) return;
    const rect = event.currentTarget.getBoundingClientRect();
    const viewportWidth = window.innerWidth || document.documentElement.clientWidth || 0;
    const left = Math.min(
      Math.max(MODEL_TEST_TOOLTIP_OFFSET, rect.right - MODEL_TEST_TOOLTIP_WIDTH),
      Math.max(MODEL_TEST_TOOLTIP_OFFSET, viewportWidth - MODEL_TEST_TOOLTIP_WIDTH - MODEL_TEST_TOOLTIP_OFFSET),
    );
    setModelTestTooltip({
      left,
      top: rect.bottom + MODEL_TEST_TOOLTIP_OFFSET,
      rows: buildModelAvailabilityTooltipRows(resolvedModelName, modelTestResult),
    });
  };
  const hideModelTestTooltip = () => setModelTestTooltip(null);
  const renderModelTestButton = () => (
    <button
      type="button"
      className={`${testModelBadgeClass} token-availability-badge`}
      style={{
        fontSize: 8.5,
        border: 0,
        appearance: 'none',
        lineHeight: 1.2,
        padding: '2px 6px',
        cursor: canTestModel && !testingModel ? 'pointer' : 'not-allowed',
        opacity: canTestModel ? 1 : 0.68,
      }}
      disabled={!canTestModel || testingModel}
      onClick={(event) => {
        event.stopPropagation();
        if (!canTestModel || testingModel) return;
        onTestModel?.();
      }}
      onMouseEnter={showModelTestTooltip}
      onMouseLeave={hideModelTestTooltip}
      onFocus={(event) => showModelTestTooltip(event as unknown as MouseEvent<HTMLElement>)}
      onBlur={hideModelTestTooltip}
      data-tooltip={suppressTooltips ? undefined : (canTestModel ? undefined : '缺少可测试的账号或模型')}
      aria-label={resolvedModelName ? `手动测试模型 ${resolvedModelName}` : '手动测试模型'}
    >
      {testingModel ? <span className="spinner spinner-sm" /> : null}
      {testModelText}
    </button>
  );
  const renderImageUpscaleToggle = () => {
    if (!imageRouteModel || !onToggleImageUpscale) return null;
    const actionText = imageUpscaleEnabled ? '关闭图片超分' : '开启图片超分';
    return (
      <button
        type="button"
        className={imageUpscaleEnabled ? 'badge badge-info' : 'badge badge-muted'}
        style={{
          fontSize: 8.5,
          border: 0,
          appearance: 'none',
          lineHeight: 1.2,
          padding: '2px 6px',
          cursor: canToggleImageUpscale ? 'pointer' : 'not-allowed',
          opacity: canToggleImageUpscale ? 1 : 0.68,
        }}
        disabled={!canToggleImageUpscale}
        onClick={(event) => {
          event.stopPropagation();
          if (!canToggleImageUpscale) return;
          onToggleImageUpscale(!imageUpscaleEnabled);
        }}
        data-tooltip={suppressTooltips ? undefined : `${actionText}。仅图片模型生效，只有请求尺寸需要放大时才处理。`}
        aria-label={actionText}
      >
        {imageUpscaleEnabled ? '超分开' : '超分关'}
      </button>
    );
  };
  const renderPinStableFirstButton = () => {
    if (!onPinStableFirstChannel) return null;
    const pinBadgeClass = isManualStableFirstChannel
      ? 'badge badge-success'
      : isSelectedStableFirstChannel
        ? 'badge badge-info'
        : 'badge badge-muted';
    const pinText = isManualStableFirstChannel
      ? '手动主'
      : isSelectedStableFirstChannel
        ? '当前主'
        : '设主';
    const pinTooltip = isManualStableFirstChannel
      ? '这是手动指定的稳定优先主通道。后续请求会持续先打此通道，连续失败 5 次后才正式切换。'
      : isSelectedStableFirstChannel
        ? '这是当前稳定优先主通道。后续请求会持续先打此通道，连续失败 5 次后才正式切换。'
        : '设为稳定优先主通道。后续请求会持续先打此通道，连续失败 5 次后才正式切换。';
    return (
      <button
        type="button"
        className={pinBadgeClass}
        style={{
          fontSize: 8.5,
          border: 0,
          appearance: 'none',
          lineHeight: 1.2,
          padding: '2px 6px',
          cursor: canPinStableFirstChannel ? 'pointer' : 'not-allowed',
          opacity: canPinStableFirstChannel ? 1 : 0.68,
        }}
        disabled={!canPinStableFirstChannel}
        onClick={(event) => {
          event.stopPropagation();
          if (!canPinStableFirstChannel) return;
          onPinStableFirstChannel();
        }}
        data-tooltip={suppressTooltips ? undefined : pinTooltip}
        aria-label={pinTooltip}
      >
        {pinText}
      </button>
    );
  };
  const renderChannelStatusActions = () => (
    <span style={{ display: 'inline-flex', alignItems: 'center', gap: 4 }}>
      {renderChannelStatusToggle()}
      {renderModelTestButton()}
      {renderImageUpscaleToggle()}
      {renderPinStableFirstButton()}
    </span>
  );

  useEffect(() => {
    if (!modelTestTooltip) return undefined;
    const hide = () => setModelTestTooltip(null);
    window.addEventListener('scroll', hide, true);
    window.addEventListener('resize', hide);
    return () => {
      window.removeEventListener('scroll', hide, true);
      window.removeEventListener('resize', hide);
    };
  }, [modelTestTooltip]);

  const renderModelTestTooltip = () => {
    if (!modelTestTooltip || typeof document === 'undefined') return null;
    return createPortal(
      <div
        className="token-availability-tooltip token-availability-tooltip-portal"
        style={{
          left: modelTestTooltip.left,
          top: modelTestTooltip.top,
          width: MODEL_TEST_TOOLTIP_WIDTH,
        }}
      >
        {modelTestTooltip.rows
          .filter((row) => row.value !== undefined && row.value !== null && String(row.value).trim() !== '')
	          .map((row, index) => (
	            <span key={`${row.label}-${index}`} className="token-availability-tooltip-row">
	              <span className="token-availability-tooltip-label">{row.label}</span>
	              <span
	                className={`token-availability-tooltip-value ${row.tone ? `is-${row.tone}` : ''}`.trim()}
	                style={{ color: getTooltipRowColor(row.tone) }}
	              >
	                {row.value}
	              </span>
	            </span>
	          ))}
      </div>,
      document.body,
    );
  };

  const renderDecisionFormula = (compactFormula: boolean) => {
    if (!decisionReasonText && decisionBreakdownRows.length === 0) return null;
    const visibleRows = decisionBreakdownRows;
    const hiddenCount = 0;
    const strategyLabel = decisionBreakdown?.strategy === 'stable_first'
      ? '稳定优先'
      : (decisionBreakdown?.strategy === 'round_robin' ? '轮询' : '权重计算');
    return (
      <div
        data-tooltip={decisionReasonTooltip}
        style={{
          display: 'grid',
          gridTemplateColumns: 'minmax(0, 1fr)',
          gap: 5,
          marginLeft: compactFormula ? undefined : 'auto',
          width: compactFormula ? '100%' : 'min(100%, 760px)',
          minWidth: compactFormula ? 0 : 420,
          padding: '6px 7px',
          borderRadius: 10,
          border: '1px solid color-mix(in srgb, var(--color-border-light) 88%, transparent)',
          background: 'color-mix(in srgb, var(--color-bg-card) 88%, var(--color-info-soft) 12%)',
          color: decisionState.reasonColor,
          lineHeight: 1.35,
          overflow: 'hidden',
        }}
      >
        <div style={{ display: 'flex', alignItems: 'center', gap: 6, minWidth: 0, flexWrap: 'wrap' }}>
          <span style={{ fontSize: 10.5, fontWeight: 800, color: 'var(--color-text-primary)', whiteSpace: 'nowrap' }}>
            计算公式
          </span>
          <span className="badge badge-info" style={{ fontSize: 9.5, padding: '1px 5px' }}>
            {strategyLabel}
          </span>
          {decisionBreakdown ? (
            <span style={{ fontSize: 10, color: 'var(--color-text-muted)', minWidth: 0 }}>
              概率 = {(decisionBreakdown.probability * 100).toFixed(1)}%，贡献 {decisionBreakdown.contribution.toFixed(4)} / {decisionBreakdown.totalContribution.toFixed(4)}
            </span>
          ) : null}
        </div>
        {decisionBreakdown?.formula ? (
          <div
            style={{
              fontSize: 10,
              color: 'var(--color-text-muted)',
              overflow: 'hidden',
              textOverflow: 'ellipsis',
              whiteSpace: 'nowrap',
            }}
          >
            {decisionBreakdown.formula}
          </div>
        ) : null}
        <div
          style={{
            overflowX: 'auto',
            borderRadius: 8,
            border: '1px solid color-mix(in srgb, var(--color-border-light) 74%, transparent)',
            background: 'color-mix(in srgb, var(--color-bg-card) 92%, white 8%)',
          }}
        >
          <div
            style={{
              display: 'grid',
              gridTemplateColumns: compactFormula
                ? 'minmax(70px, 0.8fr) minmax(92px, 1fr) minmax(110px, 1.1fr) minmax(72px, 0.8fr) minmax(78px, 0.8fr)'
                : 'minmax(78px, 0.8fr) minmax(110px, 1fr) minmax(180px, 1.6fr) minmax(92px, 0.8fr) minmax(110px, 0.9fr)',
              minWidth: compactFormula ? 560 : 680,
              alignItems: 'stretch',
              fontSize: 10,
            }}
          >
            {['指标', '当前值', '计算方式', '权重/乘数', '贡献'].map((label) => (
              <span
                key={label}
                style={{
                  padding: '4px 6px',
                  fontWeight: 800,
                  color: 'var(--color-text-muted)',
                  borderBottom: '1px solid color-mix(in srgb, var(--color-border-light) 74%, transparent)',
                  background: 'color-mix(in srgb, var(--color-bg-muted) 68%, transparent)',
                  whiteSpace: 'nowrap',
                }}
              >
                {label}
              </span>
            ))}
            {visibleRows.map((row, index) => {
              const rowKey = `${row.metric}-${row.value}-${index}`;
              const rowColor = getDecisionBreakdownToneColor(row.tone);
              const cellBase: CSSProperties = {
                padding: '4px 6px',
                minWidth: 0,
                borderTop: index === 0 ? 0 : '1px solid color-mix(in srgb, var(--color-border-light) 62%, transparent)',
                color: 'var(--color-text-secondary)',
                overflow: 'hidden',
                textOverflow: 'ellipsis',
                whiteSpace: 'nowrap',
              };
              const formulaCell: CSSProperties = {
                ...cellBase,
                whiteSpace: 'normal',
                overflowWrap: 'anywhere',
                lineHeight: 1.45,
              };
              return (
                <div key={rowKey} style={{ display: 'contents' }}>
                  <span style={{ ...cellBase, color: rowColor, fontWeight: 700 }}>{row.metric}</span>
                  <span style={cellBase}>{row.value}</span>
                  <span style={formulaCell}>{row.formula}</span>
                  <span style={{ ...cellBase, color: rowColor, fontVariantNumeric: 'tabular-nums' }}>{row.weight}</span>
                  <span style={{ ...cellBase, fontVariantNumeric: 'tabular-nums' }}>{row.contribution}</span>
                </div>
              );
            })}
          </div>
        </div>
        {hiddenCount > 0 ? (
          <span style={{ fontSize: 10, color: 'var(--color-text-muted)', whiteSpace: 'nowrap' }}>
            还有 {hiddenCount} 项，悬浮可查看完整原因
          </span>
        ) : null}
      </div>
    );
  };

  const [mobileDetailsOpen, setMobileDetailsOpen] = useState(false);

  if (mobile) {
    return (
      <div data-layer-root style={{ ...rowStyle, display: 'block' }}>
        <div style={{ display: 'flex', alignItems: 'flex-start', gap: 8 }}>
          <button
            type="button"
            ref={dragHandleRef}
            {...dragHandleProps}
            disabled={isSavingPriority || managementLocked}
            className="btn btn-ghost"
            style={{
              marginTop: 2,
              ...dragHandleStyle,
            }}
            data-tooltip={suppressTooltips ? undefined : (managementLocked ? '该路由当前不可编辑优先级' : '拖拽调整优先级桶')}
            aria-label="拖拽调整优先级桶"
          >
            <svg width="12" height="12" fill="currentColor" viewBox="0 0 12 12" aria-hidden>
              <circle cx="3" cy="2" r="1" />
              <circle cx="9" cy="2" r="1" />
              <circle cx="3" cy="6" r="1" />
              <circle cx="9" cy="6" r="1" />
              <circle cx="3" cy="10" r="1" />
              <circle cx="9" cy="10" r="1" />
            </svg>
          </button>

          <div style={{ display: 'flex', flexDirection: 'column', gap: 6, minWidth: 0, flex: 1 }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 7, flexWrap: 'wrap' }}>
              {showPriorityBadge ? (
                <span
                  className="badge"
                  style={{
                    fontSize: 10,
                    fontWeight: 700,
                    letterSpacing: 0.1,
                    ...getPriorityTagStyle(resolvedPriority),
                  }}
                >
                  P{resolvedPriority}
                </span>
              ) : null}

              <span style={{ fontWeight: 600, color: 'var(--color-text-primary)', fontSize: 14, minWidth: 0 }}>
                {channel.account?.username || `account-${channel.accountId}`}
              </span>

              <SiteBadge site={channel.site} />

              <span
                style={{ fontSize: 11, color: 'var(--color-text-muted)', marginLeft: 'auto' }}
                data-tooltip={costStatsTooltip}
              >
                消耗 <span style={{ color: 'var(--color-text-primary)', fontWeight: 600 }}>{formatCompactCost(actualTotalCost)}</span>
                <span style={{ color: 'var(--color-text-muted)', margin: '0 5px' }}>·</span>
                摊销/M <span style={{ color: 'var(--color-text-primary)', fontWeight: 600 }}>{formatInputCostPerMillion(inputCostPerMillion)}</span>
                <span style={{ color: 'var(--color-text-muted)', margin: '0 5px' }}>·</span>
                纯输入/M <span style={{ color: 'var(--color-text-primary)', fontWeight: 600 }}>{formatInputCostPerMillion(pureInputCostPerMillion)}</span>
                <span style={{ color: 'var(--color-text-muted)', margin: '0 5px' }}>·</span>
                成功/失败 <span style={{ color: 'var(--color-success)', fontWeight: 600 }}>{channel.successCount || 0}</span>
                <span style={{ color: 'var(--color-text-muted)', margin: '0 2px' }}>/</span>
                <span style={{ color: 'var(--color-danger)', fontWeight: 600 }}>{channel.failCount || 0}</span>
              </span>
            </div>

            <div style={{ display: 'flex', alignItems: 'center', gap: 5, flexWrap: 'wrap' }}>
              <span
                className="badge"
                style={{
                  fontSize: 10,
                  background: tokenBinding.badgeTone === 'info'
                    ? 'color-mix(in srgb, var(--color-info) 15%, transparent)'
                    : 'color-mix(in srgb, var(--color-warning) 15%, transparent)',
                  color: tokenBinding.badgeTone === 'info' ? 'var(--color-info)' : 'var(--color-warning)',
                }}
              >
                {tokenBinding.bindingModeLabel}
              </span>

              <span
                className="badge"
                style={{
                  fontSize: 10,
                  background: 'var(--color-info-soft)',
                  color: 'var(--color-info)',
                  maxWidth: 220,
                  overflow: 'hidden',
                  textOverflow: 'ellipsis',
                  whiteSpace: 'nowrap',
                }}
                data-tooltip={suppressTooltips ? undefined : `当前生效：${tokenBinding.effectiveTokenName}`}
              >
                当前生效：{tokenBinding.effectiveTokenName}
              </span>

              {channel.sourceModel ? (
                <span className="badge badge-info" style={{ fontSize: 10 }}>
                  {channel.sourceModel}
                </span>
              ) : null}

              {channel.manualOverride ? (
                <span
                  className="badge badge-warning"
                  style={{ fontSize: 10 }}
                  data-tooltip={suppressTooltips ? undefined : '该通道由用户手动添加，而非系统自动生成'}
                >
                  手动配置
                </span>
              ) : null}

              {renderChannelStatusActions()}

              {routeUnit ? (
                <>
                  <span className="badge badge-muted" style={{ fontSize: 10 }}>
                    OAuth 路由池
                  </span>
                  <span className="badge badge-info" style={{ fontSize: 10 }}>
                    {routeUnitName}
                  </span>
                  <span className="badge badge-muted" style={{ fontSize: 10 }}>
                    {routeUnit.memberCount} 成员
                  </span>
                  <span className="badge badge-muted" style={{ fontSize: 10 }}>
                    {routeUnitStrategyLabel}
                  </span>
                </>
              ) : null}
            </div>

            {routeUnitMemberSummaryText ? (
              <div style={{ display: 'flex', alignItems: 'flex-start', gap: 6, flexWrap: 'wrap' }}>
                <span style={{ fontSize: 11, color: 'var(--color-text-muted)', whiteSpace: 'nowrap' }}>
                  成员摘要（{routeUnit?.memberCount || 0} 个成员 · {routeUnitStrategyLabel}）
                </span>
                <span style={{ fontSize: 11, color: 'var(--color-text-secondary)', lineHeight: 1.45 }}>
                  {routeUnitMemberSummaryText}
                </span>
              </div>
            ) : null}

            <div style={{ display: 'flex', alignItems: 'center', gap: 6, flexWrap: 'wrap' }}>
              <span style={{ fontSize: 11, color: 'var(--color-text-muted)', whiteSpace: 'nowrap' }}>选中概率</span>
              <div style={{ display: 'inline-flex', alignItems: 'center', gap: 5, minWidth: 96 }}>
                <div
                  data-tooltip={decisionReasonTooltip}
                  style={{
                    width: 60,
                    height: 4,
                    background: 'color-mix(in srgb, var(--color-border) 88%, white 12%)',
                    borderRadius: 999,
                    overflow: 'hidden',
                  }}
                >
                  <div
                    style={{
                      width: `${Math.max(0, Math.min(100, decisionState.probability))}%`,
                      height: '100%',
                      background: getProbabilityColor(decisionState.probability),
                      borderRadius: 999,
                      transition: 'width 0.24s ease, background-color 0.18s ease',
                    }}
                  />
                </div>
                <span
                  data-tooltip={decisionReasonTooltip}
                  style={{
                    fontSize: 11,
                    color: decisionState.probability > 0 ? 'var(--color-text-secondary)' : decisionState.reasonColor,
                    fontVariantNumeric: 'tabular-nums',
                    whiteSpace: 'nowrap',
                  }}
                >
                  {decisionState.probability.toFixed(1)}%
                </span>
              </div>
              <div style={{ minWidth: 0, flexBasis: '100%' }}>
                {renderDecisionFormula(true)}
              </div>

              {!managementLocked && (
                <button
                  type="button"
                  className="btn btn-link"
                  onClick={() => setMobileDetailsOpen((current) => !current)}
                  style={{ marginLeft: 'auto' }}
                >
                  {mobileDetailsOpen ? '收起配置' : '配置通道'}
                </button>
              )}
            </div>

            {!managementLocked && mobileDetailsOpen && (
              <div style={{ display: 'flex', flexDirection: 'column', gap: 8, paddingTop: 6, borderTop: '1px solid var(--color-border-light)' }}>
                <div style={{ width: '100%' }}>
                  <ModernSelect
                    size="sm"
                    menuPlacement="inline"
                    value={String(activeTokenId || 0)}
                    onChange={(nextValue) => onTokenDraftChange(channel.id, Number.parseInt(nextValue, 10) || 0)}
                    disabled={isUpdatingToken}
                    options={[
                      {
                        value: '0',
                        label: tokenBinding.followOptionLabel,
                        description: tokenBinding.followOptionDescription,
                      },
                      ...tokenOptions.map((token) => ({
                        value: String(token.id),
                        label: buildFixedTokenOptionLabel(token, { includeDefaultTag: true }),
                        description: buildFixedTokenOptionDescription(token),
                      })),
                    ]}
                    placeholder="选择令牌绑定方式"
                  />
                  <div style={{ marginTop: 3, fontSize: 10.5, color: 'var(--color-text-muted)', lineHeight: 1.35 }}>
                    {tokenBinding.helperText}
                  </div>
                </div>

                <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'flex-end', gap: 10, flexWrap: 'wrap' }}>
                  <button
                    onClick={onSaveToken}
                    disabled={isUpdatingToken}
                    className="btn btn-link btn-link-info"
                  >
                    {isUpdatingToken ? <span className="spinner spinner-sm" /> : '保存'}
                  </button>

	                  {onSiteBlockModel && channel.site?.id ? (
                    <button
                      onClick={onSiteBlockModel}
                      className="btn btn-link btn-link-warning"
                    >
                      站点屏蔽
                    </button>
                  ) : null}

                  <button
                    onClick={onDeleteChannel}
                    className="btn btn-link btn-link-danger"
                  >
                    移除
                  </button>
                </div>
              </div>
            )}
          </div>
        </div>
        {renderModelTestTooltip()}
      </div>
    );
  }

  return (
    <div data-layer-root style={rowStyle}>
      <div style={{ display: 'flex', alignItems: 'center', flexDirection: 'row', gap: 6, fontSize: 12, flexWrap: 'wrap', minWidth: 0 }}>
        <button
          type="button"
          ref={dragHandleRef}
          {...dragHandleProps}
          disabled={isSavingPriority || managementLocked}
          className="btn btn-ghost"
          style={dragHandleStyle}
          data-tooltip={suppressTooltips ? undefined : (managementLocked ? '该路由当前不可编辑优先级' : '拖拽调整优先级桶')}
          aria-label="拖拽调整优先级桶"
        >
          <svg width="12" height="12" fill="currentColor" viewBox="0 0 12 12" aria-hidden>
            <circle cx="3" cy="2" r="1" />
            <circle cx="9" cy="2" r="1" />
            <circle cx="3" cy="6" r="1" />
            <circle cx="9" cy="6" r="1" />
            <circle cx="3" cy="10" r="1" />
            <circle cx="9" cy="10" r="1" />
          </svg>
        </button>

        {showPriorityBadge ? (
          <span
            className="badge"
            style={{
              fontSize: 10,
              fontWeight: 700,
              letterSpacing: 0.1,
              ...getPriorityTagStyle(resolvedPriority),
            }}
          >
            P{resolvedPriority}
          </span>
        ) : null}

        <span style={{ fontWeight: 600, color: 'var(--color-text-primary)' }}>
          {channel.account?.username || `account-${channel.accountId}`}
        </span>

        <SiteBadge site={channel.site} />

        <span
          className="badge"
          style={{
            fontSize: 10,
            background: tokenBinding.badgeTone === 'info'
              ? 'color-mix(in srgb, var(--color-info) 15%, transparent)'
              : 'color-mix(in srgb, var(--color-warning) 15%, transparent)',
            color: tokenBinding.badgeTone === 'info' ? 'var(--color-info)' : 'var(--color-warning)',
          }}
        >
          {tokenBinding.bindingModeLabel}
        </span>

        <span
          className="badge"
          style={{
            fontSize: 10,
            background: 'var(--color-info-soft)',
            color: 'var(--color-info)',
            maxWidth: 220,
            overflow: 'hidden',
            textOverflow: 'ellipsis',
            whiteSpace: 'nowrap',
          }}
          data-tooltip={suppressTooltips ? undefined : `当前生效：${tokenBinding.effectiveTokenName}`}
        >
          当前生效：{tokenBinding.effectiveTokenName}
        </span>

        {channel.sourceModel ? (
          <span className="badge badge-info" style={{ fontSize: 10 }}>
            {channel.sourceModel}
          </span>
        ) : null}

        {channel.manualOverride ? (
          <span
            className="badge badge-warning"
            style={{ fontSize: 10 }}
            data-tooltip={suppressTooltips ? undefined : '该通道由用户手动添加，而非系统自动生成'}
          >
            手动配置
          </span>
        ) : null}

        {renderChannelStatusActions()}

        {routeUnit ? (
          <>
            <span className="badge badge-muted" style={{ fontSize: 10 }}>
              OAuth 路由池
            </span>
            <span className="badge badge-info" style={{ fontSize: 10 }}>
              {routeUnitName}
            </span>
            <span className="badge badge-muted" style={{ fontSize: 10 }}>
              {routeUnit.memberCount} 成员
            </span>
            <span className="badge badge-muted" style={{ fontSize: 10 }}>
              {routeUnitStrategyLabel}
            </span>
          </>
        ) : null}

        {routeUnitMemberSummaryText ? (
          <div style={{ display: 'flex', alignItems: 'flex-start', gap: 6, width: '100%', flexWrap: 'wrap' }}>
            <span style={{ fontSize: 11, color: 'var(--color-text-muted)', whiteSpace: 'nowrap' }}>
              成员摘要（{routeUnit?.memberCount || 0} 个成员 · {routeUnitStrategyLabel}）
            </span>
            <span style={{ fontSize: 11, color: 'var(--color-text-secondary)', lineHeight: 1.45 }}>
              {routeUnitMemberSummaryText}
            </span>
          </div>
        ) : null}

        <div style={{ display: 'flex', alignItems: 'center', gap: 6, width: '100%', marginTop: mobile ? 0 : 1, flexWrap: 'wrap' }}>
          <span style={{ fontSize: 11, color: 'var(--color-text-muted)', whiteSpace: 'nowrap' }}>选中概率</span>
          <div style={{ display: 'inline-flex', alignItems: 'center', gap: 5, minWidth: 96 }}>
            <div
              data-tooltip={decisionReasonTooltip}
              style={{
                width: 60,
                height: 4,
                background: 'color-mix(in srgb, var(--color-border) 88%, white 12%)',
                borderRadius: 999,
                overflow: 'hidden',
              }}
            >
              <div
                style={{
                  width: `${Math.max(0, Math.min(100, decisionState.probability))}%`,
                  height: '100%',
                  background: getProbabilityColor(decisionState.probability),
                  borderRadius: 999,
                  transition: 'width 0.24s ease, background-color 0.18s ease',
                }}
              />
            </div>
            <span
              data-tooltip={decisionReasonTooltip}
              style={{
                fontSize: 11,
                color: decisionState.probability > 0 ? 'var(--color-text-secondary)' : decisionState.reasonColor,
                fontVariantNumeric: 'tabular-nums',
                whiteSpace: 'nowrap',
              }}
            >
              {decisionState.probability.toFixed(1)}%
            </span>
          </div>
          {renderDecisionFormula(false)}

          <span
            style={{ fontSize: 11, color: 'var(--color-text-muted)' }}
            data-tooltip={costStatsTooltip}
          >
            消耗
          </span>
          <span style={{ fontSize: 11, color: 'var(--color-text-primary)', fontWeight: 600 }}>
            {formatCompactCost(actualTotalCost)}
          </span>
          <span
            style={{ fontSize: 11, color: 'var(--color-text-muted)' }}
            data-tooltip={costStatsTooltip}
          >
            摊销/M
          </span>
          <span style={{ fontSize: 11, color: 'var(--color-text-primary)', fontWeight: 600 }}>
            {formatInputCostPerMillion(inputCostPerMillion)}
          </span>
          <span
            style={{ fontSize: 11, color: 'var(--color-text-muted)' }}
            data-tooltip={costStatsTooltip}
          >
            纯输入/M
          </span>
          <span style={{ fontSize: 11, color: 'var(--color-text-primary)', fontWeight: 600 }}>
            {formatInputCostPerMillion(pureInputCostPerMillion)}
          </span>
          <span style={{ fontSize: 11, color: 'var(--color-text-muted)' }}>成功/失败</span>
          <span style={{ fontSize: 11 }}>
            <span style={{ color: 'var(--color-success)', fontWeight: 600 }}>{channel.successCount || 0}</span>
            <span style={{ color: 'var(--color-text-muted)', margin: '0 2px' }}>/</span>
            <span style={{ color: 'var(--color-danger)', fontWeight: 600 }}>{channel.failCount || 0}</span>
          </span>
        </div>
      </div>

      {!managementLocked ? (
        <div
          data-channel-config-row
          style={{
            display: 'grid',
            gridTemplateColumns: 'minmax(240px, 1fr) auto auto',
            alignItems: 'start',
            gap: 8,
            width: '100%',
            paddingTop: 6,
            borderTop: '1px solid color-mix(in srgb, var(--color-border-light) 82%, transparent)',
          }}
        >
          <div style={{ minWidth: 0 }}>
            <ModernSelect
              size="sm"
              menuPlacement="inline"
              value={String(activeTokenId || 0)}
              onChange={(nextValue) => onTokenDraftChange(channel.id, Number.parseInt(nextValue, 10) || 0)}
              disabled={isUpdatingToken}
              options={[
                {
                  value: '0',
                  label: tokenBinding.followOptionLabel,
                  description: tokenBinding.followOptionDescription,
                },
                ...tokenOptions.map((token) => ({
                  value: String(token.id),
                  label: buildFixedTokenOptionLabel(token, { includeDefaultTag: true }),
                  description: buildFixedTokenOptionDescription(token),
                })),
              ]}
              placeholder="选择令牌绑定方式"
            />
            <div style={{ marginTop: 3, fontSize: 10.5, color: 'var(--color-text-muted)', lineHeight: 1.35 }}>
              {tokenBinding.helperText}
            </div>
          </div>

          <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'flex-end', gap: 6, flexWrap: 'wrap', minHeight: 32 }}>
            <button
              onClick={onSaveToken}
              disabled={isUpdatingToken}
              className="btn btn-link btn-link-info"
            >
              {isUpdatingToken ? <span className="spinner spinner-sm" /> : '保存'}
            </button>

	          </div>

          <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'flex-end', gap: 3, flexWrap: 'wrap', minHeight: 32 }}>
            {onSiteBlockModel && channel.site?.id ? (
              <button
                onClick={onSiteBlockModel}
                className="btn btn-link btn-link-warning"
                data-tooltip={suppressTooltips ? undefined : `将此模型加入站点「${channel.site?.name || '未知'}」的禁用列表，rebuild 后该站点的此模型通道将不再生成`}
              >
                站点屏蔽
              </button>
            ) : null}

            <button
              onClick={onDeleteChannel}
              className="btn btn-link btn-link-danger"
            >
              移除
            </button>
          </div>
        </div>
      ) : null}
      {renderModelTestTooltip()}
    </div>
  );
}
