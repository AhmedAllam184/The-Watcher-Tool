import test from 'node:test';
import assert from 'node:assert/strict';
import { promises as fsp } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  identifyProxy,
  parseIdentifyQuery,
  parseWikipediaArticle,
  trimSummary,
  wikipediaSearchUrl,
} from '../../server/providers/identify.js';
import { WATCHER_USER_AGENT } from '../../server/providers/common/userAgent.js';

const HERON_PAGE = {
  query: {
    pages: [
      {
        pageid: 1,
        title: 'IAI Heron',
        extract:
          'The IAI Heron is an Israeli medium-altitude drone. It is built by Israel Aerospace Industries. It flies long endurance missions. A fourth sentence is dropped.',
        thumbnail: { source: 'https://upload.wikimedia.org/wikipedia/commons/thumb/heron.jpg' },
        fullurl: 'https://en.wikipedia.org/wiki/IAI_Heron',
      },
    ],
  },
};

/** Stub fetch keyed by host; a route returns a Response, or throws. */
function stubWikipedia(route) {
  const calls = [];
  const fetchImpl = async (url, init = {}) => {
    calls.push({ url: String(url), headers: init.headers || {} });
    return route(String(url));
  };
  return { fetchImpl, calls };
}

function json(body, status = 200) {
  return () => new Response(JSON.stringify(body), { status });
}

/** A fresh proxy with an isolated (absent) disk cache. */
function proxy(fetchImpl, cachePath) {
  return identifyProxy({
    fetchImpl,
    cachePath:
      cachePath ??
      path.join(os.tmpdir(), `identify-test-${process.pid}-${Math.random()}.json`),
  });
}

/** Drive the Vite middleware the way the dev server does (prefix already stripped). */
function harness(plugin) {
  let middleware;
  plugin.configureServer({
    middlewares: {
      use(route, handler) {
        assert.equal(route, '/api/identify');
        middleware = handler;
      },
    },
  });
  return async (url) => {
    const response = { status: 0, headers: {}, body: '' };
    response.writeHead = (status, headers) => {
      response.status = status;
      response.headers = headers;
    };
    response.end = (body) => {
      response.body = body;
    };
    await middleware({ url }, response);
    return { status: response.status, body: JSON.parse(response.body) };
  };
}

test('invalid kind or query is rejected before any upstream call', async () => {
  const { fetchImpl, calls } = stubWikipedia(() => {
    throw new Error('unexpected');
  });
  const get = harness(proxy(fetchImpl));
  for (const url of [
    '/?kind=ship&q=Starlink',
    '/?kind=aircraft',
    '/?kind=aircraft&q=x',
    '/?kind=aircraft&q=' + encodeURIComponent('<script>alert(1)</script>'),
    '/?kind=aircraft&q=' + encodeURIComponent('a'.repeat(81)),
  ]) {
    const res = await get(url);
    assert.equal(res.status, 400, url);
  }
  assert.equal(calls.length, 0);
});

test('an unknown sub-path is a 404', async () => {
  const get = harness(proxy(stubWikipedia(json({})).fetchImpl));
  assert.equal((await get('/extra?kind=aircraft&q=Heron')).status, 404);
});

test('a found article is returned with a three-sentence summary, its image and its link', async () => {
  const { fetchImpl, calls } = stubWikipedia(json(HERON_PAGE));
  const res = await harness(proxy(fetchImpl))('/?kind=aircraft&q=IAI%20Heron%20aircraft');
  assert.equal(res.status, 200);
  assert.deepEqual(res.body, {
    title: 'IAI Heron',
    summary:
      'The IAI Heron is an Israeli medium-altitude drone. It is built by Israel Aerospace Industries. It flies long endurance missions.',
    image: 'https://upload.wikimedia.org/wikipedia/commons/thumb/heron.jpg',
    link: 'https://en.wikipedia.org/wiki/IAI_Heron',
  });
  assert.equal(calls.length, 1);
  const url = new URL(calls[0].url);
  assert.equal(url.host, 'en.wikipedia.org');
  assert.equal(url.searchParams.get('gsrsearch'), 'IAI Heron aircraft');
  assert.equal(url.searchParams.get('exsentences'), '3');
  assert.equal(url.searchParams.get('generator'), 'search');
  assert.equal(url.searchParams.get('gsrlimit'), '1');
  assert.equal(calls[0].headers['User-Agent'], WATCHER_USER_AGENT);
});

test('an article with no image still returns its summary and link, and a non-Wikimedia image is dropped', async () => {
  const page = structuredClone(HERON_PAGE);
  page.query.pages[0].thumbnail.source = 'https://example.com/heron.jpg';
  const { fetchImpl } = stubWikipedia(json(page));
  const res = await harness(proxy(fetchImpl))('/?kind=satellite&q=Starlink');
  assert.equal(res.status, 200);
  assert.equal(res.body.image, null);
  assert.equal(res.body.link, 'https://en.wikipedia.org/wiki/IAI_Heron');
});

test('a plain-http image is never returned', () => {
  const page = structuredClone(HERON_PAGE);
  page.query.pages[0].thumbnail.source = 'http://upload.wikimedia.org/heron.jpg';
  assert.equal(parseWikipediaArticle(page).image, null);
});

test('a search with no article is a cached miss: Wikipedia is not asked again', async () => {
  const { fetchImpl, calls } = stubWikipedia(json({ query: { pages: [{ ns: 0, title: 'Nope', missing: true }] } }));
  const get = harness(proxy(fetchImpl));
  assert.deepEqual((await get('/?kind=satellite&q=Nonexistent%20thing')).body, {
    title: null,
    summary: null,
    image: null,
    link: null,
  });
  await get('/?kind=satellite&q=Nonexistent%20thing');
  assert.equal(calls.length, 1);
});

