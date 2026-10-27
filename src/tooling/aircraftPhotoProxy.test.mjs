import test from 'node:test';
import assert from 'node:assert/strict';
import { promises as fsp } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { aircraftPhotoProxy } from '../../server/providers/aircraft/photos.js';
import { WATCHER_USER_AGENT } from '../../server/providers/common/userAgent.js';

const PLANESPOTTERS_PHOTO = {
  photos: [
    {
      thumbnail: { src: 'https://t.plnspttrs.net/1/small.jpg', size: 'small' },
      thumbnail_large: { src: 'https://t.plnspttrs.net/1/large.jpg', size: 'large' },
      link: 'https://www.planespotters.net/photo/1/example',
      photographer: 'Jane Spotter',
    },
  ],
};
const ADSBDB_PHOTO = {
  response: {
    aircraft: {
      url_photo: 'https://airport-data.com/images/aircraft/1.jpg',
      url_photo_thumbnail: 'https://airport-data.com/images/aircraft/1_t.jpg',
    },
  },
};

/** Stub fetch keyed by upstream host; each route returns a Response or throws. */
function stubUpstreams(routes) {
  const calls = [];
  const fetchImpl = async (url, init = {}) => {
    calls.push({ url: String(url), headers: init.headers || {} });
    const host = new URL(String(url)).host;
    const route = routes[host];
    if (!route) throw new Error('unexpected upstream');
    if (route instanceof Error) throw route;
    return route();
  };
  return { fetchImpl, calls };
}

function json(body, status = 200) {
  return () => new Response(JSON.stringify(body), { status });
}

/** A fresh proxy with an isolated (absent) disk cache. */
function proxy(fetchImpl) {
  return aircraftPhotoProxy({
    fetchImpl,
    cachePath: path.join(os.tmpdir(), `aircraft-photos-test-${process.pid}-${Math.random()}.json`),
  });
}

