import type { PulseCompanyProfile, PulseQuote } from '../../shared/world-pulse';
import type { PulseStore } from './store';

/**
 * Tiingo's individual Starter tier is deliberately treated as a small,
 * bounded local fallback.  We leave a little headroom below the published
 * limits so other manual calls made from the same account do not immediately
 * exhaust the key.
 */
export const TIINGO_HOURLY_LIMIT = 45;
export const TIINGO_DAILY_LIMIT = 900;
export const TIINGO_MONTHLY_SYMBOL_LIMIT = 500;
const HOUR_MS = 3_600_000;
const DAY_MS = 86_400_000;
const API = 'https://api.tiingo.com';

type Transport = (url: string, init?: RequestInit) => Promise<Response>;

interface TiingoIexQuote {
  ticker?: unknown;
  last?: unknown;
  tngoLast?: unknown;
  prevClose?: unknown;
  high?: unknown;
  low?: unknown;
  open?: unknown;
  quoteTimestamp?: unknown;
  lastSaleTimestamp?: unknown;
}

interface TiingoDailyProfile {
  ticker?: unknown;
  name?: unknown;
  exchangeCode?: unknown;
  description?: unknown;
  startDate?: unknown;
  endDate?: unknown;
}

export class TiingoError extends Error {
  constructor(
    public status: number,
    message: string,
  ) {
    super(message);
  }
}

