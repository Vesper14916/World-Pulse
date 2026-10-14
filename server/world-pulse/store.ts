import { createHash } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import type { PulseEvent, PulseReport } from '../../shared/world-pulse';

export const RETENTION_MS = 7 * 86400000;
const HOUR_MS = 3600000;
function validTime(value: string | null | undefined, now: number): number | undefined {
  const time = value ? Date.parse(value) : NaN;
  return Number.isFinite(time) && time <= now ? time : undefined;
}
const identity = (report: PulseReport) =>
  `${report.source.id}|${report.source.url}|${report.source.feedId ?? ''}`;
function reportExpiry(report: PulseReport, now: number): number {
  return (
    (validTime(report.publishedAt, now) ?? validTime(report.firstSeenAt, now) ?? now) + RETENTION_MS
  );
}
function isoMinimum(values: (string | null | undefined)[], now: number): string | undefined {
  const times = values.flatMap((value) => {
    const time = validTime(value, now);
    return time === undefined ? [] : [time];
  });
  return times.length ? new Date(Math.min(...times)).toISOString() : undefined;
}
function isoMaximum(values: (string | null | undefined)[], now: number): string | undefined {
  const times = values.flatMap((value) => {
    const time = validTime(value, now);
    return time === undefined ? [] : [time];
  });
  return times.length ? new Date(Math.max(...times)).toISOString() : undefined;
}
/** Apply retention independently to each report, including in-memory feed snapshots. */
export function retainEvent(
  event: PulseEvent,
  now: number,
  fallbackFirstSeen = now,
): PulseEvent | undefined {
  const firstSeen =
    validTime(event.firstSeenAt, now) ?? validTime(event.fetchedAt, now) ?? fallbackFirstSeen;
  const original = event.reports?.length
    ? event.reports
    : event.sources.map((source) => ({
        id: `${event.id}:${source.id}:${createHash('sha256').update(source.url).digest('hex').slice(0, 10)}`,
        title: event.title,
        summary: event.summary,
        source,
        publishedAt: event.publishedAt,
        firstSeenAt: new Date(firstSeen).toISOString(),
        lastFetchedAt: event.lastFetchedAt ?? event.fetchedAt,
        timeBasis: event.timeBasis ?? (event.publishedAt ? 'source-published' : 'first-seen'),
      }));
  const reports = original
    .map((report) => ({
      ...report,
      firstSeenAt: new Date(validTime(report.firstSeenAt, now) ?? firstSeen).toISOString(),
    }))
    .filter((report) => reportExpiry(report, now) > now);
  if (!reports.length) return undefined;
  const result = {
    ...event,
    reports,
    sources: reports.map((report) => report.source),
    firstSeenAt:
      isoMinimum(reports.map((report) => report.firstSeenAt), now) ??
      new Date(firstSeen).toISOString(),
    lastFetchedAt:
      isoMaximum(
        reports.map((report) => report.lastFetchedAt ?? report.firstSeenAt),
        now,
      ) ?? event.lastFetchedAt ?? event.fetchedAt,
  };
  // AI assessments are current-view data and must never return from stored news.
  if (result.importance?.method === 'ai') delete result.importance;
  if (result.companyAssessments) {
    result.companyAssessments = Object.fromEntries(Object.entries(result.companyAssessments).filter(([, value]) => value.method !== 'ai'));
    if (!Object.keys(result.companyAssessments).length) delete result.companyAssessments;
  }
  result.fetchedAt = result.lastFetchedAt;
  if (reports.length !== original.length) {
    result.title = reports[0]!.title;
    result.summary = reports[0]!.summary;
    result.publishedAt = reports[0]!.publishedAt;
    delete result.heat;
    delete result.importance;
    delete result.companyAssessments;
  }
  return result;
}

