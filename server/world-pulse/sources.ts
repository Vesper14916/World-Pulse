import { createHash } from 'node:crypto';
import { XMLParser, XMLValidator } from 'fast-xml-parser';
import type {
  PulseCategory,
  PulseEvent,
  PulseLocation,
  PulseSource,
} from '../../shared/world-pulse';

export interface SourceDefinition {
  id: string;
  name: string;
  publisher: string;
  url: string;
  category: PulseCategory;
  intervalMs: number;
  format: 'rss' | 'geojson';
  /** Network path used for diagnostics; aggregator feeds are an explicit fallback. */
  transport?: 'direct' | 'google-news';
  coverageGroup?: 'global' | 'china' | 'neutral';
}
const CORE_SOURCES: readonly SourceDefinition[] = [
  {
    id: 'bbc-world',
    name: 'BBC World',
    publisher: 'BBC',
    url: 'https://feeds.bbci.co.uk/news/world/rss.xml',
    category: 'World',
    intervalMs: 300_000,
    format: 'rss',
    coverageGroup: 'global',
  },
  {
    id: 'guardian-world',
    name: 'Guardian World',
    publisher: 'The Guardian',
    url: 'https://www.theguardian.com/world/rss',
    category: 'World',
    intervalMs: 300_000,
    format: 'rss',
    coverageGroup: 'global',
  },
  {
    id: 'bbc-technology',
    name: 'BBC Technology',
    publisher: 'BBC',
    url: 'https://feeds.bbci.co.uk/news/technology/rss.xml',
    category: 'Technology',
    intervalMs: 300_000,
    format: 'rss',
    coverageGroup: 'global',
  },
  {
    id: 'federal-reserve',
    name: 'Federal Reserve',
    publisher: 'Federal Reserve',
    url: 'https://www.federalreserve.gov/feeds/press_all.xml',
    category: 'Economy',
    intervalMs: 300_000,
    format: 'rss',
    coverageGroup: 'neutral',
  },
  {
    id: 'yahoo-finance',
    name: 'Yahoo Finance',
    publisher: 'Yahoo Finance',
    url: 'https://finance.yahoo.com/news/rssindex',
    category: 'Economy',
    intervalMs: 300_000,
    format: 'rss',
    coverageGroup: 'global',
  },
  {
    id: 'usgs',
    name: 'USGS Earthquakes',
    publisher: 'USGS',
    url: 'https://earthquake.usgs.gov/earthquakes/feed/v1.0/summary/all_week.geojson',
    category: 'Disasters',
    intervalMs: 300_000,
    format: 'geojson',
    coverageGroup: 'neutral',
  },
];

const GLOBAL_DIRECT_SOURCES: readonly SourceDefinition[] = [
  {
    id: 'npr-world',
    name: 'NPR World',
    publisher: 'NPR',
    url: 'https://feeds.npr.org/1004/rss.xml',
    category: 'World',
    intervalMs: 300_000,
    format: 'rss',
    coverageGroup: 'global',
  },
  {
    id: 'al-jazeera',
    name: 'Al Jazeera',
    publisher: 'Al Jazeera',
    url: 'https://www.aljazeera.com/xml/rss/all.xml',
    category: 'World',
    intervalMs: 300_000,
    format: 'rss',
    coverageGroup: 'global',
  },
  {
    id: 'france24-en',
    name: 'France 24 English',
    publisher: 'France 24',
    url: 'https://www.france24.com/en/rss',
    category: 'World',
    intervalMs: 300_000,
    format: 'rss',
    coverageGroup: 'global',
  },
  {
    id: 'un-news',
    name: 'UN News',
    publisher: 'United Nations',
    url: 'https://news.un.org/feed/subscribe/en/news/all/rss.xml',
    category: 'World',
    intervalMs: 300_000,
    format: 'rss',
    coverageGroup: 'global',
  },
  {
    id: 'npr-technology',
    name: 'NPR Technology',
    publisher: 'NPR',
    url: 'https://feeds.npr.org/1019/rss.xml',
    category: 'Technology',
    intervalMs: 900_000,
    format: 'rss',
    coverageGroup: 'global',
  },
  {
    id: 'nasa-news',
    name: 'NASA News',
    publisher: 'NASA',
    url: 'https://www.nasa.gov/news-release/feed/',
    category: 'Technology',
    intervalMs: 900_000,
    format: 'rss',
    coverageGroup: 'global',
  },
  {
    id: 'ecb-press',
    name: 'ECB Press',
    publisher: 'European Central Bank',
    url: 'https://www.ecb.europa.eu/rss/press.html',
    category: 'Economy',
    intervalMs: 3_600_000,
    format: 'rss',
    coverageGroup: 'global',
  },
  {
    id: 'bank-of-england',
    name: 'Bank of England News',
    publisher: 'Bank of England',
    url: 'https://www.bankofengland.co.uk/rss/news',
    category: 'Economy',
    intervalMs: 3_600_000,
    format: 'rss',
    coverageGroup: 'global',
  },
];

