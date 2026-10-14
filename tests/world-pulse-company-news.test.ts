import test from 'node:test';
import assert from 'node:assert/strict';
import { DataHub } from '../server/world-pulse/hub';
import { PulseStore } from '../server/world-pulse/store';
import { seedDirectory } from '../server/world-pulse/data';
import { companyNewsUrl, parseCompanyNews } from '../server/world-pulse/company-news';
const company = seedDirectory().companies[0]!;
const now = Date.parse('2026-09-20T12:00:00Z');
const body = `<rss><channel><item><title>NVIDIA Corporation announces new chips</title><link>https://news.google.com/rss/articles/test</link><pubDate>Sun, 20 Sep 2026 11:00:00 GMT</pubDate><source url="https://example.com">Example News</source></item><item><title>Unrelated search result</title><link>https://news.google.com/rss/articles/other</link><source>Other News</source></item></channel></rss>`;
test('company RSS preserves publishers and links without claiming company match or location', () => {
  const result = parseCompanyNews(body, company, new Date(now).toISOString());
  assert.equal(result.events.length, 2);
  assert.equal(result.events[0]!.sources[0]!.publisher, 'Example News');
  assert.equal(result.events[0]!.sources[0]!.feedId, `company-news:${company.id}`);
  assert.equal(result.events[0]!.location, undefined);
  assert.equal(result.events[1]!.title, 'Unrelated search result');
  assert.match(new URL(companyNewsUrl(company)).searchParams.get('q')!, /"NVIDIA"/);
  assert.throws(() =>
    parseCompanyNews('<!DOCTYPE rss><rss/>', company, new Date(now).toISOString()),
  );
});
test('reviewed seed gets RSS despite GDELT and SEC failure, cached and in seven-day store', async () => {
  let calls = 0;
  const store = new PulseStore();
  const hub = new DataHub(
    store,
    async (url) => {
      if (url.startsWith('https://news.google.com/')) {
        calls++;
        return body;
      }
      throw new Error('unavailable');
    },
    () => now,
    'WorldPulse Test',
  );
  const data = await hub.companyData(company.id);
  assert.equal(data.events.length, 2);
  assert.equal(data.sources.find((s) => s.id.startsWith('company-news:'))!.state, 'fresh');
  assert.equal(data.sources.find((s) => s.id.startsWith('company-news:'))!.count, 2);
  assert.equal(data.sources.find((s) => s.id.startsWith('gdelt:'))!.state, 'error');
  assert.equal(data.sources.find((s) => s.id.startsWith('sec:'))!.state, 'error');
  await hub.companyData(company.id);
  assert.equal(calls, 1);
  assert.equal(store.events(now + 8 * 86400000).length, 0);
});

test('company RSS refreshes after 15 minutes while GDELT keeps its 30 minute interval', async () => {
  let clock = now;
  let rssCalls = 0;
  let gdeltCalls = 0;
  const hub = new DataHub(
    new PulseStore(),
    async (url) => {
      if (url.startsWith('https://news.google.com/')) {
        rssCalls++;
        return body;
      }
      if (url.includes('api.gdeltproject.org')) {
        gdeltCalls++;
        return '{"articles":[]}';
      }
      throw new Error('unavailable');
    },
    () => clock,
    'WorldPulse Test',
  );
  await hub.companyData(company.id);
  clock += 14 * 60_000;
  await hub.companyData(company.id);
  assert.equal(rssCalls, 1);
  assert.equal(gdeltCalls, 1);
  clock += 60_000;
  await hub.companyData(company.id);
  assert.equal(rssCalls, 2);
  assert.equal(gdeltCalls, 1);
});

