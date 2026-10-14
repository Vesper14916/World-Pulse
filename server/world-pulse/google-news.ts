/**
 * Resolve a Google News redirect link to the publisher's own article URL.
 *
 * Google News RSS items point to news.google.com/rss/articles/<id>, which only
 * redirects in a browser. The article page carries a signature and timestamp
 * that its own batchexecute endpoint exchanges for the original URL. This is
 * an unofficial interface: it is used only when the viewer opens a report,
 * results are cached, and any failure simply leaves the original link.
 */

export type GoogleTransport = (url: string, init?: RequestInit) => Promise<Response>;

export function googleArticleId(value: string): string | undefined {
  try {
    const url = new URL(value);
    if (url.hostname !== 'news.google.com') return undefined;
    const match = /^\/(?:rss\/)?(?:articles|read)\/([A-Za-z0-9_-]{16,800})$/.exec(url.pathname);
    return match?.[1];
  } catch {
    return undefined;
  }
}

export function parseSignature(html: string): { signature: string; timestamp: string } | undefined {
  const signature = /data-n-a-sg="([^"]{8,400})"/.exec(html)?.[1];
  const timestamp = /data-n-a-ts="(\d{6,14})"/.exec(html)?.[1];
  return signature && timestamp ? { signature, timestamp } : undefined;
}

export function batchexecuteBody(id: string, timestamp: string, signature: string): string {
  const request = [
    'Fbv4je',
    `["garturlreq",[["X","X",["X","X"],null,null,1,1,"US:en",null,1,null,null,null,null,null,0,1],"X","X",1,[1,1,1],1,1,null,0,0,null,0],"${id}",${timestamp},"${signature}"]`,
  ];
  return `f.req=${encodeURIComponent(JSON.stringify([[request]]))}`;
}

export function parseBatchexecute(text: string): string | undefined {
  for (const chunk of text.split('\n')) {
    const trimmed = chunk.trim();
    if (!trimmed.startsWith('[')) continue;
    let rows: unknown;
    try {
      rows = JSON.parse(trimmed);
    } catch {
      continue;
    }
    if (!Array.isArray(rows)) continue;
    for (const row of rows) {
      if (!Array.isArray(row) || row[0] !== 'wrb.fr' || typeof row[2] !== 'string') continue;
      try {
        const inner = JSON.parse(row[2]);
        if (Array.isArray(inner) && inner[0] === 'garturlres' && typeof inner[1] === 'string')
          return inner[1];
      } catch {
        /* Not the article response. */
      }
    }
  }
  return undefined;
}

async function limitedText(response: Response, maxBytes: number): Promise<string> {
  if (!response.body) return '';
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let bytes = 0;
  let text = '';
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      bytes += value.byteLength;
      if (bytes > maxBytes) throw new Error('Google News response too large');
      text += decoder.decode(value, { stream: true });
    }
    return text + decoder.decode();
  } finally {
    void reader.cancel().catch(() => {});
  }
}

export async function resolveGoogleNewsUrl(
  link: string,
  transport: GoogleTransport,
  userAgent: string,
  timeoutMs = 10_000,
): Promise<string | undefined> {
  const id = googleArticleId(link);
  if (!id) return undefined;
  const run = async (url: string, init: RequestInit) => {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      return await transport(url, { ...init, signal: controller.signal, redirect: 'manual' });
    } finally {
      clearTimeout(timer);
    }
  };
  const page = await run(`https://news.google.com/rss/articles/${id}?hl=en-US&gl=US&ceid=US:en`, {
    headers: { 'User-Agent': userAgent, Accept: 'text/html' },
  });
  // Older links still redirect directly to the publisher.
  if ([301, 302, 303, 307, 308].includes(page.status)) {
    const location = page.headers.get('location');
    if (location && new URL(location, 'https://news.google.com').hostname !== 'news.google.com')
      return new URL(location, 'https://news.google.com').href;
  }
  if (!page.ok) return undefined;
  const params = parseSignature(await limitedText(page, 1_500_000));
  if (!params) return undefined;
  const response = await run('https://news.google.com/_/DotsSplashUi/data/batchexecute', {
    method: 'POST',
    headers: {
      'User-Agent': userAgent,
      'Content-Type': 'application/x-www-form-urlencoded;charset=UTF-8',
    },
    body: batchexecuteBody(id, params.timestamp, params.signature),
  });
  if (!response.ok) return undefined;
  const resolved = parseBatchexecute(await limitedText(response, 500_000));
  if (!resolved) return undefined;
  try {
    const url = new URL(resolved);
    return /^https?:$/.test(url.protocol) && url.hostname !== 'news.google.com' ? url.href : undefined;
  } catch {
    return undefined;
  }
}