const GLOBAL_DISCOVERY_ROWS: readonly [string, string, string, PulseCategory][] = [
  [
    'global-en-politics',
    'Global Politics Discovery',
    '(diplomacy OR sanctions OR election OR conflict OR ceasefire OR tariff) when:1d',
    'World',
  ],
  [
    'global-en-economy',
    'Global Economy Discovery',
    '(central bank OR inflation OR trade OR tariff OR energy market OR industrial policy) when:1d',
    'Economy',
  ],
  [
    'global-en-technology',
    'Global Technology Discovery',
    '(artificial intelligence OR semiconductor OR cybersecurity OR space technology OR technology regulation) when:1d',
    'Technology',
  ],
];
const GLOBAL_DISCOVERY_SOURCES: readonly SourceDefinition[] = GLOBAL_DISCOVERY_ROWS.map(
  ([id, name, query, category]) => ({
    id,
    name,
    publisher: name,
    url: `https://news.google.com/rss/search?q=${encodeURIComponent(query)}&hl=en-US&gl=US&ceid=US:en`,
    category,
    intervalMs: 300_000,
    format: 'rss',
    transport: 'google-news',
    coverageGroup: 'global',
  }),
);

/**
 * Chinese-language media feeds.
 *
 * These are deliberately kept as a separate group. Direct publisher RSS is
 * preferred when it is available; for the publishers below, Google News RSS
 * was the only repeatably reachable public feed in the current network. A
 * failure here is reported per source and never replaces the direct feeds.
 */
const CHINA_MEDIA_ROWS: readonly [string, string, string, string, PulseCategory][] = [
  ['cn-xinhua', '新华网', '新华社', 'xinhuanet.com', 'World'],
  ['cn-chinanews', '中国新闻网', '中国新闻社', 'chinanews.com.cn', 'World'],
  ['cn-thepaper', '澎湃新闻', '澎湃新闻', 'thepaper.cn', 'World'],
  ['cn-huanqiu', '环球网', '环球时报', 'huanqiu.com', 'World'],
  ['cn-caixin', '财新网', '财新传媒', 'caixin.com', 'Economy'],
  ['cn-cls', '财联社', '财联社', 'cls.cn', 'Economy'],
  ['cn-stcn', '证券时报', '证券时报社', 'stcn.com', 'Economy'],
  ['cn-21jingji', '21世纪经济报道', '21世纪经济报道', '21jingji.com', 'Economy'],
  ['cn-nbd', '每日经济新闻', '每日经济新闻', 'nbd.com.cn', 'Economy'],
  ['cn-wallstreetcn', '华尔街见闻', '华尔街见闻', 'wallstreetcn.com', 'Economy'],
  ['cn-yicai', '第一财经', '第一财经', 'yicai.com', 'Economy'],
  ['cn-jiemian', '界面新闻', '界面新闻', 'jiemian.com', 'Economy'],
  ['cn-ithome', 'IT之家', 'IT之家', 'ithome.com', 'Technology'],
  ['cn-geekpark', '极客公园', '极客公园', 'geekpark.net', 'Technology'],
  ['cn-nmc', '中央气象台预警', '中国气象局', 'nmc.cn', 'Disasters'],
];
const CHINA_MEDIA_SOURCES: readonly SourceDefinition[] = CHINA_MEDIA_ROWS.map(
  ([id, name, publisher, domain, category]) => ({
  id,
  name,
  publisher,
  url:
    id === 'cn-nmc'
      ? `https://news.google.com/rss/search?q=site:${domain}+(红色预警+OR+橙色预警)+when:2d&hl=zh-CN&gl=CN&ceid=CN:zh-Hans`
      : `https://news.google.com/rss/search?q=site:${domain}+when:2d&hl=zh-CN&gl=CN&ceid=CN:zh-Hans`,
  category,
  intervalMs: 300_000,
  format: 'rss',
  transport: 'google-news',
  coverageGroup: 'china',
  }),
);