test('tracked companies continue refreshing after the browser stops requesting them', async () => {
  let clock = now;
  let rssCalls = 0;
  const hub = new DataHub(
    new PulseStore(),
    async (url) => {
      if (url.startsWith('https://news.google.com/')) {
        rssCalls++;
        return body;
      }
      if (url.includes('api.gdeltproject.org')) return '{"articles":[]}';
      throw new Error('unavailable');
    },
    () => clock,
    'WorldPulse Test',
  );
  await hub.companyData(company.id);
  assert.equal(rssCalls, 1);
  clock += 15 * 60_000;
  await hub.refresh();
  assert.equal(rssCalls, 2);
});

test('source status separates a successful empty result from an unavailable source', async () => {
  const hub = new DataHub(
    new PulseStore(),
    async (url) => {
      if (url.startsWith('https://news.google.com/'))
        return '<rss><channel><title>Empty company feed</title></channel></rss>';
      throw new Error('unavailable');
    },
    () => now,
    'WorldPulse Test',
  );
  const data = await hub.companyData(company.id);
  const rss = data.sources.find((source) => source.id.startsWith('company-news:'))!;
  const gdelt = data.sources.find((source) => source.id.startsWith('gdelt:'))!;
  assert.equal(data.events.length, 0);
  assert.equal(rss.state, 'fresh');
  assert.equal(rss.count, 0);
  assert.equal(rss.error, undefined);
  assert.equal(gdelt.state, 'error');
  assert.match(gdelt.error!, /unavailable|invalid/i);
});

test('company operations deduplicate identities and run at most two companies concurrently', async () => {
  const companies = seedDirectory().companies.slice(0, 3);
  const started: string[] = [];
  const releases: Array<() => void> = [];
  let active = 0;
  let maximum = 0;
  const hub = new DataHub(
    new PulseStore(),
    async (url) => {
      if (url.startsWith('https://news.google.com/')) {
        const symbol = companies.find((item) => url.includes(encodeURIComponent(item.name)))?.symbol;
        started.push(symbol ?? url);
        active++;
        maximum = Math.max(maximum, active);
        await new Promise<void>((resolve) =>
          releases.push(() => {
            active--;
            resolve();
          }),
        );
        return '<rss><channel><title>Empty company feed</title></channel></rss>';
      }
      if (url.includes('api.gdeltproject.org')) return '{"articles":[]}';
      throw new Error('unavailable');
    },
    () => now,
    'WorldPulse Test',
  );
  const first = hub.companyData(companies[0]!.id);
  const duplicate = hub.companyData(companies[0]!.id);
  const second = hub.companyData(companies[1]!.id);
  const third = hub.companyData(companies[2]!.id);
  for (let attempt = 0; attempt < 20 && releases.length < 2; attempt++)
    await new Promise((resolve) => setImmediate(resolve));
  assert.equal(releases.length, 2);
  assert.equal(started.length, 2);
  releases.splice(0).forEach((release) => release());
  for (let attempt = 0; attempt < 20 && releases.length < 1; attempt++)
    await new Promise((resolve) => setImmediate(resolve));
  assert.equal(releases.length, 1);
  releases.shift()!();
  await Promise.all([first, duplicate, second, third]);
  assert.equal(maximum, 2);
  assert.equal(started.length, 3);
});

test('search discovery preserves unrelated ambiguous results without forcing a company match', () => {
  const apple = seedDirectory().companies.find((item) => item.symbol === 'AAPL')!;
  const ambiguous = `<rss><channel><item><title>Apple harvest improves this year</title><link>https://news.google.com/rss/articles/fruit</link><pubDate>Sun, 20 Sep 2026 11:00:00 GMT</pubDate><source url="https://example.com">Farm News</source></item></channel></rss>`;
  const result = parseCompanyNews(ambiguous, apple, new Date(now).toISOString());
  assert.equal(result.events.length, 1);
  assert.equal(result.events[0]!.companies, undefined);
  assert.match(result.events[0]!.classificationBasis, /direct company mention must be checked/i);
  assert.equal(result.events[0]!.sources[0]!.publisher, 'Farm News');
});
