import { XMLParser } from 'fast-xml-parser';
import type { PulseCompany } from '../../shared/world-pulse';
import { parseSource, plainText, safeUrl } from './sources';

export function companyNewsUrl(company: PulseCompany): string {
  const name = company.name
    .replace(/[,"()]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  const shortName = name
    .replace(/\s+(?:inc\.?|corporation|corp\.?|ltd\.?|plc|holdings)\s*$/i, '')
    .trim();
  const aliasQuery = /^(apple|amazon|oracle|meta|alphabet|visa)$/i.test(shortName)
    ? `("${shortName}" stock)`
    : `"${shortName}"`;
  const url = new URL('https://news.google.com/rss/search');
  url.searchParams.set(
    'q',
    `("${name}" OR ${aliasQuery} OR "${company.exchange}:${company.symbol}") when:7d`,
  );
  url.searchParams.set('hl', 'en-US');
  url.searchParams.set('gl', 'US');
  url.searchParams.set('ceid', 'US:en');
  return url.href;
}

/** Google is discovery transport, never an independent publisher or proof of a match. */
export function parseCompanyNews(body: string, company: PulseCompany, fetchedAt: string) {
  const feedId = `company-news:${company.id}`;
  const parsed = parseSource(
    {
      id: feedId,
      name: `Google News · ${company.symbol}`,
      publisher: 'Unknown publisher',
      url: companyNewsUrl(company),
      category: 'Economy',
      intervalMs: 900000,
      format: 'rss',
      transport: 'google-news',
    },
    body,
    fetchedAt,
  );
  // parseSource has already rejected DTD/entity declarations and invalid XML.
  const xml = new XMLParser({
    ignoreAttributes: false,
    processEntities: true,
    htmlEntities: true,
  }).parse(body);
  const raw = xml.rss?.channel?.item ?? [];
  const publishers = new Map<string, string>();
  for (const item of (Array.isArray(raw) ? raw : [raw]).slice(0, 10000)) {
    if (!item || typeof item !== 'object') continue;
    const link = safeUrl(item.link);
    const publisher = plainText(item.source, 120);
    if (link && publisher) publishers.set(link, publisher);
  }
  for (const event of parsed.events) {
    const source = event.sources[0]!;
    const publisher = publishers.get(source.url) ?? 'Unknown publisher';
    source.feedId = feedId;
    source.publisher = publisher;
    source.name = publisher;
    source.id = `company-news:${publisher.toLowerCase()}`;
    event.classificationBasis =
      'Company news search via Google News RSS; direct company mention must be checked separately.';
  }
  return parsed;
}
