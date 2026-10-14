import test from 'node:test';
import assert from 'node:assert/strict';
import {
  conflictVisual,
  conflictMapProperties,
  CONFLICT_STYLES,
  CONFLICT_WINDOW_MS,
  activeWaveRank,
} from '../src/services/world-pulse/conflict-visual';
import { setOutletPreferences } from '../shared/world-pulse-quality';
import type { PulseEvent, PulseSource } from '../shared/world-pulse';

const now = Date.parse('2026-09-22T12:00:00Z');
const iso = (t: number) => new Date(t).toISOString();
const bbc: PulseSource = {
  id: 'bbc',
  name: 'BBC World',
  publisher: 'BBC',
  url: 'https://www.bbc.com/news/test',
};
const reuters: PulseSource = {
  id: 'reuters',
  name: 'Reuters',
  publisher: 'Reuters',
  url: 'https://www.reuters.com/world/test',
};
function event(title: string, offset = 3600000): PulseEvent {
  return {
    id: 'controlled-event',
    title,
    summary: 'Controlled fixture',
    category: 'World',
    fetchedAt: iso(now),
    publishedAt: iso(now - offset),
    firstSeenAt: iso(now - offset),
    sources: [bbc, reuters],
    classificationBasis: 'Test',
    location: {
      name: 'Test region',
      country: 'IR',
      lon: 56,
      lat: 26,
      precision: 'exact',
      evidence: 'Controlled coordinate',
    },
    reports: [bbc, reuters].map((source, i) => ({
      id: 'report' + i,
      title,
      summary: '',
      source,
      publishedAt: iso(now - offset),
      firstSeenAt: iso(now - offset),
    })),
  };
}