export class PulseStore {
  private db: DatabaseSync;
  private lastReclaim = -Infinity;
  private invalidatedEvidence = new Set<string>();
  constructor(path = ':memory:', now = Date.now()) {
    if (path !== ':memory:') mkdirSync(dirname(path), { recursive: true });
    this.db = new DatabaseSync(path);
    this.db.exec(
      'PRAGMA busy_timeout=5000; PRAGMA secure_delete=ON; PRAGMA journal_mode=WAL; CREATE TABLE IF NOT EXISTS records (key TEXT PRIMARY KEY, value TEXT NOT NULL, expires INTEGER NOT NULL); CREATE TABLE IF NOT EXISTS events (id TEXT PRIMARY KEY, value TEXT NOT NULL, first_seen INTEGER NOT NULL, expires INTEGER NOT NULL); CREATE TABLE IF NOT EXISTS persistent (key TEXT PRIMARY KEY, value TEXT NOT NULL);',
    );
    // Migration: discard old generated prose before any snapshot can hydrate it.
    this.db.exec("DELETE FROM records WHERE key GLOB 'explain:*' OR key GLOB 'assess:*' OR key GLOB 'brief:*' OR key='assessment-index';");
    this.prune(now);
  }
  getPersistent<T>(key: string): T | undefined {
    const row = this.db.prepare('SELECT value FROM persistent WHERE key=?').get(key);
    try {
      return row ? (JSON.parse(String(row.value)) as T) : undefined;
    } catch {
      return undefined;
    }
  }
  setPersistent(key: string, value: unknown): void {
    this.db
      .prepare('INSERT OR REPLACE INTO persistent VALUES (?,?)')
      .run(key, JSON.stringify(value));
  }
  deletePersistent(key: string): void {
    this.db.prepare('DELETE FROM persistent WHERE key=?').run(key);
  }
  get<T>(key: string, now: number): T | undefined {
    this.db.prepare('DELETE FROM records WHERE key=? AND expires<=?').run(key, now);
    const row = this.db
      .prepare('SELECT value FROM records WHERE key=? AND expires>?')
      .get(key, now);
    try {
      if (!row) return undefined;
      const value = JSON.parse(String(row.value));
      if (Array.isArray(value?.events)) {
        value.events = value.events.flatMap((event: PulseEvent) => {
          const retained = retainEvent(event, now);
          return retained ? [retained] : [];
        });
        this.db.prepare('UPDATE records SET value=? WHERE key=?').run(JSON.stringify(value), key);
      }
      return value as T;
    } catch {
      return undefined;
    }
  }
  set(key: string, value: unknown, expires: number, now = Date.now()): void {
    // Defense in depth: no caller can reintroduce the retired AI response cache.
    if (/^(explain:|assess:|brief:)/.test(key) || key === 'assessment-index') return;
    if (value && typeof value === 'object' && 'events' in value && Array.isArray(value.events)) {
      value = {
        ...value,
        events: value.events.flatMap((event: PulseEvent) => {
          const retained = retainEvent(event, now);
          return retained ? [retained] : [];
        }),
      };
    }
    this.db
      .prepare('INSERT OR REPLACE INTO records VALUES (?,?,?)')
      .run(key, JSON.stringify(value), Math.min(expires, now + RETENTION_MS));
    this.db.prepare('DELETE FROM records WHERE expires<=?').run(now);
  }
  ingest(incoming: PulseEvent[], now: number): PulseEvent[] {
    // Keep expired identities until this write finishes, so a repeated undated item
    // cannot renew its first-seen time on the boundary during ingestion.
    const events: PulseEvent[] = [];
    for (const event of incoming) {
      const prior = this.db.prepare('SELECT value,first_seen FROM events WHERE id=?').get(event.id);
      const previous = prior ? (JSON.parse(String(prior.value)) as PulseEvent) : undefined;
      const firstSeen = prior
        ? Number(prior.first_seen)
        : (validTime(event.firstSeenAt, now) ?? validTime(event.fetchedAt, now) ?? now);
      const incomingReports = event.reports?.length
        ? event.reports
        : event.sources.map((source) => ({
            id: `${event.id}:${source.id}:${createHash('sha256').update(source.url).digest('hex').slice(0, 10)}`,
            title: event.title,
            summary: event.summary,
            source,
            publishedAt: event.publishedAt,
            firstSeenAt: new Date(firstSeen).toISOString(),
            lastFetchedAt: event.lastFetchedAt ?? event.fetchedAt,
            timeBasis: event.timeBasis ?? (event.publishedAt ? 'source-published' : 'first-seen'),
          }));
      const reports = new Map(
        (previous?.reports ?? []).map((report) => [identity(report), report]),
      );
      for (const report of incomingReports) {
        const known = reports.get(identity(report));
        const oldPublished = validTime(known?.publishedAt, now);
        const newPublished = validTime(report.publishedAt, now);
        const publishedAt =
          oldPublished !== undefined
            ? new Date(Math.min(oldPublished, newPublished ?? oldPublished)).toISOString()
            : report.publishedAt;
        reports.set(identity(report), {
          ...report,
          publishedAt,
          firstSeenAt: known?.firstSeenAt ?? report.firstSeenAt,
          lastFetchedAt:
            isoMaximum([known?.lastFetchedAt, report.lastFetchedAt], now) ??
            report.lastFetchedAt ??
            known?.lastFetchedAt,
          timeBasis: report.timeBasis ?? known?.timeBasis,
        });
      }
      const merged = {
        ...previous,
        ...event,
        reports: [...reports.values()],
        community: event.community ?? previous?.community,
        firstSeenAt:
          previous?.firstSeenAt ?? event.firstSeenAt ?? new Date(firstSeen).toISOString(),
        lastFetchedAt:
          isoMaximum([previous?.lastFetchedAt, event.lastFetchedAt, event.fetchedAt], now) ??
          event.fetchedAt,
      };
      const updated = retainEvent(merged, now, firstSeen);
      if (!updated) {
        this.db.prepare('DELETE FROM events WHERE id=?').run(event.id);
        continue;
      }
      if (updated.reports!.length !== merged.reports.length) this.invalidatedEvidence.add(event.id);
      this.db
        .prepare('INSERT OR REPLACE INTO events VALUES (?,?,?,?)')
        .run(
          event.id,
          JSON.stringify(updated),
          firstSeen,
          Math.max(...updated.reports!.map((report) => reportExpiry(report, now))),
        );
      events.push(updated);
    }
    this.prune(now);
    return events;
  }
  events(now: number): PulseEvent[] {
    this.prune(now);
    return this.db
      .prepare(
        'SELECT value FROM events WHERE expires>? ORDER BY first_seen ASC, id ASC LIMIT 15000',
      )
      .all(now)
      .map((row) => JSON.parse(String(row.value)) as PulseEvent);
  }
  truncated(now: number): boolean {
    return this.get<boolean>('cache-truncated', now) ?? false;
  }
  health(): { writable: boolean; integrity: 'ok' | 'error' } {
    try {
      const check = this.db.prepare('PRAGMA quick_check(1)').get();
      const integrity = Object.values(check ?? {}).some((value) => value === 'ok') ? 'ok' : 'error';
      this.db.exec('BEGIN IMMEDIATE; ROLLBACK;');
      return { writable: true, integrity };
    } catch {
      try {
        this.db.exec('ROLLBACK;');
      } catch {
        /* No active transaction. */
      }
      return { writable: false, integrity: 'error' };
    }
  }
  prune(now: number): void {
    this.db.prepare('DELETE FROM records WHERE expires<=?').run(now);
    // Read each event: older versions stored aggregate expiration from the first
    // report, which must not remove a newer independently valid report.
    const live = new Set<string>();
    const changed = new Set(this.invalidatedEvidence);
    this.invalidatedEvidence.clear();
    for (const row of this.db.prepare('SELECT id,value,first_seen FROM events').all()) {
      const event = JSON.parse(String(row.value)) as PulseEvent;
      const retained = retainEvent(event, now, Number(row.first_seen));
      if (!retained) this.db.prepare('DELETE FROM events WHERE id=?').run(row.id!);
      else {
        live.add(event.id);
        const value = JSON.stringify(retained);
        if (value !== row.value) changed.add(event.id);
        if (value !== row.value)
          this.db
            .prepare('UPDATE events SET value=?,expires=? WHERE id=?')
            .run(
              value,
              Math.max(...retained.reports!.map((report) => reportExpiry(report, now))),
              row.id!,
            );
      }
    }
    // Source records can contain raw snapshots: remove expired payloads as well.
    for (const row of this.db.prepare('SELECT key,value FROM records').all()) {
      try {
        const value = JSON.parse(String(row.value));
        if (String(row.key).startsWith('assess:') && typeof value?.eventId !== 'string') {
          this.db.prepare('DELETE FROM records WHERE key=?').run(row.key!);
          continue;
        }
        if (
          typeof value?.eventId === 'string' &&
          (!live.has(value.eventId) || changed.has(value.eventId))
        ) {
          this.db.prepare('DELETE FROM records WHERE key=?').run(row.key!);
          continue;
        }
        if (row.key === 'assessment-index') {
          for (const id of Object.keys(value))
            if (!live.has(id) || changed.has(id)) delete value[id];
          this.db
            .prepare('UPDATE records SET value=? WHERE key=?')
            .run(JSON.stringify(value), row.key!);
        }
        if (Array.isArray(value?.events)) {
          value.events = value.events.flatMap((event: PulseEvent) => {
            const kept = retainEvent(event, now);
            return kept ? [kept] : [];
          });
          const serialized = JSON.stringify(value);
          if (serialized !== row.value)
            this.db.prepare('UPDATE records SET value=? WHERE key=?').run(serialized, row.key!);
        }
      } catch {
        this.db.prepare('DELETE FROM records WHERE key=?').run(row.key!);
      }
    }
    const total = Number(this.db.prepare('SELECT count(*) AS total FROM events').get()!.total);
    if (total > 15000)
      this.db
        .prepare('INSERT OR REPLACE INTO records VALUES (?,?,?)')
        .run('cache-truncated', 'true', now + RETENTION_MS);
    this.db.exec(
      'DELETE FROM events WHERE id IN (SELECT id FROM events ORDER BY first_seen DESC LIMIT -1 OFFSET 15000)',
    );
    if (now - this.lastReclaim >= HOUR_MS) {
      this.db.exec('PRAGMA wal_checkpoint(TRUNCATE); VACUUM; PRAGMA wal_checkpoint(TRUNCATE);');
      this.lastReclaim = now;
    }
  }
  close(): void {
    this.db.close();
  }
}

