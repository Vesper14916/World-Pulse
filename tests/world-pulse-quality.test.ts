import assert from 'node:assert/strict';
import test from 'node:test';
import type { PulseCompany, PulseEvent, PulseSource } from '../shared/world-pulse';
import {
  articleKey,
  assessReport,
  cleanHeadline,
  eventQuality,
  lowValueHeadline,
  outletFor,
  setOutletPreferences,
} from '../shared/world-pulse-quality';
import { deriveReportingNames } from '../shared/company-names';
import { directCompanyMatch, heatForEvent } from '../shared/world-pulse-insights';
import { clusterPulseEvents } from '../server/world-pulse/clustering';

const now = Date.parse('2026-09-21T12:00:00Z');
const google = (publisher: string, domain?: string): PulseSource => ({
  id: `publisher:${publisher}`,
  name: publisher,
  publisher,
  url: `https://news.google.com/rss/articles/${encodeURIComponent(publisher)}${Math.random()}`,
  feedId: 'global-en-economy',
  ...(domain ? { domain } : {}),
});
function event(id: string, title: string, source: PulseSource, hoursAgo = 1, category: PulseEvent['category'] = 'Economy'): PulseEvent {
  const at = new Date(now - hoursAgo * 3_600_000).toISOString();
  return {
    id,
    title,
    summary: '',
    category,
    sources: [source],
    reports: [{ id: `${id}:r`, title, summary: '', source, publishedAt: at, firstSeenAt: at }],
    publishedAt: at,
    fetchedAt: at,
    classificationBasis: 'test',
  };
}

test('outlet aliases collapse to one canonical publisher', () => {
  assert.equal(outletFor('证券时报社').key, outletFor('证券时报').key);
  assert.equal(outletFor('21财经').key, outletFor('21世纪经济报道').key);
  assert.equal(outletFor('fj.chinanews.com.cn').key, outletFor('中国新闻社').key);
  assert.equal(outletFor('Jiemian.com').key, outletFor('界面新闻').key);
  assert.equal(outletFor('Bloomberg.com').key, 'bloomberg');
  assert.equal(outletFor('Unknown Herald', undefined, 'news.unknownherald.com').tier, 'B');
  assert.equal(outletFor('Some Agency', undefined, 'www.energy.gov').tier, 'A');
  assert.equal(outletFor('The Motley Fool').tier, 'C');
});

test('google-news suffixes are stripped only when they name the outlet', () => {
  assert.equal(
    cleanHeadline('俄美计划未来几周内举行新一轮会谈 - 每日经济新闻', google('每日经济新闻')),
    '俄美计划未来几周内举行新一轮会谈',
  );
  assert.equal(cleanHeadline('Nvidia boss says AI is safe - The Guardian', google('The Guardian')), 'Nvidia boss says AI is safe');
  const direct: PulseSource = { id: 'bbc', name: 'BBC', publisher: 'BBC', url: 'https://www.bbc.co.uk/news/1' };
  assert.equal(cleanHeadline('Ukraine war - live updates', direct), 'Ukraine war - live updates');
  assert.equal(cleanHeadline('Talks resume in Geneva - BBC News', direct), 'Talks resume in Geneva');
});

test('low-value headline patterns and user block/trust lists', () => {
  assert.ok(lowValueHeadline('Nasdaq Future Prediction LIVE: Index Gains 1.33% Ahead of Monday'));
  assert.ok(lowValueHeadline('3 Top AI Stocks to Buy Right Now'));
  assert.ok(lowValueHeadline('第2页-要闻-首页'));
  assert.equal(lowValueHeadline('Fed holds rates steady as inflation cools'), undefined);
  const report = { title: 'Nvidia earnings beat', source: google('Tekedia') };
  assert.equal(assessReport(report).quality, 'B');
  setOutletPreferences({ blocked: [outletFor('Tekedia').key], trusted: [] });
  assert.equal(assessReport(report).quality, 'blocked');
  setOutletPreferences({ blocked: [], trusted: [outletFor('The Motley Fool').key] });
  assert.equal(assessReport({ title: 'Nvidia report', source: google('The Motley Fool') }).quality, 'B');
  setOutletPreferences({ blocked: [], trusted: [] });
});

test('heat counts each outlet once and ignores low-quality copy', () => {
  const merged: PulseEvent = {
    ...event('a', 'Talks resume', google('证券时报社')),
    reports: [
      { id: '1', title: 'Talks resume - 证券时报', summary: '', source: google('证券时报社'), publishedAt: new Date(now - 3600e3).toISOString(), firstSeenAt: new Date(now - 3600e3).toISOString() },
      { id: '2', title: 'Talks resume in Geneva - 证券时报', summary: '', source: google('证券时报'), publishedAt: new Date(now - 3600e3).toISOString(), firstSeenAt: new Date(now - 3600e3).toISOString() },
      { id: '3', title: 'Talks resume, officials say', summary: '', source: google('Reuters'), publishedAt: new Date(now - 3600e3).toISOString(), firstSeenAt: new Date(now - 3600e3).toISOString() },
      { id: '4', title: 'Should You Buy the Dip on talks?', summary: '', source: google('The Motley Fool'), publishedAt: new Date(now - 3600e3).toISOString(), firstSeenAt: new Date(now - 3600e3).toISOString() },
    ],
  };
  const heat = heatForEvent(merged, now);
  assert.equal(heat.publishers24h, 2);
  const quality = eventQuality(merged);
  assert.equal(quality.lowQuality.length, 1);
  assert.equal(quality.outlets.length, 2);
});

