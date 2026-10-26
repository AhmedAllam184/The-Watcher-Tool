import test from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import { aircraftPhotoProxy } from '../../server/providers/aircraft/photos.js';

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
    },
  });
  assert.equal(calls.length, 1, 'adsbdb is not asked when Planespotters has a photo');
  assert.equal(calls[0].url, 'https://api.planespotters.net/pub/photos/hex/ABC123');
  assert.match(calls[0].headers['User-Agent'], /^TheWatcher\/1\.0 \(\+https:\/\/github\.com\//);
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
