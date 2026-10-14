import type { PulseEvent } from './world-pulse';
import { inArea, type StrategicArea } from './world-pulse-strategic';

export type ObservationHealth = 'loading' | 'fresh' | 'stale' | 'partial' | 'no-key' | 'error';
export interface ObservationSource {
  id: string;
  name: string;
  state: ObservationHealth;
  url: string;
  lastSuccess?: string;
  lastObservation?: string;
  message: string;
}
export interface VesselObservation {
  mmsi: string;
  name: string;
  lon: number;
  lat: number;
  heading?: number;
  speed?: number;
  shipType?: number;
  observedAt: string;
  receivedAt: string;
  stale?: boolean;
}
export interface MaritimeSnapshot {
  vessels: VesselObservation[];
  total: number;
  truncated: boolean;
  source: ObservationSource;
  generatedAt: string;
  at: string;
  coverage: {
    start: string | null;
    end: string | null;
    gaps: [string, string][];
    samplingMinutes: number;
    capacityLimited: boolean;
  };
  trail?: VesselObservation[];
}
export interface MaritimeNotice {
  id: string;
  title: string;
  url: string;
  publishedAt: string;
  text: string;
  areaIds: string[];
  location?: { lon: number; lat: number };
}
export interface TransitDay {
  date: string;
  count: number | null;
}
export interface WaterwayObservation {
  id: string;
  days: TransitDay[];
  source: ObservationSource;
}
export interface SituationSnapshot {
  notices: MaritimeNotice[];
  waterways: WaterwayObservation[];
  sources: ObservationSource[];
  generatedAt: string;
}
export interface TimelineSnapshot {
  bins: { at: string; samples: number }[];
  coverage: MaritimeSnapshot['coverage'];
  generatedAt: string;
}
export const COMMAND_RETENTION_MS = 168 * 3600_000;

/** Conservative, auditable title rules. They classify reporting, not military reality. */
export function conflictKind(event: PulseEvent): 'conflict' | 'ceasefire' | null {
  const title = event.title;
  if (
    /trade war|price war|chip war|war on (?:drugs|inflation|cancer)|world war (?:i\b|ii\b|one|two)|anniversary|video game|military exercise|military drill|贸易战|价格战|芯片战|商战|纪念|二战|一战|演习|军演|游戏/i.test(
      title,
    )
  )
    return null;
  if (/ceasefire|peace talks|truce|停火|和谈|停战/i.test(title)) return 'ceasefire';
  // An action plus an armed actor/location context is required for ambiguous attacks.
  const military =
    /military|army|troops|soldier|missile|airstrike|air strike|shelling|bombard|drone|armed|navy|naval|houthi|hamas|hezbollah|ukrain|russia|israel|iran|gaza|sudan|军|导弹|空袭|炮击|武装|胡塞|以色列|伊朗|加沙|乌克兰|苏丹/i;
  const action =
    /airstrikes?|air strikes?|shelling|bombard|missile.{0,35}(?:strike|attack|launch)|(?:attack|strike|invad|invasi|clash|offensive|fighting|killed|bombing)|交火|空袭|炮击|轰炸|袭击|入侵|攻势|战斗|击毙/i;
  return military.test(title) && action.test(title) ? 'conflict' : null;
}
export function eventTime(event: PulseEvent): number {
  return Date.parse(event.publishedAt || event.firstSeenAt || event.fetchedAt);
}
export function eventInArea(event: PulseEvent, area: StrategicArea): boolean {
  if (area.id === 'global') return true;
  const content = `${event.title} ${event.summary || ''}`.toLowerCase();
  if (area.aliases.some((a) => content.includes(a.toLowerCase()))) return true;
  if (!event.location) return false;
  // A country centroid cannot establish a local waterway association.
  if (area.countries.includes(event.location.country)) return true;
  return (
    event.location.precision !== 'country' && inArea(event.location.lon, event.location.lat, area)
  );
}

/** Remove later reports before historical presentation; aggregate scores are deliberately not reused. */
export function reportsAt(events: PulseEvent[], at: number): PulseEvent[] {
  return events.flatMap((event) => {
    if (!event.reports?.length) return eventTime(event) <= at ? [event] : [];
    const reports = event.reports
      .filter((r) => Date.parse(r.publishedAt || r.firstSeenAt) <= at)
      .sort(
        (a, b) =>
          Date.parse(b.publishedAt || b.firstSeenAt) - Date.parse(a.publishedAt || a.firstSeenAt),
      );
    if (!reports.length) return [];
    const first = reports[0]!;
    return [
      {
        ...event,
        title: first.title,
        summary: first.summary,
        reports,
        sources: reports.map((r) => r.source),
        publishedAt: first.publishedAt,
        firstSeenAt: first.firstSeenAt,
        timeBasis: first.timeBasis,
        location: first.title === event.title ? event.location : undefined,
        companies: undefined,
        heat: undefined,
        importance: undefined,
        companyAssessments: undefined,
      },
    ];
  });
}
