import { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { createHash } from 'node:crypto';
import sharp from 'sharp';
import { fetch } from 'undici';
import { config } from '../../config.js';
import { tokenRouter } from '../../services/tokenRouter.js';
import { reportProxyAllFailed, reportTokenExpired } from '../../services/alertService.js';
import { isTokenExpiredError } from '../../services/alertRules.js';
import { estimateProxyCost } from '../../services/modelPricingService.js';
import { shouldRetryProxyRequest } from '../../services/proxyRetryPolicy.js';
import { ensureModelAllowedForDownstreamKey, getDownstreamRoutingPolicy, recordDownstreamCostUsage } from './downstreamPolicy.js';
import { withSiteRecordProxyRequestInit } from '../../services/siteProxy.js';
import { getProxyUrlFromExtraConfig } from '../../services/accountExtraConfig.js';
import { composeProxyLogMessage } from '../../services/proxyLogMessage.js';
import { formatUtcSqlDateTime } from '../../services/localTimeService.js';
import { cloneFormDataWithOverrides, ensureMultipartBufferParser, parseMultipartFormData } from './multipart.js';
import { getProxyAuthContext } from '../../middleware/auth.js';
import { buildUpstreamUrl } from './upstreamUrl.js';
import { detectDownstreamClientContext, type DownstreamClientContext } from '../../proxy-core/downstreamClientContext.js';
import { insertProxyLog } from '../../services/proxyLogStore.js';
import { fetchWithObservedFirstByte, getObservedResponseMeta } from '../../proxy-core/firstByteTimeout.js';
import { getProxyMaxChannelRetries } from '../../services/proxyChannelRetry.js';
import { runWithSiteApiEndpointPool, SiteApiEndpointRequestError } from '../../services/siteApiEndpointService.js';
import {
  buildForcedChannelUnavailableMessage,
  canRetryChannelSelection,
  getTesterForcedChannelId,
  selectProxyChannelForAttempt,
} from '../../proxy-core/channelSelection.js';

export async function imagesProxyRoute(app: FastifyInstance) {
  ensureMultipartBufferParser(app);

  app.post('/v1/images/generations', async (request: FastifyRequest, reply: FastifyReply) => {
    const body = request.body as any;
    const requestedModel = body?.model || 'gpt-image-1';
    if (!await ensureModelAllowedForDownstreamKey(request, reply, requestedModel)) return;
    const downstreamPolicy = getDownstreamRoutingPolicy(request);
    const forcedChannelId = getTesterForcedChannelId({
      headers: request.headers as Record<string, unknown>,
      clientIp: request.ip,
    });
    const downstreamApiKeyId = getProxyAuthContext(request)?.keyId ?? null;
    const downstreamPath = '/v1/images/generations';
    const clientContext = detectDownstreamClientContext({
      downstreamPath,
      headers: request.headers as Record<string, unknown>,
      body,
    });
    const firstByteTimeoutMs = Math.max(0, Math.trunc((config.proxyFirstByteTimeoutSec || 0) * 1000));
    const excludeChannelIds: number[] = [];
    let retryCount = 0;

    while (retryCount <= getProxyMaxChannelRetries()) {
      const selected = await selectProxyChannelForAttempt({
        requestedModel,
        downstreamPolicy,
        excludeChannelIds,
        retryCount,
        forcedChannelId,
      });

      if (!selected) {
        const noChannelMessage = buildForcedChannelUnavailableMessage(forcedChannelId);
        await reportProxyAllFailed({
          model: requestedModel,
          reason: forcedChannelId ? noChannelMessage : 'No available channels after retries',
        });
        return reply.code(503).send({
          error: { message: noChannelMessage, type: 'server_error' },
        });
      }

      excludeChannelIds.push(selected.channel.id);
      const upstreamModel = selected.actualModel || requestedModel;
      const upscalePlan = resolveImageUpscalePlan({
        enabled: selected.channel.imageUpscaleEnabled === true,
        size: body?.size,
      });
      const upscaleCacheKey = upscalePlan.shouldUpscale
        ? await buildImageUpscaleCacheKey({
          downstreamPath,
          requestedModel,
          upstreamModel,
          requestedSize: upscalePlan.requestedSize.value,
          upstreamSize: upscalePlan.upstreamSize.value,
          payload: body,
        })
        : null;
      const cachedUpscaledResponse = upscaleCacheKey ? readImageUpscaleCache(upscaleCacheKey) : null;
      if (cachedUpscaledResponse) {
        return reply.code(200).send(cachedUpscaledResponse);
      }
      const imageInflightKey = await buildImageRequestInflightKey({
        downstreamPath,
        downstreamApiKeyId,
        channelId: selected.channel.id,
        requestedModel,
        upstreamModel,
        payload: body,
      });
      const existingImageInflight = readImageUpscaleInflight(imageInflightKey);
      if (existingImageInflight) {
        const inflightResponse = await existingImageInflight;
        return reply.code(inflightResponse.statusCode).send(inflightResponse.value);
      }
      const imageInflight = createImageUpscaleInflight(imageInflightKey);
      const forwardBody = {
        ...body,
        model: upstreamModel,
        ...(upscalePlan.shouldUpscale
          ? {
            size: upscalePlan.upstreamSize.value,
            response_format: 'b64_json',
          }
          : {}),
      };
      const startTime = Date.now();

      try {
        const { upstream, text, firstByteLatencyMs } = await runWithSiteApiEndpointPool(selected.site, async (target) => {
          const attemptStartedAtMs = Date.now();
          const targetUrl = buildUpstreamUrl(target.baseUrl, '/v1/images/generations');
          const response = await fetchWithObservedFirstByte(
            async (signal) => fetch(targetUrl, withSiteRecordProxyRequestInit(selected.site, {
              method: 'POST',
              headers: {
                'Content-Type': 'application/json',
                'Authorization': `Bearer ${selected.tokenValue}`,
              },
              body: JSON.stringify(forwardBody),
              signal,
            }, getProxyUrlFromExtraConfig(selected.account.extraConfig))),
            {
              firstByteTimeoutMs,
              startedAtMs: attemptStartedAtMs,
            },
          );
          const observedFirstByteLatencyMs = getObservedResponseMeta(response)?.firstByteLatencyMs ?? null;
          const responseText = await response.text();
          if (!response.ok) {
            throw new SiteApiEndpointRequestError(responseText || 'unknown error', {
              status: response.status,
              rawErrText: responseText || null,
              firstByteLatencyMs: observedFirstByteLatencyMs,
            });
          }
          return {
            upstream: response,
            text: responseText,
            firstByteLatencyMs: observedFirstByteLatencyMs,
          };
        });

        const data = parseUpstreamImageResponse(text);
        if (!data.ok) {
          await recordTokenRouterEventBestEffort('record malformed upstream response', () => tokenRouter.recordFailure(selected.channel.id, {
            status: 502,
            errorText: data.message,
            modelName: upstreamModel,
          }));
          logProxy(
            selected,
            requestedModel,
            'failed',
            502,
            Date.now() - startTime,
            data.message,
            retryCount,
            downstreamApiKeyId,
            0,
            downstreamPath,
            clientContext,
            false,
            firstByteLatencyMs,
          );
          if (canRetryChannelSelection(retryCount, forcedChannelId)) {
            clearImageUpscaleInflight(imageInflight);
            retryCount++;
            continue;
          }
          await reportProxyAllFailed({
            model: requestedModel,
            reason: data.message,
          });
          return sendImageProxyResponse(reply, imageInflightKey, {
            statusCode: 502,
            value: {
              error: { message: data.message, type: 'upstream_error' },
            },
          });
        }

        const latency = Date.now() - startTime;
        let estimatedCost = 0;
        await recordTokenRouterEventBestEffort('estimate proxy cost', async () => {
          estimatedCost = await estimateProxyCost({
            site: selected.site,
            account: selected.account,
            modelName: upstreamModel,
            promptTokens: 0,
            completionTokens: 0,
            totalTokens: 0,
          });
        });
        await recordTokenRouterEventBestEffort('record channel success', () => (
          tokenRouter.recordSuccess(selected.channel.id, latency, estimatedCost, upstreamModel, undefined, 0)
        ));
        await recordTokenRouterEventBestEffort('record downstream cost usage', () => (
          recordDownstreamCostUsage(request, estimatedCost)
        ));
        logProxy(
          selected,
          requestedModel,
          'success',
          upstream.status,
          latency,
          null,
          retryCount,
          downstreamApiKeyId,
          estimatedCost,
          downstreamPath,
          clientContext,
          false,
          firstByteLatencyMs,
        );
        const responseValue = await upscaleImageResponseIfNeeded(data.value, upscalePlan, upscaleCacheKey);
        return sendImageProxyResponse(reply, imageInflightKey, {
          statusCode: upstream.status,
          value: responseValue,
        });
      } catch (err: any) {
        const status = err instanceof SiteApiEndpointRequestError ? (err.status || 0) : 0;
        const errorText = err?.message || 'network failure';
        const firstByteLatencyMs = err instanceof SiteApiEndpointRequestError ? err.firstByteLatencyMs : null;
        await recordTokenRouterEventBestEffort('record channel failure', () => tokenRouter.recordFailure(selected.channel.id, {
          status,
          errorText,
          modelName: upstreamModel,
        }));
        logProxy(
          selected,
          requestedModel,
          'failed',
          status,
          Date.now() - startTime,
          errorText,
          retryCount,
          downstreamApiKeyId,
          0,
          downstreamPath,
          clientContext,
          false,
          firstByteLatencyMs,
        );
        if (status > 0 && isTokenExpiredError({ status, message: errorText })) {
          await reportTokenExpired({
            accountId: selected.account.id,
            username: selected.account.username,
            siteName: selected.site.name,
            detail: `HTTP ${status}`,
          });
        }
        if ((status > 0 ? shouldRetryProxyRequest(status, errorText) : true) && canRetryChannelSelection(retryCount, forcedChannelId)) {
          clearImageUpscaleInflight(imageInflight);
          retryCount++;
          continue;
        }
        await reportProxyAllFailed({
          model: requestedModel,
          reason: errorText || 'network failure',
        });
        return sendImageProxyResponse(reply, imageInflightKey, {
          statusCode: status || 502,
          value: {
            error: {
              message: status > 0 ? errorText : `Upstream error: ${errorText}`,
              type: 'upstream_error',
            },
          },
        });
      }
    }
  });

  app.post('/v1/images/edits', async (request: FastifyRequest, reply: FastifyReply) => {
    const multipartForm = await parseMultipartFormData(request);
    const jsonBody = (!multipartForm && request.body && typeof request.body === 'object')
      ? request.body as Record<string, unknown>
      : null;
    const requestedModel = typeof multipartForm?.get('model') === 'string'
      ? String(multipartForm.get('model')).trim()
      : (typeof jsonBody?.model === 'string' ? jsonBody.model.trim() : '') || 'gpt-image-1';

    if (!await ensureModelAllowedForDownstreamKey(request, reply, requestedModel)) return;
    const downstreamPolicy = getDownstreamRoutingPolicy(request);
    const forcedChannelId = getTesterForcedChannelId({
      headers: request.headers as Record<string, unknown>,
      clientIp: request.ip,
    });
    const downstreamApiKeyId = getProxyAuthContext(request)?.keyId ?? null;
    const downstreamPath = '/v1/images/edits';
    const clientContext = detectDownstreamClientContext({
      downstreamPath,
      headers: request.headers as Record<string, unknown>,
      body: jsonBody || Object.fromEntries(multipartForm?.entries?.() || []),
    });
    const firstByteTimeoutMs = Math.max(0, Math.trunc((config.proxyFirstByteTimeoutSec || 0) * 1000));
    const excludeChannelIds: number[] = [];
    let retryCount = 0;

    while (retryCount <= getProxyMaxChannelRetries()) {
      const selected = await selectProxyChannelForAttempt({
        requestedModel,
        downstreamPolicy,
        excludeChannelIds,
        retryCount,
        forcedChannelId,
      });

      if (!selected) {
        const noChannelMessage = buildForcedChannelUnavailableMessage(forcedChannelId);
        await reportProxyAllFailed({
          model: requestedModel,
          reason: forcedChannelId ? noChannelMessage : 'No available channels after retries',
        });
        return reply.code(503).send({
          error: { message: noChannelMessage, type: 'server_error' },
        });
      }

      excludeChannelIds.push(selected.channel.id);
      const upstreamModel = selected.actualModel || requestedModel;
      const requestedSize = multipartForm?.get('size') ?? jsonBody?.size;
      const upscalePlan = resolveImageUpscalePlan({
        enabled: selected.channel.imageUpscaleEnabled === true,
        size: requestedSize,
      });
      const normalizedPayload = multipartForm ? await normalizeFormDataForCache(multipartForm) : (jsonBody || {});
      const upscaleCacheKey = upscalePlan.shouldUpscale
        ? await buildImageUpscaleCacheKey({
          downstreamPath,
          requestedModel,
          upstreamModel,
          requestedSize: upscalePlan.requestedSize.value,
          upstreamSize: upscalePlan.upstreamSize.value,
          payload: normalizedPayload,
        })
        : null;
      const cachedUpscaledResponse = upscaleCacheKey ? readImageUpscaleCache(upscaleCacheKey) : null;
      if (cachedUpscaledResponse) {
        return reply.code(200).send(cachedUpscaledResponse);
      }
      const imageInflightKey = await buildImageRequestInflightKey({
        downstreamPath,
        downstreamApiKeyId,
        channelId: selected.channel.id,
        requestedModel,
        upstreamModel,
        payload: normalizedPayload,
      });
      const existingImageInflight = readImageUpscaleInflight(imageInflightKey);
      if (existingImageInflight) {
        const inflightResponse = await existingImageInflight;
        return reply.code(inflightResponse.statusCode).send(inflightResponse.value);
      }
      const imageInflight = createImageUpscaleInflight(imageInflightKey);
      const imageEditOverrides: Record<string, string> = upscalePlan.shouldUpscale
        ? {
          model: upstreamModel,
          size: upscalePlan.upstreamSize.value,
          response_format: 'b64_json',
        }
        : {
          model: upstreamModel,
        };
      const startTime = Date.now();

      try {
        const { upstream, text, firstByteLatencyMs } = await runWithSiteApiEndpointPool(selected.site, async (target) => {
          const attemptStartedAtMs = Date.now();
          const targetUrl = buildUpstreamUrl(target.baseUrl, '/v1/images/edits');
          const requestInit = multipartForm
            ? withSiteRecordProxyRequestInit(selected.site, {
              method: 'POST',
              headers: {
                Authorization: `Bearer ${selected.tokenValue}`,
              },
              body: cloneFormDataWithOverrides(multipartForm, imageEditOverrides) as any,
            }, getProxyUrlFromExtraConfig(selected.account.extraConfig))
            : withSiteRecordProxyRequestInit(selected.site, {
              method: 'POST',
              headers: {
                'Content-Type': 'application/json',
                Authorization: `Bearer ${selected.tokenValue}`,
              },
              body: JSON.stringify({
                ...(jsonBody || {}),
                ...imageEditOverrides,
              }),
            }, getProxyUrlFromExtraConfig(selected.account.extraConfig));
          const response = await fetchWithObservedFirstByte(
            async (signal) => fetch(targetUrl, {
              ...requestInit,
              signal,
            }),
            {
              firstByteTimeoutMs,
              startedAtMs: attemptStartedAtMs,
            },
          );
          const observedFirstByteLatencyMs = getObservedResponseMeta(response)?.firstByteLatencyMs ?? null;
          const responseText = await response.text();
          if (!response.ok) {
            throw new SiteApiEndpointRequestError(responseText || 'unknown error', {
              status: response.status,
              rawErrText: responseText || null,
              firstByteLatencyMs: observedFirstByteLatencyMs,
            });
          }
          return {
            upstream: response,
            text: responseText,
            firstByteLatencyMs: observedFirstByteLatencyMs,
          };
        });

        const data = parseUpstreamImageResponse(text);
        if (!data.ok) {
          await recordTokenRouterEventBestEffort('record malformed upstream response', () => tokenRouter.recordFailure(selected.channel.id, {
            status: 502,
            errorText: data.message,
            modelName: upstreamModel,
          }));
          logProxy(
            selected,
            requestedModel,
            'failed',
            502,
            Date.now() - startTime,
            data.message,
            retryCount,
            downstreamApiKeyId,
            0,
            downstreamPath,
            clientContext,
            false,
            firstByteLatencyMs,
          );
          if (canRetryChannelSelection(retryCount, forcedChannelId)) {
            clearImageUpscaleInflight(imageInflight);
            retryCount++;
            continue;
          }
          await reportProxyAllFailed({
            model: requestedModel,
            reason: data.message,
          });
          return sendImageProxyResponse(reply, imageInflightKey, {
            statusCode: 502,
            value: {
              error: { message: data.message, type: 'upstream_error' },
            },
          });
        }

        const latency = Date.now() - startTime;
        let estimatedCost = 0;
        await recordTokenRouterEventBestEffort('estimate proxy cost', async () => {
          estimatedCost = await estimateProxyCost({
            site: selected.site,
            account: selected.account,
            modelName: upstreamModel,
            promptTokens: 0,
            completionTokens: 0,
            totalTokens: 0,
          });
        });
        await recordTokenRouterEventBestEffort('record channel success', () => (
          tokenRouter.recordSuccess(selected.channel.id, latency, estimatedCost, upstreamModel, undefined, 0)
        ));
        await recordTokenRouterEventBestEffort('record downstream cost usage', () => (
          recordDownstreamCostUsage(request, estimatedCost)
        ));
        logProxy(
          selected,
          requestedModel,
          'success',
          upstream.status,
          latency,
          null,
          retryCount,
          downstreamApiKeyId,
          estimatedCost,
          downstreamPath,
          clientContext,
          false,
          firstByteLatencyMs,
        );
        const responseValue = await upscaleImageResponseIfNeeded(data.value, upscalePlan, upscaleCacheKey);
        return sendImageProxyResponse(reply, imageInflightKey, {
          statusCode: upstream.status,
          value: responseValue,
        });
      } catch (err: any) {
        const status = err instanceof SiteApiEndpointRequestError ? (err.status || 0) : 0;
        const errorText = err?.message || 'network failure';
        const firstByteLatencyMs = err instanceof SiteApiEndpointRequestError ? err.firstByteLatencyMs : null;
        await recordTokenRouterEventBestEffort('record channel failure', () => tokenRouter.recordFailure(selected.channel.id, {
          status,
          errorText,
          modelName: upstreamModel,
        }));
        logProxy(
          selected,
          requestedModel,
          'failed',
          status,
          Date.now() - startTime,
          errorText,
          retryCount,
          downstreamApiKeyId,
          0,
          downstreamPath,
          clientContext,
          false,
          firstByteLatencyMs,
        );
        if (status > 0 && isTokenExpiredError({ status, message: errorText })) {
          await reportTokenExpired({
            accountId: selected.account.id,
            username: selected.account.username,
            siteName: selected.site.name,
            detail: `HTTP ${status}`,
          });
        }
        if ((status > 0 ? shouldRetryProxyRequest(status, errorText) : true) && canRetryChannelSelection(retryCount, forcedChannelId)) {
          clearImageUpscaleInflight(imageInflight);
          retryCount++;
          continue;
        }
        await reportProxyAllFailed({
          model: requestedModel,
          reason: errorText || 'network failure',
        });
        return sendImageProxyResponse(reply, imageInflightKey, {
          statusCode: status || 502,
          value: {
            error: {
              message: status > 0 ? errorText : `Upstream error: ${errorText}`,
              type: 'upstream_error',
            },
          },
        });
      }
    }
  });

  app.post('/v1/images/variations', async (_request: FastifyRequest, reply: FastifyReply) => {
    return reply.code(400).send({
      error: {
        message: 'Image variations are not supported',
        type: 'invalid_request_error',
      },
    });
  });
}

async function logProxy(
  selected: any,
  modelRequested: string,
  status: string,
  httpStatus: number,
  latencyMs: number,
  errorMessage: string | null,
  retryCount: number,
  downstreamApiKeyId: number | null = null,
  estimatedCost = 0,
  downstreamPath = '/v1/images/generations',
  clientContext: DownstreamClientContext | null = null,
  isStream = false,
  firstByteLatencyMs: number | null = null,
) {
  try {
    const createdAt = formatUtcSqlDateTime(new Date());
    const normalizedErrorMessage = composeProxyLogMessage({
      clientKind: clientContext?.clientKind && clientContext.clientKind !== 'generic'
        ? clientContext.clientKind
        : null,
      sessionId: clientContext?.sessionId || null,
      traceHint: clientContext?.traceHint || null,
      downstreamPath,
      errorMessage,
    });
    await insertProxyLog({
      routeId: selected.channel.routeId,
      channelId: selected.channel.id,
      accountId: selected.account.id,
      downstreamApiKeyId,
      modelRequested,
      modelActual: selected.actualModel || modelRequested,
      status,
      httpStatus,
      isStream,
      firstByteLatencyMs,
      latencyMs,
      promptTokens: 0,
      completionTokens: 0,
      totalTokens: 0,
      estimatedCost,
      clientFamily: clientContext?.clientKind || null,
      clientAppId: clientContext?.clientAppId || null,
      clientAppName: clientContext?.clientAppName || null,
      clientConfidence: clientContext?.clientConfidence || null,
      errorMessage: normalizedErrorMessage,
      retryCount,
      createdAt,
    });
  } catch (error) {
    console.warn('[proxy/images] failed to write proxy log', error);
  }
}

async function recordTokenRouterEventBestEffort(
  label: string,
  operation: () => Promise<unknown> | unknown,
): Promise<void> {
  try {
    await operation();
  } catch (error) {
    console.warn(`[proxy/images] failed to ${label}`, error);
  }
}

function parseUpstreamImageResponse(text: string): { ok: true; value: any } | { ok: false; message: string } {
  try {
    return { ok: true, value: JSON.parse(text) };
  } catch {
    return { ok: false, message: text || 'Upstream returned malformed JSON' };
  }
}

type ParsedImageSize = {
  width: number;
  height: number;
  value: string;
};

type ImageUpscalePlan = {
  shouldUpscale: false;
} | {
  shouldUpscale: true;
  requestedSize: ParsedImageSize;
  upstreamSize: ParsedImageSize;
};

const IMAGE_UPSCALE_NATIVE_SIZES: ParsedImageSize[] = [
  { width: 1024, height: 1024, value: '1024x1024' },
  { width: 1536, height: 1024, value: '1536x1024' },
  { width: 1024, height: 1536, value: '1024x1536' },
];
const IMAGE_UPSCALE_TIMEOUT_MS = 110_000;
const IMAGE_UPSCALE_CACHE_TTL_MS = 10 * 60 * 1000;
const IMAGE_UPSCALE_CACHE_MAX_ENTRIES = 64;

type ImageUpscaleCacheEntry = {
  value: any;
  expiresAt: number;
  lastAccessedAt: number;
};

type ImageProxyResponse = {
  statusCode: number;
  value: any;
};

type ImageUpscaleInflightEntry = {
  key: string;
  promise: Promise<ImageProxyResponse>;
  resolve: (value: ImageProxyResponse) => void;
};

const imageUpscaleCache = new Map<string, ImageUpscaleCacheEntry>();
const imageUpscaleInflight = new Map<string, ImageUpscaleInflightEntry>();

function parseImageSize(value: unknown): ParsedImageSize | null {
  if (typeof value !== 'string') return null;
  const match = value.trim().toLowerCase().match(/^(\d{2,5})x(\d{2,5})$/);
  if (!match) return null;
  const width = Number(match[1]);
  const height = Number(match[2]);
  if (!Number.isFinite(width) || !Number.isFinite(height) || width <= 0 || height <= 0) return null;
  return { width, height, value: `${width}x${height}` };
}

function resolveNativeImageSizeForTarget(target: ParsedImageSize): ParsedImageSize {
  if (target.width === target.height) return IMAGE_UPSCALE_NATIVE_SIZES[0];
  return target.width > target.height
    ? IMAGE_UPSCALE_NATIVE_SIZES[1]
    : IMAGE_UPSCALE_NATIVE_SIZES[2];
}

function resolveImageUpscalePlan({
  enabled,
  size,
}: {
  enabled: boolean;
  size: unknown;
}): ImageUpscalePlan {
  if (!enabled) return { shouldUpscale: false };
  const requestedSize = parseImageSize(size);
  if (!requestedSize) return { shouldUpscale: false };
  const upstreamSize = resolveNativeImageSizeForTarget(requestedSize);
  if (requestedSize.width <= upstreamSize.width && requestedSize.height <= upstreamSize.height) {
    return { shouldUpscale: false };
  }
  return {
    shouldUpscale: true,
    requestedSize,
    upstreamSize,
  };
}

async function upscaleImageResponseIfNeeded(value: any, plan: ImageUpscalePlan, cacheKey: string | null): Promise<any> {
  if (!plan.shouldUpscale || !Array.isArray(value?.data)) return value;
  const operation = upscaleImageResponse(value, plan)
    .then((upscaledValue) => {
      if (hasCacheableImageB64(upscaledValue)) {
        writeImageUpscaleCache(cacheKey, upscaledValue);
      }
      return upscaledValue;
    })
    .catch((error) => {
      console.warn('[proxy/images] image upscale failed; returning original upstream image', error);
      return value;
    });
  return withImageUpscaleTimeout(operation, value);
}

async function upscaleImageResponse(value: any, plan: Extract<ImageUpscalePlan, { shouldUpscale: true }>): Promise<any> {
  const data = await Promise.all(value.data.map(async (item: any) => {
    const b64 = typeof item?.b64_json === 'string' ? item.b64_json : '';
    if (!b64) return item;
    const startedAt = Date.now();
    const input = sharp(Buffer.from(b64, 'base64'));
    const metadata = await input.metadata();
    const { data: output, info } = await input
      .resize({
        width: plan.requestedSize.width,
        height: plan.requestedSize.height,
        fit: 'inside',
      })
      .png()
      .toBuffer({ resolveWithObject: true });
    console.info('[proxy/images] image upscale completed', {
      durationMs: Date.now() - startedAt,
      requestedSize: plan.requestedSize.value,
      upstreamSize: plan.upstreamSize.value,
      inputSize: metadata.width && metadata.height ? `${metadata.width}x${metadata.height}` : null,
      outputSize: info.width && info.height ? `${info.width}x${info.height}` : null,
    });
    return {
      ...item,
      b64_json: output.toString('base64'),
    };
  }));
  return {
    ...value,
    data,
  };
}

async function withImageUpscaleTimeout<T>(operation: Promise<T>, fallbackValue: T): Promise<T> {
  let timeout: ReturnType<typeof setTimeout> | null = null;
  const timeoutPromise = new Promise<T>((resolve) => {
    timeout = setTimeout(() => {
      console.warn(`[proxy/images] image upscale exceeded ${IMAGE_UPSCALE_TIMEOUT_MS}ms; returning original upstream image`);
      resolve(fallbackValue);
    }, IMAGE_UPSCALE_TIMEOUT_MS);
  });
  const result = await Promise.race([operation, timeoutPromise]);
  if (timeout) clearTimeout(timeout);
  return result;
}

function hasCacheableImageB64(value: any): boolean {
  return Array.isArray(value?.data) && value.data.some((item: any) => typeof item?.b64_json === 'string' && item.b64_json.length > 0);
}

function readImageUpscaleCache(key: string): any | null {
  const entry = imageUpscaleCache.get(key);
  if (!entry) return null;
  const now = Date.now();
  if (entry.expiresAt <= now) {
    imageUpscaleCache.delete(key);
    return null;
  }
  entry.lastAccessedAt = now;
  return entry.value;
}

function writeImageUpscaleCache(key: string | null, value: any): void {
  if (!key) return;
  const now = Date.now();
  for (const [entryKey, entry] of imageUpscaleCache.entries()) {
    if (entry.expiresAt <= now) {
      imageUpscaleCache.delete(entryKey);
    }
  }
  imageUpscaleCache.set(key, {
    value,
    expiresAt: now + IMAGE_UPSCALE_CACHE_TTL_MS,
    lastAccessedAt: now,
  });
  while (imageUpscaleCache.size > IMAGE_UPSCALE_CACHE_MAX_ENTRIES) {
    let oldestKey: string | null = null;
    let oldestAccessedAt = Number.POSITIVE_INFINITY;
    for (const [entryKey, entry] of imageUpscaleCache.entries()) {
      if (entry.lastAccessedAt < oldestAccessedAt) {
        oldestKey = entryKey;
        oldestAccessedAt = entry.lastAccessedAt;
      }
    }
    if (!oldestKey) break;
    imageUpscaleCache.delete(oldestKey);
  }
}

function readImageUpscaleInflight(key: string | null): Promise<ImageProxyResponse> | null {
  if (!key) return null;
  return imageUpscaleInflight.get(key)?.promise ?? null;
}

function createImageUpscaleInflight(key: string | null): ImageUpscaleInflightEntry | null {
  if (!key) return null;
  let resolve!: (value: ImageProxyResponse) => void;
  const promise = new Promise<ImageProxyResponse>((next) => {
    resolve = next;
  });
  const entry = { key, promise, resolve };
  imageUpscaleInflight.set(key, entry);
  return entry;
}

function clearImageUpscaleInflight(entry: ImageUpscaleInflightEntry | null): void {
  if (!entry) return;
  if (imageUpscaleInflight.get(entry.key) === entry) {
    imageUpscaleInflight.delete(entry.key);
  }
}

function resolveImageUpscaleInflight(entry: ImageUpscaleInflightEntry | null, response: ImageProxyResponse): void {
  if (!entry) return;
  entry.resolve(response);
  clearImageUpscaleInflight(entry);
}

function sendImageProxyResponse(
  reply: FastifyReply,
  cacheKey: string | null,
  response: ImageProxyResponse,
) {
  const entry = cacheKey ? imageUpscaleInflight.get(cacheKey) ?? null : null;
  resolveImageUpscaleInflight(entry, response);
  return reply.code(response.statusCode).send(response.value);
}

async function buildImageUpscaleCacheKey(input: {
  downstreamPath: string;
  requestedModel: string;
  upstreamModel: string;
  requestedSize: string;
  upstreamSize: string;
  payload: unknown;
}): Promise<string> {
  return createHash('sha256').update(stableStringify(input)).digest('hex');
}

async function buildImageRequestInflightKey(input: {
  downstreamPath: string;
  downstreamApiKeyId: number | null;
  channelId: number;
  requestedModel: string;
  upstreamModel: string;
  payload: unknown;
}): Promise<string> {
  return createHash('sha256').update(stableStringify({
    type: 'image-request-inflight-v1',
    ...input,
  })).digest('hex');
}

async function normalizeFormDataForCache(formData: FormData): Promise<Record<string, unknown>> {
  const entries: Array<Record<string, unknown>> = [];
  for (const [key, value] of formData.entries()) {
    if (typeof value === 'string') {
      entries.push({ key, type: 'text', value });
      continue;
    }
    const file = value as File;
    const bytes = Buffer.from(await file.arrayBuffer());
    entries.push({
      key,
      type: 'file',
      name: file.name || '',
      contentType: file.type || '',
      size: file.size || bytes.length,
      sha256: createHash('sha256').update(bytes).digest('hex'),
    });
  }
  entries.sort((left, right) => stableStringify(left).localeCompare(stableStringify(right)));
  return { entries };
}

function stableStringify(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map((item) => stableStringify(item)).join(',')}]`;
  const object = value as Record<string, unknown>;
  return `{${Object.keys(object).sort().map((key) => `${JSON.stringify(key)}:${stableStringify(object[key])}`).join(',')}}`;
}
