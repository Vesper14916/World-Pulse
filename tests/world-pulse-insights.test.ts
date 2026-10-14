import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  attentionForEvent,
  companyPriority,
  directCompanyMatch,
  eventContentVersion,
  heatForEvent,
  observedEventTime,
  publicImportance,
  rankEvents,
} from '../shared/world-pulse-insights.ts';
import type { PulseCompany, PulseEvent, PulseReport } from '../shared/world-pulse.ts';

const now = Date.parse('2026-09-20T12:00:00Z');
const nvidia: PulseCompany = {
  id: 'NASDAQ:NVDA',
  symbol: 'NVDA',
  name: 'NVIDIA Corporation',
  exchange: 'NASDAQ',
  list: 'holdings',
  provenance: 'catalog',
};
const apple: PulseCompany = {
  id: 'NASDAQ:AAPL',
  symbol: 'AAPL',
  name: 'Apple Inc.',
  exchange: 'NASDAQ',
  list: 'holdings',
  provenance: 'catalog',
};
function report(index: number, changes: Partial<PulseReport> = {}): PulseReport {
  return {
    id: `r${index}`,
    title: `Independent report ${index}`,
    summary: `Original details from reporter ${index}.`,
    source: {
      id: `s${index}`,
      feedId: `feed${index}`,
      name: `Source ${index}`,
      publisher: `Publisher ${index}`,
      url: `https://publisher${index}.example/report${index}`,
    },
    publishedAt: '2026-09-20T11:00:00Z',
    firstSeenAt: '2026-09-20T11:05:00Z',
    ...changes,
  };
}
function event(changes: Partial<PulseEvent> = {}): PulseEvent {
  const original = report(0);
  return {
    id: 'e1',
    title: original.title,
    summary: original.summary,
    category: 'Technology',
    sources: [original.source],
    publishedAt: original.publishedAt,
    fetchedAt: original.firstSeenAt,
    classificationBasis: 'Source classification',
    ...changes,
  };
}
function withReports(reports: PulseReport[]): PulseEvent {
  return event({ reports, sources: reports.map((item) => item.source) });
}

