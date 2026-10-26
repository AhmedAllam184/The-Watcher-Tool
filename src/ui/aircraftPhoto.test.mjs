import test from 'node:test';
import assert from 'node:assert/strict';
import { createAircraftPhotoLoader } from './aircraftPhoto.js';

const PHOTO = {
  src: 'https://t.plnspttrs.net/1/large.jpg',
  link: 'https://www.planespotters.net/photo/1/example',
  photographer: 'Jane Spotter',
  source: 'Planespotters.net',
};

function jsonResponse(body, status = 200) {
  return new Response(JSON.stringify(body), { status });
}

test('load asks the proxy for the hex and returns the photo', async () => {
  const urls = [];
  const loader = createAircraftPhotoLoader({
    fetchImpl: async (url) => {
      urls.push(url);
      return jsonResponse({ hex: 'abc123', photo: PHOTO });
    },
  });
  assert.deepEqual(await loader.load('ABC123'), PHOTO);
  assert.deepEqual(urls, ['/api/aircraft/photo?hex=abc123']);
});

test('one request per hex per session, including misses', async () => {
  let calls = 0;
  const loader = createAircraftPhotoLoader({
    fetchImpl: async () => {
      calls += 1;
      return jsonResponse({ hex: 'abc123', photo: null });
    },
  });
  assert.equal(await loader.load('abc123'), null);
  assert.equal(await loader.load('abc123'), null);
  assert.equal(calls, 1);
});

test('failures resolve to null and are retried on the next load', async () => {
  let calls = 0;
  const loader = createAircraftPhotoLoader({
    fetchImpl: async () => {
      calls += 1;
      if (calls === 1) throw new Error('offline');
      return jsonResponse({ photo: PHOTO });
    },
  });
  assert.equal(await loader.load('abc123'), null);
  assert.deepEqual(await loader.load('abc123'), PHOTO);
  assert.equal(calls, 2);
});

test('HTTP errors resolve to null', async () => {
  const loader = createAircraftPhotoLoader({
    fetchImpl: async () => jsonResponse({ error: 'invalid hex' }, 400),
  });
  assert.equal(await loader.load('abc123'), null);
});

test('non-https URLs and malformed photos are dropped', async () => {
  const loader = createAircraftPhotoLoader({
    fetchImpl: async () =>
      jsonResponse({
        photo: { src: 'http://example.test/a.jpg', link: 'javascript:alert(1)', photographer: '  ', source: 'X' },
      }),
  });
  assert.equal(await loader.load('abc123'), null);
  const bad = createAircraftPhotoLoader({ fetchImpl: async () => jsonResponse({ photo: 'nope' }) });
  assert.equal(await bad.load('abc123'), null);
});

test('a missing link stays null and an absent photographer is null', async () => {
  const loader = createAircraftPhotoLoader({
    fetchImpl: async () =>
      jsonResponse({ photo: { src: 'https://airport-data.com/a.jpg', link: null, photographer: null, source: 'airport-data.com via adsbdb' } }),
  });
  assert.deepEqual(await loader.load('abc123'), {
    src: 'https://airport-data.com/a.jpg',
    link: null,
    photographer: null,
    source: 'airport-data.com via adsbdb',
  });
});

test('invalid hex never reaches the network', async () => {
  let calls = 0;
  const loader = createAircraftPhotoLoader({
    fetchImpl: async () => {
      calls += 1;
      return jsonResponse({});
    },
  });
  for (const hex of ['', 'xyz', 'abc1234', '../x', undefined]) {
    assert.equal(await loader.load(hex), null);
  }
  assert.equal(calls, 0);
});
