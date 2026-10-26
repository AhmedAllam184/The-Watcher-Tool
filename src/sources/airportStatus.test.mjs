import test from 'node:test';
import assert from 'node:assert/strict';
import {
  createAirportStatusSource,
  normalizeAirportStatus,
} from './airportStatus.js';

const riyadh = {
  icao: 'OERK',
  iata: 'RUH',
  name: 'King Khalid International Airport',
  city: 'Riyadh',
  lat: 24.9576,
  lon: 46.6988,
  lastPolledAt: 1_700_000_000_000,
  aircraftNearby: 12,
  holdingReliable: true,
  holding: 4,
  holdingCallsigns: ['SV1', 'SV2', 'SV3', 'SV4', 'SV5', 'SV6'],
  degradedGps: 3,
  judged: 10,
  degradedShare: 0.3,
  level: 'disrupted',
  reasons: ['4 aircraft holding', '30% report degraded GPS'],
};

test('a valid payload keeps the airports, labels and reasons', () => {
  const status = normalizeAirportStatus({
    generatedAt: 1_700_000_000_500,
    airports: [riyadh],
    method: 'method text',
    note: 'note text',
    source: 'adsb.lol (ODbL)',
  });
  assert.equal(status.generatedAt, 1_700_000_000_500);
  assert.equal(status.note, 'note text');
  assert.equal(status.airports[0].icao, 'OERK');
  assert.equal(status.airports[0].level, 'disrupted');
  assert.deepEqual(status.airports[0].reasons, riyadh.reasons);
  assert.equal(status.airports[0].holdingCallsigns.length, 5, 'capped at five');
});

test('an unknown level reads as unknown, and never as a rating', () => {
  const [airport] = normalizeAirportStatus({
    airports: [{ ...riyadh, level: 'critical' }],
  }).airports;
  assert.equal(airport.level, 'unknown');
});

test('airports without a usable code or position are dropped', () => {
  const status = normalizeAirportStatus({
    airports: [
      { ...riyadh, icao: 'oerk' },
      { ...riyadh, icao: 'TOO-LONG' },
      { ...riyadh, lat: Number.NaN },
      { ...riyadh, lon: null },
      riyadh,
    ],
  });
  assert.deepEqual(
    status.airports.map((airport) => airport.icao),
    ['OERK'],
  );
});

test('bad counts and shares are clamped, and a missing share stays null', () => {
  const [airport] = normalizeAirportStatus({
    airports: [
      {
        ...riyadh,
        holding: -2,
        judged: 1.5,
        degradedShare: 3,
        reasons: ['ok', 7],
      },
    ],
  }).airports;
  assert.equal(airport.holding, 0);
  assert.equal(airport.judged, 0);
  assert.equal(airport.degradedShare, 1);
  assert.deepEqual(airport.reasons, ['ok']);

  const [none] = normalizeAirportStatus({
    airports: [{ ...riyadh, degradedShare: undefined }],
  }).airports;
  assert.equal(none.degradedShare, null);
});

test('an unassessed holding stays null, not zero', () => {
  const [airport] = normalizeAirportStatus({
    airports: [{ ...riyadh, holdingReliable: false, holding: null }],
  }).airports;
  assert.equal(airport.holdingReliable, false);
  assert.equal(airport.holding, null);
});

test('a malformed top level is rejected', () => {
  for (const payload of [null, 'x', {}, { airports: 'nope' }]) {
    assert.throws(() => normalizeAirportStatus(payload), /Malformed/);
  }
});

test('the source asks for codes, de-duplicated and upper-cased', async () => {
  const requests = [];
  const source = createAirportStatusSource({
    fetchImpl: async (href, init) => {
      requests.push({ href, init });
      return new Response(JSON.stringify({ airports: [riyadh] }), {
        status: 200,
      });
    },
  });
  const status = await source.getStatus({ codes: ['oejn', 'OEJN', 'oerk'] });
  assert.equal(requests[0].href, '/api/airports/status?codes=OEJN%2COERK');
  assert.equal(requests[0].init.cache, 'no-store');
  assert.equal(status.airports.length, 1);

  await source.getStatus({});
  assert.equal(requests[1].href, '/api/airports/status');
});

test('the source refuses more than eight or malformed codes before fetching', async () => {
  let fetched = 0;
  const source = createAirportStatusSource({
    fetchImpl: async () => {
      fetched += 1;
      return new Response('{}', { status: 200 });
    },
  });
  const nine = Array.from({ length: 9 }, (_, i) => `AB${10 + i}`);
  await assert.rejects(source.getStatus({ codes: nine }), RangeError);
  await assert.rejects(source.getStatus({ codes: ['OE-RK'] }), RangeError);
  assert.equal(fetched, 0);
});

test('an HTTP failure surfaces its status', async () => {
  const source = createAirportStatusSource({
    fetchImpl: async () => new Response('{}', { status: 500 }),
  });
  await assert.rejects(source.getStatus({}), /HTTP 500/);
});
