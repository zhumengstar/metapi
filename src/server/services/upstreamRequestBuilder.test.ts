import { describe, expect, it } from 'vitest';

import {
  buildClaudeCountTokensUpstreamRequest,
  buildUpstreamEndpointRequest,
} from './upstreamRequestBuilder.js';

describe('upstreamRequestBuilder', () => {
  it('normalizes single-message OpenAI requests to structured responses input', () => {
    const request = buildUpstreamEndpointRequest({
      endpoint: 'responses',
      modelName: 'upstream-gpt',
      stream: false,
      tokenValue: 'sk-test',
      sitePlatform: 'sub2api',
      siteUrl: 'https://example.com',
      openaiBody: {
        model: 'gpt-5.2',
        messages: [{ role: 'user', content: 'hello' }],
      },
      downstreamFormat: 'openai',
    });

    expect(request.path).toBe('/v1/responses');
    expect(request.headers.accept).toBe('application/json');
    expect(request.body.input).toEqual([
      {
        type: 'message',
        role: 'user',
        content: [{ type: 'input_text', text: 'hello' }],
      },
    ]);
    expect(request.body.store).toBe(false);
  });

  it('forces store=false for sub2api native responses passthrough bodies', () => {
    const request = buildUpstreamEndpointRequest({
      endpoint: 'responses',
      modelName: 'upstream-gpt',
      stream: true,
      tokenValue: 'sk-test',
      sitePlatform: 'sub2api',
      siteUrl: 'https://example.com',
      openaiBody: {},
      downstreamFormat: 'responses',
      responsesOriginalBody: {
        model: 'gpt-5.2',
        input: 'hello',
        store: true,
      },
    });

    expect(request.path).toBe('/v1/responses');
    expect(request.headers.accept).toBe('text/event-stream');
    expect(request.body.input).toEqual([
      {
        type: 'message',
        role: 'user',
        content: [{ type: 'input_text', text: 'hello' }],
      },
    ]);
    expect(request.body.stream).toBe(true);
    expect(request.body.store).toBe(false);
  });

  it('overrides downstream Accept so responses transport mode wins', () => {
    const request = buildUpstreamEndpointRequest({
      endpoint: 'responses',
      modelName: 'upstream-gpt',
      stream: true,
      tokenValue: 'sk-test',
      sitePlatform: 'openai',
      siteUrl: 'https://example.com',
      openaiBody: {
        model: 'gpt-5.2',
        messages: [{ role: 'user', content: 'hello' }],
      },
      downstreamFormat: 'openai',
      downstreamHeaders: {
        accept: 'application/json',
      },
    });

    expect(request.headers.accept).toBe('text/event-stream');
  });

  it('applies a sub2api-style allowlist to generic passthrough headers', () => {
    const request = buildUpstreamEndpointRequest({
      endpoint: 'chat',
      modelName: 'upstream-gpt',
      stream: false,
      tokenValue: 'sk-test',
      sitePlatform: 'sub2api',
      siteUrl: 'https://example.com',
      openaiBody: {
        model: 'gpt-5.2',
        messages: [{ role: 'user', content: 'hello' }],
      },
      downstreamFormat: 'openai',
      downstreamHeaders: {
        accept: 'application/json',
        'accept-language': 'zh-CN',
        'user-agent': 'client-ua/1.0',
        originator: 'codex_cli_rs',
        session_id: 'session-123',
        conversation_id: 'conversation-123',
        'x-codex-turn-state': 'turn-state',
        'x-codex-turn-metadata': 'turn-metadata',
        origin: 'https://client.example',
        referer: 'https://client.example/chat',
        'x-forwarded-for': '203.0.113.1',
        'x-real-ip': '203.0.113.2',
        version: '0.202.0',
        'x-test-header': 'drop-me',
      },
    });

    expect(request.headers.accept).toBe('application/json');
    expect(request.headers['accept-language']).toBe('zh-CN');
    expect(request.headers['user-agent']).toBe('client-ua/1.0');
    expect(request.headers.originator).toBe('codex_cli_rs');
    expect(request.headers.session_id).toBe('session-123');
    expect(request.headers.conversation_id).toBe('conversation-123');
    expect(request.headers['x-codex-turn-state']).toBe('turn-state');
    expect(request.headers['x-codex-turn-metadata']).toBe('turn-metadata');

    expect(request.headers.origin).toBeUndefined();
    expect(request.headers.referer).toBeUndefined();
    expect(request.headers['x-forwarded-for']).toBeUndefined();
    expect(request.headers['x-real-ip']).toBeUndefined();
    expect(request.headers.version).toBeUndefined();
    expect(request.headers['x-test-header']).toBeUndefined();
  });

  it('strips response-only usage and cache statistics before forwarding chat requests', () => {
    const request = buildUpstreamEndpointRequest({
      endpoint: 'chat',
      modelName: 'upstream-gpt',
      stream: false,
      tokenValue: 'sk-test',
      sitePlatform: 'sub2api',
      siteUrl: 'https://example.com',
      openaiBody: {
        model: 'gpt-5.2',
        messages: [{ role: 'user', content: 'hello' }],
        prompt_cache_key: 'cache-key-1',
        stream_options: { include_usage: true },
        usage: {
          prompt_tokens: 10,
          prompt_tokens_details: { cached_tokens: 5 },
        },
        prompt_tokens_details: { cached_tokens: 5 },
        input_tokens_details: { cached_tokens: 5 },
        cached_tokens: 5,
        cache_read_tokens: 5,
        billingDetails: { source: 'local-log' },
      },
      downstreamFormat: 'openai',
    });

    expect(request.body.prompt_cache_key).toBe('cache-key-1');
    expect(request.body.stream_options).toEqual({ include_usage: true });
    expect(request.body).not.toHaveProperty('usage');
    expect(request.body).not.toHaveProperty('prompt_tokens_details');
    expect(request.body).not.toHaveProperty('input_tokens_details');
    expect(request.body).not.toHaveProperty('cached_tokens');
    expect(request.body).not.toHaveProperty('cache_read_tokens');
    expect(request.body).not.toHaveProperty('billingDetails');
  });

  it('requests upstream usage details for streaming chat completions by default', () => {
    const request = buildUpstreamEndpointRequest({
      endpoint: 'chat',
      modelName: 'upstream-gpt',
      stream: true,
      tokenValue: 'sk-test',
      sitePlatform: 'sub2api',
      siteUrl: 'https://example.com',
      openaiBody: {
        model: 'gpt-5.2',
        messages: [{ role: 'user', content: 'hello' }],
      },
      downstreamFormat: 'openai',
    });

    expect(request.body.stream).toBe(true);
    expect(request.body.stream_options).toEqual({ include_usage: true });
  });

  it('preserves explicit streaming chat options while requesting upstream usage details', () => {
    const request = buildUpstreamEndpointRequest({
      endpoint: 'chat',
      modelName: 'upstream-gpt',
      stream: true,
      tokenValue: 'sk-test',
      sitePlatform: 'sub2api',
      siteUrl: 'https://example.com',
      openaiBody: {
        model: 'gpt-5.2',
        messages: [{ role: 'user', content: 'hello' }],
        stream_options: { include_obfuscation: true },
      },
      downstreamFormat: 'openai',
    });

    expect(request.body.stream_options).toEqual({
      include_obfuscation: true,
      include_usage: true,
    });
  });

  it('strips response-only usage and cache statistics before forwarding native responses requests', () => {
    const request = buildUpstreamEndpointRequest({
      endpoint: 'responses',
      modelName: 'upstream-gpt',
      stream: false,
      tokenValue: 'sk-test',
      sitePlatform: 'openai',
      siteUrl: 'https://example.com',
      openaiBody: {},
      downstreamFormat: 'responses',
      responsesOriginalBody: {
        model: 'gpt-5.2',
        input: 'hello',
        prompt_cache_key: 'cache-key-2',
        usage: {
          input_tokens: 10,
          input_tokens_details: { cached_tokens: 5 },
        },
        input_tokens_details: { cached_tokens: 5 },
        cache_creation_tokens: 3,
        billing_details: { source: 'local-log' },
      },
    });

    expect(request.body.prompt_cache_key).toBe('cache-key-2');
    expect(request.body).not.toHaveProperty('usage');
    expect(request.body).not.toHaveProperty('input_tokens_details');
    expect(request.body).not.toHaveProperty('cache_creation_tokens');
    expect(request.body).not.toHaveProperty('billing_details');
  });

  it('drops responses-style continuation fields before proxying Claude count_tokens upstream', () => {
    const request = buildClaudeCountTokensUpstreamRequest({
      modelName: 'claude-opus-4-6',
      tokenValue: 'sk-test',
      sitePlatform: 'claude',
      claudeBody: {
        model: 'claude-opus-4-6',
        max_tokens: 256,
        previous_response_id: 'resp_prev_1',
        prompt_cache_key: 'cache-key-1',
        messages: [{ role: 'user', content: 'hello' }],
      },
    });

    expect(request.body).toMatchObject({
      model: 'claude-opus-4-6',
      messages: [{ role: 'user' }],
    });
    expect(request.body).not.toHaveProperty('previous_response_id');
    expect(request.body).not.toHaveProperty('prompt_cache_key');
    expect(request.body).not.toHaveProperty('max_tokens');
    expect(request.body).not.toHaveProperty('maxTokens');
  });

  it('merges body betas with existing anthropic-beta headers for Claude count_tokens', () => {
    const request = buildClaudeCountTokensUpstreamRequest({
      modelName: 'claude-opus-4-6',
      tokenValue: 'sk-test',
      sitePlatform: 'claude',
      claudeBody: {
        model: 'claude-opus-4-6',
        betas: ['beta-from-body'],
        messages: [{ role: 'user', content: 'hello' }],
      },
      downstreamHeaders: {
        'anthropic-beta': 'header-beta',
      },
    });

    expect(request.headers['anthropic-beta']).toContain('header-beta');
    expect(request.headers['anthropic-beta']).toContain('beta-from-body');
  });
});
