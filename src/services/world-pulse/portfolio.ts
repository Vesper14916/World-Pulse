import type {
  PulseCalendarItem,
  PulseCompany,
  PulseEvent,
  PulseQuote,
} from '../../../shared/world-pulse.ts';
import { heatForEvent, observedEventTime } from '../../../shared/world-pulse-insights.ts';
import { eventQuality } from '../../../shared/world-pulse-quality.ts';
import { matchCompanies } from './model.ts';

const HOUR = 3_600_000;
const DAY = 24 * HOUR;

/** Thresholds are reading aids, not trading signals; they are shown with every flag. */
export const RADAR = {
  movePercent: 3,
  spikeMultiple: 3,
  spikeMinimum: 3,
} as const;

export interface PortfolioSummary {
  value: number;
  dayChange: number;
  dayChangePercent: number;
  unrealized: number;
  unrealizedPercent: number;
  positions: number;
  priced: number;
}
export function portfolioSummary(
  companies: PulseCompany[],
  quotes: Record<string, PulseQuote>,
): PortfolioSummary | undefined {
  let value = 0;
  let previous = 0;
  let cost = 0;
  let positions = 0;
  let priced = 0;
  for (const company of companies) {
    if (!company.position || company.position.shares <= 0) continue;
    positions++;
    const quote = quotes[company.symbol];
    if (!quote) continue;
    priced++;
    value += company.position.shares * quote.price;
    previous += company.position.shares * quote.previousClose;
    cost += company.position.shares * company.position.cost;
  }
  if (!positions) return undefined;
  return {
    value,
    dayChange: value - previous,
    dayChangePercent: previous ? ((value - previous) / previous) * 100 : 0,
    unrealized: value - cost,
    unrealizedPercent: cost ? ((value - cost) / cost) * 100 : 0,
    positions,
    priced,
  };
}
export function positionValue(company: PulseCompany, quote?: PulseQuote) {
  if (!company.position || !quote) return undefined;
  const { shares, cost } = company.position;
  return {
    value: shares * quote.price,
    day: shares * quote.change,
    unrealized: shares * (quote.price - cost),
    unrealizedPercent: cost ? ((quote.price - cost) / cost) * 100 : 0,
  };
}

/** Events that directly mention the company, visible after quality filtering. */
export function companyEvents(events: PulseEvent[], company: PulseCompany): PulseEvent[] {
  return events.filter((event) => {
    const quality = eventQuality(event);
    if (quality.onlyBlocked || quality.onlyLowQuality) return false;
    return matchCompanies(event, [company]).length > 0;
  });
}
function within(event: PulseEvent, now: number, span: number) {
  const time = observedEventTime(event);
  return Number.isFinite(time) && time <= now && time > now - span;
}

export type RadarLevel = 'move' | 'spike' | 'quiet';
export interface RadarReading {
  level: RadarLevel;
  stories24h: number;
  dailyAverage7d: number;
  reasons: string[];
}
export function radarFor(
  company: PulseCompany,
  events: PulseEvent[],
  quote: PulseQuote | undefined,
  now = Date.now(),
): RadarReading {
  const mine = companyEvents(events, company);
  const stories24h = mine.filter((event) => within(event, now, DAY)).length;
  const previousSix = mine.filter(
    (event) => within(event, now, 7 * DAY) && !within(event, now, DAY),
  ).length;
  const dailyAverage7d = previousSix / 6;
  const reasons: string[] = [];
  const move = quote && Math.abs(quote.changePercent) >= RADAR.movePercent;
  const spike =
    stories24h >= RADAR.spikeMinimum &&
    stories24h >= RADAR.spikeMultiple * Math.max(dailyAverage7d, 1 / 3);
  if (move)
    reasons.push(
      `Price ${quote!.changePercent > 0 ? '+' : ''}${quote!.changePercent.toFixed(2)}% today (flag at ±${RADAR.movePercent}%)${stories24h ? `, with ${stories24h} ${stories24h === 1 ? 'story' : 'stories'} in 24h` : ', with no matching coverage'}.`,
    );
  if (spike)
    reasons.push(
      `${stories24h} stories in 24h vs ${dailyAverage7d.toFixed(1)} per day over the previous six days (flag at ${RADAR.spikeMultiple}× and at least ${RADAR.spikeMinimum}).`,
    );
  if (!reasons.length) reasons.push('No large price move and no coverage spike.');
  return { level: move ? 'move' : spike ? 'spike' : 'quiet', stories24h, dailyAverage7d, reasons };
}

