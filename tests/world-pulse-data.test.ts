import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  parseGdelt,
  parseHN,
  parseDirectory,
  parseFilings,
  seedDirectory,
  gdeltUrl,
  SEC_DIRECTORY,
  HN_TOP,
} from '../server/world-pulse/data';
import { PulseStore, RETENTION_MS, groupEvents } from '../server/world-pulse/store';
import { DataHub } from '../server/world-pulse/hub';
import { WorldPulseService } from '../server/world-pulse/service';
import { SOURCES, parseSource } from '../server/world-pulse/sources';
const now = Date.parse('2026-09-20T12:00:00Z');
const iso = new Date(now).toISOString();
const directory = JSON.stringify({
  fields: ['cik', 'name', 'ticker', 'exchange'],
  data: [
    [1045810, 'NVIDIA Corporation', 'NVDA', 'Nasdaq'],
    [1, 'Invalid', '../host', 'NYSE'],
  ],
});
const company = parseDirectory(directory, iso).companies[0]!;
const gdelt = JSON.stringify({
  articles: [
    {
      title: 'Japan reports infrastructure investment',
      url: 'https://www.bbc.com/news/article',
      seendate: '20260920T110000Z',
    },
    { title: 'unsafe', url: 'javascript:alert(1)' },
  ],
});
const filing = JSON.stringify({
  cik: 1045810,
  filings: {
    recent: {
      accessionNumber: ['0001045810-26-000001'],
      form: ['8-K'],
      primaryDocument: ['nvda8k.htm'],
      filingDate: ['2026-09-20'],
    },
  },
});