test('heat thresholds use observed independent publishers, not number of company matches', () => {
  assert.equal(heatForEvent(withReports([report(1)]), now).level, 'unassessed');
  assert.equal(heatForEvent(withReports([report(1), report(2)]), now).level, 'rising');
  assert.equal(heatForEvent(withReports([report(1), report(2), report(3)]), now).level, 'popular');
  const high = withReports([1, 2, 3, 4, 5].map((index) => report(index)));
  assert.equal(heatForEvent(high, now).level, 'high');
  assert.deepEqual(
    heatForEvent({ ...high, companies: [nvidia, apple], companyAssessments: {} }, now),
    heatForEvent(high, now),
  );
  assert.equal(
    heatForEvent(
      withReports(
        [1, 2, 3, 4, 5].map((index) => report(index, { publishedAt: '2026-09-20T05:00:00Z' })),
      ),
      now,
    ).level,
    'popular',
  );
});
test('syndicated identical text, repeated URLs and multiple feeds from one publisher do not inflate heat', () => {
  const original = report(1);
  const syndicated = report(2, {
    title: original.title,
    summary: original.summary,
  });
  const urlDuplicate = report(3, {
    source: {
      ...original.source,
      url: original.source.url + '?utm_source=feed',
    },
  });
  const samePublisher = report(4, {
    source: {
      ...report(4).source,
      publisher: original.source.publisher.toUpperCase(),
    },
  });
  const heat = heatForEvent(withReports([original, syndicated, urlDuplicate, samePublisher]), now);
  assert.equal(heat.publishers24h, 1);
  assert.equal(heat.newReports3h, 2);
  assert.equal(heat.level, 'unassessed');
});
test('publication windows do not treat refreshes as new reports', () => {
  const old = report(1, {
    publishedAt: '2026-09-18T12:00:00Z',
    firstSeenAt: '2026-09-20T11:59:00Z',
  });
  const future = report(2, { publishedAt: '2026-09-21T12:00:00Z' });
  assert.equal(heatForEvent(withReports([old, future]), now).publishers24h, 0);
  assert.equal(
    heatForEvent(event({ publishedAt: null, fetchedAt: new Date(now).toISOString() }), now)
      .publishers24h,
    0,
  );
});
test('unknown publication dates can use genuine discovery metadata with an explicit limitation', () => {
  const discovered = withReports([
    report(1, { publishedAt: null, firstSeenAt: '2026-09-20T10:00:00Z' }),
  ]);
  discovered.publishedAt = null;
  assert.equal(observedEventTime(discovered), Date.parse('2026-09-20T10:00:00Z'));
  const heat = heatForEvent(discovered, now);
  assert.equal(heat.newReports3h, 1);
  assert.ok(heat.reasons.some((reason) => reason.includes('unknown publication time')));
  assert.ok(Number.isNaN(observedEventTime(event({ publishedAt: null }))));
});
test('public importance cannot be inferred from heat, holdings or social votes', () => {
  const popular = withReports([1, 2, 3, 4, 5].map((index) => report(index)));
  popular.community = {
    provider: 'Hacker News',
    score: 5000,
    comments: 900,
    url: 'https://news.ycombinator.com/item?id=1',
  };
  popular.companies = [nvidia];
  assert.equal(publicImportance(popular).level, 'unassessed');
  const earthquake = event({
    category: 'Disasters',
    magnitude: 7.2,
    sources: [
      {
        id: 'usgs',
        name: 'USGS',
        publisher: 'USGS',
        url: 'https://earthquake.usgs.gov/earthquakes/eventpage/us123',
      },
    ],
  });
  assert.equal(publicImportance(earthquake).level, 'major');
  assert.deepEqual(publicImportance(earthquake).sourceIds, ['usgs']);
  assert.equal(
    publicImportance({ ...earthquake, sources: [report(1).source] }).level,
    'unassessed',
  );
});
test('company priority distinguishes subject, business context and incidental mention', () => {
  const subject = event({
    title: 'NVIDIA announces new chip',
    summary: 'A product announcement.',
  });
  const business = event({
    title: 'Industry outlook',
    summary: 'NVIDIA discusses its new chip production.',
  });
  const incidental = event({
    title: 'A broad overview',
    summary: 'Names mentioned included NVIDIA.',
  });
  assert.equal(companyPriority(subject, nvidia).level, 'important');
  assert.equal(companyPriority(business, nvidia).level, 'watch');
  assert.equal(companyPriority(incidental, nvidia).level, 'unassessed');
  assert.match(companyPriority(incidental, nvidia).reasons.join(' '), /Incidental/);
  assert.equal(
    companyPriority(event({ title: 'NVIDIA could file for bankruptcy' }), nvidia).level,
    'watch',
  );
  assert.equal(
    companyPriority(event({ title: 'NVIDIA files for bankruptcy' }), nvidia).level,
    'major',
  );
  assert.equal(
    companyPriority(event({ title: 'NVIDIA denies it filed for bankruptcy' }), nvidia).level,
    'watch',
  );
  assert.equal(
    companyPriority(event({ title: 'Apple Inc. announces partnership with NVIDIA' }), nvidia).level,
    'watch',
  );
});
test('personal ranking uses maximum relevant-company priority instead of summing mentions', () => {
  const single = event({
    id: 'single',
    title: 'NVIDIA files for bankruptcy',
    publishedAt: '2026-09-20T09:00:00Z',
  });
  const many = event({
    id: 'many',
    title: 'NVIDIA and Apple Inc. announce new products',
    publishedAt: '2026-09-20T11:00:00Z',
  });
  assert.deepEqual(
    rankEvents([many, single], 'personal', [nvidia, apple], now).map((item) => item.id),
    ['single', 'many'],
  );
  assert.deepEqual(
    rankEvents([many, single], 'personal', [apple], now).map((item) => item.id),
    ['many', 'single'],
  );
});
test('trending is capped at twenty while latest preserves full results', () => {
  const events = Array.from({ length: 25 }, (_, index) => event({ id: `event-${index}` }));
  assert.equal(rankEvents(events, 'trending', [], now).length, 20);
  assert.equal(rankEvents(events, 'latest', [], now).length, 25);
  assert.equal(events.length, 25);
});
test('filing issuer matches require equal CIK and an actual SEC source, not news query metadata', () => {
  const company = { ...nvidia, cik: '1045810' };
  const filing = event({
    title: 'Form 10-Q',
    sources: [
      {
        id: 'sec1',
        name: 'SEC',
        publisher: 'SEC',
        url: 'https://www.sec.gov/Archives/edgar/data/1045810/123/report.htm',
      },
    ],
    filing: {
      form: '10-Q',
      cik: '0001045810',
      accession: '123',
      metadataOnly: true,
    },
  });
  assert.equal(directCompanyMatch(filing, company)?.symbol, 'NVDA');
  assert.equal(companyPriority(filing, company).level, 'watch');
  assert.equal(
    directCompanyMatch({ ...filing, filing: { ...filing.filing!, cik: '123' } }, company),
    undefined,
  );
  assert.equal(directCompanyMatch({ ...filing, sources: [report(1).source] }, company), undefined);
  assert.equal(directCompanyMatch(event({ companies: [company] }), company), undefined);
});
test('matching finds the exact report source and does not treat ambiguous ordinary words as identities', () => {
  const linked = withReports([report(1), report(2, { title: 'Apple Inc. launches a product' })]);
  assert.equal(directCompanyMatch(linked, apple)?.sourceUrl, report(2).source.url);
  assert.equal(directCompanyMatch(event({ title: 'Apple harvests improve' }), apple), undefined);
  assert.equal(
    directCompanyMatch(event({ title: 'Apple harvests improve' }), {
      ...apple,
      provenance: 'user',
      name: 'Apple',
    }),
    undefined,
  );
});

