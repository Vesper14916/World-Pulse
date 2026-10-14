import type {
  PulseCompany,
  PulseCompanyData,
  PulseDirectory,
  PulseEvent,
  PulseSourceStatus,
} from '../../shared/world-pulse';
import {
  gdeltUrl,
  HN_TOP,
  parseDirectory,
  parseFilings,
  parseGdelt,
  parseHN,
  SEC_DIRECTORY,
  seedDirectory,
} from './data';
import { PulseStore, RETENTION_MS } from './store';
import { companyNewsUrl, parseCompanyNews } from './company-news';
export type DataRequest = (url: string, init?: RequestInit) => Promise<string>;
const descriptor = (id: string, name: string, url: string): PulseSourceStatus => ({
  id,
  name,
  url,
  state: 'loading',
  lastSuccess: null,
  lastAttempt: null,
  nextRefresh: null,
  count: 0,
  rejected: 0,
});
export class DataHub {
  private statuses = new Map<string, PulseSourceStatus>();
  private failures = new Map<string, number>();
  private pending = new Map<string, Promise<void>>();
  private companyPending = new Map<string, Promise<PulseCompanyData>>();
  private trackedCompanyIds = new Set<string>();
  private companyActive = 0;
  private companyWaiters: Array<() => void> = [];
  private currentDirectory: PulseDirectory;
  constructor(
    private store: PulseStore,
    private request: DataRequest,
    private now: () => number,
    private userAgent: string,
  ) {
    this.currentDirectory = store.get<PulseDirectory>('directory', now()) ?? seedDirectory();
    for (const [id, count] of store.get<[string, number][]>('extended-failures', now()) ?? [])
      this.failures.set(id, count);
    for (const s of store.get<PulseSourceStatus[]>('extended-statuses', now()) ?? [])
      this.statuses.set(s.id, {
        ...s,
        state:
          s.lastSuccess && !s.error && s.nextRefresh && Date.parse(s.nextRefresh) > now()
            ? 'fresh'
            : s.lastSuccess
              ? 'stale'
              : 'error',
      });
    for (const [id, name, url] of [
      ['gdelt-global', 'GDELT Global', gdeltUrl()],
      ['hacker-news', 'Hacker News top 50', HN_TOP],
      ['sec-directory', 'SEC company directory', SEC_DIRECTORY],
    ])
      if (!this.statuses.has(id!)) this.statuses.set(id!, descriptor(id!, name!, url!));
  }
  statusesSnapshot(): PulseSourceStatus[] {
    return [...this.statuses.values()].map((s) => ({
      ...s,
      state:
        s.state === 'error' || !s.lastSuccess
          ? s.state
          : s.error && !s.intervalMs
            ? 'stale'
          : s.intervalMs && this.now() - Date.parse(s.lastSuccess) > s.intervalMs * 2
            ? 'stale'
            : 'fresh',
    }));
  }
  private async update(
    id: string,
    name: string,
    url: string,
    interval: number,
    load: () => Promise<{
      events?: PulseEvent[];
      count?: number;
      rejected?: number;
      truncated?: boolean;
      coverage?: string;
    }>,
  ): Promise<void> {
    const existing = this.pending.get(id);
    if (existing) return existing;
    let s = this.statuses.get(id);
    if (!s) {
      s = descriptor(id, name, url);
      this.statuses.set(id, s);
    }
    s.intervalMs = interval;
    if (s.nextRefresh && Date.parse(s.nextRefresh) > this.now()) return;
    const status = s;
    const pending = (async () => {
      const attempted = this.now();
      status.lastAttempt = new Date(attempted).toISOString();
      try {
        const result = await load();
        if (result.events) this.store.ingest(result.events, this.now());
        Object.assign(status, {
          state: 'fresh',
          lastSuccess: new Date(this.now()).toISOString(),
          nextRefresh: new Date(this.now() + interval).toISOString(),
          count: result.count ?? result.events?.length ?? 0,
          rejected: result.rejected ?? 0,
          truncated: result.truncated ?? false,
          coverage: result.coverage,
          intervalMs: interval,
          consecutiveFailures: 0,
          latencyMs: Math.max(0, this.now() - attempted),
        });
        delete status.error;
        this.failures.set(id, 0);
      } catch (error) {
        const failure = (this.failures.get(id) ?? 0) + 1;
        this.failures.set(id, failure);
        Object.assign(status, {
          state:
            !status.lastSuccess || this.now() - Date.parse(status.lastSuccess) > interval * 2
              ? status.lastSuccess
                ? 'stale'
                : 'error'
              : 'fresh',
          error:
            error && typeof error === 'object' && 'status' in error && error.status === 429
              ? 'Provider rate limit (HTTP 429). Cached data retained; retry scheduled.'
              : 'Source unavailable or response invalid. Cached data retained; retry scheduled.',
          nextRefresh: new Date(
            this.now() +
              (id === 'sec-directory'
                ? 86400000
                : Math.min(3600000, 60000 * 2 ** Math.min(failure - 1, 6))),
          ).toISOString(),
          intervalMs: interval,
          consecutiveFailures: failure,
          latencyMs: Math.max(0, this.now() - attempted),
        });
      }
      this.store.set(
        'extended-statuses',
        this.statusesSnapshot(),
        this.now() + RETENTION_MS,
        this.now(),
      );
      this.store.set(
        'extended-failures',
        [...this.failures],
        this.now() + RETENTION_MS,
        this.now(),
      );
    })();
    this.pending.set(id, pending);
    try {
      await pending;
    } finally {
      this.pending.delete(id);
    }
  }
  async refresh(): Promise<void> {
    await Promise.all([
      this.update('gdelt-global', 'GDELT Global', gdeltUrl(), 1800000, async () => ({
        ...parseGdelt(await this.request(gdeltUrl()), new Date(this.now()).toISOString()),
        coverage:
          'At most 100 English-language reports discovered during the last 24 hours; not exhaustive.',
      })),
      this.refreshHN(),
      this.refreshDirectory(),
    ]);
    const dueCompanies = [...this.trackedCompanyIds].filter((id) =>
      [`company-news:${id}`, `gdelt:${id}`, `sec:${id}`].some((sourceId) => {
        const status = this.statuses.get(sourceId);
        return !status?.nextRefresh || Date.parse(status.nextRefresh) <= this.now();
      }),
    );
    await Promise.all(dueCompanies.map((id) => this.companyData(id)));
  }
  private async refreshHN(): Promise<void> {
    await this.update('hacker-news', 'Hacker News top 50', HN_TOP, 900000, async () => {
      const ids = JSON.parse(await this.request(HN_TOP));
      if (!Array.isArray(ids)) throw new Error('Invalid HN top list');
      const deadline = Date.now() + 15000;
      const selected = ids.filter((id) => Number.isSafeInteger(id) && id > 0).slice(0, 50);
      let index = 0,
        rejected = 0;
      const events: PulseEvent[] = [];
      await Promise.all(
        Array.from({ length: Math.min(3, selected.length) }, async () => {
          while (index < selected.length && Date.now() < deadline) {
            const id = selected[index++];
            try {
              const item = JSON.parse(
                await this.request(`https://hacker-news.firebaseio.com/v0/item/${id}.json`),
              );
              const event = parseHN(item, new Date(this.now()).toISOString());
              if (event) events.push(event);
              else rejected++;
            } catch {
              rejected++;
            }
          }
        }),
      );
      rejected += Math.max(0, selected.length - index);
      if (selected.length && rejected === selected.length) throw new Error('HN items unavailable');
      return {
        events,
        rejected,
        truncated: ids.length > 50 || index < selected.length,
        coverage:
          'Top 50 community submissions only. Votes and comments are discussion signals, not impact evidence.',
      };
    });
  }
  private async refreshDirectory(): Promise<void> {
    await this.update(
      'sec-directory',
      'SEC company directory',
      SEC_DIRECTORY,
      86400000,
      async () => {
        const directory = parseDirectory(
          await this.request(SEC_DIRECTORY, {
            headers: {
              'User-Agent': this.userAgent,
              Accept: 'application/json',
            },
          }),
          new Date(this.now()).toISOString(),
        );
        this.currentDirectory = directory;
        this.store.set('directory', directory, this.now() + RETENTION_MS, this.now());
        return {
          count: directory.companies.length,
          coverage: 'SEC issuer identity directory; exchange and CIK verified by this response.',
        };
      },
    );
  }
  async directory(query = ''): Promise<PulseDirectory> {
    await this.refreshDirectory();
    const status = this.statuses.get('sec-directory');
    const directory = this.currentDirectory;
    const q = query.trim().toLowerCase().slice(0, 100);
    const companies = directory.companies
      .filter((c) => !q || c.symbol.toLowerCase().includes(q) || c.name.toLowerCase().includes(q))
      .sort((a, b) => Number(b.symbol.toLowerCase() === q) - Number(a.symbol.toLowerCase() === q))
      .slice(0, 100);
    return {
      ...directory,
      companies,
      state: directory.state === 'seed' ? 'seed' : status?.state === 'fresh' ? 'fresh' : 'stale',
      message:
        directory.state === 'seed'
          ? directory.message
          : status?.state !== 'fresh'
            ? 'Using cached SEC identities; directory refresh unavailable.'
            : undefined,
    };
  }
  company(id: string): PulseCompany | undefined {
    return this.currentDirectory.companies.find((c) => c.id === id);
  }
  private async withCompanySlot<T>(load: () => Promise<T>): Promise<T> {
    if (this.companyActive >= 2) {
      await new Promise<void>((resolve) => this.companyWaiters.push(resolve));
    } else this.companyActive++;
    try {
      return await load();
    } finally {
      const next = this.companyWaiters.shift();
      if (next) next();
      else this.companyActive--;
    }
  }
  async companyData(id: string): Promise<PulseCompanyData> {
    const pending = this.companyPending.get(id);
    if (pending) return pending;
    const company = this.company(id);
    if (!company) throw new Error('Unknown company identity');
    const reviewedSeed = seedDirectory().companies.some(
      (seed) => seed.id === company.id && seed.cik === company.cik && seed.name === company.name,
    );
    if (company.provenance !== 'catalog' || !company.cik || (!company.verifiedAt && !reviewedSeed))
      throw new Error('Company identity is not verified');
    this.trackedCompanyIds.add(id);
    if (this.companyPending.size >= 10) throw new Error('Company request queue is full');
    const task = this.withCompanySlot(async () => {
      const rss = companyNewsUrl(company);
      const rssTask = this.update(
        `company-news:${id}`,
        `Google News · ${company.symbol}`,
        rss,
        900000,
        async () => ({
          ...parseCompanyNews(await this.request(rss), company, new Date(this.now()).toISOString()),
          coverage:
            'Company search via Google News RSS, up to seven days. Original publisher names preserved; search hits still require direct text matches.',
        }),
      );
      const gdelt = gdeltUrl(company),
        sec = `https://data.sec.gov/submissions/CIK${company.cik!.padStart(10, '0')}.json`;
      const gdeltTask = this.update(
        `gdelt:${id}`,
        `GDELT · ${company.symbol}`,
        gdelt,
        1800000,
        async () => ({
          ...parseGdelt(
            await this.request(gdelt),
            new Date(this.now()).toISOString(),
            `gdelt:${id}`,
          ),
          coverage: 'At most 100 matching reports; a search result is not proof of company impact.',
        }),
      );
      const secTask = company.verifiedAt
        ? this.update(`sec:${id}`, `SEC · ${company.symbol}`, sec, 3600000, async () => ({
            ...parseFilings(
              await this.request(sec, {
                headers: {
                  'User-Agent': this.userAgent,
                  Accept: 'application/json',
                },
              }),
              company,
              new Date(this.now()).toISOString(),
            ),
            coverage:
              '8-K, 10-Q, 10-K, 6-K and 20-F metadata; links to actual filings. Filing text has not been analysed.',
          }))
        : Promise.resolve();
      await Promise.all([rssTask, gdeltTask, secTask]);
      if (!company.verifiedAt)
        this.statuses.set(`sec:${id}`, {
          ...descriptor(`sec:${id}`, `SEC · ${company.symbol}`, sec),
          state: 'error',
          error:
            'SEC filings require a live or cached verified directory identity. Reviewed starter identity is used for news only.',
          coverage: 'No filing request was made because the current identity is not SEC-verified.',
        });
      const feedIds = new Set([`company-news:${id}`, `gdelt:${id}`, `sec:${id}`]);
      return {
        company,
        events: this.store
          .events(this.now())
          .filter((e) => e.sources.some((s) => feedIds.has(s.feedId ?? ''))),
        sources: this.statusesSnapshot().filter((s) => feedIds.has(s.id)),
      };
    });
    this.companyPending.set(id, task);
    try {
      return await task;
    } finally {
      this.companyPending.delete(id);
    }
  }
}