test('GDELT preserves real publisher and discovery time, never fabricates publication; query parameters fixed', () => {
  const parsed = parseGdelt(gdelt, iso);
  assert.equal(parsed.events.length, 1);
  assert.equal(parsed.rejected, 1);
  assert.equal(parsed.events[0]!.sources[0]!.publisher, 'BBC');
  assert.equal(parsed.events[0]!.sources[0]!.feedId, 'gdelt-global');
  assert.equal(parsed.events[0]!.publishedAt, null);
  assert.equal(parsed.events[0]!.reports![0]!.firstSeenAt, '2026-09-20T11:00:00.000Z');
  const url = new URL(gdeltUrl(company));
  assert.equal(url.hostname, 'api.gdeltproject.org');
  assert.equal(url.searchParams.get('maxrecords'), '100');
  assert.match(url.searchParams.get('query')!, /NVIDIA Corporation/);
  assert.throws(() => parseGdelt('<html>blocked</html>', iso));
});
test('HN keeps submission time as context but uses local discovery for undated article retention', () => {
  const item = {
    id: 42,
    type: 'story',
    title: 'New processor',
    url: 'https://example.org/processor',
    time: Math.floor(now / 1000) - 3600,
    score: 70,
    descendants: 10,
  };
  const event = parseHN(item, iso)!;
  assert.equal(event.publishedAt, null);
  assert.equal(event.reports![0]!.firstSeenAt, iso);
  assert.equal(event.timeBasis, 'first-seen');
  assert.equal(event.community!.score, 70);
  assert.equal(event.community!.url, 'https://news.ycombinator.com/item?id=42');
  assert.equal(parseHN({ ...item, url: undefined }, iso), null);
  assert.equal(parseHN({ ...item, dead: true }, iso), null);
});
test('SEC identities carry authoritative provenance; seeds cannot pretend verified; specific filing validation', () => {
  assert.equal(company.id, 'NASDAQ:NVDA');
  assert.equal(company.verifiedAt, iso);
  assert.equal(company.cik, '1045810');
  assert.equal(seedDirectory().companies.length, 13);
  assert.equal(seedDirectory().companies[0]!.verifiedAt, undefined);
  const parsed = parseFilings(filing, company, iso);
  assert.equal(parsed.events[0]!.filing!.metadataOnly, true);
  assert.match(
    parsed.events[0]!.sources[0]!.url,
    /Archives\/edgar\/data\/1045810\/000104581026000001\/nvda8k.htm$/,
  );
  assert.equal(parsed.events[0]!.location, undefined);
  assert.throws(() => parseFilings(filing, { ...company, cik: '99' }, iso));
  assert.equal(
    parseFilings(filing.replace('nvda8k.htm', '../escape.htm'), company, iso).rejected,
    1,
  );
});
test('SQLite restart retains reports, sources, firstSeen and cache, expires rolling seven days', () => {
  const temp = mkdtempSync(join(tmpdir(), 'pulse-db-'));
  const path = join(temp, 'pulse.sqlite');
  try {
    const first = new PulseStore(path, now);
    const event = parseGdelt(gdelt, iso).events[0]!;
    first.ingest([event], now);
    first.set('test', { value: 1 }, now + 1000, now);
    const reopened = new PulseStore(path, now);
    assert.equal(reopened.events(now).length, 1);
    assert.equal(reopened.events(now)[0]!.reports![0]!.firstSeenAt, '2026-09-20T11:00:00.000Z');
    assert.deepEqual(reopened.get('test', now), { value: 1 });
    assert.equal(reopened.get('test', now + 1001), undefined);
    reopened.ingest([{ ...event, fetchedAt: new Date(now + 5000).toISOString() }], now + 5000);
    assert.equal(reopened.events(now)[0]!.reports![0]!.firstSeenAt, '2026-09-20T11:00:00.000Z');
    assert.equal(reopened.events(now + RETENTION_MS).length, 0);
  } finally {
    rmSync(temp, { recursive: true, force: true });
  }
});
test('extended source flow coalesces company requests, respects intervals and returns only verified identities', async () => {
  let clock = now,
    companyCalls = 0,
    filingCalls = 0;
  const store = new PulseStore(':memory:', now);
  const hub = new DataHub(
    store,
    async (url) => {
      if (url === SEC_DIRECTORY) return directory;
      if (url === HN_TOP) return '[42]';
      if (url.includes('/item/'))
        return JSON.stringify({
          id: 42,
          type: 'story',
          title: 'Processor',
          url: 'https://example.org/processor',
          time: now / 1000,
          score: 4,
        });
      if (url.includes('/submissions/')) {
        filingCalls++;
        return filing;
      }
      if (url.includes('api.gdeltproject.org') && url.includes('NVIDIA')) companyCalls++;
      return gdelt;
    },
    () => clock,
    'WorldPulse Test contact@example.invalid',
  );
  await hub.refresh();
  assert.equal((await hub.directory('NVDA')).companies[0]!.verifiedAt, iso);
  await Promise.all([hub.companyData(company.id), hub.companyData(company.id)]);
  assert.equal(companyCalls, 1);
  assert.equal(filingCalls, 1);
  assert.ok((await hub.companyData(company.id)).events.some((e) => e.filing));
  clock += 1800000;
  await hub.companyData(company.id);
  assert.equal(companyCalls, 2);
  assert.equal(filingCalls, 1);
  await assert.rejects(hub.companyData('USER:UNKNOWN'), /Unknown/);
});
test('failed SEC directory exposes seed fallback and blocks seed company retrieval without fake success', async () => {
  const hub = new DataHub(
    new PulseStore(':memory:', now),
    async () => {
      throw new Error('secret endpoint');
    },
    () => now,
    'WorldPulse',
  );
  const result = await hub.directory('NVDA');
  assert.equal(result.state, 'seed');
  assert.equal(result.companies.length, 1);
  const data = await hub.companyData(result.companies[0]!.id);
  assert.equal(data.events.length, 0);
  assert.equal(data.sources[0]!.state, 'error');
  assert.doesNotMatch(data.sources[0]!.error!, /secret/);
});
test('Chat Completions requires a local configuration, sends standard JSON, and distinguishes provider errors', async () => {
  assert.equal(new WorldPulseService({ sources: [], env: {} }).aiConfigured, false);
  const providerEnv = {
    LLM_API_URL: 'https://provider.example/v1/chat/completions',
    LLM_MODEL: 'test-model',
    LLM_API_KEY: 'test',
  };
  for (const [status, expected] of [
    [401, 'authentication_error'],
    [402, 'insufficient_balance'],
  ] as const) {
    const service = new WorldPulseService({
      sources: [],
      env: providerEnv,
      transport: async () => new Response('private', { status }),
    });
    assert.equal((await service.aiTest()).state, expected);
  }
  const service = new WorldPulseService({
    sources: [],
    env: providerEnv,
    transport: async (_url, init) => {
      const payload = JSON.parse(String(init!.body));
      assert.equal(payload.model, 'test-model');
      assert.equal(payload.thinking, undefined);
      assert.equal(payload.response_format.type, 'json_object');
      return new Response(JSON.stringify({ choices: [{ message: { content: '{"ok":true}' } }] }));
    },
  });
  assert.equal((await service.aiTest()).state, 'available');
  assert.equal(service.diagnostics().ai.state, 'available');
  assert.equal(service.diagnostics().databaseIntegrity, 'ok');
  assert.equal((await service.aiTest()).state, 'error');
  assert.equal(service.diagnostics().ai.state, 'available');
  const timeout = new WorldPulseService({
    sources: [],
    env: providerEnv,
    aiTimeoutMs: 10,
    transport: async () => new Promise(() => {}),
  });
  assert.equal((await timeout.aiTest()).state, 'timeout');
});
test('assessment is on demand, rejects invalid refs, discards completed assessments and rules without a key', async () => {
  const feed =
    '<rss><channel><item><title>Japan announces new national energy policy</title><link>https://example.org/news</link><pubDate>Sun, 20 Sep 2026 10:00:00 GMT</pubDate></item></channel></rss>';
  const event = parseSource(SOURCES[0]!, feed, iso).events[0]!;
  let calls = 0;
  const service = new WorldPulseService({
    sources: [SOURCES[0]!],
    now: () => now,
    env: {
      LLM_API_KEY: 'test',
      LLM_API_URL: 'https://provider.example/v1/chat/completions',
      LLM_MODEL: 'test-model',
    },
    transport: async (url, init) => {
      if (String(url).includes('feeds.bbci')) return new Response(feed);
      calls++;
      const body = JSON.parse(String(init!.body));
      assert.equal(body.thinking, undefined);
      return new Response(
        JSON.stringify({
          choices: [
            {
              message: {
                content: JSON.stringify({
                  level: 'watch',
                  reasons: ['政策需要关注。'],
                  sourceIds: ['bbc-world'],
                }),
              },
            },
          ],
        }),
      );
    },
  });
  await service.refresh();
  assert.equal(calls, 0);
  assert.equal((await service.assess(event.id)).method, 'ai');
  await service.assess(event.id);
  assert.equal(calls, 2);
  await assert.rejects(service.assess(event.id, 'USER:X'), /verified company/);
  const bad = new WorldPulseService({
    sources: [SOURCES[0]!],
    now: () => now,
    env: {
      LLM_API_KEY: 'test',
      LLM_API_URL: 'https://provider.example/v1/chat/completions',
      LLM_MODEL: 'test-model',
    },
    transport: async (url) =>
      String(url).includes('feeds.bbci')
        ? new Response(feed)
        : new Response(
            JSON.stringify({
              choices: [
                {
                  message: {
                    content: '{"level":"major","reasons":["unsupported"],"sourceIds":["invented"]}',
                  },
                },
              ],
            }),
          ),
  });
  await bad.refresh();
  await assert.rejects(bad.assess(event.id), /could not be validated/);
});

