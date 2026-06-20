import { beforeEach, describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';

const { fetchMock, withSiteProxyRequestInitMock } = vi.hoisted(() => ({
  fetchMock: vi.fn(),
  withSiteProxyRequestInitMock: vi.fn(),
}));

const ANYROUTER_CHALLENGE_HTML = readFileSync(
  new URL('./platforms/__fixtures__/anyrouter-challenge.html', import.meta.url),
  'utf8',
);
const ANYROUTER_CHALLENGE_ACW = '699dbedad126579b6bc0ebb91eaae8d7af3548b5';

vi.mock('undici', () => ({
  fetch: (...args: unknown[]) => fetchMock(...args),
}));

vi.mock('./siteProxy.js', () => ({
  withSiteProxyRequestInit: (...args: unknown[]) => withSiteProxyRequestInitMock(...args),
}));

import { fetchModelPricingCatalog } from './modelPricingService.js';

describe('modelPricingService anyrouter pricing', () => {
  beforeEach(() => {
    fetchMock.mockReset();
    withSiteProxyRequestInitMock.mockReset();
    withSiteProxyRequestInitMock.mockImplementation(async (_url: string, init: Record<string, unknown>) => init);
  });

  it('reuses anyrouter shield challenge flow when fetching pricing', async () => {
    fetchMock
      .mockResolvedValueOnce(new Response(ANYROUTER_CHALLENGE_HTML, {
        status: 200,
        headers: {
          'content-type': 'text/html; charset=utf-8',
          'set-cookie': 'cdn_sec_tc=challenge-seed; Path=/; HttpOnly',
        },
      }))
      .mockResolvedValueOnce(new Response(JSON.stringify({
        data: [{
          model_name: 'claude-haiku-4-5-20251001',
          quota_type: 0,
          model_ratio: 2.5,
          completion_ratio: 5,
          cache_ratio: 0.1,
          create_cache_ratio: 1.25,
          enable_groups: ['default'],
        }],
        group_ratio: { default: 1 },
      }), {
        status: 200,
        headers: { 'content-type': 'application/json; charset=utf-8' },
      }));

    const catalog = await fetchModelPricingCatalog({
      site: {
        id: 902,
        url: 'https://anyrouter.example.com',
        platform: 'anyrouter',
      },
      account: {
        id: 77,
        accessToken: 'challenge-seed',
      },
      modelName: 'claude-haiku-4-5-20251001',
      totalTokens: 0,
    });

    expect(catalog?.models[0]?.groupPricing?.default).toMatchObject({
      inputPerMillion: 5,
      outputPerMillion: 25,
      cacheReadPerMillion: 0.5,
      cacheCreationPerMillion: 6.25,
    });
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(fetchMock.mock.calls[1][1]?.headers?.Cookie || '').toContain('session=challenge-seed');
    expect(fetchMock.mock.calls[1][1]?.headers?.Cookie || '').toContain('cdn_sec_tc=challenge-seed');
    expect(fetchMock.mock.calls[1][1]?.headers?.Cookie || '').toContain(`acw_sc__v2=${ANYROUTER_CHALLENGE_ACW}`);
  });

  it('parses one-hub numeric group ratios without defaulting them to one', async () => {
    const availableResponse = () => new Response(JSON.stringify({
      data: {
        'gpt-test': {
          price: { type: 'tokens', input: 1, output: 2 },
          groups: ['vip'],
        },
      },
    }), {
      status: 200,
      headers: { 'content-type': 'application/json; charset=utf-8' },
    });
    const groupResponse = () => new Response(JSON.stringify({
      data: {
        default: 1,
        vip: 2.5,
      },
    }), {
      status: 200,
      headers: { 'content-type': 'application/json; charset=utf-8' },
    });
    fetchMock
      .mockResolvedValueOnce(availableResponse())
      .mockResolvedValueOnce(groupResponse())
      .mockResolvedValueOnce(availableResponse())
      .mockResolvedValueOnce(groupResponse());

    const catalog = await fetchModelPricingCatalog({
      site: {
        id: 903,
        url: 'https://one-hub.example.com',
        platform: 'done-hub',
      },
      account: {
        id: 78,
        accessToken: 'access-token',
      },
      modelName: 'gpt-test',
      totalTokens: 0,
    });

    expect(catalog?.groupRatio).toMatchObject({
      default: 1,
      vip: 2.5,
    });
    expect(catalog?.models[0]?.groupPricing?.vip).toMatchObject({
      inputPerMillion: 5,
      outputPerMillion: 10,
    });
  });
});
