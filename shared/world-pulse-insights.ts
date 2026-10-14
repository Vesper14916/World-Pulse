import type {
  PulseAssessment,
  PulseCompany,
  PulseEvent,
  PulseHeat,
  PulseMatch,
  PulseReport,
  PulseSort,
} from './world-pulse.ts';
import { assessReport, cleanHeadline } from './world-pulse-quality.ts';
import {
  CHINESE_NAMES,
  CONTEXT_REQUIRED,
  deriveReportingNames,
  hasCompanyContext,
} from './company-names.ts';

const ambiguous = new Set(['apple', 'amazon', 'oracle', 'meta', 'alphabet', 'visa', 'itc']);
// Explicitly reviewed seed identities. Do not derive unrestricted short names
// from the much larger SEC directory (many are ordinary English words).
const reviewedIdentities: Record<string, { cik: string; names: string[] }> = {
  NVDA: {
    cik: '1045810',
    names: ['NVIDIA', 'NVIDIA Corporation', 'NVIDIA Corp', '英伟达', '輝達'],
  },
  AAPL: {
    cik: '320193',
    names: ['Apple Inc.', 'Apple Inc', '苹果公司', '蘋果公司'],
  },
  MSFT: {
    cik: '789019',
    names: ['Microsoft', 'Microsoft Corporation', 'Microsoft Corp', '微软', '微軟'],
  },
  AMZN: {
    cik: '1018724',
    names: ['Amazon.com', 'Amazon.com Inc.', 'Amazon.com, Inc.', '亚马逊公司', '亞馬遜公司'],
  },
  META: { cik: '1326801', names: ['Meta Platforms', 'Meta Platforms Inc.'] },
  TSLA: {
    cik: '1318605',
    names: ['Tesla', 'Tesla Inc.', 'Tesla, Inc.', '特斯拉'],
  },
  MRVL: { cik: '1835632', names: ['Marvell', 'Marvell Technology'] },
  COHR: {
    cik: '820318',
    names: ['Coherent Corp.', 'Coherent Corp', 'Coherent Corporation'],
  },
  ASTS: { cik: '1780312', names: ['AST SpaceMobile'] },
  IONQ: { cik: '1824920', names: ['IonQ'] },
  GOOGL: {
    cik: '1652044',
    names: ['Alphabet Inc.', 'Alphabet Inc', '谷歌', 'Google'],
  },
  ORCL: {
    cik: '1341439',
    names: ['Oracle Corporation', 'Oracle Corp', '甲骨文公司'],
  },
  V: { cik: '1403161', names: ['Visa Inc.', 'Visa Inc'] },
};
const scores = { unassessed: 0, watch: 1, important: 2, major: 3 } as const;
const escapeRegex = (value: string) => value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
function safeLink(value: string): string | null {
  try {
    const url = new URL(value);
    return /^https?:$/.test(url.protocol) && !url.username && !url.password ? url.href : null;
  } catch {
    return null;
  }
}
function canonicalUrl(value: string): string {
  try {
    const url = new URL(value);
    url.hash = '';
    for (const key of [...url.searchParams.keys()])
      if (/^(utm_|ref$|source$|guccounter$)/i.test(key)) url.searchParams.delete(key);
    return url.href;
  } catch {
    return value;
  }
}
function normalized(value: string): string {
  return value
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .trim();
}
function normalizedCik(value?: string): string {
  return value?.replace(/^0+/, '') || '';
}
function reportsFor(event: PulseEvent): PulseReport[] {
  return event.reports?.length
    ? event.reports
    : event.sources.map((source) => ({
        id: canonicalUrl(source.url),
        title: event.title,
        summary: event.summary,
        source,
        publishedAt: event.publishedAt,
        firstSeenAt: event.fetchedAt,
      }));
}

/** Publication time first; only genuinely supplied discovery metadata may substitute. */
export function observedEventTime(event: PulseEvent): number {
  if (event.publishedAt !== null) return Date.parse(event.publishedAt);
  const discovered = (event.reports || [])
    .map((report) => Date.parse(report.firstSeenAt))
    .filter(Number.isFinite);
  return discovered.length ? Math.min(...discovered) : NaN;
}