test('layer 1 merges one article seen through direct and aggregator feeds, across categories', () => {
  const direct: PulseSource = { id: 'guardian-world', name: 'Guardian World', publisher: 'The Guardian', url: 'https://www.theguardian.com/a' };
  const clusters = clusterPulseEvents([
    event('d', 'Nvidia boss says there is ‘0% chance’ AI destroys the world by 2030', direct, 2, 'World'),
    event('g', 'Nvidia boss says there is ‘0% chance’ AI destroys the world by 2030 - The Guardian', google('The Guardian'), 1.5, 'Economy'),
    event('x', '俄美计划未来几周内举行新一轮会谈 - 每日经济新闻', google('每日经济新闻'), 3),
    event('y', '俄美计划未来几周内举行新一轮会谈 - 证券时报', google('证券时报社'), 3.2),
    event('z', '俄美计划未来几周内举行新一轮会谈 - 第一财经', google('第一财经'), 3.1),
  ]);
  assert.equal(clusters.length, 2);
  const nvidia = clusters.find((c) => c.event.title.startsWith('Nvidia'))!;
  assert.equal(nvidia.event.id, 'd', 'direct feed leads');
  assert.equal(nvidia.event.category, 'World');
  assert.deepEqual(nvidia.evidence.basis, ['same-article']);
  assert.equal(nvidia.event.title.includes('The Guardian'), false);
  const talks = clusters.find((c) => c.event.title.startsWith('俄美'))!;
  assert.equal(talks.evidence.memberEventIds.length, 3);
  assert.equal(talks.event.reports?.length, 3);
});

test('generic index titles never merge by headline alone', () => {
  assert.equal(articleKey('快讯'), undefined);
  assert.equal(articleKey('Live updates'), undefined);
  assert.ok(articleKey('Fed holds rates steady as inflation cools again'));
});

test('reporting names come from verified registrant names with context guards', () => {
  assert.deepEqual(
    deriveReportingNames('TAIWAN SEMICONDUCTOR MANUFACTURING CO LTD').names.sort(),
    ['Taiwan Semiconductor', 'Taiwan Semiconductor Manufacturing'],
  );
  assert.deepEqual(deriveReportingNames('NVIDIA CORP').names, ['Nvidia']);
  assert.deepEqual(deriveReportingNames('Coherent Corp.').contextual, ['Coherent']);
  assert.deepEqual(deriveReportingNames('Marvell Technology, Inc.').names.sort(), ['Marvell', 'Marvell Technology']);
});

test('verified directory companies match reporting names, dictionary names and exchange tags', () => {
  const tsm: PulseCompany = {
    id: 'NYSE:TSM',
    symbol: 'TSM',
    name: 'TAIWAN SEMICONDUCTOR MANUFACTURING CO LTD',
    exchange: 'NYSE',
    list: 'holdings',
    provenance: 'catalog',
    cik: '1046179',
    verifiedAt: '2026-09-20T00:00:00Z',
    sourceUrl: 'https://www.sec.gov/edgar/browse/?CIK=1046179',
  };
  const src = google('Reuters');
  assert.equal(directCompanyMatch(event('1', 'TSMC to build third Arizona fab', src), tsm)?.term, 'TSMC');
  assert.equal(directCompanyMatch(event('2', 'Taiwan Semiconductor lifts capex', src), tsm)?.term, 'Taiwan Semiconductor');
  assert.equal(directCompanyMatch(event('3', '台积电9月营收创新高', src), tsm)?.term, '台积电');
  assert.equal(directCompanyMatch(event('4', '台积电（TSM.N）盘前涨2%', src), tsm)?.term !== undefined, true);
  assert.equal(directCompanyMatch(event('5', 'Taiwan exports rise on semiconductor demand', src), tsm), undefined);
  const coherent: PulseCompany = { ...tsm, id: 'NYSE:COHR', symbol: 'COHR', name: 'Coherent Corp.', cik: '820318', sourceUrl: 'https://www.sec.gov/edgar/browse/?CIK=820318' };
  assert.equal(directCompanyMatch(event('6', 'A coherent plan for climate policy', src), coherent), undefined);
  assert.ok(directCompanyMatch(event('7', 'Coherent shares jump after earnings', src), coherent));
  const user: PulseCompany = { ...tsm, provenance: 'user', cik: undefined, verifiedAt: undefined, sourceUrl: undefined };
  assert.equal(directCompanyMatch(event('8', 'TSMC to build third Arizona fab', src), user), undefined);
});

test('stock-promotion headline styles are recognised', () => {
  assert.ok(lowValueHeadline('Prediction: Micron Will Earn More Profit Than Microsoft in Fiscal 2027'));
  assert.ok(lowValueHeadline('Bill Ackman Built a $2.4 Billion Stake in Microsoft. Here’s Why He’s Betting Big on Big Tech.'));
  assert.equal(lowValueHeadline('Here’s why the Fed kept rates on hold'), undefined);
});
