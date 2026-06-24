import Fastify, { type FastifyInstance } from 'fastify';
import sharp from 'sharp';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

const fetchMock = vi.fn();
const selectChannelMock = vi.fn();
const selectNextChannelMock = vi.fn();
const selectPreferredChannelMock = vi.fn();
const recordSuccessMock = vi.fn();
const recordFailureMock = vi.fn();
const refreshModelsAndRebuildRoutesMock = vi.fn();
const reportProxyAllFailedMock = vi.fn();
const reportTokenExpiredMock = vi.fn();
const estimateProxyCostMock = vi.fn(async () => 0);
const dbInsertMock = vi.fn((_arg?: any) => ({
  values: () => ({
    run: () => undefined,
  }),
}));

vi.mock('undici', async () => {
  const actual = await vi.importActual<typeof import('undici')>('undici');
  return {
    ...actual,
    fetch: (...args: unknown[]) => fetchMock(...args),
  };
});

vi.mock('../../services/tokenRouter.js', () => ({
  tokenRouter: {
    selectChannel: (...args: unknown[]) => selectChannelMock(...args),
    selectNextChannel: (...args: unknown[]) => selectNextChannelMock(...args),
    selectPreferredChannel: (...args: unknown[]) => selectPreferredChannelMock(...args),
    recordSuccess: (...args: unknown[]) => recordSuccessMock(...args),
    recordFailure: (...args: unknown[]) => recordFailureMock(...args),
  },
}));

vi.mock('../../services/modelService.js', () => ({
  refreshModelsAndRebuildRoutes: (...args: unknown[]) => refreshModelsAndRebuildRoutesMock(...args),
}));

vi.mock('../../services/alertService.js', () => ({
  reportProxyAllFailed: (...args: unknown[]) => reportProxyAllFailedMock(...args),
  reportTokenExpired: (...args: unknown[]) => reportTokenExpiredMock(...args),
}));

vi.mock('../../services/alertRules.js', () => ({
  isTokenExpiredError: () => false,
}));

vi.mock('../../services/modelPricingService.js', () => ({
  estimateProxyCost: (arg: any) => estimateProxyCostMock(arg),
}));

vi.mock('../../services/proxyRetryPolicy.js', () => ({
  shouldRetryProxyRequest: () => false,
  shouldAbortSameSiteEndpointFallback: () => false,
  RETRYABLE_TIMEOUT_PATTERNS: [/(request timed out|connection timed out|read timeout|\btimed out\b)/i],
}));

vi.mock('../../db/index.js', () => ({
  db: {
    insert: (arg: any) => dbInsertMock(arg),
    select: () => ({
      from: () => ({
        where: () => ({
          orderBy: () => ({
            all: async () => [],
          }),
        }),
      }),
    }),
    update: () => ({
      set: () => ({
        where: () => ({
          run: async () => undefined,
        }),
      }),
    }),
  },
  hasProxyLogBillingDetailsColumn: async () => false,
  hasProxyLogClientColumns: async () => false,
  hasProxyLogDownstreamApiKeyIdColumn: async () => false,
  hasProxyLogStreamTimingColumns: async () => false,
  schema: {
    proxyLogs: {},
    siteApiEndpoints: {
      id: {},
      siteId: {},
      sortOrder: {},
    },
  },
}));

function buildMultipartBody(boundary: string) {
  return Buffer.from(
    `--${boundary}\r\n`
      + `Content-Disposition: form-data; name="model"\r\n\r\n`
      + `gpt-image-1\r\n`
      + `--${boundary}\r\n`
      + `Content-Disposition: form-data; name="prompt"\r\n\r\n`
      + `edit this\r\n`
      + `--${boundary}\r\n`
      + `Content-Disposition: form-data; name="image"; filename="cat.png"\r\n`
      + `Content-Type: image/png\r\n\r\n`
      + `pngdata\r\n`
      + `--${boundary}--\r\n`,
  );
}