// Keep the original six entries first: tests and cached source identities rely on them.
export const SOURCES: readonly SourceDefinition[] = [
  ...CORE_SOURCES,
  ...GLOBAL_DIRECT_SOURCES,
  ...GLOBAL_DISCOVERY_SOURCES,
  ...CHINA_MEDIA_SOURCES,
];

export function safeUrl(value: unknown): string | undefined {
  if (typeof value !== 'string' || value.length > 4096) return undefined;
  try {
    const url = new URL(value);
    if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password)
      return undefined;
    url.hash = '';
    for (const key of [...url.searchParams.keys()])
      if (/^(utm_|guccounter|guce_referrer)/i.test(key)) url.searchParams.delete(key);
    return url.href;
  } catch {
    return undefined;
  }
}
export function plainText(value: unknown, max = 2000): string {
  if (typeof value === 'object' && value !== null && '#text' in value)
    value = (value as Record<string, unknown>)['#text'];
  if (typeof value !== 'string' && typeof value !== 'number') return '';
  return String(value)
    .replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, '')
    .replace(/<style\b[^>]*>[\s\S]*?<\/style>/gi, '')
    .replace(/<[^>]*>/g, ' ')
    .replace(
      /&(?:nbsp|amp|lt|gt|quot|apos);/g,
      (x) =>
        ({ '&nbsp;': ' ', '&amp;': '&', '&lt;': '<', '&gt;': '>', '&quot;': '"', '&apos;': "'" })[
          x
        ] || '',
    )
    .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, '')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, max);
}
function published(value: unknown): string | null {
  if (typeof value !== 'string' && typeof value !== 'number') return null;
  if (value === '' || value === 0) return null;
  const ms = typeof value === 'number' ? value : Date.parse(value);
  const date = new Date(ms);
  return Number.isFinite(date.getTime()) ? date.toISOString() : null;
}
type ParsedSourceTime = Pick<
  PulseEvent,
  'publishedAt' | 'firstSeenAt' | 'lastFetchedAt' | 'timeBasis'