/** Content-only fingerprint: refreshing, ranking and fetching never changes it. */
export function eventContentVersion(event: PulseEvent): string {
  const reports = reportsFor(event)
    .map((report) => [
      report.id,
      report.title,
      report.summary,
      report.publishedAt,
      report.source.id,
      report.source.url,
      report.source.publisher,
    ])
    .sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b)));
  const value = JSON.stringify([
    event.id,
    event.title,
    event.summary,
    event.category,
    event.publishedAt,
    reports,
    event.location,
    event.magnitude,
    event.filing,
    event.companies,
  ]);
  let hash = 2166136261;
  for (let i = 0; i < value.length; i++) hash = Math.imul(hash ^ value.charCodeAt(i), 16777619);
  return `v1-${(hash >>> 0).toString(16).padStart(8, '0')}`;
}

/** Heat measures observed coverage, independently of holdings or market impact. */
export function heatForEvent(event: PulseEvent, now = Date.now()): PulseHeat {
  const reportTime = (report: PulseReport) =>
    Date.parse(report.publishedAt === null ? report.firstSeenAt : report.publishedAt);
  const candidates = reportsFor(event)
    .filter((report) => {
      const at = reportTime(report);
      if (report.publishedAt === null && !event.reports?.length) return false;
      return (
        safeLink(report.source.url) && Number.isFinite(at) && at <= now && at >= now - 86_400_000
      );
    })
    .sort((a, b) => reportTime(a) - reportTime(b));
  const urls = new Set<string>();
  const content = new Set<string>();
  const publishers = new Set<string>();
  let newReports3h = 0;
  let discoveryOnly = 0;
  let excluded = 0;
  for (const report of candidates) {
    const quality = assessReport(report);
    // Low-quality or blocked copy never counts as independent coverage.
    if (quality.quality === 'C' || quality.quality === 'blocked') {
      excluded++;
      continue;
    }
    const url = canonicalUrl(report.source.url);
    const fingerprint = normalized(cleanHeadline(report.title, report.source));
    // Identical syndicated text contributes once even when several feeds republish it.
    if (urls.has(url) || (fingerprint && content.has(fingerprint))) continue;
    urls.add(url);
    if (fingerprint) content.add(fingerprint);
    publishers.add(quality.outlet.key);
    if (report.publishedAt === null) discoveryOnly++;
    if (reportTime(report) >= now - 10_800_000) newReports3h++;
  }
  const publishers24h = publishers.size;
  const level =
    publishers24h >= 5 && newReports3h >= 3
      ? 'high'
      : publishers24h >= 3
        ? 'popular'
        : publishers24h >= 2
          ? 'rising'
          : 'unassessed';
  return {
    level,
    publishers24h,
    newReports3h,
    reasons: [
      `${publishers24h} independent publisher(s) observed in the past 24 hours; ${newReports3h} distinct report(s) published or first discovered in the past 3 hours.`,
      ...(excluded
        ? [
            `${excluded} low-quality or blocked report(s) are shown separately and not counted.`,
          ]
        : []),
      ...(discoveryOnly
        ? [
            `${discoveryOnly} report(s) have unknown publication time and use provider discovery/submission time; they are not confirmed newly published articles.`,
          ]
        : []),
      'Each outlet counts once however many names or feeds it appears under; identical headlines count once. This measures available coverage, not global importance or investment impact.',
    ],
  };
}

