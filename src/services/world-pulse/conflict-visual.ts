import type { PulseEvent, PulseReport, PulseSource } from '../../../shared/world-pulse';
import { assessReport, cleanHeadline } from '../../../shared/world-pulse-quality';

export type ConflictScale = 'unknown' | 'localized' | 'intensive' | 'large';
export interface ConflictEvidence {
  reportId: string;
  title: string;
  source: PulseSource;
  outlet: string;
  reportedAt: string;
  scale: ConflictScale;
  phrase?: string;
}
export interface ConflictVisual {
  scale: ConflictScale;
  rank: number;
  concrete: boolean;
  recentOutlets: number;
  eligible: boolean;
  located: boolean;
  countryLevel: boolean;
  latestReportAt?: string;
  evidence: ConflictEvidence[];
  reason: string;
}
export const CONFLICT_WINDOW_MS = 24 * 3600_000;
export const CONFLICT_STYLES = {
  unknown: { rank: 0, color: '#c9d0cf', radius: 24, label: 'Scale unknown' },
  localized: { rank: 1, color: '#e1b55d', radius: 24, label: 'Localized fighting' },
  intensive: {
    rank: 2,
    color: '#f39350',
    radius: 40,
    label: 'Multi-location / intensive fighting',
  },
  large: { rank: 3, color: '#f06b68', radius: 60, label: 'Large-scale offensive / bombardment' },
} as const;
export function conflictStyle(rank: number) {
  return Object.values(CONFLICT_STYLES).find((s) => s.rank === rank) || CONFLICT_STYLES.unknown;
}

// A closed, conservative vocabulary: these are evidence labels, never force or casualty estimates.
const EXCLUDED =
  /trade war|price war|chip war|cyber|video game|military (?:exercise|drill)|war on (?:drugs|inflation|cancer)|world war|anniversary|years? ago|on this day|histor(?:y|ic|ical)|retrospective|\b(?:may|might|could|would|will|rumou?r|forecast|predict\w*|threat\w*|warn\w*|prepar\w*|plans?|planned|fears?|denies?|denied)\b|\b(?:calls? for|urges?|demands?|no attacks?|did not|has not|had not|never)\b|ceasefire|peace talks|truce|贸易战|价格战|芯片战|商战|网络攻击|网络袭击|游戏|演习|军演|纪念|回顾|当年|二战|一战|可能|或将|或会|预计|预测|假如|如果|威胁|警告|计划|準備|准备|拟|恐将|担忧|担心|否认|并未|未发生|没有发生|呼吁|敦促|停火|和谈|停战|[?？]/i;
const ARMED =
  /\b(?:military|army|troops?|soldiers?|missiles?|airstrikes?|air strikes?|shelling|bombardment|drones?|armed|navy|naval|houthi|hamas|hezbollah|ukrain\w*|russia\w*|israel\w*|iran\w*|gaza|sudan\w*)\b|军|導彈|导弹|空袭|空襲|炮击|炮擊|武装|武裝|胡塞|以色列|伊朗|加沙|乌克兰|烏克蘭|苏丹/i;
const ACTION =
  /\b(?:airstrikes?|air strikes?|shelling|shelled|bombard\w*|bombing|bombed|attacks?|attacked|strikes?|clash(?:es)?|clashed|skirmishes|skirmish|fighting|offensives?|invasions?|invades?|invaded)\b|交火|空袭|空襲|炮击|炮擊|轰炸|轟炸|袭击|襲擊|入侵|攻势|攻勢|战斗|戰鬥|击毙/i;
