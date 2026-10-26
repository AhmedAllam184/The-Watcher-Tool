import test from 'node:test';
import assert from 'node:assert/strict';
import {
  __aisDarkMemorySizeForTests,
  __resetAisStoreForTests,
  darkVessels,
  ingestAisStreamEnvelope,
} from '../../server/providers/vessels/ais-store.js';

const MIN = 60_000;
const T0 = Date.UTC(2026, 9, 26, 12, 0, 0);
const DARK = '111111111';
const NEIGHBOURS = ['222222221', '222222222', '222222223'];

// Mutable clock behind the mocked Date.now(), so ingest timestamps are exact.
let now = T0;

const positionReport = (mmsi, lat, lon, speed) => ({
  MessageType: 'PositionReport',
  Message: {
    PositionReport: { UserID: Number(mmsi), Sog: speed, Cog: 90 },
  },
  MetaData: {
    MMSI: mmsi,
    ShipName: `SHIP ${mmsi}`,
    latitude: lat,
    longitude: lon,
    time_utc: '2026-10-26 12:00:00.000000000 +0000 UTC',
  },
});

function start(t) {
  now = T0;
  __resetAisStoreForTests();
  t.mock.method(Date, 'now', () => now);
}

function ingest(at, mmsi, lat, lon, speed) {
  now = at;
  assert.equal(
    ingestAisStreamEnvelope(positionReport(mmsi, lat, lon, speed)),
    true,
  );
}

/** Three reports from DARK at `at`, under way at `speed` kt. */
function darkShipReports(at, speed = 8, lat = 53.4, lon = 6.2) {
  for (let i = 0; i < 3; i++) ingest(at, DARK, lat, lon, speed);
}

/** Neighbours reporting near the dark ship's last position at `at`. */
function neighbourReports(at, mmsis = NEIGHBOURS, lat = 53.41, lon = 6.21) {
  mmsis.forEach((mmsi, i) => ingest(at, mmsi, lat + i * 0.01, lon, 6));
}

test('a vessel under way that goes silent is listed when nearby coverage still reports', (t) => {
  start(t);
  darkShipReports(T0 - 25 * MIN);
  neighbourReports(T0 - 2 * MIN);

  const result = darkVessels({ now: T0, feedLastMessageAt: T0 - MIN });
  assert.equal(result.feedHealthy, true);
  assert.equal(result.count, 1);
  const [hit] = result.vessels;
  assert.equal(hit.mmsi, DARK);
  assert.equal(hit.neighbours, 3);
  assert.equal(hit.silentMs, 25 * MIN);
  assert.equal(
    hit.inference,
    'No AIS for 25 min while under way at 8.0 kt; 3 other vessels nearby still reporting',
  );
  assert.match(result.note, /^Inference only/);
});

test('an anchored vessel that goes silent is not listed', (t) => {
  start(t);
  darkShipReports(T0 - 25 * MIN, 0.5);
  neighbourReports(T0 - 2 * MIN);

  const result = darkVessels({ now: T0, feedLastMessageAt: T0 - MIN });
  assert.equal(result.count, 0);
});

test('a vessel with too few reports is not listed', (t) => {
  start(t);
  ingest(T0 - 25 * MIN, DARK, 53.4, 6.2, 8);
  ingest(T0 - 25 * MIN, DARK, 53.4, 6.2, 8);
  neighbourReports(T0 - 2 * MIN);

  const result = darkVessels({ now: T0, feedLastMessageAt: T0 - MIN });
  assert.equal(result.count, 0);
});

test('a vessel out of coverage is not listed', (t) => {
  start(t);
  darkShipReports(T0 - 25 * MIN);

  const result = darkVessels({ now: T0, feedLastMessageAt: T0 - MIN });
  assert.equal(result.count, 0);
});

test('a vessel with fewer than three neighbours is not listed', (t) => {
  start(t);
  darkShipReports(T0 - 25 * MIN);
  neighbourReports(T0 - 2 * MIN, NEIGHBOURS.slice(0, 2));

  const result = darkVessels({ now: T0, feedLastMessageAt: T0 - MIN });
  assert.equal(result.count, 0);
});

test('an outage reports nothing, whether the feed is stale or never seen', (t) => {
  start(t);
  darkShipReports(T0 - 25 * MIN);
  neighbourReports(T0 - 2 * MIN);

  const stale = darkVessels({ now: T0, feedLastMessageAt: T0 - 6 * MIN });
  assert.equal(stale.feedHealthy, false);
  assert.deepEqual(stale.vessels, []);
  assert.equal(stale.count, 0);

  const never = darkVessels({ now: T0, feedLastMessageAt: null });
  assert.equal(never.feedHealthy, false);
  assert.deepEqual(never.vessels, []);
});

test('neighbours on either side of the antimeridian count as adjacent', (t) => {
  start(t);
  darkShipReports(T0 - 25 * MIN, 8, 0.5, 179.9);
  neighbourReports(T0 - 2 * MIN, NEIGHBOURS, 0.5, -179.9);

  const result = darkVessels({ now: T0, feedLastMessageAt: T0 - MIN });
  assert.equal(result.vessels[0]?.mmsi, DARK);
  assert.equal(result.vessels[0]?.neighbours, 3);
});

test('a pruned dark vessel is remembered and still listed after 40 minutes', (t) => {
  start(t);
  darkShipReports(T0);
  // The neighbour report 35 min later prunes DARK out of the live cache.
  neighbourReports(T0 + 35 * MIN);
  assert.equal(__aisDarkMemorySizeForTests(), 1);

  const result = darkVessels({
    now: T0 + 40 * MIN,
    feedLastMessageAt: T0 + 39 * MIN,
  });
  const [hit] = result.vessels;
  assert.equal(hit?.mmsi, DARK);
  assert.equal(hit.silentMs, 40 * MIN);
  assert.equal(hit.lastSeenMs, T0);
});

test('a dark vessel that reports again leaves dark memory', (t) => {
  start(t);
  darkShipReports(T0 - 40 * MIN);
  neighbourReports(T0 - 5 * MIN);
  assert.equal(__aisDarkMemorySizeForTests(), 1);

  ingest(T0 - MIN, DARK, 53.5, 6.3, 8);
  assert.equal(__aisDarkMemorySizeForTests(), 0);
  const result = darkVessels({ now: T0, feedLastMessageAt: T0 - MIN });
  assert.equal(result.count, 0);
});

test('dark memory expires after six hours', (t) => {
  start(t);
  darkShipReports(T0);
  neighbourReports(T0 + 35 * MIN);
  assert.equal(__aisDarkMemorySizeForTests(), 1);

  // Any later report triggers the prune that drops entries past the TTL.
  const later = T0 + 6 * 3_600_000 + MIN;
  ingest(later, NEIGHBOURS[0], 10, 120, 6);
  assert.equal(__aisDarkMemorySizeForTests(), 0);
  const result = darkVessels({
    now: later,
    feedLastMessageAt: later,
  });
  assert.equal(result.count, 0);
});