function assessment(
  event: PulseEvent,
  level: PulseAssessment['level'],
  reasons: string[],
  sourceIds: string[],
  companyId?: string,
): PulseAssessment {
  return {
    level,
    reasons,
    sourceIds: [...new Set(sourceIds)],
    method: 'rules',
    contentVersion: eventContentVersion(event),
    ...(companyId ? { companyId } : {}),
  };
}
function validExisting(
  value: PulseAssessment | undefined,
  event: PulseEvent,
  companyId?: string,
): value is PulseAssessment {
  return (
    !!value &&
    value.contentVersion === eventContentVersion(event) &&
    value.companyId === companyId &&
    value.sourceIds.length > 0 &&
    value.sourceIds.every((id) =>
      event.sources.some((source) => source.id === id && !!safeLink(source.url)),
    )
  );
}
export function publicImportance(event: PulseEvent): PulseAssessment {
  if (validExisting(event.importance, event)) return event.importance;
  const sources = event.sources.filter((source) => safeLink(source.url));
  if (!sources.length) return assessment(event, 'unassessed', ['No usable source evidence.'], []);
  const usgs = sources.find((source) => {
    try {
      return new URL(source.url).hostname === 'earthquake.usgs.gov';
    } catch {
      return false;
    }
  });
  if (usgs && Number.isFinite(event.magnitude)) {
    const magnitude = event.magnitude!;
    return assessment(
      event,
      magnitude >= 7 ? 'major' : magnitude >= 6 ? 'important' : 'watch',
      [
        `USGS reports magnitude ${magnitude}. Thresholds: 6+ important; 7+ major. Magnitude does not establish casualties, damage or economic impact.`,
      ],
      [usgs.id],
    );
  }
  const fed = sources.find((source) => {
    try {
      return /(^|\.)federalreserve\.gov$/.test(new URL(source.url).hostname);
    } catch {
      return false;
    }
  });
  if (
    fed &&
    /\b(FOMC|Federal Open Market Committee)\b/i.test(event.title) &&
    /\b(statement|target range|interest rate|monetary policy)\b/i.test(
      `${event.title} ${event.summary}`,
    )
  ) {
    return assessment(
      event,
      'important',
      [
        `Official monetary policy communication: “${event.title}”. This is a review priority, not a conclusion about the policy direction.`,
      ],
      [fed.id],
    );
  }
  // A transparent reading-priority baseline, not an inferred impact assessment.
  // Do not promote speculative headlines or infer consequences from source prestige.
  const title = event.title;
  const speculative =
    /(?:可能|或将|传闻|猜测|预测|展望|会否|是否|如何|为什么|\b(?:may|might|could|rumou?r|forecast|what if|will)\b|[?？])/i.test(
      title,
    );
  const policy =
    /(?:央行|美联储|欧央行|央銀|\b(?:central bank|federal reserve|fed|ecb)\b)/i.test(title) &&
    /(?:降息|加息|利率决议|利率決議|\b(?:cuts?|raises?|holds?)\s+(?:interest\s+)?rates?\b)/i.test(
      title,
    );
  const structural =
    /(?:宣布|通过|实施|批准|生效|announces?|approves?|imposes?|enacts?|takes effect)/i.test(
      title,
    ) && /(?:出口管制|制裁|关税|關稅|禁令|export controls?|sanctions?|tariffs?|ban\b)/i.test(title);
  if (!speculative && (policy || structural))
    return assessment(
      event,
      'important',
      [`Rules: the headline reports a monetary-policy, regulatory or trade decision: “${title}”.`],
      [sources[0]!.id],
    );
  const topical =
    /(?:经济|經濟|通胀|通膨|政策|监管|監管|外交|战争|戰爭|停火|冲突|衝突|地震|洪灾|洪災|科技|芯片|晶片|半导体|半導體|人工智能|财报|財報|营收|營收|收购|併購|数据中心|資料中心|英伟达|微软|特斯拉|\b(?:economy|inflation|policy|regulat\w*|diplomac\w*|war|ceasefire|conflict|earthquake|flood|technology|chip\w*|semiconductor\w*|AI|earnings|revenue|acquisition|data cent(?:er|re)|NVIDIA|Microsoft|Tesla)\b)/i.test(
      title,
    );
  if (topical)
    return assessment(
      event,
      'watch',
      [`Rules: the headline concerns public affairs or the technology industry, so it is marked for attention: “${title}”.`],
      [sources[0]!.id],
    );
  return assessment(
    event,
    'unassessed',
    [
      'Available text does not establish the scale, duration or verified consequences needed for a public importance assessment. Coverage volume and community votes are not importance evidence.',
    ],
    [],
  );
}