test('verified SEC names reuse reviewed aliases only for the matching issuer CIK', () => {
  const secNvidia: PulseCompany = {
    ...nvidia,
    name: 'NVIDIA CORP',
    cik: '1045810',
    verifiedAt: '2026-09-20T10:00:00Z',
    sourceUrl: 'https://www.sec.gov/edgar/browse/?CIK=1045810',
  };
  assert.equal(
    directCompanyMatch(event({ title: 'NVIDIA announces a chip' }), secNvidia)?.term,
    'NVIDIA',
  );
  // WP-016: a verified registrant's own legal name yields its reporting name,
  // independent of the reviewed seed aliases.
  assert.equal(
    directCompanyMatch(event({ title: 'NVIDIA announces a chip' }), {
      ...secNvidia,
      cik: '99999',
    })?.term,
    'NVIDIA',
  );
  assert.equal(
    directCompanyMatch(event({ title: 'NVIDIA announces a chip' }), {
      ...secNvidia,
      provenance: 'user',
    }),
    undefined,
  );
  const secApple = {
    ...apple,
    name: 'APPLE INC',
    cik: '320193',
    verifiedAt: secNvidia.verifiedAt,
    sourceUrl: 'https://www.sec.gov/edgar/browse/?CIK=320193',
  };
  assert.equal(directCompanyMatch(event({ title: 'Apple harvests improve' }), secApple), undefined);
  assert.ok(directCompanyMatch(event({ title: 'Apple Inc. announces a product' }), secApple));
});
test('content version invalidates edited reporting but ignores volatile fetch and computed scores', () => {
  const original = event();
  const version = eventContentVersion(original);
  assert.equal(
    eventContentVersion({
      ...original,
      fetchedAt: '2099-01-01T00:00:00Z',
      heat: heatForEvent(original, now),
      importance: publicImportance(original),
    }),
    version,
  );
  assert.notEqual(eventContentVersion({ ...original, summary: 'A correction.' }), version);
  assert.notEqual(
    eventContentVersion({
      ...original,
      sources: [{ ...original.sources[0]!, url: 'https://corrected.example/article' }],
    }),
    version,
  );
});
test('stale or unrelated company assessments cannot override current evidence', () => {
  const base = event({ title: 'Apple Inc. announces a new product' });
  const ai = {
    level: 'major' as const,
    reasons: ['AI assessment'],
    method: 'ai' as const,
    companyId: nvidia.id,
    sourceIds: [base.sources[0]!.id],
    contentVersion: eventContentVersion(base),
  };
  const assessed = { ...base, companyAssessments: { [nvidia.id]: ai } };
  assert.equal(companyPriority(assessed, nvidia).level, 'unassessed');
  const stale = {
    ...base,
    importance: { ...ai, companyId: undefined, contentVersion: 'old' },
  };
  assert.equal(publicImportance(stale).level, 'unassessed');
});

