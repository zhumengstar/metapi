import { describe, expect, it } from 'vitest';
import {
  buildModelAvailabilityTooltipRows,
  normalizeModelAvailabilityApiPayload,
} from './modelAvailabilityPresentation.js';

describe('modelAvailabilityPresentation', () => {
  it('normalizes route and token model-test payload shapes consistently', () => {
    const result = {
      tokenId: 12,
      model: 'gpt-5.5',
      available: true,
      message: '请求成功',
      responseText: '我是 gpt-5.5',
      httpStatus: 200,
      latencyMs: 321,
      checkedAt: '2026-06-23T01:00:00.000Z',
    };

    expect(normalizeModelAvailabilityApiPayload({ result }, 'fallback')).toEqual(result);
    expect(normalizeModelAvailabilityApiPayload({ model: 'gpt-5.5', results: [result] }, 'fallback')).toEqual(result);
    expect(normalizeModelAvailabilityApiPayload({ result: { model: 'gpt-5.5', results: [result] } }, 'fallback')).toEqual(result);
  });

  it('builds the same tooltip rows for unavailable image-only test results', () => {
    const rows = buildModelAvailabilityTooltipRows('gpt-image-2', {
      tokenId: 12,
      model: 'gpt-image-2',
      available: false,
      message: '图片模型不进行聊天可用性测试',
      responseText: null,
      httpStatus: null,
      latencyMs: null,
      checkedAt: '2026-06-23T01:00:00.000Z',
    });

    expect(rows.slice(0, 3)).toMatchObject([
      { label: '模型', value: 'gpt-image-2' },
      { label: '结果', value: '未测试：仅图片模型', tone: 'warning' },
      { label: '说明', value: '图片模型不进行聊天可用性测试', tone: 'warning' },
    ]);
    expect(rows.find((row) => row.label === '耗时')?.value).toBe('');
  });
});
