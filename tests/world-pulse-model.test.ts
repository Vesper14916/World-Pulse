import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  catalog,
  defaultAppState,
  defaultModeState,
  filterEvents,
  exportConfiguration,
  importConfiguration,
  loadState,
  matchCompanies,
  safeUrl,
  saveState,
  STORAGE_KEY,
} from '../src/services/world-pulse/model.ts';
import type { PulseEvent } from '../shared/world-pulse.ts';

const now = Date.parse('2026-09-20T12:00:00Z');
function event(overrides: Partial<PulseEvent> = {}): PulseEvent {
  return {
    id: 'one',
    title: 'NVIDIA announces a new chip',
    summary: 'Reported company announcement.',
    category: 'Technology',
    sources: [
      {
        id: 'bbc',
        name: 'BBC',
        publisher: 'BBC',
        url: 'https://www.bbc.com/news/one',
      },
    ],
    publishedAt: '2026-09-20T11:00:00Z',
    fetchedAt: '2026-09-20T11:01:00Z',
    classificationBasis: 'Source category',
    ...overrides,
  };
}
test('default state is isolated per mode and round trips without touching upstream storage', () => {
  const state = defaultAppState();
  state.modes.world.query = 'chip';
  state.companies.push({ ...catalog[0]!, list: 'holdings' });
  state.savedSearches.push({
    id: 's1',
    name: 'chips',
    state: defaultModeState(),
  });
  assert.equal(state.modes.explore.query, '');
  let value = '';
  assert.equal(
    saveState(
      {
        setItem(key, input) {
          assert.equal(key, STORAGE_KEY);
          value = input;
        },
      },
      state,
    ),
    true,
  );
  assert.deepEqual(loadState({ getItem: () => value }), {
    state,
    recovered: false,
  });
  assert.equal(loadState({ getItem: () => null }).recovered, false);
});
test('corrupt nested state, identity relabeling and unavailable storage recover safely', () => {
  const changes: ((state: any) => void)[] = [
    (state) => {
      state.modes.world.camera.zoom = '3';
    },
    (state) => {
      state.modes.portfolio.categories = ['Made up'];
    },
    (state) => {
      state.modes.explore.bounds = [10, 50, 20, -50];
    },
    (state) => {
      state.modes.world.hours = -1;
    },
    (state) => {
      state.companies = [{ ...catalog[0], sourceUrl: 'javascript:alert(1)' }];
    },
    (state) => {
      state.companies = [{ ...catalog[0], name: 'Fake company' }];
    },
    (state) => {
      state.savedSearches = [{ id: 's', name: 'bad', state: {} }];
    },
    (state) => {
      state.companies = [catalog[0], catalog[0]];
    },
  ];
  for (const change of changes) {
    const state = defaultAppState();
    change(state);
    assert.equal(loadState({ getItem: () => JSON.stringify(state) }).recovered, true);
    assert.equal(
      saveState(
        {
          setItem() {
            assert.fail('invalid state must not write');
          },
        },
        state,
      ),
      false,
    );
  }
  assert.equal(loadState({ getItem: () => '{bad' }).recovered, true);
  assert.equal(
    loadState({
      getItem() {
        throw new Error('blocked');
      },
    }).recovered,
    true,
  );
  assert.equal(
    saveState(
      {
        setItem() {
          throw new Error('quota');
        },
      },
      defaultAppState(),
    ),
    false,
  );
});
test('ambiguous bare company words do not become portfolio evidence', () => {
  assert.deepEqual(
    matchCompanies(
      event({
        title: 'Apple harvests in the Amazon',
        summary: 'An oracle reads the alphabet. Visa policy and a meta-analysis.',
      }),
      catalog,
    ),
    [],
  );
  assert.deepEqual(
    matchCompanies(event({ title: 'Apple harvests', summary: '' }), [
      {
        id: 'mine',
        symbol: 'AAPL',
        name: 'Apple',
        exchange: 'NASDAQ',
        list: 'holdings',
        provenance: 'user',
      },
    ]),
    [],
  );
});
test('direct names and explicit tickers return auditable evidence only with a safe source', () => {
  const matches = matchCompanies(
    event({
      title: 'Apple Inc. and NASDAQ:AMZN join $NVDA',
      summary: 'Microsoft announces a partnership.',
    }),
    catalog,
  );
  assert.deepEqual(
    new Set(matches.map((match) => match.symbol)),
    new Set(['AAPL', 'AMZN', 'NVDA', 'MSFT']),
  );
  assert.ok(
    matches.every(
      (match) =>
        match.excerpt.includes(match.term) && match.sourceUrl === 'https://www.bbc.com/news/one',
    ),
  );
  assert.equal(matchCompanies(event({ sources: [] }), catalog).length, 0);
  assert.equal(
    matchCompanies(event({ title: 'US$100, $nvda, $NVDAXX, NVDA', summary: '' }), catalog).length,
    0,
  );
  assert.equal(
    matchCompanies(
      event({
        title: 'Coherent Corp. joins AST SpaceMobile and IonQ',
        summary: '',
      }),
      catalog,
    ).length,
    3,
  );
});
test('filter dimensions intersect, selections union, and results sort by actual publication time', () => {
  const state = defaultModeState();
  state.categories = ['Technology', 'Economy'];
  state.sourceIds = ['bbc', 'guardian'];
  state.regions = ['United States', 'Japan'];
  state.query = 'chip';
  const one = event({
    location: {
      name: 'California',
      country: 'United States',
      lat: 36,
      lon: -120,
      precision: 'region',
      evidence: 'Title',
    },
  });
  const two = event({
    id: 'two',
    publishedAt: '2026-09-20T10:00:00Z',
    category: 'Economy',
    location: {
      name: 'Japan',
      country: 'Japan',
      lat: 36,
      lon: 138,
      precision: 'country',
      evidence: 'Title',
    },
  });
  const other = event({
    id: 'wrong-category',
    category: 'Disasters',
    location: one.location,
  });
  assert.deepEqual(
    filterEvents([two, other, one], 'explore', state, [], now).map((item) => item.id),
    ['one', 'two'],
  );
  state.sourceIds = ['missing'];
  assert.deepEqual(filterEvents([one, two], 'explore', state, [], now), []);
});
test('missing, invalid, stale and future publication dates are not fabricated as fresh', () => {
  const events = [
    event({ publishedAt: null }),
    event({ publishedAt: 'invalid' }),
    event({ publishedAt: '2026-09-18T11:00:00Z' }),
    event({ publishedAt: '2026-09-21T11:00:00Z' }),
    event({ id: 'valid' }),
  ];
  assert.deepEqual(
    filterEvents(events, 'world', defaultModeState(), [], now).map((item) => item.id),
    ['valid'],
  );
});
test('dateline bounds include both sides and exclude unlocated events', () => {
  const state = defaultModeState();
  state.bounds = [170, -20, -170, 20];
  const events = [179, -179, 0].map((lon) =>
    event({
      id: String(lon),
      location: {
        name: 'Pacific',
        country: '',
        lat: 0,
        lon,
        precision: 'region',
        evidence: 'Feed',
      },
    }),
  );
  assert.deepEqual(
    filterEvents([...events, event()], 'explore', state, [], now).map((item) => item.id),
    ['179', '-179'],
  );
});
test('portfolio considers only the active list and selected identity', () => {
  const state = defaultModeState();
  const nvidia = {
    ...catalog.find((company) => company.symbol === 'NVDA')!,
    list: 'holdings' as const,
  };
  const apple = {
    ...catalog.find((company) => company.symbol === 'AAPL')!,
    list: 'watchlist' as const,
  };
  const events = [event(), event({ id: 'apple', title: 'Apple Inc. announces a product' })];
  assert.deepEqual(
    filterEvents(events, 'portfolio', state, [nvidia, apple], now).map((item) => item.id),
    ['one'],
  );
  state.list = 'watchlist';
  assert.deepEqual(
    filterEvents(events, 'portfolio', state, [nvidia, apple], now).map((item) => item.id),
    ['apple'],
  );
  state.selectedCompany = 'missing';
  assert.equal(filterEvents(events, 'portfolio', state, [nvidia, apple], now).length, 0);
});
test('only HTTP(S) links without embedded credentials are accepted', () => {
  assert.equal(safeUrl('javascript:alert(1)'), null);
  assert.equal(safeUrl('/relative'), null);
  const credentialUrl = new URL('https://example.com');
  credentialUrl.username = 'user';
  credentialUrl.password = 'password';
  assert.equal(safeUrl(credentialUrl.href), null);
  assert.equal(safeUrl('https://example.com/news'), 'https://example.com/news');
});