test('same-publisher grouped article URLs receive unique citation IDs with retained feed filter identity', () => {
  const a = parseGdelt(gdelt, iso).events[0]!;
  const title = 'Japan announces substantial new national infrastructure investment policy';
  const make = (id: string, url: string) => ({
    ...a,
    id,
    title,
    sources: [{ ...a.sources[0]!, id: 'bbc-world', feedId: undefined, url }],
    reports: [
      {
        ...a.reports![0]!,
        id: `${id}:report`,
        title,
        source: { ...a.sources[0]!, id: 'bbc-world', feedId: undefined, url },
      },
    ],
  });
  const grouped = groupEvents([
    make('one', 'https://bbc.com/one'),
    make('two', 'https://bbc.com/two'),
  ]);
  assert.equal(grouped.length, 1);
  assert.equal(new Set(grouped[0]!.sources.map((s) => s.id)).size, 2);
  assert.ok(grouped[0]!.sources.every((s) => s.feedId === 'bbc-world'));
  for (const report of grouped[0]!.reports!)
    assert.equal(
      grouped[0]!.sources.find((s) => s.id === report.source.id)!.url,
      report.source.url,
    );
});

test('assessment never enters snapshots or survives refresh/restart', async () => {
  const temp = mkdtempSync(join(tmpdir(), 'pulse-ai-'));
  const path = join(temp, 'pulse.sqlite');
  let clock = now;
  let headline = 'Japan announces new national energy policy';
  const transport: typeof fetch = async (url) =>
    String(url).includes('feeds.bbci')
      ? new Response(
          `<rss><channel><item><title>${headline}</title><link>https://example.org/persist</link><pubDate>Sun, 20 Sep 2026 10:00:00 GMT</pubDate></item></channel></rss>`,
        )
      : new Response(
          JSON.stringify({
            choices: [
              {
                message: {
                  content:
                    '{"level":"important","reasons":["政策需要关注。"],"sourceIds":["bbc-world"]}',
                },
              },
            ],
          }),
        );
  try {
    const s = new WorldPulseService({
      sources: [SOURCES[0]!],
      now: () => clock,
      storePath: path,
      env: {
        LLM_API_KEY: 'test',
        LLM_API_URL: 'https://provider.example/v1/chat/completions',
        LLM_MODEL: 'test-model',
      },
      transport,
    });
    await s.refresh();
    const id = s.snapshot().events[0]!.id;
    await s.assess(id);
    assert.equal(s.snapshot().events[0]!.importance, undefined);
    const reopened = new WorldPulseService({
      sources: [SOURCES[0]!],
      now: () => clock,
      storePath: path,
      env: {
        LLM_API_KEY: 'test',
        LLM_API_URL: 'https://provider.example/v1/chat/completions',
        LLM_MODEL: 'test-model',
      },
      transport,
    });
    assert.equal(reopened.snapshot().events[0]!.importance, undefined);
    assert.equal(reopened.snapshot().sources[0]!.state, 'fresh');
    clock += 600001;
    headline = 'Japan updates the new national energy policy with changed terms';
    await reopened.refresh();
    assert.equal(reopened.snapshot().events[0]!.importance, undefined);
  } finally {
    rmSync(temp, { recursive: true, force: true });
  }
});

