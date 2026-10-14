import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { explanationInput, validateExplanation } from '../server/world-pulse/explanation';
import { PulseStore } from '../server/world-pulse/store';
import { WorldPulseService } from '../server/world-pulse/service';
import { SOURCES, parseSource } from '../server/world-pulse/sources';
import type { PulseArticle } from '../shared/world-pulse';

const now = Date.parse('2026-09-22T06:00:00Z');
const iso = new Date(now).toISOString();
const feed =
  '<rss><channel><item><title>Japan announces a new research center</title><link>https://example.org/research</link><description>The center is scheduled to open next year.</description><pubDate>Tue, 22 Sep 2026 05:00:00 GMT</pubDate></item></channel></rss>';
const event = parseSource(SOURCES[0]!, feed, iso).events[0]!;
const sourceId = event.sources[0]!.id;
const statements = [
  { section: 'core', kind: 'fact', text: '报道公布新研究中心。', sourceIds: [sourceId] },
  {
    section: 'impact',
    kind: 'inference',
    text: '若按期开放，可能增加研发活动。',
    sourceIds: [sourceId],
  },
  { section: 'watch', kind: 'question', text: '应核实具体开设时间。', sourceIds: [sourceId] },
];

test('analysis consumes bounded, already-read matching article excerpts and identifies headline-only input', () => {
  const headline = explanationInput(event, []);
  assert.equal(headline.basis.mode, 'headlines');
  const article: PulseArticle = {
    eventId: event.id,
    reportId: sourceId,
    title: event.title,
    source: event.sources[0]!,
    sourceUrl: event.sources[0]!.url,
    paragraphs: ['正文证据'.repeat(6000)],
    state: 'available',
    fetchedAt: iso,
    cached: true,
  };
  const full = explanationInput(event, [article]);
  assert.equal(full.basis.articleCount, 1);
  assert.equal(full.input.reports[0]!.articleExcerpt!.length, 9000);
  assert.equal(full.input.reports[0]!.articleFetchedAt, iso);
  assert.equal(explanationInput(event, [{ ...article, eventId: 'other' }]).basis.articleCount, 0);
  assert.equal(
    explanationInput(event, [{ ...article, source: { ...article.source, id: 'other' } }]).basis
      .articleCount,
    0,
  );
  assert.equal(
    explanationInput(event, [{ ...article, state: 'unavailable' }]).basis.articleCount,
    0,
  );
});

test('structured analysis requires facts, separate inference, questions and known references', () => {
  const ids = new Set([sourceId]);
  assert.equal(validateExplanation({ statements }, ids).length, 3);
  for (const change of [
    { sourceIds: ['invented'] },
    { kind: 'fact' },
    { section: '__proto__' },
    { text: '<script>wrong</script>' },
    { text: 'https://invented.example' },
    { text: '' },
  ])
    assert.throws(() =>
      validateExplanation(
        { statements: [statements[0], { ...statements[1], ...change }, statements[2]] },
        ids,
      ),
    );
  assert.throws(() => validateExplanation({ statements: [statements[0]] }, ids));
  assert.throws(() =>
    validateExplanation({ statements: [statements[0], statements[0], statements[0]] }, ids),
  );
});

