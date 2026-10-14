import test from 'node:test';
import assert from 'node:assert/strict';
import {
  conflictKind,
  eventInArea,
  reportsAt,
  COMMAND_RETENTION_MS,
  type VesselObservation,
} from '../shared/world-pulse-command';
import { strategicArea, STRATEGIC_AREAS } from '../shared/world-pulse-strategic';
import { CHOKEPOINT_REGISTRY } from '../server/_shared/chokepoint-registry';
import { parseVesselFrame, parseTransits, parseNotices } from '../server/world-pulse/maritime';
import { MaritimeStore } from '../server/world-pulse/maritime-store';
import {
  defaultAppState,
  importConfiguration,
  exportConfiguration,
  loadState,
} from '../src/services/world-pulse/model';
import type { PulseEvent } from '../shared/world-pulse';
const now = Date.parse('2026-09-22T05:00:00Z');
const event = (title: string) =>
  ({
    title,
    summary: '',
    location: { country: 'IR', lon: 53, lat: 32, precision: 'country' },
  }) as PulseEvent;
const v = (mmsi = '123456789', observed = now, lon = 56, lat = 26): VesselObservation => ({
  mmsi,
  name: 'Test vessel',
  lon,
  lat,
  observedAt: new Date(observed).toISOString(),
  receivedAt: new Date(now).toISOString(),
});

test('conflict classification rejects metaphor, history and exercises; distinguishes ceasefire reporting', () => {
  for (const t of [
    'Chip war intensifies in China',
    'US declares war on inflation',
    'Military exercise tests missile defence',
    '二战纪念活动举行',
    '解放军军演展示新装备',
    'Tech company under cyber attack',
  ])
    assert.equal(conflictKind(event(t)), null, t);
  for (const t of [
    'Iran launches missile attack on military base',
    '乌军报告遭到导弹袭击',
    'Army clashes with armed group in Sudan',
  ])
    assert.equal(conflictKind(event(t)), 'conflict', t);
  assert.equal(conflictKind(event('Israel and Hamas resume ceasefire talks')), 'ceasefire');
});
test('waterway association cannot be manufactured from a country centroid', () => {
  assert.equal(
    eventInArea(event('Iran economic policy changes'), strategicArea('hormuz_strait')!),
    false,
  );
  assert.equal(
    eventInArea(event('Shipping disruption reported in Hormuz'), strategicArea('hormuz_strait')!),
    true,
  );
  assert.equal(eventInArea(event('Iran economic policy changes'), strategicArea('gulf')!), true);
  assert.deepEqual(
    STRATEGIC_AREAS.filter((a) => a.waterway)
      .map((a) => a.id)
      .sort(),
    CHOKEPOINT_REGISTRY.map((a) => a.id).sort(),
  );
});
test('AIS parsing accepts provider timestamps and rejects invalid positions, future and expired observations', () => {
  const frame = {
    MessageType: 'PositionReport',
    MetaData: {
      MMSI: 123456789,
      ShipName: 'TEST',
      time_utc: '2026-09-22 05:00:00.123456 +0000 UTC',
    },
    Message: {
      PositionReport: { Latitude: 26, Longitude: 56, TrueHeading: 511, Cog: 82, Sog: 102.3 },
    },
  };
  const parsed = parseVesselFrame(frame, now + 1000)!;
  assert.equal(parsed.heading, 82);
  assert.equal(parsed.speed, undefined);
  assert.equal(parsed.observedAt, '2026-09-22T05:00:00.123Z');
  assert.equal(
    parseVesselFrame(
      { ...frame, Message: { PositionReport: { Latitude: 91, Longitude: 181 } } },
      now,
    ),
    null,
  );
  assert.equal(parseVesselFrame(frame, now - 600000), null);
  assert.equal(parseVesselFrame(frame, now + COMMAND_RETENTION_MS + 1000), null);
  assert.equal(
    parseVesselFrame({ ...frame, MetaData: { ...frame.MetaData, time_utc: 'unknown' } }, now),
    null,
  );
});
test('maritime history preserves location chronology, stale state, one-minute samples and strict retention', () => {
  const store = new MaritimeStore(':memory:');
  try {
    store.add(v('123456789', now - 30 * 60000));
    store.add(v('123456789', now - 29 * 60000, 56.1));
    store.add(v('123456789', now - 29 * 60000 + 2000, 56.2));
    store.add(v('123456789', now - 20000, 70, 25)); // left the strait
    store.add(v('987654321', now - 20 * 60000));
    assert.equal(store.latest(strategicArea('hormuz_strait')!, now).total, 1);
    assert.equal(store.latest(strategicArea('hormuz_strait')!, now).vessels[0]?.stale, true);
    assert.equal(store.latest(strategicArea('hormuz_strait')!, now - 25 * 60000).total, 1);
    assert.equal(store.trail('123456789', now).length, 3);
    assert.equal(store.latest(strategicArea('global')!, now, 2000, now - 60000).total, 1);
    assert.equal(store.trail('123456789', now, now - 60000).length, 1);
    store.markCoverage(['hormuz_strait'], now - 10 * 60000);
    store.markCoverage(['hormuz_strait'], now);
    assert.equal(store.coverage('hormuz_strait', now).gaps.length, 1);
    store.add(v('111222333', now - COMMAND_RETENTION_MS));
    store.prune(now);
    assert.equal(store.latest(strategicArea('global')!, now - COMMAND_RETENTION_MS).total, 0);
  } finally {
    store.close();
  }
});
test('PortWatch handles date-only fields, real zeros, nulls and source dates beyond retention', () => {
  const d = {
    features: [
      { attributes: { portname: 'Strait of Hormuz', date: '2026-09-21', n_total: 0 } },
      { attributes: { portname: 'Suez Canal', date: '2026-09-21', n_total: null } },
      { attributes: { portname: 'Strait of Hormuz', date: '2026-09-13', n_total: 50 } },
    ],
  };
  const r = parseTransits(d, now);
  assert.deepEqual(r.get('hormuz_strait'), [{ date: '2026-09-21', count: 0 }]);
  assert.equal(r.get('suez')?.[0]?.count, null);
  assert.throws(() => parseTransits({ error: { code: 400 } }, now));
});
test('official notices require a concrete source link and retained explicit date', () => {
  const rows = parseNotices(
    '<li>21/09/2026 UKMTO Warning: Hormuz <a href="/warnings/123">Details</a></li><li>13/09/2026 UKMTO Warning <a href="/warnings/old">Old</a></li><li>UKMTO news <a href="javascript:alert(1)">Unsafe</a></li>',
    now,
  );
  assert.equal(rows.length, 1);
  assert.deepEqual(rows[0]?.areaIds, ['hormuz_strait']);
  assert.ok(rows[0]?.url.startsWith('https://www.ukmto.org/'));
});
test('workspace migration preserves holdings and legacy appearance while adding separate views', () => {
  const state = defaultAppState();
  const old = { ...state, version: 2, workspace: undefined, appearance: 'graphite' };
  const migrated = loadState({ getItem: () => JSON.stringify(old) });
  assert.equal(migrated.recovered, false);
  assert.equal(migrated.state.workspace.active, 'reading');
  assert.equal(migrated.state.appearance, 'graphite');
  state.workspace.active = 'command';
  state.workspace.command.region = 'hormuz_strait';
  state.workspace.readingWidth = 420;
  assert.deepEqual(importConfiguration(exportConfiguration(state)!)?.workspace, state.workspace);
  assert.equal(
    importConfiguration(
      JSON.stringify({ ...state, workspace: { ...state.workspace, readingWidth: -100 } }),
    ),
    null,
  );
});

