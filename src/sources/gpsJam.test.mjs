import test from 'node:test';
import assert from 'node:assert/strict';
import { createGpsJamSource, normalizeGpsJamSnapshot } from './gpsJam.js';

const payload = (cells = []) => ({
  generatedAt: 1_780_000_000_000,
  windowHours: 6,
  cellDeg: 1,
  active: true,
  regions: [
    { name: 'Baltic', lat: 57, lon: 21, lastPolledAt: 1, ok: true },
    { name: 'Broken', lat: 'x', lon: 1, lastPolledAt: 1, ok: true },
  ],
  cells,
  method: 'Share of airborne aircraft broadcasting degraded GPS quality.',
  note: 'Inferred from aircraft GPS-quality broadcasts.',
  source: 'adsb.lol (ODbL)',
});

test('a malformed successful response is never accepted as an empty sample', async () => {
  for (const body of [{}, { cells: null }, { cells: {} }, null]) {
    const source = createGpsJamSource({
      fetchImpl: async () => ({ ok: true, json: async () => body }),
    });
    await assert.rejects(
      source.getSnapshot(),
      /Malformed GPS interference snapshot/,
    );
  }
});

test('cells keep their numbers, clamp ratio into 0..1 and read unknown levels as low', () => {
  const snapshot = normalizeGpsJamSnapshot(
    payload([
      {
        lat: 10,
        lon: 20,
        cellDeg: 1,
        aircraft: 52,
        degraded: 7,
        ratio: 0.14,
        level: 'high',
      },
      {
        lat: 11,
        lon: 20,
        cellDeg: 1,
        aircraft: 9,
        degraded: 9,
        ratio: 1.7,
        level: 'medium',
      },
      {
        lat: 12,
        lon: 20,
        cellDeg: 1,
        aircraft: 30,
        degraded: 0,
        ratio: -0.2,
        level: 'extreme',
      },
      {
        lat: 13,
        lon: 20,
        cellDeg: 1,
        aircraft: 10,
        degraded: 1,
        ratio: Number.NaN,
        level: 'low',
      },
    ]),
    6,
  );
  assert.deepEqual(
    snapshot.cells.map(({ ratio, level }) => [ratio, level]),
    [
      [0.14, 'high'],
      [1, 'medium'],
      [0, 'low'],
      [0.1, 'low'],
    ],
  );
});

test('cells with unusable positions or counts are dropped, not drawn', () => {
  const snapshot = normalizeGpsJamSnapshot(
    payload([
      {
        lat: Number.NaN,
        lon: 20,
        aircraft: 9,
        degraded: 1,
        ratio: 0.1,
        level: 'medium',
      },
      {
        lat: 10,
        lon: 20,
        aircraft: -4,
        degraded: 1,
        ratio: 0.1,
        level: 'medium',
      },
      {
        lat: 10,
        lon: 20,
        aircraft: 'many',
        degraded: 1,
        ratio: 0.1,
        level: 'medium',
      },
      {
        lat: 10,
        lon: 20,
        aircraft: 12,
        degraded: 2,
        ratio: 0.16,
        level: 'medium',
      },
    ]),
    6,
  );
  assert.equal(snapshot.cells.length, 1);
  assert.equal(snapshot.cells[0].aircraft, 12);
});

test('regions with unusable coordinates are dropped and labels pass through as text', () => {
  const snapshot = normalizeGpsJamSnapshot(payload(), 6);
  assert.deepEqual(snapshot.regions, [
    { name: 'Baltic', lat: 57, lon: 21, lastPolledAt: 1, ok: true },
  ]);
  assert.equal(snapshot.source, 'adsb.lol (ODbL)');
  assert.equal(snapshot.note, 'Inferred from aircraft GPS-quality broadcasts.');
});

test('the requested window and viewport area are sent, and the window is validated', async () => {
  const urls = [];
  const source = createGpsJamSource({
    fetchImpl: async (url) => {
      urls.push(url);
      return { ok: true, json: async () => payload() };
    },
  });
  await source.getSnapshot({ windowHours: 1, area: { lat: 51.5, lon: -0.12 } });
  await source.getSnapshot({});
  assert.equal(urls[0], '/api/gps-jam?window=1&lat=51.5&lon=-0.12');
  assert.equal(urls[1], '/api/gps-jam?window=6');
  await assert.rejects(source.getSnapshot({ windowHours: 3 }), RangeError);
  await assert.rejects(
    source.getSnapshot({ area: { lat: 95, lon: 0 } }),
    RangeError,
  );
  assert.equal(urls.length, 2, 'invalid requests never reach the network');
});

test('HTTP failures are reported as failures, not as an empty sample', async () => {
  const source = createGpsJamSource({
    fetchImpl: async () => ({
      ok: false,
      status: 500,
      json: async () => ({ error: 'x' }),
    }),
  });
  await assert.rejects(source.getSnapshot(), /GPS interference HTTP 500/);
});

test('cancellation during body completion is honored', async () => {
  const abort = new AbortController();
  const source = createGpsJamSource({
    fetchImpl: async () => ({
      ok: true,
      json: async () => {
        abort.abort();
        return payload();
      },
    }),
  });
  await assert.rejects(source.getSnapshot({ signal: abort.signal }), {
    name: 'AbortError',
  });
});