test('startup removes legacy AI prose and embedded assessments, preserves news/configuration/aggregate budget', () => {
  const folder = mkdtempSync(join(tmpdir(), 'pulse-ephemeral-'));
  const path = join(folder, 'pulse.sqlite');
  const marker = 'PRIVATE_AI_PROSE_MUST_DISAPPEAR';
  try {
    const store = new PulseStore(path, now);
    store.ingest([event], now);
    store.setPersistent('ai-master-enabled', false);
    store.setPersistent('manual-ai-budget', { spentRmb: 0.01, inputTokens: 20 });
    store.close();
    const db = new DatabaseSync(path);
    for (const key of ['explain:legacy', 'assess:legacy', 'brief:legacy', 'assessment-index'])
      db.prepare('INSERT INTO records VALUES (?,?,?)').run(
        key,
        JSON.stringify({ text: marker }),
        now + 60000,
      );
    const aiEvent = {
      ...event,
      importance: { method: 'ai', reasons: [marker] },
      companyAssessments: { test: { method: 'ai', reasons: [marker] } },
    };
    db.prepare('UPDATE events SET value=?').run(JSON.stringify(aiEvent));
    db.prepare('INSERT INTO records VALUES (?,?,?)').run(
      'source:test',
      JSON.stringify({ events: [aiEvent] }),
      now + 60000,
    );
    db.close();
    const migrated = new PulseStore(path, now);
    assert.equal(migrated.events(now).length, 1);
    assert.equal(migrated.events(now)[0]!.importance, undefined);
    assert.equal(migrated.events(now)[0]!.companyAssessments, undefined);
    assert.equal(migrated.getPersistent('ai-master-enabled'), false);
    assert.equal(migrated.getPersistent<{ spentRmb: number }>('manual-ai-budget')!.spentRmb, 0.01);
    for (const key of ['explain:legacy', 'assess:legacy', 'brief:legacy', 'assessment-index']) {
      assert.equal(migrated.get(key, now), undefined);
      migrated.set(key, { text: marker }, now + 60000, now);
      assert.equal(migrated.get(key, now), undefined);
    }
    migrated.close();
    assert.equal(readFileSync(path).includes(Buffer.from(marker)), false);
  } finally {
    rmSync(folder, { recursive: true, force: true });
  }
});

test('service uses public article text on demand and completed explanation/brief/assessment never reaches database', async () => {
  const folder = mkdtempSync(join(tmpdir(), 'pulse-private-'));
  const path = join(folder, 'pulse.sqlite');
  let calls = 0,
    suppliedArticle = false;
  const service = new WorldPulseService({
    storePath: path,
    sources: [SOURCES[0]!],
    now: () => now,
    env: {
      LLM_API_KEY: 'test',
      LLM_API_URL: 'https://model.example/v1/chat/completions',
      LLM_MODEL: 'test-model',
    },
    transport: async (url, init) => {
      if (String(url).includes('feeds.bbci')) return new Response(feed);
      if (String(url).includes('example.org'))
        return new Response(
          '<html><body><article><p>The research center will open next year. It is intended to support scientific research and international cooperation, according to the announcement.</p><p>The announcement sets out a schedule for construction and says that a detailed timetable will be published later this year.</p></article></body></html>',
          { headers: { 'Content-Type': 'text/html' } },
        );
      calls++;
      const body = JSON.parse(String(init!.body));
      const data = JSON.parse(body.messages[1].content);
      const isBrief = Array.isArray(data);
      const isAssessment = body.max_tokens === 700;
      if (!isBrief && !isAssessment)
        suppliedArticle = data.reports.some((r: { articleExcerpt?: string }) =>
          r.articleExcerpt?.includes('research center'),
        );
      return new Response(
        JSON.stringify({
          choices: [
            {
              message: {
                content: JSON.stringify(
                  isBrief
                    ? { text: '临时晨报内容。' }
                    : isAssessment
                      ? { level: 'watch', reasons: ['临时评估。'], sourceIds: [sourceId] }
                      : { statements },
                ),
              },
            },
          ],
          usage: { prompt_tokens: 50, completion_tokens: 100 },
        }),
      );
    },
  });
  try {
    await service.refresh();
    const id = service.snapshot().events[0]!.id;
    const article = await service.article(id);
    assert.equal(article.state, 'available');
    const result = await service.explain(id);
    assert.equal(suppliedArticle, true);
    assert.equal(result.basis.mode, 'article-excerpts');
    await service.explain(id);
    await service.polishBrief(['A public research announcement.']);
    await service.assess(id);
    assert.equal(calls, 4);
    const db = new DatabaseSync(path);
    assert.equal(
      db
        .prepare(
          "SELECT count(*) AS n FROM records WHERE key GLOB 'explain:*' OR key GLOB 'assess:*' OR key GLOB 'brief:*'",
        )
        .get()!.n,
      0,
    );
    assert.doesNotMatch(
      JSON.stringify(db.prepare('SELECT value FROM records').all()),
      /临时晨报|临时评估|若按期开放/,
    );
    assert.equal(service.snapshot().events[0]!.importance, undefined);
    db.close();
  } finally {
    service.stop();
    rmSync(folder, { recursive: true, force: true });
  }
});