describe('/v1/images/edits route', () => {
  let app: FastifyInstance;

  beforeAll(async () => {
    const { imagesProxyRoute } = await import('./images.js');
    app = Fastify();
    await app.register(imagesProxyRoute);
  });

  beforeEach(() => {
    fetchMock.mockReset();
    selectChannelMock.mockReset();
    selectNextChannelMock.mockReset();
    selectPreferredChannelMock.mockReset();
    recordSuccessMock.mockReset();
    recordFailureMock.mockReset();
    refreshModelsAndRebuildRoutesMock.mockReset();
    reportProxyAllFailedMock.mockReset();
    reportTokenExpiredMock.mockReset();
    estimateProxyCostMock.mockClear();
    dbInsertMock.mockClear();

    selectChannelMock.mockReturnValue({
      channel: { id: 11, routeId: 22 },
      site: { id: 44, name: 'demo-site', url: 'https://upstream.example.com', platform: 'openai' },
      account: { id: 33, username: 'demo-user' },
      tokenName: 'default',
      tokenValue: 'sk-demo',
      actualModel: 'upstream-gpt-image',
    });
    selectNextChannelMock.mockReturnValue(null);
    selectPreferredChannelMock.mockReturnValue(null);
  });

  afterAll(async () => {
    if (app) {
      await app.close();
    }
  });

  it('accepts multipart image edit requests and forwards them to /v1/images/edits', async () => {
    fetchMock.mockResolvedValue(new Response(JSON.stringify({
      created: 1,
      data: [{ b64_json: 'iVBORw0KGgo=' }],
    }), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    }));

    const boundary = 'metapi-boundary';
    const response = await app.inject({
      method: 'POST',
      url: '/v1/images/edits',
      headers: {
        authorization: 'Bearer sk-demo',
        'content-type': `multipart/form-data; boundary=${boundary}`,
      },
      payload: buildMultipartBody(boundary),
    });

    expect(response.statusCode).toBe(200);
    const [targetUrl] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(targetUrl).toBe('https://upstream.example.com/v1/images/edits');
  });

  it('retries the next channel when image generation JSON is malformed', async () => {
    selectNextChannelMock.mockReturnValueOnce({
      channel: { id: 12, routeId: 23 },
      site: { id: 45, name: 'fallback-site', url: 'https://fallback.example.com', platform: 'openai' },
      account: { id: 34, username: 'fallback-user' },
      tokenName: 'fallback',
      tokenValue: 'sk-fallback',
      actualModel: 'fallback-gpt-image',
    });
    fetchMock
      .mockResolvedValueOnce(new Response('not-json', {
        status: 200,
        headers: { 'content-type': 'application/json' },
      }))
      .mockResolvedValueOnce(new Response(JSON.stringify({
        created: 2,
        data: [{ b64_json: 'ZmFsbGJhY2s=' }],
      }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      }));

    const response = await app.inject({
      method: 'POST',
      url: '/v1/images/generations',
      headers: {
        authorization: 'Bearer sk-demo',
      },
      payload: {
        model: 'gpt-image-1',
        prompt: 'draw a cat',
      },
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({
      created: 2,
      data: [{ b64_json: 'ZmFsbGJhY2s=' }],
    });
    expect(selectNextChannelMock).toHaveBeenCalledTimes(1);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('routes Antigravity image generation through internal Gemini runtime and returns OpenAI image data', async () => {
    selectChannelMock.mockReturnValue({
      channel: { id: 41, routeId: 22 },
      site: {
        id: 79,
        name: 'antigravity-site',
        url: 'https://cloudcode-pa.googleapis.com',
        platform: 'antigravity',
      },
      account: {
        id: 39,
        username: 'antigravity-user@example.com',
        extraConfig: JSON.stringify({
          oauth: {
            provider: 'antigravity',
            email: 'antigravity-user@example.com',
            projectId: 'project-demo',
          },
        }),
      },
      tokenName: 'default',
      tokenValue: 'antigravity-access-token',
      actualModel: 'gemini-3.1-flash-image',
    });
    fetchMock.mockResolvedValue(new Response([
      'data: {"response":{"candidates":[{"content":{"role":"model","parts":[{"inlineData":{"mimeType":"image/png","data":"aW1hZ2U="}}]},"finishReason":"STOP","index":0}]}}',
      '',
      'data: [DONE]',
      '',
    ].join('\n'), {
      status: 200,
      headers: { 'content-type': 'text/event-stream; charset=utf-8' },
    }));

    const response = await app.inject({
      method: 'POST',
      url: '/v1/images/generations',
      headers: {
        authorization: 'Bearer sk-demo',
      },
      payload: {
        model: 'gemini-3.1-flash-image',
        prompt: 'a small cat',
        size: '1024x1024',
      },
    });

    expect(response.statusCode).toBe(200);
    const [targetUrl, requestInit] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(targetUrl).toBe('https://daily-cloudcode-pa.googleapis.com/v1internal:streamGenerateContent?alt=sse');
    expect(JSON.parse(String(requestInit.body))).toMatchObject({
      model: 'gemini-3.1-flash-image',
      requestType: 'image_gen',
      contents: [
        {
          role: 'user',
          parts: [{ text: 'a small cat' }],
        },
      ],
      generationConfig: {
        responseModalities: ['TEXT', 'IMAGE'],
        imageConfig: { aspectRatio: '1:1' },
      },
    });
    expect(JSON.parse(response.body)).toMatchObject({
      data: [
        {
          b64_json: 'aW1hZ2U=',
          mime_type: 'image/png',
        },
      ],
    });
  });

  it('routes Antigravity image edits through internal Gemini runtime with inline image data', async () => {
    selectChannelMock.mockReturnValue({
      channel: { id: 42, routeId: 22 },
      site: {
        id: 79,
        name: 'antigravity-site',
        url: 'https://cloudcode-pa.googleapis.com',
        platform: 'antigravity',
      },
      account: {
        id: 39,
        username: 'antigravity-user@example.com',
        extraConfig: JSON.stringify({
          oauth: {
            provider: 'antigravity',
            email: 'antigravity-user@example.com',
            projectId: 'project-demo',
          },
        }),
      },
      tokenName: 'default',
      tokenValue: 'antigravity-access-token',
      actualModel: 'gemini-3.1-flash-image',
    });
    fetchMock.mockResolvedValue(new Response([
      'data: {"response":{"candidates":[{"content":{"role":"model","parts":[{"inlineData":{"mimeType":"image/png","data":"ZWRpdGVk"}}]},"finishReason":"STOP","index":0}]}}',
      '',
      'data: [DONE]',
      '',
    ].join('\n'), {
      status: 200,
      headers: { 'content-type': 'text/event-stream; charset=utf-8' },
    }));

    const boundary = 'metapi-gemini-edit-boundary';
    const response = await app.inject({
      method: 'POST',
      url: '/v1/images/edits',
      headers: {
        authorization: 'Bearer sk-demo',
        'content-type': `multipart/form-data; boundary=${boundary}`,
      },
      payload: buildMultipartBody(boundary),
    });

    expect(response.statusCode).toBe(200);
    const [targetUrl, requestInit] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(targetUrl).toBe('https://daily-cloudcode-pa.googleapis.com/v1internal:streamGenerateContent?alt=sse');
    expect(JSON.parse(String(requestInit.body))).toMatchObject({
      model: 'gemini-3.1-flash-image',
      requestType: 'image_gen',
      contents: [
        {
          role: 'user',
          parts: [
            { text: 'edit this' },
            { inlineData: { mimeType: 'image/png', data: Buffer.from('pngdata').toString('base64') } },
          ],
        },
      ],
      generationConfig: {
        responseModalities: ['TEXT', 'IMAGE'],
        imageConfig: { aspectRatio: '1:1' },
      },
    });
    expect(response.json()).toMatchObject({
      data: [
        {
          b64_json: 'ZWRpdGVk',
          mime_type: 'image/png',
        },
      ],
    });
  });

  it('passes Gemini native 4K image size for image generation requests', async () => {
    selectChannelMock.mockReturnValue({
      channel: { id: 43, routeId: 22 },
      site: {
        id: 79,
        name: 'antigravity-site',
        url: 'https://cloudcode-pa.googleapis.com',
        platform: 'antigravity',
      },
      account: {
        id: 39,
        username: 'antigravity-user@example.com',
        extraConfig: JSON.stringify({ oauth: { provider: 'antigravity', projectId: 'project-demo' } }),
      },
      tokenName: 'default',
      tokenValue: 'antigravity-access-token',
      actualModel: 'gemini-3.1-flash-image',
    });
    fetchMock.mockResolvedValue(new Response([
      'data: {"response":{"candidates":[{"content":{"role":"model","parts":[{"inlineData":{"mimeType":"image/png","data":"aW1hZ2U="}}]},"finishReason":"STOP","index":0}]}}',
      '',
      'data: [DONE]',
      '',
    ].join('\n'), {
      status: 200,
      headers: { 'content-type': 'text/event-stream; charset=utf-8' },
    }));

    const response = await app.inject({
      method: 'POST',
      url: '/v1/images/generations',
      headers: { authorization: 'Bearer sk-demo' },
      payload: {
        model: 'gemini-3.1-flash-image',
        prompt: 'a 4k landscape',
        size: '4096x2304',
        image_config: { image_size: '4k' },
      },
    });

    expect(response.statusCode).toBe(200);
    const [, requestInit] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(JSON.parse(String(requestInit.body))).toMatchObject({
      generationConfig: {
        imageConfig: {
          aspectRatio: '16:9',
          imageSize: '4K',
        },
      },
    });
  });

  it('keeps image generation size unchanged when channel image upscale is disabled', async () => {
    fetchMock.mockResolvedValue(new Response(JSON.stringify({
      created: 1,
      data: [{ b64_json: 'ZmFrZQ==' }],
    }), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    }));

    const response = await app.inject({
      method: 'POST',
      url: '/v1/images/generations',
      headers: {
        authorization: 'Bearer sk-demo',
      },
      payload: {
        model: 'gpt-image-1',
        prompt: 'draw a poster',
        size: '2048x2048',
      },
    });

    expect(response.statusCode).toBe(200);
    const [, requestInit] = fetchMock.mock.calls[0] as [string, RequestInit];
    const body = JSON.parse(String(requestInit.body));
    expect(body).toMatchObject({
      model: 'upstream-gpt-image',
      size: '2048x2048',
    });
    expect(body.response_format).toBeUndefined();
  });

  it('deduplicates concurrent image generation requests even when image upscale is disabled', async () => {
    let resolveFetch!: (response: Response) => void;
    fetchMock.mockReturnValueOnce(new Promise<Response>((resolve) => {
      resolveFetch = resolve;
    }));

    const payload = {
      model: 'gpt-image-1',
      prompt: 'draw a normal concurrent poster 2026-06-21',
      size: '1024x1024',
    };
    const firstRequest = app.inject({
      method: 'POST',
      url: '/v1/images/generations',
      headers: {
        authorization: 'Bearer sk-demo',
      },
      payload,
    });
    const secondRequest = app.inject({
      method: 'POST',
      url: '/v1/images/generations',
      headers: {
        authorization: 'Bearer sk-demo',
      },
      payload,
    });
    await vi.waitFor(() => {
      expect(fetchMock).toHaveBeenCalledTimes(1);
    });
    resolveFetch(new Response(JSON.stringify({
      created: 1,
      data: [{ b64_json: 'bm9ybWFs' }],
    }), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    }));

    const [firstResponse, secondResponse] = await Promise.all([firstRequest, secondRequest]);

    expect(firstResponse.statusCode).toBe(200);
    expect(secondResponse.statusCode).toBe(200);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(secondResponse.json()).toEqual(firstResponse.json());
  });

  it('requests a native image size and upscales b64 output when image upscale is enabled', async () => {
    const onePixelPng = await sharp({
      create: {
        width: 1,
        height: 1,
        channels: 4,
        background: { r: 255, g: 255, b: 255, alpha: 1 },
      },
    }).png().toBuffer();
    selectChannelMock.mockReturnValueOnce({
      channel: { id: 11, routeId: 22, imageUpscaleEnabled: true },
      site: { id: 44, name: 'demo-site', url: 'https://upstream.example.com', platform: 'openai' },
      account: { id: 33, username: 'demo-user' },
      tokenName: 'default',
      tokenValue: 'sk-demo',
      actualModel: 'upstream-gpt-image',
    });
    fetchMock.mockResolvedValue(new Response(JSON.stringify({
      created: 1,
      data: [{ b64_json: onePixelPng.toString('base64') }],
    }), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    }));

    const response = await app.inject({
      method: 'POST',
      url: '/v1/images/generations',
      headers: {
        authorization: 'Bearer sk-demo',
      },
      payload: {
        model: 'gpt-image-1',
        prompt: 'draw a poster',
        size: '2048x2048',
      },
    });

    expect(response.statusCode).toBe(200);
    const [, requestInit] = fetchMock.mock.calls[0] as [string, RequestInit];
    const body = JSON.parse(String(requestInit.body));
    expect(body).toMatchObject({
      model: 'upstream-gpt-image',
      size: '1024x1024',
      response_format: 'b64_json',
    });
    const responseBody = response.json();
    const output = Buffer.from(responseBody.data[0].b64_json, 'base64');
    await expect(sharp(output).metadata()).resolves.toMatchObject({
      width: 2048,
      height: 2048,
    });
  });

  it('upscales to 4k output when a 4k size is requested', async () => {
    const onePixelPng = await sharp({
      create: {
        width: 1,
        height: 1,
        channels: 4,
        background: { r: 255, g: 255, b: 255, alpha: 1 },
      },
    }).png().toBuffer();
    selectChannelMock.mockReturnValueOnce({
      channel: { id: 11, routeId: 22, imageUpscaleEnabled: true },
      site: { id: 44, name: 'demo-site', url: 'https://upstream.example.com', platform: 'openai' },
      account: { id: 33, username: 'demo-user' },
      tokenName: 'default',
      tokenValue: 'sk-demo',
      actualModel: 'upstream-gpt-image',
    });
    fetchMock.mockResolvedValue(new Response(JSON.stringify({
      created: 1,
      data: [{ b64_json: onePixelPng.toString('base64') }],
    }), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    }));

    const response = await app.inject({
      method: 'POST',
      url: '/v1/images/generations',
      headers: {
        authorization: 'Bearer sk-demo',
      },
      payload: {
        model: 'gpt-image-1',
        prompt: 'draw a poster',
        size: '4096x4096',
      },
    });

    expect(response.statusCode).toBe(200);
    const [, requestInit] = fetchMock.mock.calls[0] as [string, RequestInit];
    const body = JSON.parse(String(requestInit.body));
    expect(body).toMatchObject({
      model: 'upstream-gpt-image',
      size: '1024x1024',
      response_format: 'b64_json',
    });
    const responseBody = response.json();
    const output = Buffer.from(responseBody.data[0].b64_json, 'base64');
    await expect(sharp(output).metadata()).resolves.toMatchObject({
      width: 4096,
      height: 4096,
    });
  });

  it('upscales image output without adding a padded canvas when aspect ratios differ', async () => {
    const widePng = await sharp({
      create: {
        width: 2,
        height: 1,
        channels: 4,
        background: { r: 255, g: 255, b: 255, alpha: 1 },
      },
    }).png().toBuffer();
    selectChannelMock.mockReturnValueOnce({
      channel: { id: 11, routeId: 22, imageUpscaleEnabled: true },
      site: { id: 44, name: 'demo-site', url: 'https://upstream.example.com', platform: 'openai' },
      account: { id: 33, username: 'demo-user' },
      tokenName: 'default',
      tokenValue: 'sk-demo',
      actualModel: 'upstream-gpt-image',
    });
    fetchMock.mockResolvedValue(new Response(JSON.stringify({
      created: 1,
      data: [{ b64_json: widePng.toString('base64') }],
    }), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    }));

    const response = await app.inject({
      method: 'POST',
      url: '/v1/images/generations',
      headers: {
        authorization: 'Bearer sk-demo',
      },
      payload: {
        model: 'gpt-image-1',
        prompt: 'draw a wide poster',
        size: '2048x2048',
      },
    });

    expect(response.statusCode).toBe(200);
    const responseBody = response.json();
    const output = Buffer.from(responseBody.data[0].b64_json, 'base64');
    await expect(sharp(output).metadata()).resolves.toMatchObject({
      width: 2048,
      height: 1024,
    });
  });

  it('returns a cached upscaled image for repeated image generation requests', async () => {
    const onePixelPng = await sharp({
      create: {
        width: 1,
        height: 1,
        channels: 4,
        background: { r: 32, g: 64, b: 96, alpha: 1 },
      },
    }).png().toBuffer();
    selectChannelMock.mockReturnValue({
      channel: { id: 11, routeId: 22, imageUpscaleEnabled: true },
      site: { id: 44, name: 'demo-site', url: 'https://upstream.example.com', platform: 'openai' },
      account: { id: 33, username: 'demo-user' },
      tokenName: 'default',
      tokenValue: 'sk-demo',
      actualModel: 'upstream-gpt-image',
    });
    fetchMock.mockResolvedValueOnce(new Response(JSON.stringify({
      created: 1,
      data: [{ b64_json: onePixelPng.toString('base64') }],
    }), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    }));

    const payload = {
      model: 'gpt-image-1',
      prompt: 'draw a cached poster 2026-06-21',
      size: '2048x2048',
    };
    const firstResponse = await app.inject({
      method: 'POST',
      url: '/v1/images/generations',
      headers: {
        authorization: 'Bearer sk-demo',
      },
      payload,
    });
    const secondResponse = await app.inject({
      method: 'POST',
      url: '/v1/images/generations',
      headers: {
        authorization: 'Bearer sk-demo',
      },
      payload,
    });

    expect(firstResponse.statusCode).toBe(200);
    expect(secondResponse.statusCode).toBe(200);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(secondResponse.json()).toEqual(firstResponse.json());
  });

  it('deduplicates concurrent image upscale generation requests while the first request is still running', async () => {
    const onePixelPng = await sharp({
      create: {
        width: 1,
        height: 1,
        channels: 4,
        background: { r: 48, g: 96, b: 144, alpha: 1 },
      },
    }).png().toBuffer();
    selectChannelMock.mockReturnValue({
      channel: { id: 11, routeId: 22, imageUpscaleEnabled: true },
      site: { id: 44, name: 'demo-site', url: 'https://upstream.example.com', platform: 'openai' },
      account: { id: 33, username: 'demo-user' },
      tokenName: 'default',
      tokenValue: 'sk-demo',
      actualModel: 'upstream-gpt-image',
    });
    let resolveFetch!: (response: Response) => void;
    fetchMock.mockReturnValueOnce(new Promise<Response>((resolve) => {
      resolveFetch = resolve;
    }));

    const payload = {
      model: 'gpt-image-1',
      prompt: 'draw a concurrent poster 2026-06-21',
      size: '2048x2048',
    };
    const firstRequest = app.inject({
      method: 'POST',
      url: '/v1/images/generations',
      headers: {
        authorization: 'Bearer sk-demo',
      },
      payload,
    });
    const secondRequest = app.inject({
      method: 'POST',
      url: '/v1/images/generations',
      headers: {
        authorization: 'Bearer sk-demo',
      },
      payload,
    });
    await vi.waitFor(() => {
      expect(fetchMock).toHaveBeenCalledTimes(1);
    });
    resolveFetch(new Response(JSON.stringify({
      created: 1,
      data: [{ b64_json: onePixelPng.toString('base64') }],
    }), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    }));

    const [firstResponse, secondResponse] = await Promise.all([firstRequest, secondRequest]);

    expect(firstResponse.statusCode).toBe(200);
    expect(secondResponse.statusCode).toBe(200);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(secondResponse.json()).toEqual(firstResponse.json());
  });

  it('keeps returning a successful image edit response when post-success accounting fails', async () => {
    fetchMock.mockResolvedValue(new Response(JSON.stringify({
      created: 1,
      data: [{ b64_json: 'iVBORw0KGgo=' }],
    }), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    }));
    estimateProxyCostMock.mockRejectedValueOnce(new Error('cost failed'));

    const boundary = 'metapi-boundary-accounting';
    const response = await app.inject({
      method: 'POST',
      url: '/v1/images/edits',
      headers: {
        authorization: 'Bearer sk-demo',
        'content-type': `multipart/form-data; boundary=${boundary}`,
      },
      payload: buildMultipartBody(boundary),
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({
      created: 1,
      data: [{ b64_json: 'iVBORw0KGgo=' }],
    });
    expect(selectNextChannelMock).not.toHaveBeenCalled();
    expect(recordFailureMock).not.toHaveBeenCalled();
  });

  it('returns explicit not-supported error for /v1/images/variations', async () => {
    const response = await app.inject({
      method: 'POST',
      url: '/v1/images/variations',
      payload: {
        model: 'gpt-image-1',
      },
    });

    expect(response.statusCode).toBe(400);
    expect(response.json()).toEqual({
      error: {
        message: 'Image variations are not supported',
        type: 'invalid_request_error',
      },
    });
  });
});
