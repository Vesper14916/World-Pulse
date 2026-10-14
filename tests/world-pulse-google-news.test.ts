import test from 'node:test';
import assert from 'node:assert/strict';
import {
  batchexecuteBody,
  googleArticleId,
  parseBatchexecute,
  parseSignature,
  resolveGoogleNewsUrl,
} from '../server/world-pulse/google-news';

const LINK = 'https://news.google.com/rss/articles/CBMiZkFVX3lxTFBDRWZSYjVSZGwxVmJsZ0F5WUJj?oc=5';

test('google news ids are read only from news.google.com article paths', () => {
  assert.equal(googleArticleId(LINK), 'CBMiZkFVX3lxTFBDRWZSYjVSZGwxVmJsZ0F5WUJj');
  assert.equal(googleArticleId('https://example.com/rss/articles/CBMiZkFVX3lxTFBDRWZSYjVSZGwxVmJsZ0F5WUJj'), undefined);
  assert.equal(googleArticleId('https://news.google.com/search?q=x'), undefined);
});

test('signature parsing and batchexecute round trip resolve the publisher URL', async () => {
  const page = '<div jscontroller="x" data-n-a-id="CBMi" data-n-a-ts="1789960000" data-n-a-sg="AZ5r3eSIGNATURE"></div>';
  assert.deepEqual(parseSignature(page), { signature: 'AZ5r3eSIGNATURE', timestamp: '1789960000' });
  const outer = JSON.parse(decodeURIComponent(batchexecuteBody('CBMi', '1789960000', 'SIG').slice(6)));
  const inner = JSON.parse(outer[0][0][1]);
  assert.equal(outer[0][0][0], 'Fbv4je');
  assert.deepEqual(inner.slice(0, 1).concat(inner.slice(2)), ['garturlreq', 'CBMi', 1789960000, 'SIG']);
  const reply = `)]}'\n\n[["wrb.fr","Fbv4je","[\\"garturlres\\",\\"https://www.theguardian.com/story\\",1]",null,null,null,"generic"],["di",42]]`;
  assert.equal(parseBatchexecute(reply), 'https://www.theguardian.com/story');
  const calls: string[] = [];
  const transport = async (url: string) => {
    calls.push(url);
    return url.includes('batchexecute')
      ? new Response(reply, { status: 200 })
      : new Response(page, { status: 200 });
  };
  assert.equal(await resolveGoogleNewsUrl(LINK, transport, 'test'), 'https://www.theguardian.com/story');
  assert.equal(calls.length, 2);
  const failing = async () => new Response('nope', { status: 500 });
  assert.equal(await resolveGoogleNewsUrl(LINK, failing, 'test'), undefined);
});
