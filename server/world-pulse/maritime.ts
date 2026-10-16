import WebSocket from 'ws';
import { createHash } from 'node:crypto';
import { CHOKEPOINT_REGISTRY } from '../_shared/chokepoint-registry';
import { STRATEGIC_AREAS, strategicArea, inArea } from '../../shared/world-pulse-strategic';
import {
  COMMAND_RETENTION_MS,
  type VesselObservation,
  type ObservationSource,
  type MaritimeSnapshot,
  type MaritimeNotice,
  type SituationSnapshot,
  type WaterwayObservation,
  type TimelineSnapshot,
} from '../../shared/world-pulse-command';
import { MaritimeStore } from './maritime-store';

const ISO = (t: number) => new Date(t).toISOString();
const UA = 'WorldPulse/1.0 (https://github.com/Vesper14916/World-Pulse)';
const PORTWATCH =
  'https://services9.arcgis.com/weJ1QsnbMYJlCHdG/arcgis/rest/services/Daily_Chokepoints_Data/FeatureServer/0/query';
const UKMTO = 'https://www.ukmto.org/recent-incidents';
const continuous = STRATEGIC_AREAS.filter((a) => a.continuous).map((a) => a.id);
const finite = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v);

export function parseVesselFrame(raw: unknown, now: number): VesselObservation | null {
  if (!raw || typeof raw !== 'object') return null;
  const d = raw as Record<string, any>;
  const meta = d.MetaData,
    message = d.Message?.[d.MessageType];
  if (
    !meta ||
    !message ||
    !['PositionReport', 'StandardClassBPositionReport', 'ExtendedClassBPositionReport'].includes(
      d.MessageType,
    )
  )
    return null;
  const mmsi = String(meta.MMSI ?? message.UserID ?? '');
  const lon = message.Longitude ?? meta.longitude ?? meta.Longitude,
    lat = message.Latitude ?? meta.latitude ?? meta.Latitude;
  if (
    !/^\d{9}$/.test(mmsi) ||
    !finite(lon) ||
    !finite(lat) ||
    Math.abs(lon) > 180 ||
    Math.abs(lat) > 85
  )
    return null;
  // AIS provider timestamps can contain a Go-style UTC suffix and nanoseconds.
  const rawTime = typeof meta.time_utc === 'string' ? meta.time_utc : '';
  const normalized = rawTime
    .replace(/(\.\d{3})\d+/, '$1')
    .replace(' +0000 UTC', 'Z')
    .replace(/ UTC$/, 'Z')
    .replace(' ', 'T');
  const parsed = Date.parse(normalized);
  if (!Number.isFinite(parsed) || parsed > now + 300000 || parsed <= now - COMMAND_RETENTION_MS)
    return null;
  const heading =
    finite(message.TrueHeading) && message.TrueHeading >= 0 && message.TrueHeading < 360
      ? message.TrueHeading
      : finite(message.Cog) && message.Cog >= 0 && message.Cog < 360
        ? message.Cog
        : undefined;
  const speed =
    finite(message.Sog) && message.Sog >= 0 && message.Sog < 102.3 ? message.Sog : undefined;
  return {
    mmsi,
    name: String(meta.ShipName || message.Name || mmsi)
      .replace(/[\x00-\x1f]/g, '')
      .trim()
      .slice(0, 80),
    lon,
    lat,
    heading,
    speed,
    observedAt: ISO(parsed),
    receivedAt: ISO(now),
  };
}
/** Parse only explicit dated, link-bearing notice records; a changed page fails closed. */
export function parseNotices(html: string, now: number): MaritimeNotice[] {
  const records: MaritimeNotice[] = [];
  const blocks = html.match(/<(?:article|li)\b[^>]*>[\s\S]*?<\/(?:article|li)>/gi) || [];
  for (const block of blocks) {
    const text = block
      .replace(/<[^>]+>/g, ' ')
      .replace(/&amp;/g, '&')
      .replace(/&nbsp;/g, ' ')
      .replace(/\s+/g, ' ')
      .trim();
    if (!/UKMTO|warning|advisory/i.test(text)) continue;
    const date = text.match(/\b(\d{2})\/(\d{2})\/(\d{4})\b/);
    if (!date) continue;
    const time = Date.parse(`${date[3]}-${date[2]}-${date[1]}T00:00:00Z`);
    if (!Number.isFinite(time) || time <= now - COMMAND_RETENTION_MS || time > now) continue;
    const href = block.match(/href=["']([^"']+)["']/i)?.[1];
    if (!href) continue;
    let url: URL;
    try {
      url = new URL(href, UKMTO);
    } catch {
      continue;
    }
    if (url.protocol !== 'https:' || url.hostname !== 'www.ukmto.org' || url.href === UKMTO)
      continue;
    const title = text.slice(0, 250);
    records.push({
      id: createHash('sha256')
        .update(url.href + title)
        .digest('hex')
        .slice(0, 24),
      title,
      url: url.href,
      publishedAt: ISO(time),
      text: text.slice(0, 1200),
      areaIds: STRATEGIC_AREAS.filter(
        (a) =>
          a.id !== 'global' &&
          a.aliases.some((alias) => text.toLowerCase().includes(alias.toLowerCase())),
      ).map((a) => a.id),
    });
  }
  return [...new Map(records.map((r) => [r.id, r])).values()];
}
export function parseTransits(
  payload: unknown,
  now: number,
): Map<string, WaterwayObservation['days']> {
  const d = payload as { features?: { attributes?: Record<string, unknown> }[]; error?: unknown };
  if (!d || d.error || !Array.isArray(d.features)) throw Error('PortWatch payload unavailable');
  const output = new Map<string, WaterwayObservation['days']>();
  for (const f of d.features) {
    const a = f.attributes;
    if (!a) continue;
    const c = CHOKEPOINT_REGISTRY.find((c) => c.portwatchName === a.portname);
    if (!c) continue;
    const t = typeof a.date === 'number' ? a.date : Date.parse(String(a.date));
    if (!Number.isFinite(t) || t <= now - COMMAND_RETENTION_MS || t > now) continue;
    const days = output.get(c.id) || [];
    const date = ISO(t).slice(0, 10);
    const count = finite(a.n_total) && a.n_total >= 0 ? Math.floor(a.n_total) : null;
    if (!days.some((d) => d.date === date)) days.push({ date, count });
    output.set(c.id, days);
  }
  for (const days of output.values()) days.sort((a, b) => a.date.localeCompare(b.date));
  return output;
}
export class MaritimeService {
  private store: MaritimeStore;
  private socket?: WebSocket;
  private timer?: ReturnType<typeof setInterval>;
  private retry?: ReturnType<typeof setTimeout>;
  private stopped = true;
  private connected = false;
  private failures = 0;
  private latest = new Map<string, VesselObservation>();
  private watched = new Map<string, number>();
  private lastFrame = 0;
  private lastPrune = 0;
  private polling = false;
  private nextPoll = 0;
  private notices: MaritimeNotice[] = [];
  private waterways: WaterwayObservation[] = [];
  private source: ObservationSource;
  private ukmto: ObservationSource = {
    id: 'ukmto',
    name: 'UKMTO',
    url: UKMTO,
    state: 'loading',
    message: 'Waiting for official maritime notices.',
  };
  private portwatch: ObservationSource = {
    id: 'portwatch',
    name: 'IMF PortWatch',
    url: 'https://portwatch.imf.org/',
    state: 'loading',
    message: 'Waiting for dated daily transit observations.',
  };
  constructor(
    private key: string | undefined,
    path: string,
    private transport: typeof fetch = (...args) => globalThis.fetch(...args),
    private now: () => number = Date.now,
  ) {
    this.store = new MaritimeStore(path);
    this.store.prune(this.now());
    const cache = this.store.get<SituationSnapshot>('situation', this.now());
    if (cache) {
      this.notices = cache.notices;
      this.waterways = cache.waterways;
      this.ukmto = {
        ...(cache.sources.find((s) => s.id === 'ukmto') || this.ukmto),
        state: 'stale',
      };
      this.portwatch = {
        ...(cache.sources.find((s) => s.id === 'portwatch') || this.portwatch),
        state: 'stale',
      };
    }
    this.source = {
      id: 'aisstream',
      name: 'AISStream',
      url: 'https://aisstream.io/',
      state: key ? 'loading' : 'no-key',
      message: key
        ? 'Connecting to observed AIS positions.'
        : 'Add AISSTREAM_API_KEY to the local environment to receive vessel observations.',
    };
  }
  start() {
    if (!this.stopped) return;
    this.stopped = false;
    if (this.key) this.connect();
    void this.poll();
    this.timer = setInterval(() => this.tick(), 15000);
    this.timer.unref?.();
  }
  stop() {
    this.stopped = true;
    clearInterval(this.timer);
    clearTimeout(this.retry);
    this.socket?.removeAllListeners();
    this.socket?.terminate();
    this.socket = undefined;
    this.store.close();
  }
  private areas() {
    return [
      ...new Set([
        ...continuous,
        ...[...this.watched].filter(([, until]) => until > this.now()).map(([id]) => id),
      ]),
    ];
  }
  watch(id: string) {
    if (!strategicArea(id)?.waterway || continuous.includes(id)) return;
    const changed = !this.watched.has(id);
    if (this.watched.size >= 4 && !this.watched.has(id))
      this.watched.delete(this.watched.keys().next().value!);
    this.watched.set(id, this.now() + 10 * 60000);
    if (changed && this.connected) this.subscribe();
  }
  private subscribe() {
    if (this.socket?.readyState !== WebSocket.OPEN) return;
    this.socket.send(
      JSON.stringify({
        APIKey: this.key,
        BoundingBoxes: this.areas().map((id) => {
          const b = strategicArea(id)!.bounds;
          return [
            [b[1], b[0]],
            [b[3], b[2]],
          ];
        }),
        FilterMessageTypes: [
          'PositionReport',
          'StandardClassBPositionReport',
          'ExtendedClassBPositionReport',
        ],
      }),
    );
  }
  private connect() {
    if (this.stopped || !this.key) return;
    const ws = new WebSocket('wss://stream.aisstream.io/v0/stream', {
      perMessageDeflate: true,
      handshakeTimeout: 12000,
      maxPayload: 2_000_000,
    });
    this.socket = ws;
    ws.on('open', () => {
      this.connected = true;
      this.lastFrame = this.now();
      this.subscribe();
      this.source = {
        ...this.source,
        state: 'loading',
        message: 'Connected · awaiting vessel observations; coverage is partial.',
      };
    });
    ws.on('message', (raw) => {
      this.lastFrame = this.now();
      try {
        const data = JSON.parse(raw.toString());
        if (data.error || data.Error) {
          this.source = {
            ...this.source,
            state: 'error',
            message:
              'AIS provider rejected the subscription. Verify the local key and account access.',
          };
          this.connected = false;
          ws.close();
          return;
        }
        if (data.MessageType === 'SubscriptionConfirmation') {
          this.failures = 0;
          return;
        }
        const v = parseVesselFrame(data, this.now());
        if (!v) return;
        if (!this.areas().some((id) => inArea(v.lon, v.lat, strategicArea(id)!))) return;
        const before = this.latest.get(v.mmsi);
        if (before && Date.parse(before.observedAt) >= Date.parse(v.observedAt)) return;
        if (this.latest.size >= 5000 && !this.latest.has(v.mmsi))
          this.latest.delete(this.latest.keys().next().value!);
        this.latest.set(v.mmsi, v);
        if (
          !before ||
          Math.floor(Date.parse(before.observedAt) / 60000) !==
            Math.floor(Date.parse(v.observedAt) / 60000)
        )
          this.store.add(v);
        this.failures = 0;
        this.source = {
          ...this.source,
          state: 'fresh',
          lastSuccess: ISO(this.now()),
          lastObservation: v.observedAt,
          message: 'Observed AIS reports · partial geographic coverage, not all ships.',
        };
      } catch {
        this.source = {
          ...this.source,
          state: 'partial',
          message: 'Some AIS frames could not be decoded; valid observations remain available.',
        };
      }
    });
    ws.on('error', () => {
      this.source = {
        ...this.source,
        state: 'error',
        message: 'AIS connection unavailable. Retained observations are marked by their age.',
      };
    });
    ws.on('close', () => {
      this.connected = false;
      if (this.stopped) return;
      if (this.source.state === 'fresh')
        this.source = {
          ...this.source,
          state: 'stale',
          message: 'AIS stream disconnected. Reconnecting with backoff.',
        };
      this.retry = setTimeout(
        () => this.connect(),
        Math.min(300000, 5000 * 2 ** Math.min(this.failures++, 6)),
      );
      this.retry.unref?.();
    });
  }
  private tick() {
    const now = this.now();
    for (const [id, v] of this.latest)
      if (Date.parse(v.observedAt) < now - 3600000) this.latest.delete(id);
    let changed = false;
    for (const [id, t] of this.watched)
      if (t < now) {
        this.watched.delete(id);
        changed = true;
      }
    if (changed) this.subscribe();
    if (this.connected && now - this.lastFrame < 120000) this.store.markCoverage(this.areas(), now);
    if (this.connected && now - this.lastFrame > 120000) {
      this.source = {
        ...this.source,
        state: 'stale',
        message: 'No recent AIS frames; stream coverage cannot be confirmed.',
      };
      this.socket?.terminate();
    }
    if (now - this.lastPrune > 60000) {
      const retained = this.situation();
      this.notices = retained.notices;
      this.waterways = retained.waterways;
      this.store.put('situation', retained, now + COMMAND_RETENTION_MS);
      this.store.prune(now);
      this.lastPrune = now;
    }
    if (now >= this.nextPoll) void this.poll();
  }
  async poll() {
    if (this.polling || this.stopped) return;
    this.polling = true;
    this.nextPoll = this.now() + 6 * 3600000;
    await Promise.allSettled([this.fetchTransits(), this.fetchNotices()]);
    if (!this.stopped)
      this.store.put('situation', this.situation(), this.now() + COMMAND_RETENTION_MS);
    this.polling = false;
  }
  private async read(url: string) {
    const r = await this.transport(url, {
      headers: { 'User-Agent': UA, Accept: 'application/json,text/html' },
      signal: AbortSignal.timeout(15000),
    });
    if (!r.ok) throw Error(`HTTP ${r.status}`);
    return r;
  }
  private async fetchTransits() {
    try {
      const since = ISO(this.now() - COMMAND_RETENTION_MS).slice(0, 10);
      const q = new URLSearchParams({
        where: `date >= date '${since}'`,
        outFields: 'portname,date,n_total',
        returnGeometry: 'false',
        orderByFields: 'date ASC',
        resultRecordCount: '1000',
        f: 'json',
      });
      const payload = await (await this.read(`${PORTWATCH}?${q}`)).json();
      if (payload.exceededTransferLimit) throw Error('Unexpected truncated transit response');
      const map = parseTransits(payload, this.now());
      let latest: string | undefined;
      for (const days of map.values())
        if (days.length && (!latest || days[days.length - 1]!.date > latest))
          latest = days[days.length - 1]!.date;
      if (!latest) {
        const check = new URLSearchParams({
          where: '1=1',
          outFields: 'date',
          orderByFields: 'date DESC',
          resultRecordCount: '1',
          returnGeometry: 'false',
          f: 'json',
        });
        const d = await (await this.read(`${PORTWATCH}?${check}`)).json();
        const raw = d.features?.[0]?.attributes?.date;
        const t = typeof raw === 'number' ? raw : Date.parse(raw);
        if (Number.isFinite(t)) latest = ISO(t);
      }
      this.portwatch = {
        ...this.portwatch,
        state: map.size ? 'fresh' : 'stale',
        lastSuccess: ISO(this.now()),
        lastObservation: latest,
        message: map.size
          ? 'Daily transit counts; publication may lag. Missing days are not zero.'
          : 'No observations inside the retained seven-day window. Latest upstream date is shown separately.',
      };
      this.waterways = CHOKEPOINT_REGISTRY.map((c) => ({
        id: c.id,
        days: map.get(c.id) || [],
        source: { ...this.portwatch, state: map.get(c.id)?.length ? 'fresh' : 'stale' },
      }));
    } catch (e) {
      this.portwatch = {
        ...this.portwatch,
        state: 'error',
        message: `Daily transits unavailable (${e instanceof Error ? e.message : 'source error'}).`,
      };
    }
  }
  private async fetchNotices() {
    try {
      const html = await (await this.read(UKMTO)).text();
      if (html.length > 3_000_000) throw Error('Unexpected page size');
      const notices = parseNotices(html, this.now());
      this.notices = notices;
      this.ukmto = {
        ...this.ukmto,
        state: notices.length ? 'fresh' : 'partial',
        lastSuccess: ISO(this.now()),
        lastObservation: notices[0]?.publishedAt,
        message: notices.length
          ? 'Dated UKMTO notices; statements are attributed to the issuing source.'
          : 'No dated notices could be extracted; open the official website. This does not mean no incidents.',
      };
    } catch (e) {
      this.ukmto = {
        ...this.ukmto,
        state: 'error',
        message: `Official notice feed unavailable (${e instanceof Error ? e.message : 'source error'}). Open UKMTO for its current publications.`,
      };
      this.nextPoll = Math.min(this.nextPoll, this.now() + 30 * 60000);
    }
  }
  situation(): SituationSnapshot {
    const cutoff = this.now() - COMMAND_RETENTION_MS;
    return {
      notices: this.notices.filter((n) => Date.parse(n.publishedAt) > cutoff),
      waterways: this.waterways.map((w) => ({
        ...w,
        days: w.days.filter((d) => Date.parse(d.date) > cutoff),
        source: {
          ...w.source,
          ...(this.portwatch.state === 'error'
            ? { state: 'error' as const, message: this.portwatch.message }
            : {}),
        },
      })),
      sources: [{ ...this.source }, { ...this.ukmto }, { ...this.portwatch }],
      generatedAt: ISO(this.now()),
    };
  }
  snapshot(region = 'global', at = this.now(), mmsi?: string): MaritimeSnapshot {
    const area = strategicArea(region);
    if (!area) throw Error('Unknown observation area');
    const cutoff = this.now() - COMMAND_RETENTION_MS;
    const sampled = this.store.latest(area, at, Number.MAX_SAFE_INTEGER, cutoff);
    // Fresh in-memory observations preserve sub-minute updates; historical queries only read persisted samples.
    if (Math.abs(at - this.now()) < 2000) {
      const byId = new Map(sampled.vessels.map((v) => [v.mmsi, v]));
      for (const v of this.latest.values()) {
        if (inArea(v.lon, v.lat, area) && Date.parse(v.observedAt) <= at)
          byId.set(v.mmsi, { ...v, stale: at - Date.parse(v.observedAt) > 900000 });
        else byId.delete(v.mmsi);
      }
      sampled.total = byId.size;
      sampled.vessels = [...byId.values()]
        .sort((a, b) => b.observedAt.localeCompare(a.observedAt))
        .slice(0, 2000);
    }
    sampled.vessels = sampled.vessels.slice(0, 2000);
    return {
      ...sampled,
      truncated: sampled.total > sampled.vessels.length,
      source: { ...this.source },
      generatedAt: ISO(this.now()),
      at: ISO(at),
      coverage: this.store.coverage(region, this.now()),
      ...(mmsi ? { trail: this.store.trail(mmsi, at, cutoff) } : {}),
    };
  }
  timeline(region: string, from: number, to: number): TimelineSnapshot {
    return {
      bins: this.store.bins(strategicArea(region)!, from, to),
      coverage: this.store.coverage(region, this.now()),
      generatedAt: ISO(this.now()),
    };
  }
}