test('configuration export and import contains only persistent user settings', () => {
  const state = defaultAppState();
  state.companies = [
    {
      ...catalog[0]!,
      list: 'holdings',
      aliases: ['英伟达公司'],
      aliasProvenance: 'user',
    },
  ];
  const exported = exportConfiguration(state)!;
  assert.doesNotMatch(exported, /API_KEY|news|cache/i);
  assert.deepEqual(importConfiguration(exported), state);
  assert.equal(importConfiguration('{"format":"world-pulse-config","version":2}'), null);
});

test('user aliases form auditable direct matches without relabeling company identity', () => {
  const company = {
    ...catalog[0]!,
    list: 'holdings' as const,
    aliases: ['绿色算力公司'],
    aliasProvenance: 'user' as const,
  };
  const [match] = matchCompanies(
    event({ title: '绿色算力公司发布新产品', summary: '' }),
    [company],
  );
  assert.equal(match?.companyId, company.id);
  assert.equal(match?.provenance, 'user-provided');
});

test('legacy v1 migration adds mode sorting without losing companies, saved queries or explicit theme', () => {
  const legacy = defaultAppState();
  legacy.appearance = 'graphite';
  legacy.companies = [{ ...catalog[0]!, list: 'holdings' }];
  legacy.modes.world.query = 'preserve this';
  legacy.modes.portfolio.selectedCompany = legacy.companies[0]!.id;
  legacy.savedSearches = [
    {
      id: 'saved',
      name: 'My research',
      state: { ...defaultModeState(), regions: ['US'] },
    },
  ];
  const serialized = JSON.parse(JSON.stringify(legacy));
  serialized.version = 1;
  for (const mode of Object.values(serialized.modes) as Record<string, unknown>[]) {
    delete mode.sort;
    delete mode.coverage;
  }
  delete serialized.savedSearches[0].state.sort;
  delete serialized.savedSearches[0].state.coverage;
  const migrated = loadState({ getItem: () => JSON.stringify(serialized) });
  assert.equal(migrated.recovered, false);
  assert.deepEqual(migrated.state.companies, legacy.companies);
  assert.equal(migrated.state.appearance, 'graphite');
  assert.equal(migrated.state.modes.world.query, 'preserve this');
  assert.equal(migrated.state.modes.world.sort, 'latest');
  assert.equal(migrated.state.modes.portfolio.sort, 'personal');
  assert.equal(migrated.state.version, 3);
  assert.equal(migrated.state.modes.world.coverage, 'balanced');
  assert.equal(migrated.state.modes.portfolio.coverage, 'all');
  assert.equal(migrated.state.savedSearches[0]!.state.sort, 'latest');
  assert.equal(migrated.state.savedSearches[0]!.state.coverage, 'all');
  assert.deepEqual(migrated.state.savedSearches[0]!.state.regions, ['US']);
  assert.equal(defaultAppState().appearance, 'midnight');
});