>;
function sourceTime(props: RecordLike, quake: boolean, fetchedAt: string): ParsedSourceTime {
  const publishedAt = quake
    ? published(props.time)
    : [props.pubDate, props.published, props['dc:date']]
        .map(published)
        .find((value): value is string => value !== null) ?? null;
  if (publishedAt)
    return {
      publishedAt,
      firstSeenAt: fetchedAt,
      lastFetchedAt: fetchedAt,
      timeBasis: 'source-published',
    };
  const updatedAt = quake ? null : published(props.updated);
  if (updatedAt)
    return {
      publishedAt: updatedAt,
      firstSeenAt: fetchedAt,
      lastFetchedAt: fetchedAt,
      timeBasis: 'source-updated',
    };
  return {
    publishedAt: null,
    firstSeenAt: fetchedAt,
    lastFetchedAt: fetchedAt,
    timeBasis: 'first-seen',
  };
}
function identifier(value: string): string {
  return createHash('sha256').update(value).digest('hex').slice(0, 24);
}
function reportSource(source: SourceDefinition, props: RecordLike, url: string): PulseSource {
  if (source.transport !== 'google-news')
    return {
      id: source.id,
      name: source.name,
      publisher: source.publisher,
      url,
      coverageGroup: source.coverageGroup,
    };
  const publisher = plainText(props.source, 120) || source.publisher;
  const publisherUrl = safeUrl(
    typeof props.source === 'object' ? props.source?.['@_url'] : undefined,
  );
  const identity = publisherUrl
    ? new URL(publisherUrl).hostname.replace(/^www\./i, '')
    : publisher.toLocaleLowerCase();
  return {
    id: `publisher:${identifier(identity)}`,
    feedId: source.id,
    name: publisher,
    publisher,
    url,
    coverageGroup: source.coverageGroup,
    ...(publisherUrl ? { domain: new URL(publisherUrl).hostname.replace(/^www\./i, '') } : {}),
  };
}
const COUNTRIES: [string, number, number][] = [
  ['Ukraine', 49, 32],
  ['Russia', 61, 100],
  ['China', 35, 105],
  ['Taiwan', 23.7, 121],
  ['Japan', 36, 138],
  ['South Korea', 36, 128],
  ['North Korea', 40, 127],
  ['India', 21, 78],
  ['Pakistan', 30, 70],
  ['Afghanistan', 34, 66],
  ['Iran', 32, 54],
  ['Iraq', 33, 44],
  ['Israel', 31.5, 35],
  ['Lebanon', 34, 36],
  ['Syria', 35, 38],
  ['Jordan', 31, 36],
  ['Saudi Arabia', 24, 45],
  ['Yemen', 16, 48],
  ['Turkey', 39, 35],
  ['Egypt', 27, 30],
  ['Sudan', 16, 30],
  ['Ethiopia', 9, 40],
  ['Nigeria', 9, 8],
  ['South Africa', -29, 24],
  ['Kenya', 1, 38],
  ['France', 47, 2],
  ['Germany', 51, 10],
  ['Italy', 43, 12],
  ['Spain', 40, -4],
  ['United Kingdom', 55, -3],
  ['United States', 39, -98],
  ['Canada', 57, -106],
  ['Mexico', 24, -102],
  ['Brazil', -10, -52],
  ['Argentina', -35, -64],
  ['Venezuela', 7, -66],
  ['Australia', -25, 134],
  ['New Zealand', -41, 174],
  ['Indonesia', -2, 118],
  ['Philippines', 13, 122],
  ['Thailand', 15, 101],
  ['Vietnam', 16, 106],
  ['Myanmar', 21, 96],
  ['Malaysia', 4, 102],
  ['Singapore', 1.35, 103.82],
  ['Poland', 52, 19],
  ['Finland', 64, 26],
  ['Sweden', 62, 15],
  ['Norway', 62, 10],
  ['Greece', 39, 22],
  ['Portugal', 40, -8],
  ['Bangladesh', 24, 90],
  ['Nepal', 28, 84],
  ['Peru', -10, -76],
  ['Chile', -33, -71],
  ['Colombia', 4, -73],
  ['Cuba', 22, -79],
];
const COUNTRY_CODES =
  'UA RU CN TW JP KR KP IN PK AF IR IQ IL LB SY JO SA YE TR EG SD ET NG ZA KE FR DE IT ES GB US CA MX BR AR VE AU NZ ID PH TH VN MM MY SG PL FI SE NO GR PT BD NP PE CL CO CU'.split(
    ' ',
  );
