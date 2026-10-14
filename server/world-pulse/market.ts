import type {
  PulseCalendarItem,
  PulseMarketSnapshot,
  PulseQuote,
  PulseCompanyProfile,
  PulseSearchResult,
} from '../../shared/world-pulse';
import type { PulseStore } from './store';
import { TiingoError, TiingoService } from './tiingo';

/**
 * Finnhub free-tier market data for the local Portfolio view.
 *
 * Only endpoints available on the free plan are used (quote, profile, peers,
 * earnings calendar, market status, symbol search). Historical candles are
 * not used. Every call goes through one limiter well under the documented
 * 60 calls/minute so the personal key is never pushed near its limit.
 */

const API = 'https://finnhub.io/api/v1';
export const MARKET_CALLS_PER_MINUTE = 30;
const ACTIVE_WINDOW_MS = 2 * 60_000;
const ACTIVE_INTERVAL_MS = 60_000;
const BACKGROUND_INTERVAL_MS = 5 * 60_000;
const DAY_MS = 86_400_000;

/** Scheduled US macro releases (Federal Reserve FOMC calendar, BLS CPI schedule). */
const MACRO: { date: string; title: string; kind: 'fomc' | 'cpi' }[] = [
  ...[
    ['2026-10-28', 'FOMC rate decision'],
    ['2026-12-09', 'FOMC rate decision · projections'],
    ['2027-01-27', 'FOMC rate decision'],
    ['2027-03-17', 'FOMC rate decision · projections'],
    ['2027-04-28', 'FOMC rate decision'],
    ['2027-06-09', 'FOMC rate decision · projections'],
    ['2027-07-28', 'FOMC rate decision'],
    ['2027-09-15', 'FOMC rate decision · projections'],
    ['2027-10-27', 'FOMC rate decision'],
    ['2027-12-08', 'FOMC rate decision · projections'],
  ].map(([date, title]) => ({ date: date!, title: title!, kind: 'fomc' as const })),
  ...[
    ['2026-10-14', 'US CPI (September)'],
    ['2026-11-10', 'US CPI (October)'],
    ['2026-12-10', 'US CPI (November)'],
  ].map(([date, title]) => ({ date: date!, title: title!, kind: 'cpi' as const })),
];

export class MarketError extends Error {
  constructor(
    public status: number,
    message: string,
  ) {
    super(message);
  }
}

type Transport = (url: string, init?: RequestInit) => Promise<Response>;
interface Tick {
  t: number;
  p: number;
}

export function validSymbol(value: unknown): value is string {
  return typeof value === 'string' && /^[A-Z][A-Z0-9.-]{0,14}$/.test(value);
}

export class MarketService {
  private calls: number[] = [];
  private tracked = new Map<string, number>();
  private lastActive = 0;
  private lastPoll = 0;
  private polling?: Promise<void>;
  private backoffUntil = 0;
  private statusCache?: { at: number; value: PulseMarketSnapshot['status'] };
  private readonly tiingo: TiingoService;

  constructor(
    private store: PulseStore,
    private key: string | undefined,
    private transport: Transport,
    private now: () => number,
    tiingoKey?: string,
  ) {
    this.tiingo = new TiingoService(store, tiingoKey, transport, now);
  }

  get configured(): boolean {
    return !!this.key?.trim() || this.tiingo.configured;
  }

