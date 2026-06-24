import { formatDateTimeLocal } from './checkinLogTime.js';

export type ModelAvailabilityResult = {
  tokenId?: number | null;
  model: string;
  available: boolean;
  message?: string | null;
  responseText?: string | null;
  httpStatus?: number | null;
  latencyMs?: number | null;
  checkedAt?: string | null;
};

export type ModelAvailabilityTooltipRow = {
  label: string;
  value?: string | number | null;
  tone?: 'success' | 'error' | 'warning' | 'muted';
};

const IMAGE_ONLY_SKIPPED_MESSAGES = [
  '只有图片模型，未进行聊天可用性测试',
  '图片模型不进行聊天可用性测试',
];

function hasOwnResultShape(value: any): boolean {
  return value && typeof value === 'object' && (
    'available' in value
    || 'model' in value
    || 'modelName' in value
    || 'message' in value
    || 'responseText' in value
    || 'httpStatus' in value
  );
}

export function isImageOnlySkippedAvailabilityResult(
  result: ModelAvailabilityResult | null | undefined,
): boolean {
  if (result?.available) return false;
  const message = String(result?.message || '').trim();
  return IMAGE_ONLY_SKIPPED_MESSAGES.some((item) => message === item || message.includes(item));
}

export function normalizeModelAvailabilityResult(
  raw: any,
  fallbackModel: string,
  fallbackTokenId?: number | null,
): ModelAvailabilityResult | null {
  if (!raw || typeof raw !== 'object') return null;
  const tokenId = raw.tokenId == null
    ? (fallbackTokenId ?? null)
    : Number(raw.tokenId);
  const model = String(raw.model || raw.modelName || fallbackModel || '').trim();
  const checkedAt = raw.checkedAt || raw.updatedAt || new Date().toISOString();
  return {
    tokenId: Number.isInteger(tokenId) && Number(tokenId) > 0 ? Number(tokenId) : null,
    model,
    available: raw.available === true,
    message: String(raw.message || '').trim() || (raw.available === true ? '请求成功' : '最近测试不可用'),
    responseText: raw.responseText ?? null,
    httpStatus: raw.httpStatus ?? null,
    latencyMs: raw.latencyMs ?? null,
    checkedAt,
  };
}

export function normalizeModelAvailabilityApiPayload(
  payload: any,
  fallbackModel: string,
  fallbackTokenId?: number | null,
): ModelAvailabilityResult | null {
  const candidates = [
    Array.isArray(payload?.results) ? payload.results[0] : null,
    Array.isArray(payload?.result?.results) ? payload.result.results[0] : null,
    hasOwnResultShape(payload?.result) ? payload.result : null,
    hasOwnResultShape(payload) ? payload : null,
  ];
  for (const candidate of candidates) {
    const normalized = normalizeModelAvailabilityResult(candidate, fallbackModel, fallbackTokenId);
    if (normalized) return normalized;
  }
  return null;
}

export function buildMissingModelAvailabilityResult(
  model: string,
  message = '测试接口没有返回结果',
  tokenId: number | null = null,
): ModelAvailabilityResult {
  return {
    tokenId,
    model,
    available: false,
    message,
    responseText: null,
    httpStatus: null,
    latencyMs: null,
    checkedAt: new Date().toISOString(),
  };
}

export function buildModelAvailabilityTooltipRows(
  modelName: string,
  result: ModelAvailabilityResult | null | undefined,
): ModelAvailabilityTooltipRow[] {
  if (!result) {
    return [
      { label: '模型', value: modelName || '-', tone: 'muted' },
      { label: '结果', value: '未测试', tone: 'muted' },
    ];
  }

  const imageOnlySkipped = isImageOnlySkippedAvailabilityResult(result);
  const checkedAt = result.checkedAt ? formatDateTimeLocal(result.checkedAt) : '';
  return [
    { label: '模型', value: result.model || modelName || '-' },
    {
      label: '结果',
      value: result.available ? '可用' : (imageOnlySkipped ? '未测试：仅图片模型' : '不可用'),
      tone: result.available ? 'success' : (imageOnlySkipped ? 'warning' : 'error'),
    },
    { label: '说明', value: result.available || imageOnlySkipped ? result.message : '', tone: imageOnlySkipped ? 'warning' : undefined },
    { label: '上游报错', value: result.available || imageOnlySkipped ? '' : result.message, tone: 'error' },
    { label: '模型答复', value: result.responseText || '' },
    { label: 'HTTP', value: result.httpStatus == null ? '' : result.httpStatus },
    {
      label: '耗时',
      value: result.latencyMs != null && Number.isFinite(Number(result.latencyMs))
        ? `${result.latencyMs}ms`
        : '',
    },
    { label: '检测时间', value: checkedAt },
  ];
}
