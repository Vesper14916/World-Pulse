import type { PulseEvent, PulseReport, PulseSource } from './world-pulse.ts';

/**
 * Information-quality helpers shared by the local service and the browser.
 *
 * Everything here is a transparent, reviewable rule. Nothing infers truth or
 * importance; the helpers only decide which strings name the same outlet or
 * the same article, and which outlets are known to publish low-value copy.
 */

export type OutletTier = 'A' | 'B' | 'C';
export interface Outlet {
  key: string;
  label: string;
  tier: OutletTier;
  /** Why the tier was assigned; shown in the UI. */
  basis: string;
}
export interface OutletPreferences {
  blocked: string[];
  trusted: string[];
}

interface OutletRow {
  key: string;
  label: string;
  tier: OutletTier;
  aliases: string[];
}

// Tier A: wire services, public-service broadcasters, established national
// newspapers and business desks, and official publishers. It is a reading
// convenience, not a statement about accuracy of any single report.
const OUTLETS: OutletRow[] = [
  { key: 'reuters', label: 'Reuters', tier: 'A', aliases: ['reuters', 'reuters.com'] },
  { key: 'ap', label: 'AP', tier: 'A', aliases: ['ap', 'ap news', 'apnews.com', 'associated press'] },
  { key: 'afp', label: 'AFP', tier: 'A', aliases: ['afp', 'afp.com', 'agence france-presse'] },
  { key: 'bloomberg', label: 'Bloomberg', tier: 'A', aliases: ['bloomberg', 'bloomberg.com', 'bloomberg news'] },
  { key: 'ft', label: 'Financial Times', tier: 'A', aliases: ['financial times', 'ft', 'ft.com'] },
  { key: 'wsj', label: 'WSJ', tier: 'A', aliases: ['wsj', 'wsj.com', 'the wall street journal', 'wall street journal'] },
  { key: 'nyt', label: 'The New York Times', tier: 'A', aliases: ['the new york times', 'new york times', 'nytimes.com', 'nytimes'] },
  { key: 'wapo', label: 'The Washington Post', tier: 'A', aliases: ['the washington post', 'washington post', 'washingtonpost.com'] },
  { key: 'guardian', label: 'The Guardian', tier: 'A', aliases: ['the guardian', 'guardian', 'theguardian.com', 'guardian world'] },
  { key: 'bbc', label: 'BBC', tier: 'A', aliases: ['bbc', 'bbc news', 'bbc.co.uk', 'bbc.com', 'bbc world', 'bbc technology'] },
  { key: 'npr', label: 'NPR', tier: 'A', aliases: ['npr', 'npr.org', 'npr world', 'npr technology'] },
  { key: 'pbs', label: 'PBS', tier: 'A', aliases: ['pbs', 'pbs.org', 'pbs news'] },
  { key: 'cnbc', label: 'CNBC', tier: 'A', aliases: ['cnbc', 'cnbc.com'] },
  { key: 'cbs', label: 'CBS News', tier: 'A', aliases: ['cbs news', 'cbsnews.com'] },
  { key: 'nbc', label: 'NBC News', tier: 'A', aliases: ['nbc news', 'nbcnews.com'] },
  { key: 'abc-us', label: 'ABC News', tier: 'A', aliases: ['abc news', 'abcnews.com', 'abcnews.go.com', 'abc news - breaking news, latest news and videos'] },
  { key: 'cnn', label: 'CNN', tier: 'A', aliases: ['cnn', 'cnn.com'] },
  { key: 'aljazeera', label: 'Al Jazeera', tier: 'A', aliases: ['al jazeera', 'aljazeera.com', 'al jazeera english'] },
  { key: 'france24', label: 'France 24', tier: 'A', aliases: ['france 24', 'france24.com', 'france 24 english'] },
  { key: 'dw', label: 'DW', tier: 'A', aliases: ['dw', 'dw.com', 'deutsche welle'] },
  { key: 'economist', label: 'The Economist', tier: 'A', aliases: ['the economist', 'economist.com'] },
  { key: 'nikkei', label: 'Nikkei Asia', tier: 'A', aliases: ['nikkei asia', 'asia.nikkei.com', 'nikkei'] },
  { key: 'scmp', label: 'South China Morning Post', tier: 'A', aliases: ['south china morning post', 'scmp.com', 'scmp'] },
  { key: 'politico', label: 'Politico', tier: 'A', aliases: ['politico', 'politico.com', 'politico.eu'] },
  { key: 'axios', label: 'Axios', tier: 'A', aliases: ['axios', 'axios.com'] },
  { key: 'barrons', label: "Barron's", tier: 'A', aliases: ["barron's", 'barrons.com', 'barrons'] },
  { key: 'marketwatch', label: 'MarketWatch', tier: 'A', aliases: ['marketwatch', 'marketwatch.com'] },
  { key: 'the-information', label: 'The Information', tier: 'A', aliases: ['the information', 'theinformation.com'] },
  { key: 'techcrunch', label: 'TechCrunch', tier: 'A', aliases: ['techcrunch', 'techcrunch.com'] },
  { key: 'verge', label: 'The Verge', tier: 'A', aliases: ['the verge', 'theverge.com'] },
  { key: 'ars', label: 'Ars Technica', tier: 'A', aliases: ['ars technica', 'arstechnica.com'] },
  { key: 'wired', label: 'Wired', tier: 'A', aliases: ['wired', 'wired.com'] },
  { key: 'un', label: 'United Nations', tier: 'A', aliases: ['united nations', 'un news', 'news.un.org'] },
  { key: 'fed', label: 'Federal Reserve', tier: 'A', aliases: ['federal reserve', 'federalreserve.gov'] },
  { key: 'ecb', label: 'European Central Bank', tier: 'A', aliases: ['european central bank', 'ecb', 'ecb press', 'ecb.europa.eu'] },
  { key: 'boe', label: 'Bank of England', tier: 'A', aliases: ['bank of england', 'bank of england news', 'bankofengland.co.uk'] },
  { key: 'usgs', label: 'USGS', tier: 'A', aliases: ['usgs', 'usgs earthquakes', 'earthquake.usgs.gov'] },
  { key: 'nasa', label: 'NASA', tier: 'A', aliases: ['nasa', 'nasa news', 'nasa.gov'] },
  { key: 'sec', label: 'SEC EDGAR', tier: 'A', aliases: ['sec', 'sec edgar', 'sec.gov'] },
  { key: 'yahoo-finance', label: 'Yahoo Finance', tier: 'B', aliases: ['yahoo finance', 'finance.yahoo.com', 'yahoo', 'yahoo news singapore'] },
  { key: 'forbes', label: 'Forbes', tier: 'B', aliases: ['forbes', 'forbes.com'] },
  { key: 'business-insider', label: 'Business Insider', tier: 'B', aliases: ['business insider', 'businessinsider.com', 'markets insider'] },
  { key: 'fox-business', label: 'Fox Business', tier: 'B', aliases: ['fox business', 'foxbusiness.com'] },
  // Chinese-language media. Google News reports several names per outlet;
  // they must count as one independent publisher.
  { key: 'xinhua', label: '新华社', tier: 'A', aliases: ['新华社', '新华网', 'xinhuanet.com', 'news.cn', 'xinhua', '新华每日电讯'] },
  { key: 'chinanews', label: '中国新闻社', tier: 'A', aliases: ['中国新闻社', '中国新闻网', '中新网', '中新社', 'chinanews.com.cn', 'chinanews.com'] },
  { key: 'thepaper', label: '澎湃新闻', tier: 'A', aliases: ['澎湃新闻', 'thepaper.cn', '澎湃'] },
  { key: 'huanqiu', label: '环球时报', tier: 'B', aliases: ['环球时报', '环球网', 'huanqiu.com', 'global times', 'globaltimes.cn'] },
  { key: 'caixin', label: '财新', tier: 'A', aliases: ['财新', '财新传媒', '财新网', '财新周刊', 'caixin.com', 'caixin', 'caixin global'] },
  { key: 'cls', label: '财联社', tier: 'A', aliases: ['财联社', 'cls.cn', '财联社app'] },
  { key: 'stcn', label: '证券时报', tier: 'A', aliases: ['证券时报', '证券时报社', '证券时报网', 'stcn.com', 'e公司'] },
  { key: '21jingji', label: '21世纪经济报道', tier: 'A', aliases: ['21世纪经济报道', '21财经', '21jingji.com', '21经济网'] },
  { key: 'nbd', label: '每日经济新闻', tier: 'A', aliases: ['每日经济新闻', '每经网', '每经', 'nbd.com.cn'] },
  { key: 'wallstreetcn', label: '华尔街见闻', tier: 'B', aliases: ['华尔街见闻', 'wallstreetcn.com'] },
  { key: 'yicai', label: '第一财经', tier: 'A', aliases: ['第一财经', 'yicai.com', '第一财经日报', 'yicai global'] },
  { key: 'jiemian', label: '界面新闻', tier: 'A', aliases: ['界面新闻', 'jiemian.com', '界面'] },
  { key: 'ithome', label: 'IT之家', tier: 'B', aliases: ['it之家', 'ithome.com'] },
  { key: 'geekpark', label: '极客公园', tier: 'B', aliases: ['极客公园', 'geekpark.net'] },
  { key: 'cma', label: '中国气象局', tier: 'A', aliases: ['中国气象局', '中央气象台', 'nmc.cn', 'cma.gov.cn'] },
  { key: '36kr', label: '36氪', tier: 'B', aliases: ['36氪', '36kr.com'] },
  { key: 'cgtn', label: 'CGTN', tier: 'B', aliases: ['cgtn', 'news.cgtn.com', 'cgtn.com'] },
  { key: 'chinadaily', label: 'China Daily', tier: 'B', aliases: ['china daily', 'china daily global edition', 'chinadaily.com.cn'] },
  // Tier C: promotional investing copy, press-release wires and SEO
  // aggregators. They stay available but are folded away and excluded from heat.
  { key: 'motley-fool', label: 'The Motley Fool', tier: 'C', aliases: ['the motley fool', 'motley fool', 'fool.com'] },
  { key: 'simply-wall-st', label: 'Simply Wall St', tier: 'C', aliases: ['simply wall st', 'simplywall.st'] },
  { key: 'marketbeat', label: 'MarketBeat', tier: 'C', aliases: ['marketbeat', 'marketbeat.com'] },
  { key: 'investorplace', label: 'InvestorPlace', tier: 'C', aliases: ['investorplace', 'investorplace.com'] },
  { key: '247wallst', label: '24/7 Wall St.', tier: 'C', aliases: ['24/7 wall st.', '24/7 wall st', '247wallst.com'] },
  { key: 'zacks', label: 'Zacks', tier: 'C', aliases: ['zacks', 'zacks investment research', 'zacks.com'] },
  { key: 'tipranks', label: 'TipRanks', tier: 'C', aliases: ['tipranks', 'tipranks.com'] },
  { key: 'insider-monkey', label: 'Insider Monkey', tier: 'C', aliases: ['insider monkey', 'insidermonkey.com'] },
  { key: 'gurufocus', label: 'GuruFocus', tier: 'C', aliases: ['gurufocus', 'gurufocus.com'] },
  { key: 'ainvest', label: 'AInvest', tier: 'C', aliases: ['ainvest', 'ainvest.com'] },
  { key: 'benzinga-pr', label: 'Benzinga', tier: 'C', aliases: ['benzinga', 'benzinga.com'] },
  { key: 'kalkine', label: 'Kalkine Media', tier: 'C', aliases: ['kalkine media', 'kalkinemedia.com'] },
  { key: 'sunday-guardian', label: 'The Sunday Guardian', tier: 'C', aliases: ['the sunday guardian', 'sundayguardianlive.com'] },
  { key: 'ssbcrack', label: 'SSBCrack', tier: 'C', aliases: ['ssbcrack', 'ssbcrack news', 'news.ssbcrack.com'] },
  { key: 'latestly', label: 'LatestLY', tier: 'C', aliases: ['latestly', 'latestly.com'] },
  { key: 'menafn', label: 'Menafn', tier: 'C', aliases: ['menafn', 'menafn.com'] },
  { key: 'newsbytes', label: 'NewsBytes', tier: 'C', aliases: ['newsbytes', 'newsbytesapp.com'] },
  { key: 'techtimes', label: 'Tech Times', tier: 'C', aliases: ['tech times', 'techtimes.com'] },
  { key: 'global-banking-finance-review', label: 'Global Banking & Finance Review', tier: 'C', aliases: ['global banking & finance review', 'globalbankingandfinance.com'] },
  { key: 'press-release', label: 'Press release wire', tier: 'C', aliases: ['pr newswire', 'prnewswire.com', 'globe newswire', 'globenewswire.com', 'business wire', 'businesswire.com', 'accesswire', 'einpresswire', 'press release distribution australia', 'newsfile'] },
  { key: 'crypto-promo', label: 'Crypto promo sites', tier: 'C', aliases: ['blockonomi', 'cryptorank', 'crypto news', 'interactivecrypto', 'bloomingbit', 'portalcripto.com.br', 'forklog', 'coinpedia'] },
];