/** A single unambiguous named country is a regional association, never an inferred facility. */
export function inferLocation(title: string): PulseLocation | undefined {
  const matches = COUNTRIES.filter(([name]) => new RegExp(`\\b${name}\\b`, 'i').test(title));
  if (matches.length !== 1) return undefined;
  const [country, lat, lon] = matches[0]!;
  return {
    name: country,
    country: COUNTRY_CODES[COUNTRIES.findIndex((item) => item[0] === country)]!,
    lat,
    lon,
    precision: 'country',
    evidence: `System-derived country association: the headline explicitly names ${country}. Country centroid, not an incident coordinate. Headline: ${title}`,
  };
}
type RecordLike = Record<string, any>; // XML and GeoJSON are untrusted and validated below.
export function parseSource(
  source: SourceDefinition,
  body: string,
  fetchedAt: string,
): { events: PulseEvent[]; rejected: number } {
  let items: RecordLike[];
  if (source.format === 'geojson') {
    const json = JSON.parse(body);
    if (json.type !== 'FeatureCollection' || !Array.isArray(json.features))
      throw new Error('Invalid GeoJSON feed');
    items = json.features;
  } else {
    if (/<!DOCTYPE|<!ENTITY/i.test(body) || XMLValidator.validate(body) !== true)
      throw new Error('Invalid RSS feed');
    const parsed = new XMLParser({
      ignoreAttributes: false,
      processEntities: true,
      htmlEntities: true,
    }).parse(body);
    if (!parsed.rss?.channel && !parsed.feed) throw new Error('Invalid RSS feed');
    const raw = parsed.rss?.channel?.item ?? parsed.feed?.entry ?? [];
    items = Array.isArray(raw) ? raw : [raw];
  }
  let rejected = 0;
  const events = new Map<string, PulseEvent>();
  for (const item of items.slice(0, 10000)) {
    if (!item || typeof item !== 'object') {
      rejected++;
      continue;
    }
    const quake = source.format === 'geojson';
    const props = quake ? item.properties : item;
    if (!props || typeof props !== 'object') {
      rejected++;
      continue;
    }
    const title = plainText(props.title, 500);
    const links = Array.isArray(props.link) ? props.link : [props.link];
    const rawLink = quake
      ? props.url
      : links.find(
          (link: any) =>
            typeof link === 'string' || link?.['@_rel'] === 'alternate' || !link?.['@_rel'],
        );
    const url = safeUrl(
      typeof rawLink === 'object' ? (rawLink?.['@_href'] ?? rawLink?.['#text']) : rawLink,
    );
    if (!title || !url) {
      rejected++;
      continue;
    }
    const time = sourceTime(props, quake, fetchedAt);
    const event: PulseEvent = {
      id: identifier(url),
      title,
      summary: plainText(
        quake ? props.place : (props.description ?? props.summary ?? props['content:encoded']),
      ),
      category: source.category,
      sources: [reportSource(source, props, url)],
      ...time,
      fetchedAt,
      classificationBasis: `System classification from ${source.name} feed (${source.category}); not an independently assessed severity score.`,
    };
    if (quake) {
      const coords = item.geometry?.coordinates;
      if (
        item.geometry?.type !== 'Point' ||
        !Array.isArray(coords) ||
        !Number.isFinite(coords[0]) ||
        !Number.isFinite(coords[1]) ||
        Math.abs(coords[0]) > 180 ||
        Math.abs(coords[1]) > 90
      ) {
        rejected++;
        continue;
      }
      event.location = {
        name: plainText(props.place, 250) || title,
        country: '',
        lat: coords[1],
        lon: coords[0],
        precision: 'exact',
        evidence:
          'Coordinates supplied by USGS in this event record; epicentre estimates can be revised.',
      };
      if (['yellow', 'orange', 'red'].includes(props.alert)) event.earthquakeAlert = props.alert;
      if (props.tsunami === 1) event.earthquakeAlert = 'tsunami';
      if (typeof props.mag === 'number' && Number.isFinite(props.mag)) event.magnitude = props.mag;
    } else event.location = inferLocation(title);
    if (!events.has(event.id)) events.set(event.id, event);
  }
  return { events: [...events.values()], rejected: rejected + Math.max(0, items.length - 10000) };
}