/** Stories per day for the last seven days, oldest first. */
export function coverageTimeline(events: PulseEvent[], now = Date.now()) {
  const days = Array.from({ length: 7 }, (_, index) => {
    const end = now - (6 - index) * DAY;
    return { start: end - DAY, end, count: 0, events: [] as PulseEvent[] };
  });
  for (const event of events) {
    const time = observedEventTime(event);
    const day = days.find((slot) => time > slot.start && time <= slot.end);
    if (day) {
      day.count++;
      day.events.push(event);
    }
  }
  return days;
}

/** Countries named in the reporting, most frequent first. */
export function coverageRegions(events: PulseEvent[]) {
  const counts = new Map<string, { country: string; name: string; count: number }>();
  for (const event of events) {
    const location = event.location;
    if (!location?.country) continue;
    const entry = counts.get(location.country) ?? { country: location.country, name: location.name, count: 0 };
    entry.count++;
    counts.set(location.country, entry);
  }
  return [...counts.values()].sort((a, b) => b.count - a.count);
}

export interface BriefLine {
  symbol: string;
  level: RadarLevel | 'ahead';
  text: string;
  eventIds: string[];
}
function signed(value: number, digits = 2) {
  return `${value > 0 ? '+' : value < 0 ? '−' : ''}${Math.abs(value).toFixed(digits)}`;
}
/** Rule-written morning brief: flagged companies first, then what is scheduled. */
export function morningBrief(
  companies: PulseCompany[],
  events: PulseEvent[],
  quotes: Record<string, PulseQuote>,
  calendar: PulseCalendarItem[],
  now = Date.now(),
): { lines: BriefLine[]; quiet: string[] } {
  const lines: BriefLine[] = [];
  const quiet: string[] = [];
  for (const company of companies) {
    const quote = quotes[company.symbol];
    const radar = radarFor(company, events, quote, now);
    if (radar.level === 'quiet') {
      quiet.push(company.symbol);
      continue;
    }
    const recent = companyEvents(events, company)
      .filter((event) => within(event, now, DAY))
      .sort((a, b) => heatForEvent(b, now).publishers24h - heatForEvent(a, now).publishers24h);
    const lead = recent[0];
    const outlets = lead ? heatForEvent(lead, now).publishers24h : 0;
    const price = quote ? `${signed(quote.changePercent)}% (${quote.price.toFixed(2)})` : 'price unavailable';
    const text =
      radar.level === 'move'
        ? `${price}; ${radar.stories24h ? `${radar.stories24h} ${radar.stories24h === 1 ? 'story' : 'stories'} in 24h${lead ? `, most covered: “${lead.title}”${outlets > 1 ? ` (${outlets} outlets)` : ''}` : ''}` : 'no matching coverage found'}.`
        : `Coverage ${radar.dailyAverage7d ? `${(radar.stories24h / Math.max(radar.dailyAverage7d, 1 / 3)).toFixed(1)}×` : 'well above'} its recent daily level (${radar.stories24h} stories)${lead ? `; most covered: “${lead.title}”` : ''}. Price ${quote ? `${signed(quote.changePercent)}%` : 'unavailable'}.`;
    lines.push({ symbol: company.symbol, level: radar.level, text, eventIds: recent.map((event) => event.id) });
  }
  const today = new Date(now).toISOString().slice(0, 10);
  const weekAhead = new Date(now + 7 * DAY).toISOString().slice(0, 10);
  const ahead = calendar.filter((item) => item.date >= today && item.date <= weekAhead);
  if (ahead.length)
    lines.push({
      symbol: 'AHEAD',
      level: 'ahead',
      text: ahead.map((item) => `${item.title} (${new Date(item.date + 'T12:00:00Z').toLocaleDateString('en-GB', { weekday: 'short', day: 'numeric', month: 'short' })})`).join(' · ') + '.',
      eventIds: [],
    });
  lines.sort((a, b) => ({ move: 0, spike: 1, ahead: 2, quiet: 3 })[a.level] - ({ move: 0, spike: 1, ahead: 2, quiet: 3 })[b.level]);
  return { lines, quiet };
}

/** Change since a report, from prices this service recorded; never back-filled. */
export function sinceReport(reportPrice: number | null | undefined, quote?: PulseQuote) {
  if (!reportPrice || !quote) return undefined;
  return ((quote.price - reportPrice) / reportPrice) * 100;
}