test('SEC directory failure is attempted at most once per day', async () => {
  let clock = now,
    calls = 0;
  const hub = new DataHub(
    new PulseStore(':memory:', now),
    async () => {
      calls++;
      throw new Error('offline');
    },
    () => clock,
    'WorldPulse',
  );
  await hub.directory();
  clock += 3600000;
  await hub.directory();
  assert.equal(calls, 1);
  clock = now + 86400000;
  await hub.directory();
  assert.equal(calls, 2);
});

test('restart restores unexpired successful cache, while explicit failure remains stale', () => {
  const store = new PulseStore(':memory:', now);
  const source = {
    id: 'sec-directory',
    name: 'SEC',
    url: SEC_DIRECTORY,
    state: 'stale',
    lastSuccess: new Date(now - 1000).toISOString(),
    lastAttempt: new Date(now - 2000).toISOString(),
    nextRefresh: new Date(now + 86400000).toISOString(),
    count: 1,
    rejected: 0,
  };
  store.set('extended-statuses', [source], now + RETENTION_MS, now);
  const restored = new DataHub(
    store,
    async () => {
      throw Error('must not fetch');
    },
    () => now,
    'WorldPulse test',
  );
  assert.equal(restored.statusesSnapshot().find((s) => s.id === 'sec-directory')?.state, 'fresh');
  store.set('extended-statuses', [{ ...source, error: 'Last refresh failed' }], now + RETENTION_MS, now);
  const failed = new DataHub(
    store,
    async () => {
      throw Error('must not fetch');
    },
    () => now,
    'WorldPulse test',
  );
  assert.equal(failed.statusesSnapshot().find((s) => s.id === 'sec-directory')?.state, 'stale');
});