  private async call<T>(path: string): Promise<T> {
    if (!this.key?.trim()) throw new MarketError(503, 'Finnhub is not configured.');
    const now = this.now();
    if (now < this.backoffUntil) throw new MarketError(429, 'Market data is cooling down after a rate limit.');
    this.calls = this.calls.filter((time) => time > now - 60_000);
    if (this.calls.length >= MARKET_CALLS_PER_MINUTE)
      throw new MarketError(429, 'Local market-data budget for this minute is used; cached values shown.');
    this.calls.push(now);
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 10_000);
    try {
      const response = await this.transport(`${API}${path}`, {
        headers: { 'X-Finnhub-Token': this.key!.trim(), Accept: 'application/json' },
        signal: controller.signal,
      });
      if (response.status === 429) {
        this.backoffUntil = this.now() + 60_000;
        throw new MarketError(429, 'Finnhub rate limit reached; retrying after a minute.');
      }
      if (response.status === 401 || response.status === 403)
        throw new MarketError(response.status, 'Finnhub rejected this request (key or plan).');
      if (!response.ok) throw new MarketError(502, 'Finnhub is unavailable.');
      const text = await response.text();
      if (text.length > 2_000_000) throw new MarketError(502, 'Finnhub response too large.');
      return JSON.parse(text) as T;
    } catch (error) {
      if (error instanceof MarketError) throw error;
      throw new MarketError(502, 'Finnhub could not be reached.');
    } finally {
      clearTimeout(timer);
    }
  }

  usage() {
    const now = this.now();
    return { callsLastMinute: this.calls.filter((time) => time > now - 60_000).length, limit: MARKET_CALLS_PER_MINUTE };
  }

  async status(): Promise<PulseMarketSnapshot['status']> {
    if (!this.key?.trim())
      // Tiingo's free IEX feed has no market-status endpoint.  Keep the
      // status conservative rather than pretending a local clock is exchange
      // truth; quote timestamps remain visible in the Portfolio cards.
      return { isOpen: false, session: 'closed', holiday: null };
    if (this.statusCache && this.now() - this.statusCache.at < 60_000) return this.statusCache.value;
    try {
      const raw = await this.call<{ isOpen?: boolean; session?: string | null; holiday?: string | null }>(
        '/stock/market-status?exchange=US',
      );
      const value = {
        isOpen: !!raw.isOpen,
        session: (['pre-market', 'regular', 'post-market'].includes(raw.session ?? '') ? raw.session : 'closed') as
          | 'pre-market'
          | 'regular'
          | 'post-market'
          | 'closed',
        holiday: typeof raw.holiday === 'string' ? raw.holiday.slice(0, 80) : null,
      };
      this.statusCache = { at: this.now(), value };
      return value;
    } catch {
      return this.statusCache?.value ?? { isOpen: false, session: 'closed', holiday: null };
    }
  }

  private cachedQuote(symbol: string): PulseQuote | undefined {
    const finnhub = this.store.get<PulseQuote>(`fh:quote:${symbol}`, this.now());
    const tiingo = this.store.get<PulseQuote>(`tiingo:quote:${symbol}`, this.now());
    if (!finnhub) return tiingo;
    if (!tiingo) return finnhub;

    // A failed refresh can leave an older Finnhub value beside a newer Tiingo
    // fallback. Expose one quote only, choosing the freshest record; when the
    // timestamps tie, retain Finnhub as the preferred provider.
    const finnhubAt = Date.parse(finnhub.fetchedAt);
    const tiingoAt = Date.parse(tiingo.fetchedAt);
    return Number.isFinite(tiingoAt) && (!Number.isFinite(finnhubAt) || tiingoAt > finnhubAt)
      ? tiingo
      : finnhub;
  }

  private async fetchQuote(symbol: string): Promise<PulseQuote | undefined> {
    const raw = await this.call<{ c?: number; d?: number; dp?: number; pc?: number; h?: number; l?: number; o?: number; t?: number }>(
      `/quote?symbol=${encodeURIComponent(symbol)}`,
    );
    if (!Number.isFinite(raw.c) || !raw.c || !Number.isFinite(raw.pc)) return undefined;
    const quote: PulseQuote = {
      symbol,
      price: raw.c!,
      change: Number.isFinite(raw.d) ? raw.d! : raw.c! - raw.pc!,
      changePercent: Number.isFinite(raw.dp) ? raw.dp! : raw.pc ? ((raw.c! - raw.pc!) / raw.pc!) * 100 : 0,
      previousClose: raw.pc!,
      high: Number.isFinite(raw.h) ? raw.h! : raw.c!,
      low: Number.isFinite(raw.l) ? raw.l! : raw.c!,
      open: Number.isFinite(raw.o) ? raw.o! : raw.c!,
      time: raw.t && Number.isFinite(raw.t) ? new Date(raw.t * 1000).toISOString() : new Date(this.now()).toISOString(),
      fetchedAt: new Date(this.now()).toISOString(),
      source: 'finnhub',
    };
    this.store.set(`fh:quote:${symbol}`, quote, this.now() + 7 * DAY_MS, this.now());
    const ticks = this.store.get<Tick[]>(`fh:ticks:${symbol}`, this.now()) ?? [];
    const last = ticks[ticks.length - 1];
    if (!last || last.p !== quote.price || this.now() - last.t > 30 * 60_000) {
      ticks.push({ t: this.now(), p: quote.price });
      const kept = ticks.filter((tick) => tick.t > this.now() - 7 * DAY_MS).slice(-4000);
      this.store.set(`fh:ticks:${symbol}`, kept, this.now() + 7 * DAY_MS, this.now());
    }
    return quote;
  }

  /** Price recorded by this service at or just after a time, for "since this report". */
  priceAt(symbol: string, time: number): number | undefined {
    const ticks = this.store.get<Tick[]>(`fh:ticks:${symbol}`, this.now()) ?? [];
    // Only a price recorded within 20 minutes of the report counts; otherwise
    // the service was not watching then and no delta is shown.
    const after = ticks.find((tick) => tick.t >= time);
    if (!after || after.t - time > 20 * 60_000) return undefined;
    return after.p;
  }

  /**
   * Quotes for the viewer's companies. Values refresh at most every minute
   * while the page is open; otherwise the background poll keeps them current.
   */
  async quotes(symbols: string[]): Promise<PulseMarketSnapshot> {
    const list = [...new Set(symbols.filter(validSymbol))].slice(0, 40);
    this.lastActive = this.now();
    for (const symbol of list) this.tracked.set(symbol, this.now());
    const status = await this.status();
    const freshFor = status.session === 'closed' ? 6 * 3_600_000 : ACTIVE_INTERVAL_MS;
    const due = list.filter((symbol) => {
      const cached = this.cachedQuote(symbol);
      return !cached || this.now() - Date.parse(cached.fetchedAt) >= freshFor;
    });
    let limited = false;
    const refreshedByFinnhub = new Set<string>();
    if (this.key?.trim()) {
      for (const symbol of due) {
        try {
          const quote = await this.fetchQuote(symbol);
          if (quote) refreshedByFinnhub.add(symbol);
        } catch (error) {
          if (error instanceof MarketError && error.status === 429) {
            limited = true;
            break;
          }
          if (error instanceof MarketError && error.status === 503) break;
        }
      }
    }
    // Tiingo is a bounded batch fallback. It is only called for symbols still
    // missing after Finnhub, so adding the key never doubles normal usage.
    if (this.tiingo.configured) {
      const fallback = list.filter(
        (symbol) => due.includes(symbol) && !refreshedByFinnhub.has(symbol),
      );
      if (fallback.length) {
        try {
          const values = await this.tiingo.quotes(fallback);
          for (const [symbol, quote] of Object.entries(values)) {
            // Keep the provider cache separate, while the public response
            // exposes only the Finnhub-preferred or Tiingo-fallback record.
            this.store.set(`tiingo:quote:${symbol}`, quote, this.now() + 7 * DAY_MS, this.now());
          }
        } catch (error) {
          if (error instanceof TiingoError && error.status === 429) limited = true;
        }
      }
    }
    const quotes: Record<string, PulseQuote> = {};
    for (const symbol of list) {
      const quote = this.cachedQuote(symbol);
      if (quote) quotes[symbol] = quote;
    }
    return {
      configured: this.configured,
      status,
      quotes,
      limited,
      usage: this.usage(),
      providers: {
        finnhub: { configured: !!this.key?.trim(), ...this.usage() },
        tiingo: { configured: this.tiingo.configured, ...this.tiingo.usage() },
      },
      fetchedAt: new Date(this.now()).toISOString(),
    };
  }

  /** Background schedule: every 5 minutes while US markets are in session. */
  async poll(): Promise<void> {
    if (!this.configured || this.polling) return;
    const now = this.now();
    for (const [symbol, seen] of this.tracked) if (now - seen > 3 * DAY_MS) this.tracked.delete(symbol);
    const active = now - this.lastActive < ACTIVE_WINDOW_MS;
    const interval = active ? ACTIVE_INTERVAL_MS : BACKGROUND_INTERVAL_MS;
    if (now - this.lastPoll < interval || !this.tracked.size) return;
    this.polling = (async () => {
      const status = await this.status();
      if (status.session === 'closed') return;
      this.lastPoll = this.now();
      if (this.key?.trim()) {
        for (const symbol of this.tracked.keys()) {
          try {
            await this.fetchQuote(symbol);
          } catch (error) {
            if (error instanceof MarketError && (error.status === 429 || error.status === 503)) break;
          }
        }
      } else if (this.tiingo.configured) {
        try {
          await this.tiingo.quotes([...this.tracked.keys()]);
        } catch {
          // A later foreground request will report the bounded quota state.
        }
      }
    })();
    try {
      await this.polling;
    } finally {
      this.polling = undefined;
    }
  }

  async profile(symbol: string): Promise<PulseCompanyProfile> {
    if (!validSymbol(symbol)) throw new MarketError(400, 'Unknown symbol.');
    if (!this.key?.trim()) {
      try {
        return await this.tiingo.profile(symbol);
      } catch (error) {
        if (error instanceof TiingoError)
          throw new MarketError(error.status, error.message);
      }
    }
    const key = `fh:profile:${symbol}`;
    const cached = this.store.get<PulseCompanyProfile>(key, this.now());
    if (cached) return cached;
    const [raw, peers, earnings] = await Promise.all([
      this.call<Record<string, unknown>>(`/stock/profile2?symbol=${encodeURIComponent(symbol)}`),
      this.call<unknown>(`/stock/peers?symbol=${encodeURIComponent(symbol)}`).catch(() => []),
      this.call<{ earningsCalendar?: unknown[] }>(
        `/calendar/earnings?from=${this.day(0)}&to=${this.day(120)}&symbol=${encodeURIComponent(symbol)}`,
      ).catch(() => ({ earningsCalendar: [] })),
    ]);
    const next = (earnings.earningsCalendar ?? [])
      .filter((row): row is Record<string, unknown> => !!row && typeof row === 'object')
      .map((row) => ({
        date: typeof row.date === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(row.date) ? row.date : '',
        hour: row.hour === 'bmo' || row.hour === 'amc' ? (row.hour as 'bmo' | 'amc') : undefined,
        epsEstimate: typeof row.epsEstimate === 'number' ? row.epsEstimate : undefined,
      }))
      .filter((row) => row.date >= this.day(0))
      .sort((a, b) => a.date.localeCompare(b.date))[0];
    const text = (value: unknown, max = 120) => (typeof value === 'string' ? value.slice(0, max) : undefined);
    const profile: PulseCompanyProfile = {
      symbol,
      name: text(raw.name) ?? symbol,
      exchange: text(raw.exchange, 80),
      industry: text(raw.finnhubIndustry, 80),
      country: text(raw.country, 8),
      marketCap: typeof raw.marketCapitalization === 'number' ? raw.marketCapitalization : undefined,
      weburl: text(raw.weburl, 300)?.startsWith('http') ? text(raw.weburl, 300) : undefined,
      peers: Array.isArray(peers) ? peers.filter(validSymbol).filter((peer) => peer !== symbol).slice(0, 10) : [],
      nextEarnings: next?.date ? next : undefined,
      fetchedAt: new Date(this.now()).toISOString(),
    };
    this.store.set(key, profile, this.now() + DAY_MS, this.now());
    return profile;
  }

  async search(query: string): Promise<PulseSearchResult[]> {
    const q = query.trim().slice(0, 60);
    if (q.length < 1) return [];
    const key = `fh:search:${q.toLowerCase()}`;
    const cached = this.store.get<PulseSearchResult[]>(key, this.now());
    if (cached) return cached;
    const raw = await this.call<{ result?: unknown[] }>(`/search?q=${encodeURIComponent(q)}`);
    const results = (raw.result ?? [])
      .filter((row): row is Record<string, unknown> => !!row && typeof row === 'object')
      .map((row) => ({
        symbol: typeof row.symbol === 'string' ? row.symbol : '',
        description: typeof row.description === 'string' ? row.description.slice(0, 120) : '',
        type: typeof row.type === 'string' ? row.type.slice(0, 40) : '',
      }))
      // US listings only: foreign venues carry a suffix such as 2330.TW.
      .filter((row) => validSymbol(row.symbol) && !row.symbol.includes('.') && /stock|adr|reit|etp|etf/i.test(row.type || 'stock'))
      .slice(0, 12);
    this.store.set(key, results, this.now() + 6 * 3_600_000, this.now());
    return results;
  }

  async calendar(symbols: string[]): Promise<PulseCalendarItem[]> {
    const items: PulseCalendarItem[] = MACRO.filter(
      (item) => item.date >= this.day(0) && item.date <= this.day(45),
    ).map((item) => ({ date: item.date, title: item.title, kind: item.kind }));
    for (const symbol of [...new Set(symbols.filter(validSymbol))].slice(0, 25)) {
      let profile = this.store.get<PulseCompanyProfile>(`fh:profile:${symbol}`, this.now());
      if (!profile)
        try {
          profile = await this.profile(symbol);
        } catch {
          continue;
        }
      if (profile.nextEarnings)
        items.push({
          date: profile.nextEarnings.date,
          title: `${symbol} earnings${profile.nextEarnings.hour === 'amc' ? ' · after close' : profile.nextEarnings.hour === 'bmo' ? ' · before open' : ''}`,
          kind: 'earnings',
          symbol,
          ...(profile.nextEarnings.epsEstimate !== undefined ? { detail: `EPS estimate ${profile.nextEarnings.epsEstimate.toFixed(2)}` } : {}),
        });
    }
    return items.sort((a, b) => a.date.localeCompare(b.date));
  }

  private day(offset: number): string {
    return new Date(this.now() + offset * DAY_MS).toISOString().slice(0, 10);
  }
}
