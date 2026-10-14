import test from 'node:test';
import assert from 'node:assert/strict';
import { extractArticleParagraphs, publicArticleUrl } from '../server/world-pulse/article';

test('article reader extracts readable text without returning publisher markup or boilerplate', () => {
  const paragraphs = extractArticleParagraphs(
    `<!doctype html><body><header>Subscribe</header><article><h1>Headline</h1><p>First public paragraph contains enough context for a reader to understand the report.</p><p>Second public paragraph carries a separate detail from the original publisher.</p><script>window.secret = 'do not include';</script><footer>Privacy policy</footer></article></body>`,
    'Headline',
  );
  assert.deepEqual(paragraphs, [
    'First public paragraph contains enough context for a reader to understand the report.',
    'Second public paragraph carries a separate detail from the original publisher.',
  ]);
});

test('article reader permits only public web report addresses', () => {
  assert.equal(publicArticleUrl('https://publisher.example/story?utm_source=rss'), 'https://publisher.example/story');
  const credentialUrl = new URL('https://publisher.example/story');
  credentialUrl.username = 'reader';
  credentialUrl.password = 'secret';
  for (const value of [
    'http://localhost:3000/private',
    'http://127.0.0.1/private',
    `http://${['10', '2', '3', '4'].join('.')}/private`,
    `http://${['192', '168', '0', '1'].join('.')}/private`,
    credentialUrl.href,
  ])
    assert.equal(publicArticleUrl(value), undefined);
});

test('article reader prefers JSON-LD article bodies and drops Chinese boilerplate', () => {
  const body = '第一段：这是一段足够长的中文正文，用来说明报道的主要事实和背景，读者可以据此理解事件经过。\n第二段：这里提供了另一处来自原始发布方的细节，包括时间、地点和有关各方的表态。';
  const html = `<html><head><script type="application/ld+json">${JSON.stringify({ '@type': 'NewsArticle', articleBody: body })}</script></head><body><p>责任编辑：张三</p></body></html>`;
  const paragraphs = extractArticleParagraphs(html, '标题');
  assert.equal(paragraphs.length, 2);
  assert.ok(paragraphs[0]!.startsWith('第一段'));
  const teaser = extractArticleParagraphs('<article><p>Subscribe to read the rest of this story about markets.</p></article>');
  assert.deepEqual(teaser, []);
});
