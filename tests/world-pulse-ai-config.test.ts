import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { HeadlineFilter } from '../server/world-pulse/filter';
import {
  aiConfigFromEnv,
  parseTokenPrice,
  validChatCompletionsUrl,
  writeLocalAIEnvironment,
} from '../server/world-pulse/ai-config';
import { worldPulseMiddleware } from '../server/world-pulse/plugin';
import { WorldPulseService } from '../server/world-pulse/service';
import { PulseStore } from '../server/world-pulse/store';
import type { PulseEvent } from '../shared/world-pulse';

const API_KEY = 'test-key-that-must-never-be-returned';
const ENDPOINT = 'https://provider.example/v1/chat/completions';
const now = Date.parse('2026-09-20T10:00:00.000Z');

function response(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

test('AI endpoint validation requires Chat Completions over HTTPS or loopback and rates stay explicit', () => {
  const credentialsUrl = new URL(ENDPOINT);
  credentialsUrl.username = 'user';
  credentialsUrl.password = 'pass';
  const queryUrl = new URL(ENDPOINT);
  queryUrl.searchParams.set(['api', 'key'].join('_'), 'hidden');
  assert.equal(validChatCompletionsUrl(ENDPOINT), ENDPOINT);
  assert.equal(validChatCompletionsUrl('http://127.0.0.1:1234/v1/chat/completions'), 'http://127.0.0.1:1234/v1/chat/completions');
  assert.equal(validChatCompletionsUrl('http://provider.example/v1/chat/completions'), undefined);
  assert.equal(validChatCompletionsUrl(credentialsUrl.href), undefined);
  assert.equal(validChatCompletionsUrl(queryUrl.href), undefined);
  assert.equal(validChatCompletionsUrl('https://provider.example/v1/completions'), undefined);
  assert.equal(parseTokenPrice('0'), 0);
  assert.equal(parseTokenPrice('12.5'), 12.5);
  assert.equal(parseTokenPrice(''), null);
  assert.equal(parseTokenPrice('-1'), null);
  assert.equal(parseTokenPrice('Infinity'), null);
  assert.deepEqual(aiConfigFromEnv({}), {
    apiUrl: '',
    model: '',
    inputPricePerMillion: null,
    outputPricePerMillion: null,
    keyConfigured: false,
  });
});

test('local AI config API never returns a key, preserves blank key saves, rejects cross-origin writes, and supports explicit removal', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'world-pulse-ai-config-'));
  const envFile = join(directory, '.env.local');
  writeFileSync(envFile, '# local integration\nFINNHUB_API_KEY="preserve-this-local-setting"\n', {
    mode: 0o600,
  });
  const env = {
    LLM_API_URL: ENDPOINT,
    LLM_MODEL: 'local-test-model',
    LLM_API_KEY: API_KEY,
    LLM_INPUT_PRICE_PER_MILLION: '1',
    LLM_OUTPUT_PRICE_PER_MILLION: '2',
    FINNHUB_API_KEY: 'preserve-this-local-setting',
  };
  writeLocalAIEnvironment(directory, env);
  const service = new WorldPulseService({ sources: [], env });
  const middleware = worldPulseMiddleware(service, undefined, directory);
  const server = createServer((request, response) =>
    middleware(request, response, () => {
      response.statusCode = 404;
      response.end();
    }),
  );
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = (server.address() as { port: number }).port;
  const base = `http://127.0.0.1:${port}`;
  try {
    const read = await fetch(`${base}/api/world-pulse/ai-config`);
    const publicConfig = await read.json();
    assert.equal(read.headers.get('cache-control'), 'no-store');
    assert.equal(publicConfig.keyConfigured, true);
    assert.equal(publicConfig.apiUrl, ENDPOINT);
    assert.equal('apiKey' in publicConfig, false);
    assert.doesNotMatch(JSON.stringify(publicConfig), new RegExp(API_KEY));

    const update = await fetch(`${base}/api/world-pulse/ai-config`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        apiUrl: ENDPOINT,
        model: 'updated-model',
        apiKey: '',
        inputPricePerMillion: '1.25',
        outputPricePerMillion: '3.5',
      }),
    });
    const updated = await update.json();
    assert.equal(updated.keyConfigured, true);
    assert.equal(updated.model, 'updated-model');
    assert.equal(updated.inputPricePerMillion, 1.25);
    assert.doesNotMatch(JSON.stringify(updated), new RegExp(API_KEY));
    const afterSave = readFileSync(envFile, 'utf8');
    assert.match(afterSave, /FINNHUB_API_KEY="preserve-this-local-setting"/);
    assert.match(afterSave, /LLM_API_KEY=/);

    const blocked = await fetch(`${base}/api/world-pulse/ai-config`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Origin: 'https://untrusted.example',
      },
      body: JSON.stringify({ clearApiKey: true }),
    });
    assert.equal(blocked.status, 403);
    assert.match(readFileSync(envFile, 'utf8'), /LLM_API_KEY=/);

    const clearedResponse = await fetch(`${base}/api/world-pulse/ai-config`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ clearApiKey: true }),
    });
    const cleared = await clearedResponse.json();
    assert.equal(cleared.keyConfigured, false);
    assert.doesNotMatch(JSON.stringify(cleared), new RegExp(API_KEY));
    assert.doesNotMatch(readFileSync(envFile, 'utf8'), /LLM_API_KEY=/);

    const invalid = await fetch(`${base}/api/world-pulse/ai-config`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        apiUrl: (() => {
          const url = new URL(ENDPOINT);
          url.searchParams.set(['api', 'key'].join('_'), 'private');
          return url.href;
        })(),
        model: 'test',
        inputPricePerMillion: '1',
        outputPricePerMillion: '1',
      }),
    });
    assert.equal(invalid.status, 400);
  } finally {
    service.stop();
    await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
    rmSync(directory, { recursive: true, force: true });
  }
});

