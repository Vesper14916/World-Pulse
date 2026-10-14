import { DatabaseSync } from 'node:sqlite';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import {
  COMMAND_RETENTION_MS,
  type VesselObservation,
  type MaritimeSnapshot,
  type TimelineSnapshot,
} from '../../shared/world-pulse-command';
import type { StrategicArea } from '../../shared/world-pulse-strategic';

type SampleRow = {
  mmsi: string;
  name: string;
  lon: number;
  lat: number;
  heading: number | null;
  speed: number | null;
  ship_type: number | null;
  observed: number;
  received: number;
};
const iso = (t: number) => new Date(t).toISOString();
function vessel(row: SampleRow): VesselObservation {
  return {
    mmsi: row.mmsi,
    name: row.name,
    lon: row.lon,
    lat: row.lat,
    heading: row.heading ?? undefined,
    speed: row.speed ?? undefined,
    shipType: row.ship_type ?? undefined,
    observedAt: iso(row.observed),
    receivedAt: iso(row.received),
  };
}
export class MaritimeStore {
  private db: DatabaseSync;
  private limited = false;
  constructor(
    path: string,
    private maxBytes = 1_000_000_000,
  ) {
    if (path !== ':memory:') mkdirSync(dirname(path), { recursive: true });
    this.db = new DatabaseSync(path);
    this.db.exec(`PRAGMA auto_vacuum=INCREMENTAL; PRAGMA journal_mode=WAL; PRAGMA busy_timeout=3000;
      CREATE TABLE IF NOT EXISTS samples(mmsi TEXT NOT NULL,bucket INTEGER NOT NULL,observed INTEGER NOT NULL,received INTEGER NOT NULL,name TEXT NOT NULL,lon REAL NOT NULL,lat REAL NOT NULL,heading REAL,speed REAL,ship_type INTEGER,PRIMARY KEY(mmsi,bucket));
      CREATE INDEX IF NOT EXISTS samples_time ON samples(observed);
      CREATE TABLE IF NOT EXISTS coverage(area TEXT NOT NULL,bucket INTEGER NOT NULL,PRIMARY KEY(area,bucket));
      CREATE TABLE IF NOT EXISTS cache(id TEXT PRIMARY KEY,value TEXT NOT NULL,expires INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS state(id TEXT PRIMARY KEY,value TEXT NOT NULL);`);
    this.limited =
      this.db.prepare("SELECT value FROM state WHERE id='capacity-limited'").get()?.value === '1';
  }
  add(v: VesselObservation) {
    const observed = Date.parse(v.observedAt),
      received = Date.parse(v.receivedAt);
    this.db
      .prepare(
        `INSERT INTO samples VALUES(?,?,?,?,?,?,?,?,?,?) ON CONFLICT(mmsi,bucket) DO UPDATE SET observed=excluded.observed,received=excluded.received,name=excluded.name,lon=excluded.lon,lat=excluded.lat,heading=excluded.heading,speed=excluded.speed,ship_type=excluded.ship_type WHERE excluded.observed>samples.observed`,
      )
      .run(
        v.mmsi,
        Math.floor(observed / 60000),
        observed,
        received,
        v.name,
        v.lon,
        v.lat,
        v.heading ?? null,
        v.speed ?? null,
        v.shipType ?? null,
      );
  }
  markCoverage(areas: readonly string[], now: number) {
    const stmt = this.db.prepare('INSERT OR IGNORE INTO coverage VALUES(?,?)');
    this.db.exec('BEGIN');
    try {
      for (const id of areas) stmt.run(id, Math.floor(now / 60000));
      this.db.exec('COMMIT');
    } catch (e) {
      this.db.exec('ROLLBACK');
      throw e;
    }
  }
  get<T>(id: string, now: number): T | undefined {
    const row = this.db.prepare('SELECT value FROM cache WHERE id=? AND expires>?').get(id, now);
    try {
      return row ? (JSON.parse(String(row.value)) as T) : undefined;
    } catch {
      return undefined;
    }
  }
  put(id: string, value: unknown, expires: number) {
    this.db
      .prepare('INSERT OR REPLACE INTO cache VALUES(?,?,?)')
      .run(id, JSON.stringify(value), expires);
  }
  latest(
    area: StrategicArea,
    at: number,
    limit = 2000,
    retainedSince = Number.NEGATIVE_INFINITY,
  ): { vessels: VesselObservation[]; total: number } {
    // Find each vessel's latest sample first, then apply geography. An old in-area sample must not resurrect a vessel that left.
    const rows = this.db
      .prepare(
        `SELECT * FROM (SELECT *,ROW_NUMBER() OVER(PARTITION BY mmsi ORDER BY observed DESC) AS rn FROM samples WHERE observed<=? AND observed>?) WHERE rn=1`,
      )
      .all(at, Math.max(at - 3600000, retainedSince)) as unknown as SampleRow[];
    const [w, s, e, n] = area.bounds;
    const found = rows
      .filter((v) => v.lon >= w && v.lon <= e && v.lat >= s && v.lat <= n)
      .sort((a, b) => b.observed - a.observed || a.mmsi.localeCompare(b.mmsi));
    return {
      vessels: found
        .slice(0, limit)
        .map((row) => ({ ...vessel(row), stale: at - row.observed > 900000 })),
      total: found.length,
    };
  }
  trail(mmsi: string, at: number, retainedSince = Number.NEGATIVE_INFINITY): VesselObservation[] {
    return (
      this.db
        .prepare(
          'SELECT * FROM samples WHERE mmsi=? AND observed>? AND observed<=? ORDER BY observed LIMIT 240',
        )
        .all(mmsi, Math.max(at - 7200000, retainedSince), at) as unknown as SampleRow[]
    ).map(vessel);
  }
  coverage(areaId: string, now: number): MaritimeSnapshot['coverage'] {
    const ids =
      areaId === 'global'
        ? ['hormuz_strait', 'bab_el_mandeb', 'suez', 'malacca_strait']
        : areaId === 'gulf'
          ? ['hormuz_strait']
          : areaId === 'red_sea'
            ? ['bab_el_mandeb', 'suez']
            : areaId === 'east_asia'
              ? ['malacca_strait', 'taiwan_strait']
              : [areaId];
    const rows = this.db
      .prepare(
        `SELECT DISTINCT bucket FROM coverage WHERE area IN (${ids.map(() => '?').join(',')}) AND bucket>=? ORDER BY bucket`,
      )
      .all(...ids, Math.floor((now - COMMAND_RETENTION_MS) / 60000)) as { bucket: number }[];
    const gaps: [string, string][] = [];
    for (let i = 1; i < rows.length; i++) {
      const prev = rows[i - 1]!.bucket,
        next = rows[i]!.bucket;
      if (next - prev > 1) gaps.push([iso((prev + 1) * 60000), iso(next * 60000)]);
    }
    return {
      start: rows.length ? iso(rows[0]!.bucket * 60000) : null,
      end: rows.length ? iso((rows[rows.length - 1]!.bucket + 1) * 60000) : null,
      gaps,
      samplingMinutes: 1,
      capacityLimited: this.limited,
    };
  }
  bins(area: StrategicArea, from: number, to: number): TimelineSnapshot['bins'] {
    const [w, s, e, n] = area.bounds;
    return (
      this.db
        .prepare(
          'SELECT CAST(observed/3600000 AS INTEGER)*3600000 AS at,COUNT(*) AS samples FROM samples WHERE observed>=? AND observed<=? AND lon>=? AND lon<=? AND lat>=? AND lat<=? GROUP BY 1 ORDER BY 1',
        )
        .all(from, to, w, e, s, n) as { at: number; samples: number }[]
    ).map((r) => ({ at: iso(r.at), samples: r.samples }));
  }
  prune(now: number) {
    const cutoff = now - COMMAND_RETENTION_MS;
    this.db.prepare('DELETE FROM samples WHERE observed<=?').run(cutoff);
    this.db.prepare('DELETE FROM coverage WHERE bucket*60000<=?').run(cutoff);
    this.db.prepare('DELETE FROM cache WHERE expires<=?').run(now);
    const size = Number(this.db.prepare('PRAGMA page_size').get()?.page_size || 4096);
    const allocated = () =>
      Number(this.db.prepare('PRAGMA page_count').get()?.page_count || 0) -
      Number(this.db.prepare('PRAGMA freelist_count').get()?.freelist_count || 0);
    // Delete whole oldest hours, freeing all associated coverage, until live pages fit the cap.
    for (let i = 0; allocated() * size > this.maxBytes && i < 169; i++) {
      const row = this.db.prepare('SELECT MIN(observed) AS oldest FROM samples').get();
      if (row?.oldest == null) break;
      const end = (Math.floor(Number(row.oldest) / 3600000) + 1) * 3600000;
      this.db.prepare('DELETE FROM samples WHERE observed<?').run(end);
      this.db.prepare('DELETE FROM coverage WHERE bucket*60000<?').run(end);
      this.limited = true;
      this.db.prepare("INSERT OR REPLACE INTO state VALUES('capacity-limited','1')").run();
    }
    this.db.exec('PRAGMA wal_checkpoint(TRUNCATE); PRAGMA incremental_vacuum(2000);');
  }
  close() {
    this.db.close();
  }
}