test('explicit English and Chinese wording drives radius and color, not coverage or importance', () => {
  for (const [title, scale, radius] of [
    ['Army reports localized fighting', 'localized', 24],
    ['军队发生小规模交火', 'localized', 24],
    ['Army fighting across multiple cities', 'intensive', 40],
    ['军队在多地交火', 'intensive', 40],
    ['Army launches large-scale offensive', 'large', 60],
    ['军队发动大规模攻势', 'large', 60],
    ['Iran military clash reported', 'unknown', 24],
  ] as const) {
    const e = event(title),
      v = conflictVisual(e, now);
    assert.equal(v.scale, scale, title);
    assert.equal(CONFLICT_STYLES[v.scale].radius, radius);
    assert.equal(v.eligible, true);
    assert.equal(v.evidence.length, 2);
    assert.equal(v.latestReportAt, iso(now - 3600000));
  }
  const e = event('Iran military clash reported');
  e.heat = { level: 'high', publishers24h: 900, newReports3h: 1000, reasons: [] };
  e.importance = { level: 'major', method: 'ai', reasons: [], sourceIds: [] };
  assert.equal(conflictVisual(e, now).scale, 'unknown');
});
test('concrete combat excludes speculative, threat, negated, exercise, metaphor and peace reporting', () => {
  for (const title of [
    'Iran may launch large-scale offensive',
    'Army plans attacks',
    'Army threatens large-scale invasion',
    'Army denies attacks',
    'Army says localized fighting, not a large-scale offensive',
    'Army fighting has ended',
    'No attacks by Iran military',
    'Military exercise tests airstrikes',
    'Iran trade war escalates',
    'Anniversary of army invasion',
    'Russian army invaded Ukraine in 2022',
    '2022年俄军发动大规模攻势',
    'Israel and Hamas discuss ceasefire',
    'How an army offensive changed history',
    '军队可能发动大规模攻势',
    '军方否认发动空袭',
    '军演模拟空袭',
    '历史回顾：军队发动大规模攻势',
    '双方达成停火后军队停止炮击',
  ]) {
    const v = conflictVisual(event(title), now);
    assert.equal(v.concrete, false, title);
    assert.equal(v.eligible, false, title);
  }
});
test('independence is based on eligible per-report outlets, never feed names or event source count', () => {
  const e = event('Army reports localized fighting');
  e.reports![1]!.source = {
    ...bbc,
    id: 'google-bbc',
    name: 'BBC News via Google',
    publisher: 'BBC News',
  };
  assert.equal(conflictVisual(e, now).recentOutlets, 1);
  assert.equal(conflictVisual(e, now).eligible, false);
  e.reports![1]!.source = reuters;
  e.reports![1]!.title = 'Army could launch attacks';
  assert.equal(conflictVisual(e, now).recentOutlets, 1);
  e.reports![1]!.title = e.title;
  e.reports![1]!.source = { ...reuters, url: 'javascript:alert(1)' };
  assert.equal(conflictVisual(e, now).recentOutlets, 1);
  e.reports![1]!.source = reuters;
  setOutletPreferences({ blocked: ['reuters'], trusted: [] });
  try {
    assert.equal(conflictVisual(e, now).eligible, false);
  } finally {
    setOutletPreferences({ blocked: [], trusted: [] });
  }
});
test('24-hour eligibility is cursor-relative with a closed recent boundary and no future evidence', () => {
  const e = event('Army launches large-scale offensive', CONFLICT_WINDOW_MS);
  assert.equal(conflictVisual(e, now).eligible, true);
  assert.equal(conflictVisual(e, now + 1).eligible, false);
  assert.equal(conflictVisual(e, now - 3600000).eligible, true);
  assert.equal(conflictVisual(e, now - CONFLICT_WINDOW_MS - 1).concrete, false);
  e.reports![1]!.publishedAt = iso(now + 1);
  assert.equal(conflictVisual(e, now).recentOutlets, 1);
});
test('expired scale wording cannot promote a fresh unknown-scale event', () => {
  const e = event('Iran military clash reported');
  e.reports!.push({
    ...e.reports![0]!,
    id: 'old',
    title: 'Army launches large-scale offensive',
    publishedAt: iso(now - CONFLICT_WINDOW_MS - 1),
  });
  assert.equal(conflictVisual(e, now).scale, 'unknown');
});
test('unlocated and invalid coordinates stay in the evidence list; country positions are explicit', () => {
  const e = event('Army reports localized fighting');
  e.location = undefined;
  assert.equal(conflictVisual(e, now).concrete, true);
  assert.equal(conflictVisual(e, now).eligible, false);
  e.location = {
    name: 'Iran',
    country: 'IR',
    lat: 32,
    lon: 54,
    precision: 'country',
    evidence: 'Country centroid',
  };
  assert.equal(conflictMapProperties(e, now).waveCountry, 1);
  e.location.lat = 91;
  assert.equal(conflictVisual(e, now).located, false);
});
test('aggregation properties separate highest reported scale from eligible wave scale and expire at second outlet age', () => {
  const high = event('Army launches large-scale offensive');
  high.reports = high.reports!.slice(0, 1);
  const low = event('Army reports localized fighting');
  low.reports![1]!.publishedAt = iso(now - 7200000);
  const h = conflictMapProperties(high, now),
    l = conflictMapProperties(low, now);
  assert.equal(Math.max(h.conflictRank, l.conflictRank), 3);
  assert.equal(Math.max(h.waveRank, l.waveRank), 1);
  assert.equal(l.waveExpires, now - 7200000 + CONFLICT_WINDOW_MS);
  assert.equal(conflictMapProperties(event('Iran military clash reported'), now).waveRank, 0);
});

test('a ceasefire or ended representative headline cannot inherit active waves from older member reports', () => {
  const e = event('Army launches large-scale offensive');
  e.title = 'Army announces ceasefire talks';
  assert.equal(conflictVisual(e, now).eligible, false);
});

test('an expired severe member cannot keep a live cluster red between network refreshes', () => {
  const until = [now + 10000, now + 10000, 0, now + 1];
  assert.equal(activeWaveRank(until, now), 3);
  assert.equal(activeWaveRank(until, now + 2), 1);
  assert.equal(activeWaveRank(until, now + 10001), -1);
});
