import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PulseStore } from '../server/world-pulse/store';
import { MarketService, MARKET_CALLS_PER_MINUTE } from '../server/world-pulse/market';
import { TIINGO_HOURLY_LIMIT } from '../server/world-pulse/tiingo';

function setup(handler: (url: string) => Response | Promise<Response>, key: string | undefined = 'k') {
  const dir = mkdtempSync(join(tmpdir(), 'wp-market-'));
  let now = Date.parse('2026-09-21T15:00:00Z');
  const store = new PulseStore(join(dir, 'db.sqlite'), now);
  const calls: string[] = [];
  const service = new MarketService(
    store,
    key,
    async (url, init) => {
      calls.push(url);
      assert.equal(init && (init.headers as Record<string, string>)['X-Finnhub-Token'], key);
      assert.equal(url.includes('token='), false, 'key never goes into the URL');
      return handler(url);
    },
    () => now,
  );
  return { service, calls, advance: (ms: number) => (now += ms), cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}
const json = (value: unknown, status = 200) => new Response(JSON.stringify(value), { status });

test('quotes are cached, keyed in headers and refreshed at most once a minute in session', async () => {
  const { service, calls, advance, cleanup } = setup((url) =>
    url.includes('market-status')
      ? json({ isOpen: true, session: 'regular', holiday: null })
      : json({ c: 176.4, d: -4.36, dp: -2.41, pc: 180.76, h: 181, l: 175, o: 180, t: 1789960000 }),
  );
  try {
    const first = await service.quotes(['NVDA', 'bad symbol' as string]);
    assert.equal(first.quotes.NVDA!.price, 176.4);
    assert.equal(first.status.session, 'regular');
    const count = calls.length;
    await service.quotes(['NVDA']);
    assert.equal(calls.length, count, 'served from cache within a minute');
    advance(61_000);
    await service.quotes(['NVDA']);
    assert.ok(calls.length > count);
  } finally {
    cleanup();
  }
});

test('the local limiter stops before the free-plan limit and 429 triggers a cool-down', async () => {
  const rateLimited = false;
  const { service, calls, cleanup } = setup((url) =>
    url.includes('market-status')
      ? json({ isOpen: true, session: 'regular' })
      : rateLimited
        ? json({ error: 'limit' }, 429)
        : json({ c: 10, d: 0, dp: 0, pc: 10 }),
  );
  try {
    const symbols = Array.from({ length: 40 }, (_, i) => `S${String.fromCharCode(65 + (i % 26))}${i}`);
    const snapshot = await service.quotes(symbols);
    assert.equal(calls.length, MARKET_CALLS_PER_MINUTE);
    assert.equal(snapshot.limited, true);
  } finally {
    cleanup();
  }
  const second = setup((url) => (url.includes('market-status') ? json({ session: 'regular' }) : json({}, 429)));
  try {
    const result = await second.service.quotes(['AAA', 'BBB']);
    assert.equal(result.limited, true);
    const before = second.calls.length;
    await second.service.quotes(['CCC']);
    assert.equal(second.calls.length, before, 'no calls during cool-down');
  } finally {
    second.cleanup();
  }
  void rateLimited;
});

test('without a key the service reports unconfigured and makes no requests', async () => {
  const { service, calls, cleanup } = setup(() => json({}), '');
  try {
    const snapshot = await service.quotes(['NVDA']);
    assert.equal(snapshot.configured, false);
    assert.equal(calls.length, 0);
    const calendar = await service.calendar([]);
    assert.ok(calendar.every((item) => item.kind !== 'earnings'));
  } finally {
    cleanup();
  }
});

test('profile, peers, earnings and US-only search are parsed defensively', async () => {
  const { service, cleanup } = setup((url) => {
    if (url.includes('profile2')) return json({ name: 'NVIDIA Corp', exchange: 'NASDAQ', finnhubIndustry: 'Semiconductors', marketCapitalization: 4300000 });
    if (url.includes('peers')) return json(['NVDA', 'AMD', 'AVGO', '<script>']);
    if (url.includes('calendar/earnings')) return json({ earningsCalendar: [{ date: '2026-11-17', hour: 'amc', epsEstimate: 2.52 }] });
    if (url.includes('search')) return json({ result: [{ symbol: '2330.TW', description: 'TSMC', type: 'Common Stock' }, { symbol: 'TSM', description: 'Taiwan Semiconductor', type: 'ADR' }] });
    return json({});
  });
  try {
    const profile = await service.profile('NVDA');
    assert.deepEqual(profile.peers, ['AMD', 'AVGO']);
    assert.equal(profile.nextEarnings?.date, '2026-11-17');
    assert.deepEqual((await service.search('taiwan semi')).map((row) => row.symbol), ['TSM']);
    const calendar = await service.calendar(['NVDA']);
    assert.ok(calendar.some((item) => item.kind === 'earnings' && item.symbol === 'NVDA'));
    assert.ok(calendar.some((item) => item.kind === 'fomc'));
  } finally {
    cleanup();
  }
});

test('Tiingo is a bounded batch fallback and never duplicates a Finnhub quote', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'wp-tiingo-'));
  const now = Date.parse('2026-09-21T15:00:00Z');
  const store = new PulseStore(join(dir, 'db.sqlite'), now);
  const calls: string[] = [];
  const service = new MarketService(
    store,
    '',
    async (url, init) => {
      calls.push(url);
      assert.equal((init && (init.headers as Record<string, string>).Authorization), 'Token tiingo-key');
      assert.equal(url.includes('tiingo-key'), false);
      if (!url.includes('/iex/')) return json({});
      return json([
        { ticker: 'NVDA', last: 180, prevClose: 175, high: 182, low: 174, open: 176, lastSaleTimestamp: '2026-09-21T14:59:00Z' },
        { ticker: 'AAPL', last: 230, prevClose: 228, high: 231, low: 227, open: 229, lastSaleTimestamp: '2026-09-21T14:59:00Z' },
      ]);
    },
    () => now,
    'tiingo-key',
  );
  try {
    const first = await service.quotes(['NVDA', 'AAPL']);
    assert.deepEqual(Object.keys(first.quotes).sort(), ['AAPL', 'NVDA']);
    assert.equal(first.quotes.NVDA!.source, 'tiingo');
    assert.equal(first.quotes.AAPL!.changePercent, ((230 - 228) / 228) * 100);
    assert.equal(first.providers?.tiingo.callsLastHour, 1);
    assert.equal(first.providers?.tiingo.uniqueSymbolsThisMonth, 2);
    const count = calls.length;
    const second = await service.quotes(['NVDA', 'AAPL']);
    assert.equal(calls.length, count, 'cached Tiingo batch is reused');
    assert.equal(Object.keys(second.quotes).length, 2, 'one quote per symbol is exposed');
    assert.equal(first.providers?.tiingo.hourlyLimit, TIINGO_HOURLY_LIMIT);
    const restarted = new MarketService(
      store,
      '',
      async () => json([]),
      () => now,
      'tiingo-key',
    );
    const restartedSnapshot = await restarted.quotes(['NVDA']);
    assert.equal(restartedSnapshot.providers?.tiingo.callsToday, 1, 'daily usage survives restart');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('when Finnhub misses a symbol, Tiingo fills only that symbol and the response stays deduplicated', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'wp-tiingo-mixed-'));
  let now = Date.parse('2026-09-21T15:00:00Z');
  const store = new PulseStore(join(dir, 'db.sqlite'), now);
  const calls: string[] = [];
  const service = new MarketService(
    store,
    'finnhub-key',
    async (url, init) => {
      calls.push(url);
      if (url.includes('market-status')) return json({ isOpen: true, session: 'regular' });
      if (url.includes('/quote?symbol=NVDA'))
        return json({ c: 180, d: 5, dp: 2.86, pc: 175, h: 181, l: 174, o: 176, t: 1789960000 });
      if (url.includes('/quote?symbol=AAPL')) return json({});
      assert.equal((init?.headers as Record<string, string>)?.Authorization, 'Token tiingo-key');
      assert.match(url, /api\.tiingo\.com\/iex\//);
      return json([{ ticker: 'AAPL', last: 230, prevClose: 228, lastSaleTimestamp: '2026-09-21T14:59:00Z' }]);
    },
    () => now,
    'tiingo-key',
  );
  try {
    const result = await service.quotes(['NVDA', 'AAPL']);
    assert.deepEqual(Object.keys(result.quotes).sort(), ['AAPL', 'NVDA']);
    assert.equal(result.quotes.NVDA!.source, 'finnhub');
    assert.equal(result.quotes.AAPL!.source, 'tiingo');
    assert.equal(Object.values(result.quotes).length, 2, 'one public quote per symbol');
    assert.equal(result.providers?.tiingo.callsLastHour, 1, 'one Tiingo batch for the missing symbol');
    assert.ok(calls.some((url) => url.includes('/quote?symbol=NVDA')));
    assert.ok(calls.some((url) => url.includes('/quote?symbol=AAPL')));
    now += 61_000;
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
