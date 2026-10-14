import test from 'node:test';
import assert from 'node:assert/strict';
import { parseSource, SOURCES, type SourceDefinition } from '../server/world-pulse/sources';
import { PulseStore, RETENTION_MS } from '../server/world-pulse/store';

const fetchedAt = '2026-09-20T12:00:00.000Z';
const directSource: SourceDefinition = {
  id: 'test-feed',
  name: 'Test feed',
  publisher: 'Test publisher',
  url: 'https://feed.example/rss.xml',
  category: 'World',
  intervalMs: 300_000,
  format: 'rss',
};
const rss = (fields: string, link = 'https://example.org/story') =>
  `<rss version="2.0"><channel><item><title>Test headline</title><link>${link}</link>${fields}</item></channel></rss>`;

test('public sources use the intended tiered local refresh cadence', () => {
  assert.ok(SOURCES.length > 6);
  assert.ok(SOURCES.every((source) => [300_000, 900_000, 3_600_000].includes(source.intervalMs)));
  assert.equal(SOURCES.find((source) => source.id === 'npr-world')?.intervalMs, 300_000);
  assert.equal(SOURCES.find((source) => source.id === 'nasa-news')?.intervalMs, 900_000);
  assert.equal(SOURCES.find((source) => source.id === 'ecb-press')?.intervalMs, 3_600_000);
});

test('source publication, source update, and discovery-only time bases remain distinct', () => {
  const published = parseSource(
    directSource,
    rss(
      '<pubDate>Sun, 20 Sep 2026 09:00:00 GMT</pubDate><updated>2026-09-20T10:00:00Z</updated>',
    ),
    fetchedAt,
  ).events[0]!;
  assert.equal(published.publishedAt, '2026-09-20T09:00:00.000Z');
  assert.equal(published.timeBasis, 'source-published');
  assert.equal(published.firstSeenAt, fetchedAt);
  assert.equal(published.lastFetchedAt, fetchedAt);

  const updated = parseSource(
    directSource,
    rss('<pubDate>not-a-date</pubDate><updated>2026-09-20T10:00:00Z</updated>'),
    fetchedAt,
  ).events[0]!;
  assert.equal(updated.publishedAt, '2026-09-20T10:00:00.000Z');
  assert.equal(updated.timeBasis, 'source-updated');

  const discovered = parseSource(
    directSource,
    rss('<pubDate>not-a-date</pubDate><updated>also-not-a-date</updated>'),
    fetchedAt,
  ).events[0]!;
  assert.equal(discovered.publishedAt, null);
  assert.equal(discovered.timeBasis, 'first-seen');
  assert.equal(discovered.firstSeenAt, fetchedAt);
  assert.equal(discovered.lastFetchedAt, fetchedAt);
});

test('Google News query feeds retain the item publisher without counting the channel as a publisher', () => {
  const channel = SOURCES.find((source) => source.id === 'cn-geekpark')!;
  const body = rss(
    '<source url="https://www.geekpark.net/">极客公园</source><pubDate>Sun, 20 Sep 2026 09:00:00 GMT</pubDate>',
  );
  const first = parseSource(channel, body, fetchedAt).events[0]!.sources[0]!;
  assert.equal(first.publisher, '极客公园');
  assert.equal(first.name, '极客公园');
  assert.equal(first.feedId, 'cn-geekpark');
  assert.notEqual(first.id, first.feedId);

  const otherChannel = { ...channel, id: 'another-query-channel' };
  const second = parseSource(otherChannel, body, fetchedAt).events[0]!.sources[0]!;
  assert.equal(second.id, first.id);
  assert.equal(second.feedId, 'another-query-channel');
});

test('re-fetching an undated report updates retrieval metadata without extending retention', () => {
  const start = Date.parse(fetchedAt);
  const store = new PulseStore(':memory:', start);
  try {
    const body = rss('');
    store.ingest([parseSource(directSource, body, fetchedAt).events[0]!], start);
    const later = start + 60 * 60 * 1000;
    store.ingest(
      [parseSource(directSource, body, new Date(later).toISOString()).events[0]!],
      later,
    );
    assert.equal(store.events(later)[0]!.reports![0]!.firstSeenAt, fetchedAt);
    assert.equal(store.events(start + RETENTION_MS).length, 0);
  } finally {
    store.close();
  }
});