test('sourced SEC directory companies survive storage without relabeling unverifiable identities', () => {
  const state = defaultAppState();
  state.companies = [
    {
      id: 'NYSE:EXM',
      symbol: 'EXM',
      name: 'Example Corporation',
      exchange: 'NYSE',
      list: 'holdings',
      provenance: 'catalog',
      cik: '12345',
      verifiedAt: '2026-09-20T10:00:00Z',
      sourceUrl: 'https://www.sec.gov/edgar/browse/?CIK=12345',
    },
  ];
  assert.equal(loadState({ getItem: () => JSON.stringify(state) }).recovered, false);
  state.companies[0]!.sourceUrl = 'https://www.sec.gov/edgar/browse/?CIK=99999';
  assert.equal(loadState({ getItem: () => JSON.stringify(state) }).recovered, true);
});

test('reviewed SEC offline seed lookup records persist without claiming live verification', () => {
  const state = defaultAppState();
  const company = {
    ...catalog[0]!,
    sourceUrl: `https://www.sec.gov/edgar/browse/?CIK=${catalog[0]!.cik}`,
  };
  state.companies = [company];
  assert.equal(company.verifiedAt, undefined);
  assert.equal(loadState({ getItem: () => JSON.stringify(state) }).recovered, false);
  assert.equal(saveState({ setItem() {} }, state), true);
  state.companies[0] = {
    ...company,
    cik: '99999',
    sourceUrl: 'https://www.sec.gov/edgar/browse/?CIK=99999',
  };
  assert.equal(loadState({ getItem: () => JSON.stringify(state) }).recovered, true);
  state.companies[0] = { ...company, name: 'Arbitrary replacement' };
  assert.equal(loadState({ getItem: () => JSON.stringify(state) }).recovered, true);
  const legacySeed = { ...catalog[0]! };
  delete legacySeed.cik;
  state.companies = [legacySeed];
  assert.equal(loadState({ getItem: () => JSON.stringify(state) }).recovered, false);
});

test('source filtering uses feed identity when article evidence has a unique source ID', () => {
  const state = defaultModeState('explore');
  state.sourceIds = ['bbc-world'];
  const item = event({
    sources: [
      {
        id: 'bbc-article-123',
        feedId: 'bbc-world',
        name: 'BBC World',
        publisher: 'BBC',
        url: 'https://www.bbc.com/news/123',
      },
    ],
  });
  assert.equal(filterEvents([item], 'explore', state, [], now).length, 1);
});

