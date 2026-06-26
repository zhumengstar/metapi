import { beforeEach, describe, expect, it, vi } from 'vitest';

const { fetchMock, withSiteProxyRequestInitMock } = vi.hoisted(() => ({
  fetchMock: vi.fn(),
  withSiteProxyRequestInitMock: vi.fn(),
}));

vi.mock('undici', () => ({
  fetch: (...args: unknown[]) => fetchMock(...args),
}));

vi.mock('./siteProxy.js', () => ({
  withSiteProxyRequestInit: (...args: unknown[]) => withSiteProxyRequestInitMock(...args),
}));

import { fetchModelPricingCatalog } from './modelPricingService.js';

describe('modelPricingService sub2api pricing groups', () => {
  beforeEach(() => {
    fetchMock.mockReset();
    withSiteProxyRequestInitMock.mockReset();
    withSiteProxyRequestInitMock.mockImplementation(async (_url: string, init: Record<string, unknown>) => init);
  });

  it('maps numeric sub2api pricing groups to Chinese group names', async () => {
    fetchMock
      .mockResolvedValueOnce(new Response(JSON.stringify({
        data: [{
          model_name: 'gpt-image-1',
          quota_type: 0,
          model_ratio: 1,
          completion_ratio: 1,
          enable_groups: ['1', '8'],
        }],
        group_ratio: {
          '1': 0.12,
          '8': 0.25,
        },
      }), {
        status: 200,
        headers: { 'content-type': 'application/json; charset=utf-8' },
      }))
      .mockResolvedValueOnce(new Response(JSON.stringify({
        data: [
          { id: 1, name: '生图（1k）' },
          { id: 8, name: '生图（2k4k）' },
        ],
      }), {
        status: 200,
        headers: { 'content-type': 'application/json; charset=utf-8' },
      }));

    const catalog = await fetchModelPricingCatalog({
      site: {
        id: 9201,
        url: 'https://sub2api.example.com',
        platform: 'sub2api',
      },
      account: {
        id: 82,
        accessToken: 'access-token',
      },
      modelName: 'gpt-image-1',
      totalTokens: 0,
    });

    expect(catalog?.groupRatio).toEqual({
      '1': 0.12,
      '8': 0.25,
      '生图（1k）': 0.12,
      '生图（2k4k）': 0.25,
      default: 1,
    });
    expect(catalog?.models[0]?.enableGroups).toEqual(['1', '生图（1k）', '8', '生图（2k4k）']);
    expect(Object.keys(catalog?.models[0]?.groupPricing || {})).toEqual([
      '1',
      '8',
      '生图（1k）',
      '生图（2k4k）',
      'default',
    ]);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(String(fetchMock.mock.calls[1][0])).toBe('https://sub2api.example.com/api/v1/groups/available');
  });

  it('loads sub2api group ratios from available groups when pricing endpoint is unavailable', async () => {
    fetchMock
      .mockResolvedValueOnce(new Response('not found', {
        status: 404,
        headers: { 'content-type': 'text/plain; charset=utf-8' },
      }))
      .mockResolvedValueOnce(new Response(JSON.stringify({
        code: 0,
        message: 'success',
        data: [
          { id: 2, name: '纯pro通道-VIP-超稳定-专用通道', rate_multiplier: 0.2 },
          { id: 3, name: '纯PLUS通道-稳定', rate_multiplier: 0.12 },
          { id: 4, name: 'team渠道-特价组-杀号太厉害 暂停', rate_multiplier: 0.075 },
        ],
      }), {
        status: 200,
        headers: { 'content-type': 'application/json; charset=utf-8' },
      }));

    const catalog = await fetchModelPricingCatalog({
      site: {
        id: 9203,
        url: 'https://sub2api.example.com',
        platform: 'sub2api',
      },
      account: {
        id: 84,
        accessToken: 'access-token',
      },
      modelName: 'gpt-5.2-codex',
      totalTokens: 0,
    });

    expect(catalog?.models).toEqual([]);
    expect(catalog?.groupRatio).toEqual({
      '纯pro通道-VIP-超稳定-专用通道': 0.2,
      '纯PLUS通道-稳定': 0.12,
      'team渠道-特价组-杀号太厉害 暂停': 0.075,
      default: 1,
    });
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(String(fetchMock.mock.calls[0][0])).toBe('https://sub2api.example.com/api/pricing');
    expect(String(fetchMock.mock.calls[1][0])).toBe('https://sub2api.example.com/api/v1/groups/available');
  });

  it('matches pricing groups with normalized punctuation and spacing', async () => {
    fetchMock.mockResolvedValueOnce(new Response(JSON.stringify({
      data: [{
        model_name: 'gpt-5.2-codex',
        quota_type: 0,
        model_ratio: 1,
        completion_ratio: 1,
        enable_groups: ['标准ChatGPT-Codex通道'],
      }],
      group_ratio: {
        '标准 ChatGPT-Codex 通道': 0.5,
      },
    }), {
      status: 200,
      headers: { 'content-type': 'application/json; charset=utf-8' },
    }));

    const catalog = await fetchModelPricingCatalog({
      site: {
        id: 9202,
        url: 'https://new-api.example.com',
        platform: 'new-api',
      },
      account: {
        id: 83,
        accessToken: 'access-token',
      },
      modelName: 'gpt-5.2-codex',
      totalTokens: 0,
    });

    expect(Object.keys(catalog?.models[0]?.groupPricing || {})).toEqual([
      '标准 ChatGPT-Codex 通道',
      'default',
    ]);
    expect(catalog?.models[0]?.groupPricing['标准 ChatGPT-Codex 通道']).toMatchObject({
      inputPerMillion: 1,
      outputPerMillion: 1,
    });
  });
});