/** Exact-headline, same-region, same-day grouping only; no fuzzy/topic merge. */
export function groupEvents(events: PulseEvent[]): PulseEvent[] {
  const groups = new Map<string, PulseEvent>();
  for (const event of events) {
    const title = event.title.toLowerCase().replace(/[’‘]/g, "'").replace(/\s+/g, ' ').trim();
    const date = event.publishedAt ?? event.reports?.[0]?.firstSeenAt;
    // Filings and disasters keep their source-native identity, even when titles are repetitive.
    const key =
      !event.filing && event.magnitude === undefined && title.length >= 40 && date
        ? `${title}|${event.location?.country ?? ''}|${date.slice(0, 10)}`
        : `id:${event.id}`;
    const previous = groups.get(key);
    if (!previous) {
      groups.set(key, {
        ...event,
        sources: [...event.sources],
        reports: [...(event.reports ?? [])],
      });
      continue;
    }
    for (const source of event.sources)
      if (
        !previous.sources.some(
          (s) => s.id === source.id && s.url === source.url && s.feedId === source.feedId,
        )
      )
        previous.sources.push(source);
    for (const report of event.reports ?? [])
      if (!previous.reports!.some((r) => r.id === report.id)) previous.reports!.push(report);
    if (!previous.summary && event.summary) previous.summary = event.summary;
    if (!previous.publishedAt && event.publishedAt) previous.publishedAt = event.publishedAt;
    if (!previous.community && event.community) previous.community = event.community;
  }
  return [...groups.values()].map((event) => {
    const urls = new Map<string, Set<string>>();
    for (const source of event.sources) {
      const set = urls.get(source.id) ?? new Set<string>();
      set.add(source.url);
      urls.set(source.id, set);
    }
    const normalized = (source: PulseEvent['sources'][number]) =>
      urls.get(source.id)!.size > 1
        ? {
            ...source,
            feedId: source.feedId ?? source.id,
            id: `${source.id}:${createHash('sha256').update(source.url).digest('hex').slice(0, 10)}`,
          }
        : { ...source };
    return {
      ...event,
      sources: event.sources.map(normalized),
      reports: event.reports?.map((report) => ({
        ...report,
        source: normalized(report.source),
      })),
    };
  });
}
