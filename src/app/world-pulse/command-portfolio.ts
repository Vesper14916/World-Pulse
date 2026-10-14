import type { PulseEvent, PulseMarketSnapshot, PulseCompany } from '../../../shared/world-pulse';
import { matchCompanies, type AppState } from '../../services/world-pulse/model';
import { button, el, ago, setChildren, preservePanel } from './dom';

/** Company matching happens in the browser. Only public stock symbols leave it. */
export class CommandPortfolio {
  readonly element = el('section', {
    class: 'command-portfolio',
    'aria-label': 'Portfolio connections',
  });
  private market?: PulseMarketSnapshot;
  private lastFetch = 0;
  private pending = false;
  private error = '';
  private signature = '';
  private symbols = '';
  private events: PulseEvent[] = [];
  private replay = false;
  constructor(
    private getState: () => AppState,
    private openCompany: (id: string) => void,
    private openEvent: (e: PulseEvent) => void,
  ) {}
  update(events: PulseEvent[], replay: boolean) {
    this.events = events;
    this.replay = replay;
    this.render();
  }
  async refresh() {
    const symbols = [...new Set(this.getState().companies.map((c) => c.symbol))].slice(0, 30);
    const key = symbols.join(',');
    if (
      this.pending ||
      !symbols.length ||
      (key === this.symbols && Date.now() - this.lastFetch < 60000)
    )
      return;
    this.pending = true;
    this.symbols = key;
    try {
      const r = await fetch('/api/world-pulse/market', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ symbols }),
        signal: AbortSignal.timeout(15000),
      });
      if (!r.ok) throw Error();
      this.market = await r.json();
      this.error = '';
    } catch {
      this.error = 'Current quotes unavailable. Direct reporting links remain available.';
    } finally {
      this.lastFetch = Date.now();
      this.pending = false;
      this.render();
    }
  }
  private render() {
    const companies = this.getState().companies;
    const signature = JSON.stringify([
      companies,
      this.events.map((e) => [e.id, e.title]),
      this.replay,
      this.market?.fetchedAt,
      this.error,
    ]);
    if (signature === this.signature) return;
    this.signature = signature;
    const restore = preservePanel(this.element);
    const matches = companies
      .map((c) => ({
        company: c,
        reports: this.events.filter((e) => matchCompanies(e, [c]).length),
      }))
      .filter((row) => row.reports.length);
    setChildren(
      this.element,
      el('div', { class: 'command-panel-title' }, 'YOUR COMPANIES / DIRECT MENTIONS'),
      !companies.length
        ? el(
            'p',
            { class: 'command-muted' },
            'Add companies in Reading → Portfolio to see direct reporting connections here.',
          )
        : null,
      companies.length && !matches.length
        ? el(
            'p',
            { class: 'command-muted' },
            'No direct company mentions in the selected area and time window.',
          )
        : null,
      this.replay
        ? el(
            'p',
            { class: 'command-note' },
            'Replay reports · quotes below are current, not historical prices.',
          )
        : null,
      this.market?.limited
        ? el(
            'p',
            { class: 'command-note' },
            'Quote refresh is limited; displayed quotes may be cached.',
          )
        : null,
      this.error ? el('p', { class: 'command-note' }, this.error) : null,
      ...matches.slice(0, 8).map(({ company, reports }) => this.card(company, reports)),
      companies.length
        ? button('Open Portfolio →', () => this.openCompany(''), 'command-open-reading')
        : button('Add companies →', () => this.openCompany(''), 'command-open-reading'),
    );
    restore();
  }
  private card(company: PulseCompany, reports: PulseEvent[]) {
    const quote = this.market?.quotes[company.symbol];
    const stale =
      !!quote?.time &&
      Date.now() -
        Date.parse(
          typeof quote.time === 'number'
            ? new Date(quote.time * 1000).toISOString()
            : String(quote.time),
        ) >
        15 * 60000;
    const matching = matchCompanies(reports[0]!, [company])[0];
    return el(
      'article',
      { class: 'command-company', 'data-command-company': company.symbol },
      el(
        'div',
        { class: 'command-company-heading' },
        button(company.symbol, () => this.openCompany(company.id), 'company-symbol'),
        el('span', {}, `${reports.length} direct ${reports.length === 1 ? 'mention' : 'mentions'}`),
      ),
      el(
        'div',
        { class: 'command-quote' },
        quote
          ? `$${quote.price.toFixed(2)} · ${quote.changePercent >= 0 ? '+' : ''}${quote.changePercent.toFixed(2)}%`
          : 'Quote unavailable',
        el(
          'small',
          {},
          quote
            ? `Current quote · ${quote.source || 'Finnhub'} · ${stale ? 'stale' : ago(quote.fetchedAt)}`
            : this.market?.configured
              ? 'Provider did not return this symbol'
              : 'Market key not configured',
        ),
      ),
      el(
        'details',
        {},
        el('summary', {}, 'Why connected?'),
        el(
          'p',
          { class: 'command-muted' },
          `Reporting directly mentions “${matching?.term || company.name}”. This is not a price-impact inference.`,
        ),
        ...reports
          .slice(0, 3)
          .map((e) => button(e.title, () => this.openEvent(e), 'command-company-report')),
      ),
      company.links?.length
        ? el(
            'p',
            { class: 'command-muted' },
            `Your links: ${company.links.map((l) => `${l.symbol} (${l.relation})`).join(', ')} · user-provided`,
          )
        : null,
    );
  }
}