function number(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

function text(value: unknown, max = 240): string | undefined {
  return typeof value === 'string' && value.trim() ? value.trim().slice(0, max) : undefined;
}

function monthKey(now: number): string {
  return new Date(now).toISOString().slice(0, 7);
}

export interface TiingoUsage {
  callsLastHour: number;
  callsToday: number;
  uniqueSymbolsThisMonth: number;
  hourlyLimit: number;
  dailyLimit: number;
  monthlySymbolLimit: number;
}

export class TiingoService {
  private calls: number[] = [];
  private dailyCalls: number[] = [];
  private usedSymbols = new Set<string>();
  private usageMonth: string;
  private backoffUntil = 0;

  constructor(
    private readonly store: PulseStore,
    private readonly key: string | undefined,
    private readonly transport: Transport,
    private readonly now: () => number,
  ) {
    this.usageMonth = monthKey(this.now());
    const saved = this.store.getPersistent<{ month?: string; symbols?: string[]; calls?: number[] }>('tiingo-usage');
    if (saved?.month === this.usageMonth && Array.isArray(saved.symbols))
      this.usedSymbols = new Set(saved.symbols.filter((symbol) => /^[A-Z][A-Z0-9.-]{0,14}$/.test(symbol)));
    if (Array.isArray(saved?.calls)) {
      const now = this.now();
      this.dailyCalls = saved.calls.filter((time) => Number.isFinite(time) && time > now - DAY_MS);
      this.calls = this.dailyCalls.filter((time) => time > now - HOUR_MS);
    }
  }

  get configured(): boolean {
    return !!this.key?.trim();
  }

  usage(): TiingoUsage {
    const now = this.now();
    this.rollMonth(now);
    this.calls = this.calls.filter((time) => time > now - HOUR_MS);
    this.dailyCalls = this.dailyCalls.filter((time) => time > now - DAY_MS);
    return {
      callsLastHour: this.calls.length,
      callsToday: this.dailyCalls.length,
      uniqueSymbolsThisMonth: this.usedSymbols.size,
      hourlyLimit: TIINGO_HOURLY_LIMIT,
      dailyLimit: TIINGO_DAILY_LIMIT,
      monthlySymbolLimit: TIINGO_MONTHLY_SYMBOL_LIMIT,
    };
  }

  private rollMonth(now: number): void {
    const next = monthKey(now);
    if (next === this.usageMonth) return;
    this.usageMonth = next;
    this.usedSymbols = new Set();
    this.persistUsage();
  }

  private persistUsage(): void {
    this.store.setPersistent('tiingo-usage', {
      month: this.usageMonth,
      symbols: [...this.usedSymbols].slice(0, TIINGO_MONTHLY_SYMBOL_LIMIT),
      // Keep only the active daily window so a restart cannot bypass today's
      // cap, while the persistent record itself does not grow without bound.
      calls: this.dailyCalls.filter((time) => time > this.now() - DAY_MS),
    });
  }

  private reserve(symbols: string[]): void {
    if (!this.configured) throw new TiingoError(503, 'Tiingo is not configured.');
    const now = this.now();
    this.rollMonth(now);
    this.calls = this.calls.filter((time) => time > now - HOUR_MS);
    this.dailyCalls = this.dailyCalls.filter((time) => time > now - DAY_MS);
    if (now < this.backoffUntil) throw new TiingoError(429, 'Tiingo is cooling down after a rate limit.');
    if (this.calls.length >= TIINGO_HOURLY_LIMIT)
      throw new TiingoError(429, 'Tiingo hourly budget is used; cached values shown.');
    if (this.dailyCalls.length >= TIINGO_DAILY_LIMIT)
      throw new TiingoError(429, 'Tiingo daily budget is used; cached values shown.');
    const unseen = symbols.filter((symbol) => !this.usedSymbols.has(symbol));
    if (this.usedSymbols.size + unseen.length > TIINGO_MONTHLY_SYMBOL_LIMIT)
      throw new TiingoError(429, 'Tiingo monthly symbol budget is used; cached values shown.');
    this.calls.push(now);
    this.dailyCalls.push(now);
    unseen.forEach((symbol) => this.usedSymbols.add(symbol));
    this.persistUsage();
  }

  private async json<T>(path: string): Promise<T> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 12_000);
    try {
      const response = await this.transport(`${API}${path}`, {
        headers: { Authorization: `Token ${this.key!.trim()}`, Accept: 'application/json' },
        signal: controller.signal,
      });
      if (response.status === 429) {
        this.backoffUntil = this.now() + 60_000;
        throw new TiingoError(429, 'Tiingo rate limit reached; retrying after a minute.');
      }
      if (response.status === 401 || response.status === 403)
        throw new TiingoError(response.status, 'Tiingo rejected this request or plan entitlement.');
      if (!response.ok) throw new TiingoError(502, 'Tiingo is unavailable.');
      const body = await response.text();
      if (body.length > 3_000_000) throw new TiingoError(502, 'Tiingo response too large.');
      return JSON.parse(body) as T;
    } catch (error) {
      if (error instanceof TiingoError) throw error;
      throw new TiingoError(502, 'Tiingo could not be reached.');
    } finally {
      clearTimeout(timer);
    }
  }

  /** Batch IEX quote request: one provider call for the whole Portfolio page. */
  async quotes(symbols: string[]): Promise<Record<string, PulseQuote>> {
    const list = [...new Set(symbols)].filter((symbol) => /^[A-Z][A-Z0-9.-]{0,14}$/.test(symbol)).slice(0, 40);
    if (!list.length || !this.configured) return {};
    const due: string[] = [];
    const cached: Record<string, PulseQuote> = {};
    for (const symbol of list) {
      const value = this.store.get<PulseQuote>(`tiingo:quote:${symbol}`, this.now());
      if (value) cached[symbol] = value;
      if (!value || this.now() - Date.parse(value.fetchedAt) >= 5 * 60_000) due.push(symbol);
    }
    if (due.length) {
      this.reserve(due);
      const raw = await this.json<TiingoIexQuote[]>(`/iex/?tickers=${encodeURIComponent(due.join(','))}`);
      if (!Array.isArray(raw)) throw new TiingoError(502, 'Invalid Tiingo IEX response.');
      for (const row of raw) {
        const symbol = text(row.ticker, 15)?.toUpperCase();
        if (!symbol || !list.includes(symbol)) continue;
        const price = number(row.last) ?? number(row.tngoLast);
        const previousClose = number(row.prevClose);
        if (!price || !previousClose) continue;
        const quote: PulseQuote = {
          symbol,
          price,
          change: price - previousClose,
          changePercent: ((price - previousClose) / previousClose) * 100,
          previousClose,
          high: number(row.high) ?? price,
          low: number(row.low) ?? price,
          open: number(row.open) ?? price,
          time: text(row.lastSaleTimestamp, 60) ?? text(row.quoteTimestamp, 60) ?? new Date(this.now()).toISOString(),
          fetchedAt: new Date(this.now()).toISOString(),
          source: 'tiingo',
        };
        this.store.set(`tiingo:quote:${symbol}`, quote, this.now() + 7 * DAY_MS, this.now());
        cached[symbol] = quote;
      }
    }
    return cached;
  }

  async profile(symbol: string): Promise<PulseCompanyProfile> {
    const key = `tiingo:profile:${symbol}`;
    const cached = this.store.get<PulseCompanyProfile>(key, this.now());
    if (cached) return cached;
    this.reserve([symbol]);
    const raw = await this.json<TiingoDailyProfile>(`/tiingo/daily/${encodeURIComponent(symbol)}`);
    const profile: PulseCompanyProfile = {
      symbol,
      name: text(raw.name) ?? symbol,
      exchange: text(raw.exchangeCode, 40),
      industry: undefined,
      country: undefined,
      peers: [],
      fetchedAt: new Date(this.now()).toISOString(),
    };
    this.store.set(key, profile, this.now() + 24 * HOUR_MS, this.now());
    return profile;
  }
}