const ENDED_OR_NEGATED =
  /\b(?:not|no)\b.{0,24}\b(?:large[- ]scale|full[- ]scale|major|sustained|localized|fighting|invasion|offensive)\b|\b(?:fighting|attacks?|offensive|shelling)\b.{0,20}\b(?:ends?|ended|stopped|halted|ceased|over)\b|\b(?:ends?|ended|stopped|halted|ceased)\b.{0,20}\b(?:fighting|attacks?|offensive|shelling)\b|并非|並非|不是|并无|並無|(?:交火|战斗|戰鬥|炮击|炮擊|攻势|攻勢).{0,8}(?:结束|結束|停止)|(?:停止|结束|結束).{0,8}(?:交火|战斗|戰鬥|炮击|炮擊|攻势|攻勢)/i;
const SCALE_RULES: { scale: Exclude<ConflictScale, 'unknown'>; pattern: RegExp }[] = [
  {
    scale: 'large',
    pattern:
      /\b(?:large[- ]scale|full[- ]scale|major) (?:military )?(?:offensive|invasion|assault)|\b(?:widespread|wide[- ]ranging) (?:aerial )?(?:bombardment|bombing|airstrikes?)|大规模(?:军事)?(?:攻势|进攻|入侵|轰炸)|大規模(?:軍事)?(?:攻勢|進攻|入侵|轟炸)|广泛轰炸|廣泛轟炸/i,
  },
  {
    scale: 'intensive',
    pattern:
      /\b(?:multi[- ]location|multi[- ]front) (?:fighting|clash(?:es)?|attacks?)|\b(?:fighting|clash(?:es)?|attacks?|airstrikes?|strikes?) (?:across|in|at) (?:multiple|several) (?:locations|cities|fronts|areas)|\b(?:sustained|continuous) (?:heavy|intensive) (?:shelling|bombardment|attacks?|strikes?)|多(?:地|处|處|个地点|個地點)(?:持续|持續)?(?:交火|战斗|戰鬥|空袭|空襲|遭袭|遭襲)|(?:持续|持續)(?:密集|猛烈)(?:炮击|炮擊|轰炸|轟炸|打击|打擊)/i,
  },
  {
    scale: 'localized',
    pattern:
      /\b(?:localized|localised|small[- ]scale|limited) (?:armed )?(?:fighting|clash(?:es)?|skirmishes?|attacks?)|(?:局部|小规模|小規模)(?:武装|武裝)?(?:交火|战斗|戰鬥|冲突|衝突)/i,
  },
];

