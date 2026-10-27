import test from 'node:test';
import assert from 'node:assert/strict';
import {
  createSatelliteInfoLoader,
  normalizeSatelliteInfo,
} from './satelliteInfo.js';

const SERVER_RECORD = {
  norad: 25544,
  name: 'ISS (ZARYA)',
  owner: { code: 'ISS', name: 'International Space Station partners' },
  launchSite: { code: 'TYMSC', name: 'Baikonur, Kazakhstan' },
  apogeeKm: 420,
  rcsM2: null,
  source: 'CelesTrak SATCAT',
  unexpected: { injected: true },
};

function jsonResponse(body, status = 200) {
  return new Response(JSON.stringify(body), { status });
}

test('one request per NORAD id, and the record is normalised to the fields the panel renders', async () => {
  const urls = [];
  const loader = createSatelliteInfoLoader({
    fetchImpl: async (url) => {
      urls.push(url);
      return jsonResponse({ norad: 25544, satellite: SERVER_RECORD });
    },
  });
  const [first, second] = await Promise.all([loader.load(25544), loader.load('25544')]);
  await loader.load(25544);
  assert.deepEqual(urls, ['/api/satellites/info?norad=25544']);
  assert.equal(first.satellite.owner.name, 'International Space Station partners');
  assert.equal(first.satellite.apogeeKm, 420);
  assert.equal(first.satellite.rcsM2, null);
  assert.equal(first.satellite.unexpected, undefined, 'unknown fields are dropped');
  assert.strictEqual(first, second, 'concurrent callers share one answer');
});

test('an object CelesTrak does not list resolves to a null satellite', async () => {
  const loader = createSatelliteInfoLoader({
    fetchImpl: async () => jsonResponse({ norad: 12345, satellite: null }),
  });
  assert.deepEqual(await loader.load(12345), { satellite: null });
});

test('an invalid NORAD id is answered locally without a request', async () => {
  let calls = 0;
  const loader = createSatelliteInfoLoader({
    fetchImpl: async () => {
      calls += 1;
      return jsonResponse({});
    },
  });
  for (const id of ['', 'abc', 0, -3, 1.5, null, undefined]) {
    assert.deepEqual(await loader.load(id), { satellite: null }, String(id));
  }
  assert.equal(calls, 0);
});

test('a failed lookup rejects and is retried on the next call', async () => {
  let attempts = 0;
  const loader = createSatelliteInfoLoader({
    fetchImpl: async () => {
      attempts += 1;
      if (attempts === 1) return jsonResponse({ error: 'satcat unavailable', transient: true }, 503);
      return jsonResponse({ norad: 28228, satellite: SERVER_RECORD });
    },
  });
  await assert.rejects(loader.load(28228));
  const retried = await loader.load(28228);
  assert.equal(attempts, 2);
  assert.equal(retried.satellite.name, 'ISS (ZARYA)');
});

test('normalizeSatelliteInfo rejects non-objects and keeps only typed values', () => {
  assert.equal(normalizeSatelliteInfo(null), null);
  assert.equal(normalizeSatelliteInfo('ISS'), null);
  const cleaned = normalizeSatelliteInfo({ name: '  ', apogeeKm: '420', owner: 'PRC' });
  assert.equal(cleaned.name, null);
  assert.equal(cleaned.apogeeKm, null, 'a string is not a number');
  assert.equal(cleaned.owner, null);
});
