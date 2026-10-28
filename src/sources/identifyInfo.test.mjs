import test from 'node:test';
import assert from 'node:assert/strict';
import { createIdentifyLoader, normalizeArticle } from './identifyInfo.js';

const ARTICLE = {
  title: 'IAI Heron',
  summary: 'The IAI Heron is an Israeli drone.',
  image: 'https://upload.wikimedia.org/wikipedia/commons/thumb/heron.jpg',
  link: 'https://en.wikipedia.org/wiki/IAI_Heron',
};

test('one request per kind and query, with the query text sent as given', async () => {
  const urls = [];
  const loader = createIdentifyLoader({
    fetchImpl: async (url) => {
      urls.push(String(url));
      return new Response(JSON.stringify(ARTICLE), { status: 200 });
    },
  });
  const first = await loader.load('aircraft', 'IAI Heron aircraft');
  const second = await loader.load('aircraft', 'iai heron aircraft');
  assert.deepEqual(first, ARTICLE);
  assert.deepEqual(second, ARTICLE);
  assert.equal(urls.length, 1);
  assert.equal(urls[0], '/api/identify?kind=aircraft&q=IAI+Heron+aircraft');
});

test('a failed lookup resolves to null and is retried on the next call', async () => {
  let fail = true;
  const loader = createIdentifyLoader({
    fetchImpl: async () => {
      if (fail) return new Response('', { status: 503 });
      return new Response(JSON.stringify(ARTICLE), { status: 200 });
    },
  });
  assert.equal(await loader.load('satellite', 'Starlink'), null);
  fail = false;
  assert.deepEqual(await loader.load('satellite', 'Starlink'), ARTICLE);
});

test('a blank query or an unknown kind is answered locally without a request', async () => {
  let calls = 0;
  const loader = createIdentifyLoader({
    fetchImpl: async () => {
      calls += 1;
      return new Response('{}', { status: 200 });
    },
  });
  assert.equal(await loader.load('aircraft', '  '), null);
  assert.equal(await loader.load('ship', 'Heron'), null);
  assert.equal(calls, 0);
});

test('only https article links and Wikimedia images reach the page', () => {
  assert.deepEqual(
    normalizeArticle({
      ...ARTICLE,
      image: 'https://example.com/heron.jpg',
      link: 'javascript:alert(1)',
    }),
    { title: 'IAI Heron', summary: ARTICLE.summary, image: null, link: null },
  );
  assert.equal(normalizeArticle({ ...ARTICLE, image: 'http://upload.wikimedia.org/x.jpg' }).image, null);
  assert.equal(normalizeArticle({ title: 'X', summary: '' }), null);
  assert.equal(normalizeArticle(null), null);
});