/** Shared conservative evidence matcher; caller may supply reviewed seed aliases. */
export function directCompanyMatch(
  event: PulseEvent,
  company: PulseCompany,
  approvedAliases: string[] = [],
): PulseMatch | undefined {
  const sourceRecords = reportsFor(event);
  const filingSource = event.sources.find((source) => {
    try {
      return /(^|\.)sec\.gov$/.test(new URL(source.url).hostname) && !!safeLink(source.url);
    } catch {
      return false;
    }
  });
  if (
    filingSource &&
    event.filing &&
    normalizedCik(company.cik) &&
    normalizedCik(company.cik) === normalizedCik(event.filing.cik)
  ) {
    return {
      companyId: company.id,
      symbol: company.symbol,
      term: `CIK ${event.filing.cik}`,
      excerpt:
        `SEC ${event.filing.form} filing identifies issuer CIK ${event.filing.cik}; matched to ${company.name}. ${event.filing.metadataOnly ? 'Filing metadata only; filing contents have not been assessed.' : ''}`.trim(),
      sourceUrl: filingSource.url,
    };
  }
  const verifiedDirectory =
    company.provenance === 'catalog' &&
    !!company.cik &&
    !!company.verifiedAt &&
    !!company.sourceUrl &&
    !!safeLink(company.sourceUrl);
  const fullName =
    /\s(?:Inc\.?|Corporation|Corp\.?|Holdings|Ltd\.?)$/i.test(company.name) || verifiedDirectory
      ? [company.name]
      : [];
  const reviewed = reviewedIdentities[company.symbol];
  const reviewedAliases =
    company.provenance === 'catalog' && reviewed?.cik === normalizedCik(company.cik)
      ? reviewed.names
      : [];
  // A verified identity (seed or SEC directory) may use derived reporting names
  // and reviewed dictionary names; a user-provided identity uses only what the
  // user typed, so a mistyped ticker can never borrow another company's names.
  const identified = company.provenance === 'catalog' && (!!reviewedAliases.length || verifiedDirectory);
  const derived = identified ? deriveReportingNames(company.name) : { names: [], contextual: [] };
  const dictionary = identified ? (CHINESE_NAMES[company.symbol] ?? []) : [];
  const allNames = [
    ...new Set([...fullName, ...derived.names, ...approvedAliases, ...reviewedAliases, ...dictionary]),
  ].filter((name) => name.trim() && !ambiguous.has(name.trim().toLowerCase()));
  const latinNames = allNames.filter((name) => !/[\u3400-\u9fff]/.test(name));
  const cjkNames = allNames.filter((name) => /[\u3400-\u9fff]/.test(name));
  const namePattern = latinNames.length
    ? new RegExp(
        `(?<![A-Za-z0-9])(?:${[...latinNames]
          .sort((a, b) => b.length - a.length)
          .map((name) => escapeRegex(name).replace(/ /g, '\\s+'))
          .join('|')})(?:['’]s)?(?![A-Za-z0-9])`,
        'i',
      )
    : null;
  const symbol = escapeRegex(company.symbol);
  for (const report of sourceRecords) {
    const url = safeLink(report.source.url);
    if (!url) continue;
    const text = `${report.title}\n${report.summary}`;
    const cashtag = new RegExp(`(?<![A-Za-z0-9$])\\$${symbol}(?![A-Za-z0-9.-])`).exec(text);
    const qualified =
      new RegExp(
        `(?<![A-Za-z0-9])(?:${escapeRegex(company.exchange)}|NASDAQ|Nasdaq|NYSE|NYSE American|AMEX)\\s*:\\s*${symbol}(?![A-Za-z0-9.-])`,
        'i',
      ).exec(text) ??
      // Chinese financial press: 英伟达(NVDA.O), 台积电（TSM.N）.
      new RegExp(`[（(]\\s*${symbol}(?:\\.(?:O|N|US|A|K))?\\s*[)）]`).exec(text) ??
      (company.symbol.length >= 3
        ? new RegExp(`(?<![A-Za-z0-9$])${symbol}\\s+(?:stock|shares)\\b`).exec(text)
        : null);
    const nameHit = namePattern?.exec(text) ?? null;
    const chineseHit = cjkNames.map((name) => new RegExp(escapeRegex(name)).exec(text)).find(Boolean) ?? null;
    const contextual = identified ? CONTEXT_REQUIRED[company.symbol] : undefined;
    const contextHit = contextual?.context.test(text) ? contextual.name.exec(text) : null;
    const derivedContextHit =
      !contextual && derived.contextual.length && hasCompanyContext(text)
        ? new RegExp(
            `(?<![A-Za-z0-9])(?:${derived.contextual.map(escapeRegex).join('|')})(?![A-Za-z0-9])`,
          ).exec(text)
        : null;
    const hit = cashtag || qualified || nameHit || chineseHit || contextHit || derivedContextHit;
    if (!hit) continue;
    const start = Math.max(0, hit.index - 65);
    const end = Math.min(text.length, hit.index + hit[0].length + 100);
    return {
      companyId: company.id,
      symbol: company.symbol,
      term: hit[0],
      excerpt: `${start ? '…' : ''}${text.slice(start, end)}${end < text.length ? '…' : ''}`,
      sourceUrl: url,
    };
  }
  return undefined;
}
export function companyPriority(
  event: PulseEvent,
  company: PulseCompany,
  match?: PulseMatch,
): PulseAssessment {
  const existing = event.companyAssessments?.[company.id];
  const names =
    company.provenance === 'catalog'
      ? [company.name, company.name.replace(/,?\s+(?:Corporation|Corp\.?|Inc\.?)$/i, '')]
      : [];
  const evidence =
    match?.companyId === company.id ? match : directCompanyMatch(event, company, names);
  if (!evidence)
    return assessment(
      event,
      'unassessed',
      ['No verified direct company evidence in the available reporting.'],
      [],
      company.id,
    );
  if (validExisting(existing, event, company.id)) return existing;
  const report = reportsFor(event).find(
    (report) => canonicalUrl(report.source.url) === canonicalUrl(evidence.sourceUrl),
  );
  const sourceId =
    report?.source.id ||
    event.sources.find((source) => canonicalUrl(source.url) === canonicalUrl(evidence.sourceUrl))
      ?.id;
  const sourceIds = sourceId ? [sourceId] : [];
  if (event.filing?.metadataOnly && evidence.term === `CIK ${event.filing.cik}`)
    return assessment(
      event,
      'watch',
      [
        `Company subject: SEC ${event.filing.form} filing metadata identifies this issuer. Contents are not yet assessed; the form alone cannot establish a material development.`,
      ],
      sourceIds,
      company.id,
    );
  const title = report?.title || event.title;
  const titleIndex = title.toLowerCase().indexOf(evidence.term.toLowerCase());
  const inTitle = titleIndex >= 0;
  // A headline mention after another actor's action is a business association,
  // not proof that this company is the subject of the reported action.
  const preceding = inTitle ? title.slice(0, titleIndex) : '';
  const subject =
    inTitle &&
    titleIndex < 100 &&
    !/\b(with|against|unlike|compared|mentions?|including|announces?|launches?|sues?|acquires?|buys?|reports?|says?)\b/i.test(
      preceding,
    ) &&
    !/(?:与|和|对|提及|相比|起诉|收购|表示|宣布)/.test(preceding);
  const hedged =
    /\b(could|may|might|rumou?r|speculat\w*|if|potential|reportedly|denies?|denied|not|never|false|untrue)\b/i.test(
      title,
    );
  const chineseHedged = /(?:可能|或将|传闻|据传|否认|尚未|预测|[?？])/.test(title);
  const critical =
    /\b(files? for bankruptcy|filed for bankruptcy|declares? bankruptcy|declared bankruptcy|defaults? on|defaulted on|delisted|files? for liquidation)\b/i.test(
      title,
    );
  if (subject && critical && !hedged && !chineseHedged)
    return assessment(
      event,
      'major',
      [
        `Company subject; headline explicitly reports a major corporate event: “${title}”. Direction and magnitude of financial impact remain unassessed.`,
      ],
      sourceIds,
      company.id,
    );
  const business =
    /\b(earnings|revenue|profit|guidance|acquisition|acquire[sd]?|merger|contract|production|factory|plant|recall|regulator|lawsuit|investment|launch|announc\w*|chip|product|shipment|partnership)\b/i.test(
      evidence.excerpt,
    );
  const chineseBusiness =
    /(?:财报|財報|营收|營收|利润|指引|收购|合并|合同|量产|工厂|召回|监管|诉讼|投资|发布|芯片|产品|出货|合作)/.test(
      evidence.excerpt,
    );
  if (subject && (business || chineseBusiness) && !hedged && !chineseHedged)
    return assessment(
      event,
      'important',
      [
        `Company subject; reporting describes a business development: “${title}”. Priority reflects direct relevance, not a verified financial effect.`,
      ],
      sourceIds,
      company.id,
    );
  if (subject || business)
    return assessment(
      event,
      'watch',
      [
        `${subject ? 'Company subject' : 'Business association'}: direct mention “${evidence.term}”. Available text does not establish the scale or certainty of company impact.`,
      ],
      sourceIds,
      company.id,
    );
  return assessment(
    event,
    'unassessed',
    [
      `Incidental mention: “${evidence.term}”. No specific company development or operational consequence is established.`,
    ],
    sourceIds,
    company.id,
  );
}