test('attention keeps unknown null and maps increasing evidence monotonically', () => {
  assert.equal(attentionForEvent(event(), undefined, now).position, null);
  const source = {
    ...report(1).source,
    url: 'https://earthquake.usgs.gov/earthquakes/eventpage/test',
  };
  const quake = event({ sources: [source], magnitude: 5 });
  const watch = attentionForEvent(quake, undefined, now);
  const important = attentionForEvent({ ...quake, magnitude: 6 }, undefined, now);
  const major = attentionForEvent({ ...quake, magnitude: 7 }, undefined, now);
  assert(watch.position! < important.position! && important.position! < major.position!);
  const many = {
    ...quake,
    reports: [report(1), report(2), report(3)],
    sources: [source, report(2).source, report(3).source],
  };
  assert(attentionForEvent(many, undefined, now).position! >= watch.position!);
  assert.equal(attentionForEvent(quake, [], now).position, null);
});
test('attention company changes use maximum priority without modifying public scores', () => {
  const item = event({
    title: 'NVIDIA Corporation reports earnings and guidance',
    summary: 'NVIDIA Corporation released earnings.',
  });
  const before = JSON.stringify(item);
  const nv = attentionForEvent(item, [nvidia], now);
  const ap = attentionForEvent(item, [apple], now);
  assert.notEqual(nv.position, ap.position);
  assert.equal(attentionForEvent(item, [nvidia, apple], now).position, nv.position);
  assert.equal(JSON.stringify(item), before);
  assert.equal(attentionForEvent(item, undefined, now).importance.level, 'watch');
});

test('public baseline cites topical evidence without promoting speculation or vague news', () => {
  const policy = event({ title: '美联储宣布降息', summary: '' });
  assert.equal(publicImportance(policy).level, 'important');
  assert.deepEqual(publicImportance(policy).sourceIds, ['s0']);
  assert.equal(publicImportance(event({ title: '美联储可能降息吗？' })).level, 'unassessed');
  assert.equal(publicImportance(event({ title: 'IMF称世界经济面临风险' })).level, 'watch');
  assert.equal(publicImportance(event({ title: '今日观察' })).level, 'unassessed');
  assert.equal(publicImportance({ ...policy, sources: [] }).level, 'unassessed');
});
test('reviewed Chinese identity matches issuer but not ambiguous words or another CIK', () => {
  const issuer = { ...nvidia, cik: '1045810' };
  const news = event({ title: '英伟达发布新芯片', summary: '' });
  const match = directCompanyMatch(news, issuer);
  assert.equal(match?.term, '英伟达');
  assert.equal(companyPriority(news, issuer, match).level, 'important');
  assert.equal(directCompanyMatch(news, { ...issuer, cik: '1' }), undefined);
  assert.equal(
    directCompanyMatch(event({ title: '苹果丰收了', summary: '' }), {
      ...apple,
      cik: '320193',
    }),
    undefined,
  );
  assert.equal(
    directCompanyMatch(event({ title: '苹果公司公布财报', summary: '' }), {
      ...apple,
      cik: '320193',
    })?.term,
    '苹果公司',
  );
});

test('ambiguous brands require reviewed issuer and identifying product context', () => {
  const issuer = { ...apple, cik: '320193' };
  assert.equal(
    directCompanyMatch(event({ title: 'Apple announces a new iPhone', summary: '' }), issuer)?.term,
    'Apple',
  );
  assert.equal(
    directCompanyMatch(event({ title: 'Apple harvest improves', summary: '' }), issuer),
    undefined,
  );
  assert.equal(
    directCompanyMatch(event({ title: 'Apple announces a new iPhone', summary: '' }), {
      ...issuer,
      provenance: 'user',
    }),
    undefined,
  );
});
