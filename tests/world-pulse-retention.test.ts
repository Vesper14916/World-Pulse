import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PulseStore, RETENTION_MS, retainEvent } from '../server/world-pulse/store';
import type { PulseEvent, PulseReport } from '../shared/world-pulse';
const now = Date.parse('2026-09-20T12:00:00Z');
const iso = (time: number) => new Date(time).toISOString();
function report(id: string, time: number, published = true): PulseReport {
  return {
    id,
    title: `Report ${id}`,
    summary: id,
    publishedAt: published ? iso(time) : null,
    firstSeenAt: iso(time),
    source: { id, name: id, publisher: id, url: `https://example.org/${id}` },
  };
}
function event(reports: PulseReport[]): PulseEvent {
  return {
    id: 'event',
    title: reports[0]!.title,
    summary: reports[0]!.summary,
    reports,
    sources: reports.map((r) => r.source),
    publishedAt: reports[0]!.publishedAt,
    fetchedAt: iso(now),
    category: 'World',
    classificationBasis: 'test',
    importance: {
      level: 'major',
      method: 'ai',
      reasons: ['old'],
      sourceIds: ['old'],
    },
  };
}
test('168h boundary removes only old reports, source links and dependent assessment', () => {
  const store = new PulseStore(':memory:', now);
  const results = store.ingest(
    [event([report('old', now - RETENTION_MS + 1), report('new', now - 1000)])],
    now,
  );
  assert.equal(results[0]!.reports!.length, 2);
  const retained = store.events(now + 1)[0]!;
  assert.deepEqual(
    retained.sources.map((s) => s.id),
    ['new'],
  );
  assert.equal(retained.title, 'Report new');
  assert.equal(retained.importance, undefined);
  assert.equal(store.events(now + RETENTION_MS).length, 0);
  store.close();
});
test('undated repeated reports preserve firstSeen rather than reingestion time', () => {
  const store = new PulseStore(':memory:', now);
  const original = event([report('a', now, false)]);
  store.ingest([original], now);
  store.ingest([event([report('a', now + 100, false)])], now + 100);
  assert.equal(store.events(now + 100)[0]!.reports![0]!.firstSeenAt, iso(now));
  assert.equal(
    store.ingest([event([report('a', now + RETENTION_MS, false)])], now + RETENTION_MS).length,
    0,
  );
  store.close();
});
test('published timestamp is used even when report was discovered earlier', () => {
  const r = report('a', now - 1000);
  r.firstSeenAt = iso(now - RETENTION_MS);
  assert.ok(retainEvent(event([r]), now));
});
test('old dated reports cannot return; invalid dates use firstSeen and cache snapshots prune too', () => {
  const store = new PulseStore(':memory:', now);
  const old = event([report('old', now - RETENTION_MS)]);
  assert.equal(store.ingest([old], now).length, 0);
  const invalid = report('invalid', now - RETENTION_MS);
  invalid.publishedAt = 'not a date';
  assert.equal(retainEvent(event([invalid]), now), undefined);
  store.set('feed:test', { events: [old, event([report('new', now)])] }, now + RETENTION_MS, now);
  assert.equal(store.get<{ events: PulseEvent[] }>('feed:test', now)!.events.length, 1);
  store.close();
});
test('startup prunes offline data and preserves latest configuration and current budget', () => {
  const dir = mkdtempSync(join(tmpdir(), 'pulse-retention-'));
  try {
    const path = join(dir, 'test.sqlite');
    let store = new PulseStore(path, now);
    store.ingest([event([report('a', now)])], now);
    store.set('explain:x', { text: 'cached' }, now + RETENTION_MS * 2, now);
    store.setPersistent('filter-settings', { enabled: true });
    store.setPersistent('filter-budget', { month: '2026-09', spent: 0.25 });
    store.close();
    store = new PulseStore(path, now + RETENTION_MS);
    assert.equal(store.events(now + RETENTION_MS).length, 0);
    assert.equal(store.get('explain:x', now + RETENTION_MS), undefined);
    assert.deepEqual(store.getPersistent('filter-budget'), {
      month: '2026-09',
      spent: 0.25,
    });
    assert.deepEqual(store.getPersistent('filter-settings'), { enabled: true });
    store.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
test('dependent AI caches and assessment index are purged when an evidence report expires', () => {
  const store = new PulseStore(':memory:', now);
  store.ingest([event([report('old', now - RETENTION_MS + 1), report('new', now)])], now);
  store.set('explain:hash', { eventId: 'event', text: 'old evidence' }, now + RETENTION_MS, now);
  store.set('assess:hash', { eventId: 'event', level: 'major' }, now + RETENTION_MS, now);
  store.set('assessment-index', { event: [''], missing: [''] }, now + RETENTION_MS, now);
  store.prune(now + 1);
  assert.equal(store.get('explain:hash', now + 1), undefined);
  assert.equal(store.get('assess:hash', now + 1), undefined);
  assert.equal(store.get('assessment-index', now + 1), undefined);
  assert.equal(store.events(now + 1)[0]!.reports!.length, 1);
  store.close();
});

test('republishing the same source identity cannot extend its retained publication lifetime', () => {
  const store = new PulseStore(':memory:', now);
  store.ingest([event([report('a', now - RETENTION_MS + 1000)])], now);
  store.ingest([event([report('a', now + 500)])], now + 500);
  assert.equal(store.events(now + 1000).length, 0);
  store.close();
});

test('re-fetch advances synchronization time without changing first discovery or expiry', () => {
  const store = new PulseStore(':memory:', now);
  const original = event([report('a', now, false)]);
  original.firstSeenAt = iso(now);
  original.lastFetchedAt = iso(now);
  store.ingest([original], now);
  const refreshed = event([report('a', now + 60_000, false)]);
  refreshed.firstSeenAt = iso(now + 60_000);
  refreshed.lastFetchedAt = iso(now + 60_000);
  refreshed.reports![0]!.lastFetchedAt = iso(now + 60_000);
  store.ingest([refreshed], now + 60_000);
  const retained = store.events(now + 60_000)[0]!;
  assert.equal(retained.firstSeenAt, iso(now));
  assert.equal(retained.lastFetchedAt, iso(now + 60_000));
  assert.equal(retained.reports![0]!.firstSeenAt, iso(now));
  assert.equal(retained.reports![0]!.lastFetchedAt, iso(now + 60_000));
  assert.equal(store.events(now + RETENTION_MS).length, 0);
  store.close();
});