test('replay removes later reports and aggregate scores instead of leaking future evidence', () => {
  const source = { id: 'bbc', name: 'BBC', url: 'https://www.bbc.com/news/test' };
  const sample = {
    ...event('Updated title'),
    id: 'a',
    publishedAt: new Date(now).toISOString(),
    fetchedAt: new Date(now).toISOString(),
    sources: [source],
    reports: [
      {
        id: 'old',
        title: 'Initial military clash report',
        summary: 'Early reporting',
        source,
        publishedAt: new Date(now - 7200000).toISOString(),
        firstSeenAt: new Date(now - 7000000).toISOString(),
      },
      {
        id: 'new',
        title: 'Updated missile attack count',
        summary: 'Later reporting',
        source,
        publishedAt: new Date(now).toISOString(),
        firstSeenAt: new Date(now).toISOString(),
      },
    ],
  } as PulseEvent;
  const result = reportsAt([sample], now - 3600000);
  assert.equal(result[0]?.title, 'Initial military clash report');
  assert.equal(result[0]?.reports?.length, 1);
  assert.equal(result[0]?.heat, undefined);
  assert.equal(result[0]?.location, undefined);
  assert.equal(reportsAt([sample], now - 10000000).length, 0);
});

test('storage pressure trims oldest complete periods and exposes a shortened coverage window', () => {
  const store = new MaritimeStore(':memory:', 50000);
  try {
    for (let i = 0; i < 500; i++)
      store.add(v(String(100000000 + i), now - (i % 24) * 3600000, 56, 26));
    store.markCoverage(['hormuz_strait'], now - 23 * 3600000);
    store.markCoverage(['hormuz_strait'], now);
    store.prune(now);
    assert.equal(store.coverage('hormuz_strait', now).capacityLimited, true);
    assert.equal(store.latest(strategicArea('global')!, now - 23 * 3600000).total, 0);
  } finally {
    store.close();
  }
});