/** Drive the Vite middleware the way the dev server does (prefix already stripped). */
function harness(plugin) {
  let middleware;
  plugin.configureServer({
    middlewares: {
      use(route, handler) {
        assert.equal(route, '/api/aircraft/photo');
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

test('invalid hex is rejected before any upstream call', async () => {
  const { fetchImpl, calls } = stubUpstreams({});
  const get = harness(proxy(fetchImpl));
  for (const url of ['/?hex=nope', '/?hex=abc12', '/?hex=abc1234', '/?', '/?hex=../../x']) {
    const res = await get(url);
    assert.equal(res.status, 400, url);
    assert.deepEqual(res.body, { error: 'invalid hex' });
  }
  assert.equal(calls.length, 0);
});

test('unknown sub-path is a 404', async () => {
  const get = harness(proxy(stubUpstreams({}).fetchImpl));
  assert.equal((await get('/extra?hex=abc123')).status, 404);
});

test('Planespotters photo is returned with photographer, link and source', async () => {
  const { fetchImpl, calls } = stubUpstreams({
    'api.planespotters.net': json(PLANESPOTTERS_PHOTO),
    'api.adsbdb.com': json({}, 404),
  });
  const res = await harness(proxy(fetchImpl))('/?hex=ABC123');
  assert.equal(res.status, 200);
  assert.deepEqual(res.body, {
    hex: 'abc123',
    photo: {
      src: 'https://t.plnspttrs.net/1/large.jpg',
      link: 'https://www.planespotters.net/photo/1/example',
      photographer: 'Jane Spotter',
      source: 'Planespotters.net',
      kind: 'airframe',
    },
  });
  assert.equal(calls.length, 1, 'adsbdb is not asked when Planespotters has a photo');
  assert.equal(calls[0].url, 'https://api.planespotters.net/pub/photos/hex/ABC123');
  assert.equal(calls[0].headers['User-Agent'], WATCHER_USER_AGENT);
});

test('falls back to the adsbdb airport-data photo when Planespotters has none', async () => {
  const { fetchImpl } = stubUpstreams({
    'api.planespotters.net': json({ photos: [] }),
    'api.adsbdb.com': json(ADSBDB_PHOTO),
  });
  const res = await harness(proxy(fetchImpl))('/?hex=abc123');
  assert.deepEqual(res.body.photo, {
    src: 'https://airport-data.com/images/aircraft/1_t.jpg',
    link: 'https://airport-data.com/images/aircraft/1.jpg',
    photographer: null,
    source: 'airport-data.com via adsbdb',
    kind: 'airframe',
  });
});

test('falls back to adsbdb when Planespotters fails', async () => {
  const { fetchImpl } = stubUpstreams({
    'api.planespotters.net': new Error('socket hang up'),
    'api.adsbdb.com': json(ADSBDB_PHOTO),
  });
  const res = await harness(proxy(fetchImpl))('/?hex=abc123');
  assert.equal(res.body.photo.source, 'airport-data.com via adsbdb');
});

test('non-https image URLs are never returned', async () => {
  const insecure = {
    photos: [
      {
        thumbnail: { src: 'http://t.plnspttrs.net/1/small.jpg' },
        thumbnail_large: { src: 'javascript:alert(1)' },
        link: 'http://www.planespotters.net/photo/1',
        photographer: 'X',
      },
    ],
  };
  const { fetchImpl } = stubUpstreams({
    'api.planespotters.net': json(insecure),
    'api.adsbdb.com': json({ response: { aircraft: { url_photo: 'http://insecure.example/a.jpg' } } }),
  });
  const res = await harness(proxy(fetchImpl))('/?hex=abc123');
  assert.equal(res.body.photo, null);
});

test('no photo anywhere is a cached miss: upstreams are not asked again', async () => {
  const { fetchImpl, calls } = stubUpstreams({
    'api.planespotters.net': json({}, 404),
    'api.adsbdb.com': json({}, 404),
  });
  const get = harness(proxy(fetchImpl));
  assert.deepEqual((await get('/?hex=abc123')).body, { hex: 'abc123', photo: null });
  assert.deepEqual((await get('/?hex=abc123')).body, { hex: 'abc123', photo: null });
  assert.equal(calls.length, 2, 'one lookup per upstream, then the miss is cached');
});

test('upstream failures are not cached as misses', async () => {
  let attempts = 0;
  const { fetchImpl, calls } = stubUpstreams({
    'api.planespotters.net': () => {
      attempts += 1;
      throw new Error('down');
    },
    'api.adsbdb.com': new Error('down'),
  });
  const get = harness(proxy(fetchImpl));
  assert.equal((await get('/?hex=abc123')).body.photo, null);
  await get('/?hex=abc123');
  assert.equal(attempts, 2, 'a failed lookup is retried on the next request');
  assert.equal(calls.length, 4);
});

test('concurrent requests for one hex share a single upstream lookup', async () => {
  const { fetchImpl, calls } = stubUpstreams({
    'api.planespotters.net': json(PLANESPOTTERS_PHOTO),
  });
  const get = harness(proxy(fetchImpl));
  const results = await Promise.all([get('/?hex=abc123'), get('/?hex=abc123'), get('/?hex=abc123')]);
  assert.ok(results.every((r) => r.body.photo?.photographer === 'Jane Spotter'));
  assert.equal(calls.length, 1);
});

test('error responses stay generic', async () => {
  const get = harness(proxy(async () => {
    throw new Error('fixture-secret-token');
  }));
  const res = await get('/?hex=abc123');
  assert.equal(res.status, 200);
  assert.doesNotMatch(JSON.stringify(res.body), /fixture-secret-token/);
});

/** A fresh temp directory for one proxy's disk cache file. */
async function cacheFile(t) {
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'aircraft-photo-test-'));
  t.after(() => fsp.rm(dir, { recursive: true, force: true }));
  return path.join(dir, 'aircraft-photos.json');
}

/** The parsed disk cache, or null while it is absent or half written. */
async function readSaved(file) {
  try {
    return JSON.parse(await fsp.readFile(file, 'utf8'));
  } catch {
    return null;
  }
}

/** Poll the disk cache (real time) until `ready(saved)` holds. */
async function waitForSaved(file, ready) {
  for (let i = 0; i < 300; i++) {
    const saved = await readSaved(file);
    if (saved && ready(saved)) return saved;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error('the disk cache was not written');
}

const CACHED_PHOTO = {
  src: 'https://t.example.net/cached.jpg',
  link: null,
  photographer: null,
  source: 'disk cache',
};

test('concurrent first requests share one disk read, so a cached hex never reaches upstream', async (t) => {
  const file = await cacheFile(t);
  await fsp.writeFile(
    file,
    JSON.stringify({ photos: { abc123: { at: Date.now(), data: CACHED_PHOTO } } }),
  );
  const { fetchImpl, calls } = stubUpstreams({
    'api.planespotters.net': json(PLANESPOTTERS_PHOTO),
  });
  const get = harness(aircraftPhotoProxy({ fetchImpl, cachePath: file }));
  const results = await Promise.all([
    get('/?hex=abc123'),
    get('/?hex=abc123'),
    get('/?hex=abc123'),
  ]);
  assert.ok(results.every((r) => r.body.photo.source === 'disk cache'));
  assert.equal(calls.length, 0, 'the disk cache answered every caller');
});

test('expired entries are dropped when the disk cache loads and are not written back', async (t) => {
  t.mock.timers.enable({ apis: ['setInterval'] });
  const file = await cacheFile(t);
  const EIGHT_DAYS = 8 * 24 * 3600_000;
  await fsp.writeFile(
    file,
    JSON.stringify({
      photos: {
        old111: { at: Date.now() - EIGHT_DAYS, data: CACHED_PHOTO },
        new111: { at: Date.now(), data: null },
      },
    }),
  );
  const { fetchImpl } = stubUpstreams({
    'api.planespotters.net': json(PLANESPOTTERS_PHOTO),
  });
  const get = harness(aircraftPhotoProxy({ fetchImpl, cachePath: file }));
  await get('/?hex=abc123');
  t.mock.timers.tick(15_000);
  const saved = await waitForSaved(file, (s) => s.photos.abc123);
  assert.equal(saved.photos.old111, undefined);
  assert.ok(saved.photos.new111, 'a fresh miss is kept');
});

test('the cache holds at most 5,000 hexes and the oldest go first', async (t) => {
  t.mock.timers.enable({ apis: ['setInterval'] });
  const file = await cacheFile(t);
  const now = Date.now();
  const photos = {};
  for (let i = 0; i < 5005; i++) {
    const hex = i.toString(16).padStart(6, '0');
    photos[hex] = { at: now - 1000 * (5005 - i), data: null };
  }
  await fsp.writeFile(file, JSON.stringify({ photos }));
  const { fetchImpl } = stubUpstreams({
    'api.planespotters.net': json({}, 404),
    'api.adsbdb.com': json({}, 404),
  });
  const get = harness(aircraftPhotoProxy({ fetchImpl, cachePath: file }));
  await get('/?hex=ffffff');
  t.mock.timers.tick(15_000);
  const saved = await waitForSaved(file, (s) => s.photos.ffffff);
  const hexes = Object.keys(saved.photos);
  assert.equal(hexes.length, 5000);
  assert.equal(saved.photos['000000'], undefined, 'the oldest is evicted');
  assert.equal(saved.photos['000005'], undefined, 'and so are the next oldest');
  assert.ok(saved.photos['000100'], 'newer entries stay');
});

test('the disk write goes through a temp file: none is left behind and the JSON parses', async (t) => {
  t.mock.timers.enable({ apis: ['setInterval'] });
  const file = await cacheFile(t);
  const renames = [];
  const realRename = fsp.rename;
  t.mock.method(fsp, 'rename', async (from, to) => {
    renames.push([from, to]);
    return realRename(from, to);
  });
  const { fetchImpl } = stubUpstreams({
    'api.planespotters.net': json(PLANESPOTTERS_PHOTO),
  });
  const get = harness(aircraftPhotoProxy({ fetchImpl, cachePath: file }));
  await get('/?hex=abc123');
  t.mock.timers.tick(15_000);
  const saved = await waitForSaved(file, (s) => s.photos.abc123);
  assert.equal(saved.photos.abc123.data.photographer, 'Jane Spotter');
  assert.deepEqual(await fsp.readdir(path.dirname(file)), [path.basename(file)]);
  assert.deepEqual(renames, [[`${file}.${process.pid}.tmp`, file]]);
  await assert.rejects(fsp.access(`${file}.${process.pid}.tmp`));
});

const WIKI_URL = 'https://en.wikipedia.org/';
const WIKIPEDIA_C17 = {
  query: {
    pages: [
      {
        pageid: 1,
        title: 'Boeing C-17 Globemaster III',
        fullurl: 'https://en.wikipedia.org/wiki/Boeing_C-17_Globemaster_III',
        thumbnail: {
          source:
            'https://upload.wikimedia.org/wikipedia/commons/thumb/c17.jpg/640px-c17.jpg',
          width: 640,
          height: 400,
        },
      },
    ],
  },
};
/** Upstreams that have no photo of the airframe, so only a type photo can answer. */
const NO_AIRFRAME = {
  'api.planespotters.net': json({}, 404),
  'api.adsbdb.com': json({}, 404),
};
const wikiCalls = (calls) => calls.filter((c) => c.url.startsWith(WIKI_URL));

test('an airframe photo is returned without asking Wikipedia about the type', async () => {
  const { fetchImpl, calls } = stubUpstreams({
    'api.planespotters.net': json(PLANESPOTTERS_PHOTO),
    'en.wikipedia.org': json(WIKIPEDIA_C17),
  });
  const res = await harness(proxy(fetchImpl))('/?hex=abc123&type=C17');
  assert.equal(res.body.photo.kind, 'airframe');
  assert.equal(wikiCalls(calls).length, 0);
});

test('with no airframe photo, a Wikipedia type photo stands in and is labelled as a type', async () => {
  const { fetchImpl, calls } = stubUpstreams({
    ...NO_AIRFRAME,
    'en.wikipedia.org': json(WIKIPEDIA_C17),
  });
  const res = await harness(proxy(fetchImpl))('/?hex=ae0001&type=C17');
  assert.deepEqual(res.body, {
    hex: 'ae0001',
    photo: {
      src: 'https://upload.wikimedia.org/wikipedia/commons/thumb/c17.jpg/640px-c17.jpg',
      link: 'https://en.wikipedia.org/wiki/Boeing_C-17_Globemaster_III',
      photographer: null,
      source: 'Wikipedia',
      kind: 'type',
      title: 'Boeing C-17 Globemaster III',
    },
  });
  const [wiki] = wikiCalls(calls);
  const params = new URL(wiki.url).searchParams;
  assert.equal(params.get('generator'), 'search');
  assert.equal(params.get('gsrsearch'), 'C-17 Globemaster III aircraft');
  assert.equal(params.get('gsrlimit'), '1');
  assert.equal(params.get('prop'), 'pageimages|info');
  assert.equal(params.get('pithumbsize'), '640');
  assert.equal(wiki.headers['User-Agent'], WATCHER_USER_AGENT);
});

test('a military code is searched by its common name, other types as typed', async () => {
  for (const [type, search] of [
    ['K35R', 'KC-135 Stratotanker aircraft'],
    ['h60', 'UH-60 Black Hawk aircraft'],
    ['Eurofighter Typhoon', 'Eurofighter Typhoon aircraft'],
    ['A10X', 'A10X aircraft'],
  ]) {
    const { fetchImpl, calls } = stubUpstreams({
      ...NO_AIRFRAME,
      'en.wikipedia.org': json(WIKIPEDIA_C17),
    });
    await harness(proxy(fetchImpl))(
      `/?hex=ae0002&type=${encodeURIComponent(type)}`,
    );
    assert.equal(
      new URL(wikiCalls(calls)[0].url).searchParams.get('gsrsearch'),
      search,
      type,
    );
  }
});

test('no type given means no Wikipedia lookup, even with no airframe photo', async () => {
  const { fetchImpl, calls } = stubUpstreams({
    ...NO_AIRFRAME,
    'en.wikipedia.org': json(WIKIPEDIA_C17),
  });
  const res = await harness(proxy(fetchImpl))('/?hex=ae0001&type=');
  assert.deepEqual(res.body, { hex: 'ae0001', photo: null });
  assert.equal(wikiCalls(calls).length, 0);
});

test('invalid types are rejected before any upstream call', async () => {
  const { fetchImpl, calls } = stubUpstreams({});
  const get = harness(proxy(fetchImpl));
  for (const type of [
    'x',
    'a'.repeat(81),
    'C17<script>',
    'a/b',
    '../x',
    'C17;DROP',
    '%20%20',
  ]) {
    const res = await get(`/?hex=abc123&type=${encodeURIComponent(type)}`);
    assert.equal(res.status, 400, type);
    assert.deepEqual(res.body, { error: 'invalid type' });
  }
  assert.equal(calls.length, 0);
});

test('a Wikipedia failure gives no photo and is retried, not cached', async () => {
  let attempts = 0;
  const { fetchImpl } = stubUpstreams({
    ...NO_AIRFRAME,
    'en.wikipedia.org': () => {
      attempts += 1;
      throw new Error('down');
    },
  });
  const get = harness(proxy(fetchImpl));
  assert.equal((await get('/?hex=ae0001&type=C17')).body.photo, null);
  assert.equal((await get('/?hex=ae0001&type=C17')).body.photo, null);
  assert.equal(attempts, 2);
});

test('a type photo is cached per normalised type: a second airframe of that type skips Wikipedia', async () => {
  const { fetchImpl, calls } = stubUpstreams({
    ...NO_AIRFRAME,
    'en.wikipedia.org': json(WIKIPEDIA_C17),
  });
  const get = harness(proxy(fetchImpl));
  await get('/?hex=ae0001&type=C17');
  const second = await get('/?hex=ae0002&type=%20c17%20');
  assert.equal(second.body.photo.kind, 'type');
  assert.equal(wikiCalls(calls).length, 1);
});

test('a type with no Wikipedia image is a cached miss', async () => {
  const { fetchImpl, calls } = stubUpstreams({
    ...NO_AIRFRAME,
    'en.wikipedia.org': json({
      query: {
        pages: [
          {
            title: 'Nothing',
            fullurl: 'https://en.wikipedia.org/wiki/Nothing',
          },
        ],
      },
    }),
  });
  const get = harness(proxy(fetchImpl));
  assert.equal((await get('/?hex=ae0001&type=Nothing')).body.photo, null);
  assert.equal((await get('/?hex=ae0002&type=Nothing')).body.photo, null);
  assert.equal(wikiCalls(calls).length, 1);
});

test('only https upload.wikimedia.org images are returned as type photos', async () => {
  for (const source of [
    'http://upload.wikimedia.org/wikipedia/commons/c17.jpg',
    'https://evil.example/c17.jpg',
    'javascript:alert(1)',
  ]) {
    const page = {
      title: 'C-17',
      fullurl: 'https://en.wikipedia.org/wiki/C-17',
      thumbnail: { source },
    };
    const { fetchImpl } = stubUpstreams({
      ...NO_AIRFRAME,
      'en.wikipedia.org': json({ query: { pages: [page] } }),
    });
    const res = await harness(proxy(fetchImpl))('/?hex=ae0001&type=C17');
    assert.equal(res.body.photo, null, source);
  }
});

test('type entries keep their own lifetimes: 30 days for a photo, 7 days for a miss', async (t) => {
  t.mock.timers.enable({ apis: ['setInterval'] });
  const file = await cacheFile(t);
  const DAY = 24 * 3600_000;
  await fsp.writeFile(
    file,
    JSON.stringify({
      photos: {
        'type:c17': {
          at: Date.now() - 10 * DAY,
          data: { ...CACHED_PHOTO, kind: 'type' },
        },
        'type:f16': { at: Date.now() - 8 * DAY, data: null },
      },
    }),
  );
  const { fetchImpl } = stubUpstreams({
    'api.planespotters.net': json(PLANESPOTTERS_PHOTO),
  });
  const get = harness(aircraftPhotoProxy({ fetchImpl, cachePath: file }));
  await get('/?hex=abc123');
  t.mock.timers.tick(15_000);
  const saved = await waitForSaved(file, (s) => s.photos.abc123);
  assert.ok(saved.photos['type:c17'], 'a type photo under 30 days old is kept');
  assert.equal(
    saved.photos['type:f16'],
    undefined,
    'a type miss over 7 days old is dropped',
  );
});
