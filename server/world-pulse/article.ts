import { safeUrl } from './sources';

const MAX_ARTICLE_CHARS = 18_000;
const MAX_PARAGRAPHS = 80;

function decodeEntity(value: string): string {
  const codePoint = (input: string, radix: 10 | 16) => {
    const code = Number.parseInt(input, radix);
    return Number.isInteger(code) && code >= 0 && code <= 0x10ffff
      ? String.fromCodePoint(code)
      : '';
  };
  return value
    .replace(/&#x([0-9a-f]+);/gi, (_all, hex) => codePoint(hex, 16))
    .replace(/&#(\d+);/g, (_all, decimal) => codePoint(decimal, 10))
    .replace(
      /&(nbsp|amp|lt|gt|quot|apos);/gi,
      (_all, name) =>
        ({ nbsp: ' ', amp: '&', lt: '<', gt: '>', quot: '"', apos: "'" })[
          String(name).toLowerCase() as 'nbsp' | 'amp' | 'lt' | 'gt' | 'quot' | 'apos'
        ] ?? '',
    );
}

function readableSegment(html: string): string {
  const article = html.match(/<article\b[^>]*>([\s\S]*?)<\/article\s*>/i)?.[1];
  const main = html.match(/<main\b[^>]*>([\s\S]*?)<\/main\s*>/i)?.[1];
  const body = html.match(/<body\b[^>]*>([\s\S]*?)<\/body\s*>/i)?.[1];
  return article ?? main ?? body ?? html;
}

const BOILERPLATE =
  /^(?:share|subscribe|sign up|sign in|log in|advertisement|cookie settings|privacy policy|read more|related(?: articles| stories)?|most read|recommended|follow us|all rights reserved.*|copyright .*|©.*|责任编辑[:：].*|编辑[:：].*|校对[:：].*|来源[:：].{0,20}|版权所有.*|免责声明.*|本文来自.{0,30}|点击(?:进入|查看).*|扫码.*|下载.{0,10}app.*|打开.{0,12}app.*)$/i;

function visualLength(text: string): number {
  // CJK sentences carry more meaning per character than Latin text.
  const cjk = (text.match(/[\u3400-\u9fff]/g) ?? []).length;
  return text.length + cjk;
}

/** Many publishers embed the full body in schema.org JSON-LD; prefer it when present. */
function jsonLdBody(html: string): string | undefined {
  for (const match of html.matchAll(
    /<script\b[^>]*type=["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script\s*>/gi,
  )) {
    let data: unknown;
    try {
      data = JSON.parse(match[1]!.trim());
    } catch {
      continue;
    }
    const stack: unknown[] = [data];
    while (stack.length) {
      const item = stack.pop();
      if (Array.isArray(item)) stack.push(...item);
      else if (item && typeof item === 'object') {
        const record = item as Record<string, unknown>;
        if (typeof record.articleBody === 'string' && record.articleBody.length >= 80)
          return record.articleBody;
        for (const value of Object.values(record)) if (value && typeof value === 'object') stack.push(value);
      }
    }
  }
  return undefined;
}

function paragraphsFrom(lines: string[], title: string): string[] {
  const known = new Set<string>();
  const titleText = title.replace(/\s+/g, ' ').trim().toLowerCase();
  const paragraphs: string[] = [];
  let length = 0;
  for (const line of lines) {
    const text = line.replace(/\s+/g, ' ').trim();
    const normalized = text.toLowerCase();
    if (
      visualLength(text) < 30 ||
      normalized === titleText ||
      known.has(normalized) ||
      BOILERPLATE.test(text)
    )
      continue;
    known.add(normalized);
    paragraphs.push(text.slice(0, Math.max(0, MAX_ARTICLE_CHARS - length)));
    length += text.length;
    if (paragraphs.length >= MAX_PARAGRAPHS || length >= MAX_ARTICLE_CHARS) break;
  }
  return paragraphs;
}

/**
 * Produces a local reading copy from public publisher HTML. The original HTML
 * never reaches the browser; callers render the returned strings as text.
 * A result shorter than a short paragraph (a paywall teaser) counts as none.
 */
export function extractArticleParagraphs(html: string, title = ''): string[] {
  if (typeof html !== 'string' || !html.trim()) return [];
  const structured = jsonLdBody(html);
  if (structured) {
    const fromLd = paragraphsFrom(decodeEntity(structured.replace(/<[^>]*>/g, ' ')).split(/\n+|(?<=[。！？])\s*(?=\S{40,})/), title);
    if (fromLd.reduce((sum, text) => sum + visualLength(text), 0) >= 120) return fromLd;
  }
  const cleaned = readableSegment(html)
    .replace(/<(script|style|noscript|svg|canvas|iframe|form|nav|footer|header|aside|figure|button)\b[^>]*>[\s\S]*?<\/\1\s*>/gi, ' ')
    .replace(/<(br|p|div|li|blockquote|h[1-6]|section|figcaption)\b[^>]*>/gi, '\n')
    .replace(/<\/(p|div|li|blockquote|h[1-6]|section|figcaption)\s*>/gi, '\n')
    .replace(/<[^>]*>/g, ' ');
  const paragraphs = paragraphsFrom(decodeEntity(cleaned).split(/\n+/), title);
  return paragraphs.reduce((sum, text) => sum + visualLength(text), 0) >= 120 ? paragraphs : [];
}

function privateIpv4(host: string): boolean {
  const parts = host.split('.').map(Number);
  if (parts.length !== 4 || parts.some((part) => !Number.isInteger(part) || part < 0 || part > 255))
    return false;
  return (
    parts[0] === 10 ||
    parts[0] === 127 ||
    parts[0] === 0 ||
    (parts[0] === 169 && parts[1] === 254) ||
    (parts[0] === 172 && parts[1]! >= 16 && parts[1]! <= 31) ||
    (parts[0] === 192 && parts[1] === 168)
  );
}

/** Only article URLs already present in a collected report may reach this reader. */
export function publicArticleUrl(value: string): string | undefined {
  const safe = safeUrl(value);
  if (!safe) return undefined;
  const host = new URL(safe).hostname.toLowerCase();
  if (
    host === 'localhost' ||
    host.endsWith('.localhost') ||
    host.endsWith('.local') ||
    host.endsWith('.internal') ||
    host === '::1' ||
    host.startsWith('fe80:') ||
    privateIpv4(host)
  )
    return undefined;
  return safe;
}