test('company and list selection immediately recompute personal order without a shared global score', () => {
  const state = defaultModeState('portfolio');
  const nvidia = {
    ...catalog.find((company) => company.symbol === 'NVDA')!,
    list: 'holdings' as const,
  };
  const apple = {
    ...catalog.find((company) => company.symbol === 'AAPL')!,
    list: 'holdings' as const,
  };
  const nvidiaNews = event({
    id: 'nvidia',
    title: 'NVIDIA files for bankruptcy',
    publishedAt: '2026-09-20T09:00:00Z',
  });
  const appleNews = event({
    id: 'apple',
    title: 'Apple Inc. announces new products',
  });
  assert.deepEqual(
    filterEvents([appleNews, nvidiaNews], 'portfolio', state, [nvidia, apple], now).map(
      (item) => item.id,
    ),
    ['nvidia', 'apple'],
  );
  state.selectedCompany = apple.id;
  assert.deepEqual(
    filterEvents([appleNews, nvidiaNews], 'portfolio', state, [nvidia, apple], now).map(
      (item) => item.id,
    ),
    ['apple'],
  );
  state.selectedCompany = '';
  state.list = 'watchlist';
  assert.deepEqual(
    filterEvents(
      [appleNews, nvidiaNews],
      'portfolio',
      state,
      [nvidia, { ...apple, list: 'watchlist' }],
      now,
    ).map((item) => item.id),
    ['apple'],
  );
});

test('discovery-only articles stay filterable without assigning a fabricated publication time', () => {
  const item = event({
    publishedAt: null,
    reports: [
      {
        id: 'discovery1',
        title: 'New discovery',
        summary: '',
        source: event().sources[0]!,
        publishedAt: null,
        firstSeenAt: '2026-09-20T10:00:00Z',
      },
    ],
  });
  assert.equal(filterEvents([item], 'world', defaultModeState(), [], now).length, 1);
  assert.equal(item.publishedAt, null);
});

test('headline exclusion hides only in World/Explore, keeps uncertainty and direct company matches', () => {
  const hidden = event({
    relevance: {
      decision: 'exclude',
      reason: 'lifestyle',
      method: 'ai',
      version: 'v1',
    },
  });
  const uncertain = event({
    id: 'two',
    relevance: {
      decision: 'uncertain',
      reason: 'uncertain',
      method: 'ai',
      version: 'v1',
    },
  });
  assert.deepEqual(
    filterEvents([hidden, uncertain], 'world', defaultModeState(), [], now).map((e) => e.id),
    ['two'],
  );
  assert.equal(
    filterEvents([hidden], 'explore', { ...defaultModeState(), showFiltered: true }, [], now)
      .length,
    1,
  );
  assert.equal(
    filterEvents(
      [hidden],
      'portfolio',
      defaultModeState('portfolio'),
      [{ ...catalog[0]!, list: 'holdings' }],
      now,
    ).length,
    1,
  );
  assert.equal(hidden.relevance?.decision, 'exclude');
});

test('World coverage filters and balanced presentation preserve membership while limiting runs', () => {
  const events = [
    ...Array.from({ length: 6 }, (_, index) =>
      event({
        id: `cn-${index}`,
        title: `China report ${index}`,
        publishedAt: new Date(now - index * 60_000).toISOString(),
        sources: [
          {
            id: `cn-source-${index % 2}`,
            feedId: `cn-feed-${index % 2}`,
            name: '中文来源',
            publisher: `中文媒体 ${index % 2}`,
            url: `https://china.example/${index}`,
            coverageGroup: 'china',
          },
        ],
      }),
    ),
    ...Array.from({ length: 3 }, (_, index) =>
      event({
        id: `global-${index}`,
        title: `Global report ${index}`,
        publishedAt: new Date(now - (index + 1) * 90_000).toISOString(),
        sources: [
          {
            id: `global-source-${index}`,
            name: 'Global source',
            publisher: `Global publisher ${index}`,
            url: `https://global.example/${index}`,
            coverageGroup: 'global',
          },
        ],
      }),
    ),
  ];
  const balanced = filterEvents(events, 'world', defaultModeState('world'), [], now);
  assert.equal(balanced.length, events.length);
  assert.deepEqual(
    new Set(balanced.map((item) => item.id)),
    new Set(events.map((item) => item.id)),
  );
  for (let index = 3; index < balanced.length; index++) {
    const run = balanced.slice(index - 3, index + 1);
    assert.ok(
      run.some((item) => item.sources[0]?.coverageGroup === 'global'),
      'a fourth China-only item must use an available global alternative',
    );
  }
  const globalState = { ...defaultModeState('world'), coverage: 'global' as const };
  assert.deepEqual(
    filterEvents(events, 'world', globalState, [], now).map((item) => item.id),
    ['global-0', 'global-1', 'global-2'],
  );
  const chinaState = { ...defaultModeState('world'), coverage: 'china' as const };
  assert.equal(filterEvents(events, 'world', chinaState, [], now).length, 6);
});