const LOOKUP = new Map<string, OutletRow>();
for (const row of OUTLETS) for (const alias of row.aliases) LOOKUP.set(normalizeName(alias), row);

const SECOND_LEVEL = new Set(['com', 'co', 'org', 'net', 'gov', 'edu', 'ac']);
function normalizeName(value: string): string {
  return value
    .normalize('NFKC')
    .toLowerCase()
    .replace(/^https?:\/\//, '')
    .replace(/^www\./, '')
    .replace(/\/.*$/, '')
    .replace(/\s+/g, ' ')
    .trim();
}
/** example.co.uk, news.example.com → the registrable domain. */
function registrable(host: string): string {
  const parts = host.split('.').filter(Boolean);
  if (parts.length <= 2) return parts.join('.');
  const tld = parts[parts.length - 1]!;
  const second = parts[parts.length - 2]!;
  const keep = SECOND_LEVEL.has(second) && tld.length === 2 ? 3 : 2;
  return parts.slice(-keep).join('.');
}
function looksLikeDomain(value: string): boolean {
  return /^[a-z0-9-]+(\.[a-z0-9-]+)+$/.test(value);
}
function hostOf(url?: string): string | undefined {
  if (!url) return undefined;
  try {
    const host = new URL(url).hostname.toLowerCase().replace(/^www\./, '');
    return host === 'news.google.com' ? undefined : host;
  } catch {
    return undefined;
  }
}

const OFFICIAL_SUFFIX = /(?:\.gov|\.mil|\.int|\.gov\.[a-z]{2}|\.gov\.cn|europa\.eu)$/;

/** Canonical outlet for a report's publisher name and/or link. */
export function outletFor(publisher: string, url?: string, domain?: string): Outlet {
  const candidates: string[] = [];
  const name = normalizeName(publisher || '');
  if (name) candidates.push(name);
  for (const host of [domain, hostOf(url)]) {
    if (!host) continue;
    const clean = normalizeName(host);
    candidates.push(clean, registrable(clean));
  }
  if (name && looksLikeDomain(name)) candidates.push(registrable(name));
  for (const candidate of candidates) {
    const row = LOOKUP.get(candidate);
    if (row) return { key: row.key, label: row.label, tier: row.tier, basis: tierBasis(row.tier) };
  }
  const host = candidates.find(looksLikeDomain);
  if (host && OFFICIAL_SUFFIX.test(host))
    return { key: registrable(host), label: publisher || host, tier: 'A', basis: 'Official government or intergovernmental domain.' };
  const key = host && name === host ? registrable(host) : name || (host ? registrable(host) : 'unknown');
  return { key, label: publisher || host || 'Unknown publisher', tier: 'B', basis: tierBasis('B') };
}
function tierBasis(tier: OutletTier): string {
  return tier === 'A'
    ? 'Established newsroom, wire service or official publisher.'
    : tier === 'B'
      ? 'Not on the reviewed lists; shown normally.'
      : 'Known for promotional investing copy, press-release redistribution or SEO aggregation.';
}

export function sourceOutlet(source: PulseSource): Outlet {
  return outletFor(source.publisher || source.name, source.url, source.domain);
}

/**
 * Headline patterns that mark low-value copy regardless of outlet: SEO
 * "prediction" pages, listicles pitching stocks, and automated market tickers.
 */
const LOW_VALUE_HEADLINES: [RegExp, string][] = [
  [/^\s*[-–—|]|^第\d+页|(?:^|[-|\s])首页\s*$|^要闻\s*[-–—|]\s*快讯$|^打开.{0,12}app$|^(?:news|home|index|latest news|top stories)\s*$/i, 'Navigation or index page'],
  [/今日看盘|个股飘红|个股翻绿|ETF规模速报|早餐FM|^盘前必读/i, '自动行情播报'],
  [/\bprediction\s*(?:live|today)\b|\bfuture prediction\b|\bstock price prediction\b|\bprice prediction\b/i, 'Price-prediction page'],
  [/\b(?:\d+|two|three|four|five|six|seven|eight|nine|ten)\s+(?:top\s+)?(?:\w+\s+)?stocks?\s+(?:to|you\s+can|that\s+could|i['’]d)\s+(?:buy|sell|hold|watch|own)\b/i, 'Stock-pick listicle'],
  [/\b(?:should you buy|is it time to buy|is it too late to buy|buy the dip|better buy:|millionaire[- ]maker|could make you a millionaire|no-brainer|screaming buy|set for life|stock to buy (?:now|right now|and hold)|buy (?:it )?before)\b/i, 'Promotional investing headline'],
  [/^prediction:|\bhere['’]s why\b.{0,80}\b(?:stocks?|shares|buy|invest\w*|betting)\b|\b(?:stocks?|shares|buy|invest\w*|betting)\b.{0,120}\bhere['’]s why\b/i, 'Stock-promotion headline'],
  [/\b(?:shares? (?:sold|bought|acquired) by|position (?:raised|lowered|trimmed|increased) by|stake (?:raised|lowered|boosted|trimmed) by|holdings? (?:raised|lowered) by)\b/i, 'Automated holdings filing summary'],
  [/\b(?:stock|shares?) (?:up|down|rises?|falls?|jumps?|drops?|gains?|slips?) [\d.]+%\s*(?:[-–—:]\s*(?:here['’]s why|what['’]s (?:going on|next)|should you)|$)/i, 'Automated price-move headline'],
  [/(?:\d+|[一二三四五六七八九十]+)只(?:个股|股票|概念股)|龙虎榜|主力资金(?:净)?(?:流入|流出)|北向资金(?:净)?(?:买入|卖出)|盘中异动|快速(?:拉升|下跌)|涨停(?:板)?(?:复盘|梳理)/, '自动行情播报'],
];
export function lowValueHeadline(title: string): string | undefined {
  for (const [pattern, reason] of LOW_VALUE_HEADLINES) if (pattern.test(title)) return reason;
  return undefined;
}

let preferences: OutletPreferences = { blocked: [], trusted: [] };
/** The browser installs the viewer's local block/trust lists before ranking. */
export function setOutletPreferences(value: OutletPreferences): void {
  preferences = {
    blocked: [...new Set(value.blocked)].slice(0, 500),
    trusted: [...new Set(value.trusted)].slice(0, 500),
  };
}
export function outletPreferences(): OutletPreferences {
  return preferences;
}

export type ReportQuality = 'A' | 'B' | 'C' | 'blocked';
export interface ReportAssessment {
  quality: ReportQuality;
  outlet: Outlet;
  reason: string;
}
export function assessReport(report: Pick<PulseReport, 'title' | 'source'>): ReportAssessment {
  const outlet = sourceOutlet(report.source);
  if (preferences.blocked.includes(outlet.key))
    return { quality: 'blocked', outlet, reason: 'You blocked this publisher.' };
  if (preferences.trusted.includes(outlet.key))
    return { quality: outlet.tier === 'C' ? 'B' : outlet.tier, outlet, reason: 'You trust this publisher.' };
  const pattern = lowValueHeadline(cleanHeadline(report.title, report.source));
  if (pattern) return { quality: 'C', outlet, reason: pattern };
  return { quality: outlet.tier, outlet, reason: outlet.basis };
}

// ---------------------------------------------------------------------------
// Headline normalisation

const SUFFIX = /\s+[-–—|_]\s+([^-–—|_]{1,80})$/;
/**
 * Remove the " - Publisher" tail that Google News and many CMSs append. Only
 * strips when the tail names the report's own outlet (or the link is a Google
 * News redirect, which always appends the outlet), so real subtitles stay.
 */
export function cleanHeadline(title: string, source?: Pick<PulseSource, 'publisher' | 'name' | 'url' | 'domain'>): string {
  let value = title.normalize('NFKC').replace(/\s+/g, ' ').trim();
  for (let pass = 0; pass < 2; pass++) {
    const match = SUFFIX.exec(value);
    if (!match) break;
    const tail = match[1]!.trim();
    const viaGoogle = !!source?.url && /^https?:\/\/news\.google\.com\//.test(source.url);
    const tailOutlet = outletFor(tail);
    const own = source ? outletFor(source.publisher || source.name, source.url, source.domain) : undefined;
    const namesOwn =
      !!own &&
      (tailOutlet.key === own.key ||
        normalizeName(tail) === normalizeName(source?.publisher ?? '') ||
        normalizeName(tail) === normalizeName(source?.name ?? ''));
    const knownOutlet = LOOKUP.has(normalizeName(tail)) || looksLikeDomain(normalizeName(tail));
    if (!(namesOwn || (viaGoogle && (knownOutlet || tail.length <= 60)))) break;
    const stripped = value.slice(0, match.index).trim();
    if (stripped.length < 6) break;
    value = stripped;
  }
  return value;
}
/** Google copies the headline plus outlet into the summary; drop that echo. */
export function cleanSummary(summary: string, title: string, cleanTitle: string): string {
  const text = summary.normalize('NFKC').replace(/\s+/g, ' ').trim();
  if (!text) return '';
  const lowered = text.toLowerCase();
  if (lowered.startsWith(title.toLowerCase()) || lowered.startsWith(cleanTitle.toLowerCase())) {
    const rest = text.slice(lowered.startsWith(title.toLowerCase()) ? title.length : cleanTitle.length).trim();
    // What remains is usually just the outlet name.
    if (rest.length <= 60) return '';
  }
  return text;
}

/** Key identifying the same article text across feeds; undefined when too generic. */
export function articleKey(cleanTitle: string): string | undefined {
  const text = cleanTitle
    .normalize('NFKC')
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .trim();
  const cjk = (text.match(/[㐀-鿿]/g) ?? []).length;
  const latin = text.replace(/[㐀-鿿\s]/g, '').length;
  if (cjk < 8 && latin < 24) return undefined;
  if (/^(?:live|live updates?|morning brief(?:ing)?|evening brief(?:ing)?|news ?summary|早报|晚报|午报|快讯|要闻)\b/.test(text))
    return undefined;
  return text;
}

export function reportTitle(report: Pick<PulseReport, 'title' | 'source'>): string {
  return cleanHeadline(report.title, report.source);
}

/** Aggregate view of an event's reports for display and heat. */
export function eventQuality(event: PulseEvent) {
  const reports = event.reports?.length
    ? event.reports
    : event.sources.map((source) => ({ title: event.title, source }));
  const assessed = reports.map((report) => ({ report, ...assessReport(report) }));
  const visible = assessed.filter((item) => item.quality !== 'blocked' && item.quality !== 'C');
  const outlets = new Map<string, Outlet>();
  for (const item of visible) outlets.set(item.outlet.key, item.outlet);
  return {
    outlets: [...outlets.values()],
    lowQuality: assessed.filter((item) => item.quality === 'C'),
    blocked: assessed.filter((item) => item.quality === 'blocked'),
    /** True when every report is low quality or blocked. */
    onlyLowQuality: !visible.length,
    onlyBlocked: assessed.length > 0 && assessed.every((item) => item.quality === 'blocked'),
    bestTier: (visible.some((item) => item.quality === 'A') ? 'A' : visible.length ? 'B' : 'C') as OutletTier,
  };
}