export function rankEvents(
  events: PulseEvent[],
  sort: PulseSort,
  companies: PulseCompany[] = [],
  now = Date.now(),
): PulseEvent[] {
  const dated = (event: PulseEvent) =>
    Number.isFinite(observedEventTime(event)) ? observedEventTime(event) : -Infinity;
  const personal = (event: PulseEvent) =>
    Math.max(0, ...companies.map((company) => scores[companyPriority(event, company).level]));
  const values = new Map(
    events.map((event) => [
      event.id,
      sort === 'personal'
        ? [personal(event)]
        : sort === 'important'
          ? [scores[publicImportance(event).level]]
          : sort === 'trending'
            ? [heatForEvent(event, now).publishers24h, heatForEvent(event, now).newReports3h]
            : [],
    ]),
  );
  const ranked = [...events].sort((a, b) => {
    const av = values.get(a.id)!;
    const bv = values.get(b.id)!;
    for (let index = 0; index < av.length; index++) {
      const delta = bv[index]! - av[index]!;
      if (delta) return delta;
    }
    return dated(b) - dated(a) || 0;
  });
  return sort === 'trending' ? ranked.slice(0, 20) : ranked;
}

/** Reading-priority display heuristic, never a calibrated risk or investment score. */
export function attentionForEvent(event: PulseEvent, companies?: PulseCompany[], now = Date.now()) {
  const heat = heatForEvent(event, now);
  const weights = { unassessed: 0, watch: 25, important: 60, major: 90 };
  const importance =
    companies === undefined
      ? publicImportance(event)
      : (companies
          .map((company) => companyPriority(event, company, directCompanyMatch(event, company)))
          .sort((a, b) => weights[b.level] - weights[a.level])[0] ?? {
          level: 'unassessed' as const,
          reasons: ['No matching company evidence.'],
          sourceIds: [],
          method: 'rules' as const,
        });
  const heatPosition =
    70 * Math.min(heat.publishers24h / 5, 1) + 30 * Math.min(heat.newReports3h / 5, 1);
  const position =
    importance.level === 'unassessed'
      ? null
      : (0.7 * weights[importance.level] + 0.3 * heatPosition) / 100;
  return {
    state: position === null ? ('unassessed' as const) : ('assessed' as const),
    position,
    heat,
    importance,
    limitations: [
      'Reading priority only; not price direction or a calibrated score.',
      'Collected reports only. Source outages and conservative event grouping can undercount coverage.',
    ],
  };
}