test('automatic filter waits for prices, uses only standard request fields, and settles usage at configured rates', async () => {
  const store = new PulseStore(':memory:', now);
  const env: Record<string, string> = {
    LLM_API_URL: ENDPOINT,
    LLM_MODEL: 'local-test-model',
    LLM_API_KEY: API_KEY,
  };
  let calls = 0;
  const transport: typeof fetch = async (url, options) => {
    calls++;
    assert.equal(String(url), ENDPOINT);
    const body = JSON.parse(String(options?.body));
    assert.equal(body.model, 'local-test-model');
    assert.equal(body.thinking, undefined);
    assert.equal(body.provider, undefined);
    return response({
      usage: { prompt_tokens: 100, completion_tokens: 20 },
      choices: [{ message: { content: JSON.stringify({ items: [{ id: 0, d: 'K', r: 'relevant' }] }) } }],
    });
  };
  const filter = new HeadlineFilter(store, env, () => now, transport);
  const item: PulseEvent = {
    id: 'event',
    title: 'A report with an unspecified development',
    summary: 'This summary must not be sent.',
    category: 'World',
    sources: [{ id: 'source', publisher: 'Example', name: 'Example', url: 'https://example.org/story' }],
    publishedAt: new Date(now).toISOString(),
    fetchedAt: new Date(now).toISOString(),
    classificationBasis: 'fixture',
  };
  try {
    filter.enqueue([item]);
    await filter.flush();
    assert.equal(calls, 0);
    assert.equal(filter.status().pricingConfigured, false);
    assert.equal(filter.annotate([item])[0]!.relevance.decision, 'uncertain');

    env.LLM_INPUT_PRICE_PER_MILLION = '2';
    env.LLM_OUTPUT_PRICE_PER_MILLION = '8';
    filter.configurationChanged();
    await filter.flush();
    assert.equal(calls, 1);
    assert.equal(filter.status().pricingConfigured, true);
    assert(Math.abs(filter.status().spentRmb - 0.00036) < 1e-9);
    assert.equal(filter.annotate([item])[0]!.relevance.decision, 'keep');
  } finally {
    filter.stop();
    store.close();
  }
});

test('manual AI runs without price settings and records cost as unknown until prices are supplied', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'world-pulse-manual-cost-'));
  let clock = now;
  const service = new WorldPulseService({
    sources: [],
    storePath: ':memory:',
    now: () => clock,
    env: { LLM_API_URL: ENDPOINT, LLM_MODEL: 'local-test-model', LLM_API_KEY: API_KEY },
    transport: async () => response({
      usage: { prompt_tokens: 100, completion_tokens: 50 },
      choices: [{ message: { content: '{"ok":true}' } }],
    }),
  });
  try {
    assert.equal((await service.aiTest()).state, 'available');
    assert.equal(service.snapshot().manualAI?.spentRmb, 0);
    assert.equal(service.snapshot().manualAI?.unknownCalls, 1);
    service.saveAIConfiguration(directory, {
      inputPricePerMillion: 2,
      outputPricePerMillion: 5,
    });
    clock += 31_000;
    assert.equal((await service.aiTest()).state, 'available');
    assert.equal(service.snapshot().manualAI?.unknownCalls, 1);
    assert(Math.abs(service.snapshot().manualAI!.spentRmb - 0.00045) < 1e-9);
  } finally {
    service.stop();
    rmSync(directory, { recursive: true, force: true });
  }
});