test('an upstream failure with nothing stored is a 503, and it is not cached', async () => {
  let failing = true;
  const { fetchImpl, calls } = stubWikipedia(() =>
    failing ? new Response('', { status: 503 }) : json(HERON_PAGE)(),
  );
  const get = harness(proxy(fetchImpl));
  const first = await get('/?kind=aircraft&q=IAI%20Heron');
  assert.equal(first.status, 503);
  failing = false;
  const second = await get('/?kind=aircraft&q=IAI%20Heron');
  assert.equal(second.status, 200);
  assert.equal(calls.length, 2, 'the failure was not remembered');
});

test('a thrown fetch is a 503 too, and not a 500', async () => {
  const { fetchImpl } = stubWikipedia(() => {
    throw new Error('network down');
  });
  assert.equal((await harness(proxy(fetchImpl))('/?kind=aircraft&q=IAI%20Heron')).status, 503);
});

test('concurrent requests for one query share a single upstream lookup', async () => {
  let release;
  const gate = new Promise((resolve) => {
    release = resolve;
  });
  const { fetchImpl, calls } = stubWikipedia(async () => {
    await gate;
    return new Response(JSON.stringify(HERON_PAGE), { status: 200 });
  });
  const get = harness(proxy(fetchImpl));
  const pending = Promise.all([
    get('/?kind=aircraft&q=IAI%20Heron'),
    get('/?kind=aircraft&q=iai%20heron'),
    get('/?kind=aircraft&q=IAI%20Heron'),
  ]);
  release();
  const answers = await pending;
  assert.ok(answers.every((answer) => answer.status === 200));
  assert.equal(calls.length, 1);
});

test('the aircraft and satellite kinds are separate cache keys for one query', async () => {
  const { fetchImpl, calls } = stubWikipedia(json(HERON_PAGE));
  const get = harness(proxy(fetchImpl));
  await get('/?kind=aircraft&q=Heron');
  await get('/?kind=satellite&q=Heron');
  assert.equal(calls.length, 2);
});

test('the disk cache is written through a temp file, and a fresh instance reads the answer back', async () => {
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'identify-disk-'));
  const cachePath = path.join(dir, 'identify.json');
  try {
    const first = stubWikipedia(json(HERON_PAGE));
    const plugin = proxy(first.fetchImpl, cachePath);
    await harness(plugin)('/?kind=aircraft&q=IAI%20Heron');
    await plugin.flush();
    const saved = JSON.parse(await fsp.readFile(cachePath, 'utf8'));
    assert.equal(saved.articles['aircraft|iai heron'].data.title, 'IAI Heron');
    assert.deepEqual(await fsp.readdir(dir), ['identify.json']);

    const second = stubWikipedia(json({}, 500));
    const res = await harness(proxy(second.fetchImpl, cachePath))('/?kind=aircraft&q=IAI%20Heron');
    assert.equal(res.status, 200);
    assert.equal(res.body.title, 'IAI Heron');
    assert.equal(second.calls.length, 0);
  } finally {
    await fsp.rm(dir, { recursive: true, force: true });
  }
});

test('an expired entry on disk is dropped when the cache loads, so it is fetched again', async () => {
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'identify-expired-'));
  const cachePath = path.join(dir, 'identify.json');
  try {
    const old = Date.now() - 40 * 24 * 3600_000;
    await fsp.writeFile(
      cachePath,
      JSON.stringify({
        articles: { 'aircraft|iai heron': { at: old, data: { title: 'Old', summary: 'Old.', image: null, link: null } } },
      }),
    );
    const { fetchImpl, calls } = stubWikipedia(json(HERON_PAGE));
    const res = await harness(proxy(fetchImpl, cachePath))('/?kind=aircraft&q=IAI%20Heron');
    assert.equal(res.body.title, 'IAI Heron');
    assert.equal(calls.length, 1);
  } finally {
    await fsp.rm(dir, { recursive: true, force: true });
  }
});

test('a fresh disk entry is served without any upstream call', async () => {
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'identify-fresh-'));
  const cachePath = path.join(dir, 'identify.json');
  try {
    await fsp.writeFile(
      cachePath,
      JSON.stringify({
        articles: { 'aircraft|iai heron': { at: Date.now(), data: { title: 'IAI Heron', summary: 'Cached.', image: null, link: null } } },
      }),
    );
    const { fetchImpl, calls } = stubWikipedia(json({}, 500));
    const res = await harness(proxy(fetchImpl, cachePath))('/?kind=aircraft&q=IAI%20Heron');
    assert.equal(res.body.summary, 'Cached.');
    assert.equal(calls.length, 0);
  } finally {
    await fsp.rm(dir, { recursive: true, force: true });
  }
});

test('query and summary helpers keep text plain and bounded', () => {
  assert.equal(parseIdentifyQuery('  Long   March 2C  '), 'Long March 2C');
  assert.equal(parseIdentifyQuery('Yaogan-30 (02)'), 'Yaogan-30 (02)');
  assert.equal(parseIdentifyQuery('x'), null);
  assert.equal(parseIdentifyQuery(undefined), null);
  assert.equal(trimSummary(''), null);
  assert.equal(trimSummary('A long text without a stop'), 'A long text without a stop');
  assert.ok(trimSummary('x'.repeat(2000) + '.').length <= 600);
  const url = new URL(wikipediaSearchUrl('Starlink'));
  assert.equal(url.searchParams.get('piprop'), 'thumbnail');
  assert.equal(url.searchParams.get('pithumbsize'), '640');
});
