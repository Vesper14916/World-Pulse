import { createHash } from 'node:crypto';
import type { PulseCompany, PulseEvent, PulseDirectory } from '../../shared/world-pulse';
import { inferLocation, plainText, safeUrl } from './sources';
export const SEC_DIRECTORY = 'https://www.sec.gov/files/company_tickers_exchange.json';
export const HN_TOP = 'https://hacker-news.firebaseio.com/v0/topstories.json';
export const GDELT_BASE = 'https://api.gdeltproject.org/api/v2/doc/doc';
const publisherName = (url: string): string => {
  const host = new URL(url).hostname.replace(/^www\./, '');
  return /(^|\.)bbc\.(com|co\.uk)$/.test(host)
    ? 'BBC'
    : /(^|\.)theguardian\.com$/.test(host)
      ? 'The Guardian'
      : /(^|\.)yahoo\.com$/.test(host)
        ? 'Yahoo Finance'
        : host;
};
export const hash = (text: string): string =>
  createHash('sha256').update(text).digest('hex').slice(0, 24);
const seedRows: [string, string, string, string][] = [
  ['NVDA', 'NVIDIA Corporation', 'NASDAQ', '1045810'],
  ['AAPL', 'Apple Inc.', 'NASDAQ', '320193'],
  ['MSFT', 'Microsoft Corporation', 'NASDAQ', '789019'],
  ['AMZN', 'Amazon.com, Inc.', 'NASDAQ', '1018724'],
  ['META', 'Meta Platforms, Inc.', 'NASDAQ', '1326801'],
  ['TSLA', 'Tesla, Inc.', 'NASDAQ', '1318605'],
  ['MRVL', 'Marvell Technology, Inc.', 'NASDAQ', '1835632'],
  ['COHR', 'Coherent Corp.', 'NYSE', '820318'],
  ['ASTS', 'AST SpaceMobile, Inc.', 'NASDAQ', '1780312'],
  ['IONQ', 'IonQ, Inc.', 'NYSE', '1824920'],
  ['GOOGL', 'Alphabet Inc.', 'NASDAQ', '1652044'],
  ['ORCL', 'Oracle Corporation', 'NYSE', '1341439'],
  ['V', 'Visa Inc.', 'NYSE', '1403161'],
];
export const seedDirectory = (): PulseDirectory => ({
  state: 'seed',
  updatedAt: null,
  message:
    'Starter identities only; SEC directory has not been verified in this session. Company filing retrieval requires a live or cached SEC identity.',
  companies: seedRows.map(([symbol, name, exchange, cik]) => ({
    id: `${exchange}:${symbol}`,
    symbol,
    name,
    exchange,
    cik,
    list: 'watchlist',
    provenance: 'catalog',
    sourceUrl: `https://www.sec.gov/edgar/browse/?CIK=${cik}`,
  })),
});
export function parseDirectory(body: string, now: string): PulseDirectory {
  const json = JSON.parse(body);
  if (!Array.isArray(json.fields) || !Array.isArray(json.data))
    throw new Error('Invalid SEC directory');
  const indexes = ['cik', 'name', 'ticker', 'exchange'].map((k) => json.fields.indexOf(k));
  if (indexes.some((i) => i < 0)) throw new Error('Missing SEC identity fields');
  const companies: PulseCompany[] = [];
  for (const row of json.data.slice(0, 30000)) {
    if (!Array.isArray(row)) continue;
    const [cikRaw, nameRaw, tickerRaw, exchangeRaw] = indexes.map((i) => row[i]);
    const symbol = plainText(tickerRaw, 30).toUpperCase(),
      name = plainText(nameRaw, 250),
      exchange = plainText(exchangeRaw, 30).toUpperCase(),
      cik = String(cikRaw);
    if (
      !/^[A-Z][A-Z0-9.-]{0,14}$/.test(symbol) ||
      !/^[0-9]{1,10}$/.test(cik) ||
      !name ||
      !['NASDAQ', 'NYSE', 'CBOE', 'OTC', 'NYSE AMERICAN', 'NYSE ARCA'].includes(exchange)
    )
      continue;
    companies.push({
      id: `${exchange}:${symbol}`,
      symbol,
      name,
      exchange,
      cik,
      list: 'watchlist',
      provenance: 'catalog',
      verifiedAt: now,
      sourceUrl: `https://www.sec.gov/edgar/browse/?CIK=${cik}`,
    });
  }
  if (!companies.length) throw new Error('Empty SEC directory');
  return { companies, updatedAt: now, state: 'fresh' };
}
export function gdeltUrl(company?: PulseCompany): string {
  const url = new URL(GDELT_BASE);
  const name = company?.name.replace(/[^\p{L}\p{N} .,&-]/gu, ' ').trim();
  url.searchParams.set(
    'query',
    company
      ? `"${name}" sourcelang:english`
      : '(economy OR technology OR election OR conflict OR climate OR energy) sourcelang:english',
  );
  url.searchParams.set('mode', 'ArtList');
  url.searchParams.set('format', 'json');
  url.searchParams.set('maxrecords', '100');
  url.searchParams.set('sort', 'DateDesc');
  url.searchParams.set('timespan', '24h');
  return url.href;
}
export function parseGdelt(
  body: string,
  fetchedAt: string,
  feedId = 'gdelt-global',
): { events: PulseEvent[]; rejected: number; truncated: boolean } {
  const data = JSON.parse(body);
  if (!Array.isArray(data.articles)) throw new Error('Invalid GDELT response');
  let rejected = 0;
  const events: PulseEvent[] = [];
  for (const item of data.articles.slice(0, 100)) {
    const url = safeUrl(item.url),
      title = plainText(item.title, 500);
    if (!url || !title) {
      rejected++;
      continue;
    }
    const publisher = publisherName(url);
    const seen =
      typeof item.seendate === 'string'
        ? item.seendate.replace(
            /^(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})Z$/,
            '$1-$2-$3T$4:$5:$6Z',
          )
        : '';
    // seendate is discovery time, not a publisher-provided publication date.
    const firstSeenAt = Number.isFinite(Date.parse(seen))
      ? new Date(seen).toISOString()
      : fetchedAt;
    const source = { id: `gdelt:${publisher}`, feedId, name: publisher, publisher, url };
    const id = hash(url);
    events.push({
      id,
      title,
      summary: '',
      category: 'World',
      sources: [source],
      publishedAt: null,
      fetchedAt,
      firstSeenAt,
      lastFetchedAt: fetchedAt,
      timeBasis: 'first-seen',
      location: inferLocation(title),
      classificationBasis:
        'GDELT discovery feed; category is an ingestion label. Publication time and full text are not supplied.',
      reports: [
        {
          id: `${id}:${source.id}`,
          title,
          summary: '',
          source,
          publishedAt: null,
          firstSeenAt,
          lastFetchedAt: fetchedAt,
          timeBasis: 'first-seen',
        },
      ],
    });
  }
  return { events, rejected, truncated: data.articles.length >= 100 };
}
export function parseHN(item: Record<string, unknown>, fetchedAt: string): PulseEvent | null {
  if (item.type !== 'story' || item.deleted || item.dead || !Number.isSafeInteger(item.id))
    return null;
  const title = plainText(item.title, 500),
    url = safeUrl(item.url);
  if (!title || !url) return null;
  const communityUrl = `https://news.ycombinator.com/item?id=${item.id}`;
  const publisher = publisherName(url);
  const timestamp = typeof item.time === 'number' ? item.time * 1000 : NaN;
  const source = { id: `hn:${publisher}`, feedId: 'hacker-news', name: publisher, publisher, url };
  return {
    reports: [
      {
        id: `${hash(url)}:${source.id}`,
        title,
        summary: '',
        source,
        publishedAt: null,
        firstSeenAt: fetchedAt,
        lastFetchedAt: fetchedAt,
        timeBasis: 'first-seen',
      },
    ],
    id: hash(url),
    title,
    summary: '',
    category: 'Technology',
    sources: [{ id: `hn:${publisher}`, feedId: 'hacker-news', name: publisher, publisher, url }],
    publishedAt: null,
    fetchedAt,
    firstSeenAt: fetchedAt,
    lastFetchedAt: fetchedAt,
    timeBasis: 'first-seen',
    location: inferLocation(title),
    classificationBasis: `Hacker News community submission; score and comments measure discussion, not factual importance. Submitted ${Number.isFinite(timestamp) ? new Date(timestamp).toISOString() : 'at an unavailable time'}. Article publication time is not supplied.`,
    community: {
      provider: 'Hacker News',
      score: typeof item.score === 'number' ? Math.max(0, item.score) : 0,
      comments: typeof item.descendants === 'number' ? Math.max(0, item.descendants) : 0,
      url: communityUrl,
    },
  };
}
export function parseFilings(
  body: string,
  company: PulseCompany,
  fetchedAt: string,
): { events: PulseEvent[]; rejected: number; truncated: boolean } {
  const data = JSON.parse(body);
  const recent = data.filings?.recent;
  if (!recent || !Array.isArray(recent.accessionNumber)) throw new Error('Invalid SEC submissions');
  if (String(Number(data.cik)) !== String(Number(company.cik)))
    throw new Error('SEC identity mismatch');
  const events: PulseEvent[] = [];
  let rejected = 0;
  for (let i = 0; i < Math.min(1000, recent.accessionNumber.length); i++) {
    const form = recent.form?.[i];
    if (!['8-K', '10-Q', '10-K', '6-K', '20-F'].includes(form)) continue;
    const accession = recent.accessionNumber[i],
      doc = recent.primaryDocument?.[i],
      date = recent.filingDate?.[i];
    if (
      typeof accession !== 'string' ||
      !/^\d{10}-\d{2}-\d{6}$/.test(accession) ||
      typeof doc !== 'string' ||
      !/^[-a-zA-Z0-9_.]+$/.test(doc) ||
      typeof date !== 'string' ||
      !/^\d{4}-\d{2}-\d{2}$/.test(date)
    ) {
      rejected++;
      continue;
    }
    const url = `https://www.sec.gov/Archives/edgar/data/${Number(company.cik)}/${accession.replace(/-/g, '')}/${doc}`;
    events.push({
      id: hash(url),
      title: `${company.name} files ${form}`,
      summary: `SEC filing metadata only. Filed ${date}; the document has not been read.`,
      category: 'Economy',
      sources: [
        {
          id: `sec:${company.cik}`,
          feedId: `sec:${company.id}`,
          name: 'SEC EDGAR',
          publisher: 'SEC',
          url,
        },
      ],
      publishedAt: `${date}T00:00:00.000Z`,
      fetchedAt,
      firstSeenAt: fetchedAt,
      lastFetchedAt: fetchedAt,
      timeBasis: 'source-published',
      classificationBasis:
        'Regulatory filing metadata. Time is the filing date at day precision, not an intraday release time.',
      filing: { form, cik: company.cik!, accession, metadataOnly: true },
      companies: [
        {
          id: company.id,
          symbol: company.symbol,
          name: company.name,
          exchange: company.exchange,
          cik: company.cik,
        },
      ],
    });
  }
  return { events, rejected, truncated: recent.accessionNumber.length > 1000 };
}