function linkBearing(source: PulseSource) {
  try {
    return ['http:', 'https:'].includes(new URL(source.url).protocol);
  } catch {
    return false;
  }
}
/** Cursor-relative, per-report assessment. Syndicated aliases and repeat articles count once per outlet. */
export function conflictVisual(event: PulseEvent, at = Date.now()): ConflictVisual {
  const reports: PulseReport[] = event.reports?.length
    ? event.reports
    : event.sources.map((source) => ({
        id: event.id + ':' + source.id,
        title: event.title,
        summary: event.summary,
        source,
        publishedAt: event.publishedAt,
        firstSeenAt: event.firstSeenAt || event.fetchedAt,
      }));
  const evidence: ConflictEvidence[] = [];
  const excludedEvent = EXCLUDED.test(event.title) || ENDED_OR_NEGATED.test(event.title);
  for (const report of reports) {
    const time = Date.parse(report.publishedAt || report.firstSeenAt);
    const { quality, outlet } = assessReport(report);
    const title = cleanHeadline(report.title, report.source);
    const historicalYear = [
      ...title.matchAll(/\b(?:in|during)\s+((?:19|20)\d{2})\b|((?:19|20)\d{2})年/g),
    ].some((m) => Number(m[1] || m[2]) < new Date(at).getUTCFullYear());
    if (
      excludedEvent ||
      historicalYear ||
      !Number.isFinite(time) ||
      time > at ||
      !linkBearing(report.source) ||
      outlet.key === 'unknown' ||
      ['blocked', 'C'].includes(quality) ||
      EXCLUDED.test(title) ||
      ENDED_OR_NEGATED.test(title) ||
      !ARMED.test(title) ||
      !ACTION.test(title)
    )
      continue;
    const rule = SCALE_RULES.find((rule) => rule.pattern.test(title));
    evidence.push({
      reportId: report.id,
      title,
      source: report.source,
      outlet: outlet.key,
      reportedAt: new Date(time).toISOString(),
      scale: rule?.scale || 'unknown',
      phrase: rule?.pattern.exec(title)?.[0],
    });
  }
  evidence.sort((a, b) => Date.parse(b.reportedAt) - Date.parse(a.reportedAt));
  const recent = evidence.filter((e) => at - Date.parse(e.reportedAt) <= CONFLICT_WINDOW_MS);
  // Old descriptions may remain in the detail list but cannot promote today's visual scale.
  const current = recent.length ? recent : evidence;
  const rank = Math.max(0, ...current.map((e) => CONFLICT_STYLES[e.scale].rank));
  const scale = (Object.keys(CONFLICT_STYLES) as ConflictScale[]).find(
    (k) => CONFLICT_STYLES[k].rank === rank,
  )!;
  const recentOutlets = new Set(recent.map((e) => e.outlet)).size;
  const loc = event.location;
  const located =
    !!loc &&
    ['exact', 'region', 'country'].includes(loc.precision) &&
    Number.isFinite(loc.lon) &&
    Math.abs(loc.lon) <= 180 &&
    Number.isFinite(loc.lat) &&
    Math.abs(loc.lat) <= 85;
  const eligible = recentOutlets >= 2 && located;
  const reason = !evidence.length
    ? 'No qualifying concrete combat report.'
    : !located
      ? 'Location unavailable; retained in the signal list.'
      : !recent.length
        ? 'Reports are older than 24 hours at the selected time; static marker.'
        : recentOutlets < 2
          ? 'One independent outlet within 24 hours; static marker.'
          : 'At least two independent outlets within 24 hours; reported fighting, not independent verification.';
  return {
    scale,
    rank,
    concrete: evidence.length > 0,
    recentOutlets,
    eligible,
    located,
    countryLevel: loc?.precision === 'country',
    latestReportAt: evidence[0]?.reportedAt,
    evidence,
    reason,
  };
}

/** Numeric fields are aggregated by MapLibre; eligible ranks never borrow an old/single-source member's scale. */
export function conflictMapProperties(event: PulseEvent, at: number) {
  const v = conflictVisual(event, at);
  const latestByOutlet = new Map<string, number>();
  for (const e of v.evidence)
    latestByOutlet.set(
      e.outlet,
      Math.max(latestByOutlet.get(e.outlet) || 0, Date.parse(e.reportedAt)),
    );
  const secondNewest = [...latestByOutlet.values()].sort((a, b) => b - a)[1] || 0;
  const expires = v.eligible ? secondNewest + CONFLICT_WINDOW_MS : 0;
  const until = (rank: number) =>
    expires
      ? Math.min(
          expires,
          Math.max(
            0,
            ...v.evidence
              .filter((e) => CONFLICT_STYLES[e.scale].rank === rank)
              .map((e) => Date.parse(e.reportedAt)),
          ) + CONFLICT_WINDOW_MS,
        )
      : 0;
  return {
    conflictRank: v.concrete ? v.rank : -1,
    waveRank: v.eligible ? v.rank : -1,
    waveCountry: v.eligible && v.countryLevel ? 1 : 0,
    waveExpires: expires,
    waveUntil0: expires,
    waveUntil1: until(1),
    waveUntil2: until(2),
    waveUntil3: until(3),
    scaleLabel: v.concrete ? conflictStyle(v.rank).label : '',
    evidenceTime: v.latestReportAt || '',
  };
}

/** Re-evaluate cluster grade while animating even if a network refresh is unavailable. */
export function activeWaveRank(until: readonly number[], at: number): number {
  for (let rank = 3; rank >= 0; rank--) if ((until[rank] || 0) >= at) return rank;
  return -1;
}
