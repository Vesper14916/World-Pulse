import test from 'node:test';
import assert from 'node:assert/strict';
import type { PulseCompany, PulseEvent, PulseQuote } from '../shared/world-pulse';
import {
  coverageRegions,
  coverageTimeline,
  morningBrief,
  portfolioSummary,
  radarFor,
  sinceReport,
} from '../src/services/world-pulse/portfolio';

const now = Date.parse('2026-09-21T12:00:00Z');
const nvda: PulseCompany = {
  id: 'NASDAQ:NVDA',
  symbol: 'NVDA',
  name: 'NVIDIA Corporation',
  exchange: 'NASDAQ',
  list: 'holdings',
  provenance: 'catalog',
  cik: '1045810',
  sourceUrl: 'https://investor.nvidia.com/',
  position: { shares: 10, cost: 100 },
};
const quote = (price: number, previousClose: number): PulseQuote => ({
  symbol: 'NVDA',
  price,
  change: price - previousClose,
  changePercent: ((price - previousClose) / previousClose) * 100,
  previousClose,
  high: price,
  low: price,
  open: price,
  time: new Date(now).toISOString(),
  fetchedAt: new Date(now).toISOString(),
});
let counter = 0;
function story(title: string, hoursAgo: number, publisher = 'Reuters', country?: string): PulseEvent {
  const at = new Date(now - hoursAgo * 3_600_000).toISOString();
  const id = `e${counter++}`;
  const source = { id: `s-${publisher}`, name: publisher, publisher, url: `https://example.com/${id}` };
  return {
    id,
    title,
    summary: '',
    category: 'Technology',
    sources: [source],
    reports: [{ id: `${id}:r`, title, summary: '', source, publishedAt: at, firstSeenAt: at }],
    publishedAt: at,
    fetchedAt: at,
    classificationBasis: 'test',
    ...(country ? { location: { name: country, country, lat: 0, lon: 0, precision: 'country' as const, evidence: 'test' } } : {}),
  };
}

test('portfolio summary values positions with live quotes only', () => {
  const summary = portfolioSummary([nvda, { ...nvda, id: 'x', symbol: 'AMD', position: { shares: 5, cost: 50 } }], { NVDA: quote(120, 125) })!;
  assert.equal(summary.value, 1200);
  assert.equal(summary.dayChange, -50);
  assert.equal(summary.unrealized, 200);
  assert.equal(summary.positions, 2);
  assert.equal(summary.priced, 1);
  assert.equal(portfolioSummary([{ ...nvda, position: undefined }], {}), undefined);
});

test('radar flags large moves and coverage spikes with reasons', () => {
  const quiet = [story('Nvidia opens a new office', 30)];
  assert.equal(radarFor(nvda, quiet, quote(100, 99.5), now).level, 'quiet');
  const move = radarFor(nvda, [story('Nvidia shares slide after export rules', 2)], quote(96, 100), now);
  assert.equal(move.level, 'move');
  assert.match(move.reasons[0]!, /−?4\.00%|-4\.00%/);
  const spike = radarFor(
    nvda,
    [
      story('Nvidia unveils a chip', 1),
      story('Nvidia chip draws orders', 2, 'CNBC'),
      story('Nvidia supply deal widens', 3, 'Bloomberg'),
      story('Nvidia event recap', 50),
    ],
    quote(100, 100),
    now,
  );
  assert.equal(spike.level, 'spike');
  assert.equal(spike.stories24h, 3);
});

test('morning brief lists flagged companies first and quiet ones separately', () => {
  const brief = morningBrief(
    [nvda, { ...nvda, id: 'NASDAQ:MSFT', symbol: 'MSFT', name: 'Microsoft Corporation', cik: '789019', sourceUrl: 'https://www.microsoft.com/en-us/Investor/' }],
    [story('Nvidia shares slide after export rules', 2)],
    { NVDA: quote(96, 100) },
    [{ date: '2026-09-23', title: 'FOMC rate decision', kind: 'fomc' }],
    now,
  );
  assert.equal(brief.lines[0]!.symbol, 'NVDA');
  assert.match(brief.lines[0]!.text, /Nvidia shares slide/);
  assert.equal(brief.lines.at(-1)!.symbol, 'AHEAD');
  assert.deepEqual(brief.quiet, ['MSFT']);
});

test('coverage timeline and regions count stories, and since-report deltas need a recorded price', () => {
  const events = [story('A', 1, 'Reuters', 'US'), story('B', 30, 'Reuters', 'US'), story('C', 80, 'Reuters', 'CN')];
  const days = coverageTimeline(events, now);
  assert.equal(days.length, 7);
  assert.equal(days[6]!.count, 1);
  assert.equal(days.reduce((sum, day) => sum + day.count, 0), 3);
  assert.deepEqual(coverageRegions(events).map((r) => [r.country, r.count]), [['US', 2], ['CN', 1]]);
  assert.equal(sinceReport(null, quote(100, 99)), undefined);
  assert.equal(Math.round(sinceReport(80, quote(100, 99))!), 25);
});
