import test from 'node:test';
import assert from 'node:assert/strict';
import {
  GPS_JAM_BUCKET_MS,
  createGpsJamGrid,
  gpsJamLevel,
  isDegraded,
} from './gpsJam.js';

const HOUR = 3_600_000;
const T0 = 1_000 * GPS_JAM_BUCKET_MS; // aligned to a bucket start

/** Airborne aircraft at a point with a given NIC (or none). */
function ac(hex, { nic, nacP, lat = 50.2, lon = 10.3, ...rest } = {}) {
  const row = { hex, lat, lon, alt_baro: 35000, ...rest };
  if (nic !== undefined) row.nic = nic;
  if (nacP !== undefined) row.nac_p = nacP;
  return row;
}

/** `total` aircraft in one cell, the first `bad` of them degraded. */
function fleet(prefix, total, bad, opts = {}) {
  return Array.from({ length: total }, (_, n) =>
    ac(`${prefix}${n}`, { nic: n < bad ? 3 : 9, ...opts }),
  );
}

test('isDegraded uses NIC below 7 when present', () => {
  assert.equal(isDegraded(ac('a', { nic: 6 })), true);
  assert.equal(isDegraded(ac('a', { nic: 7 })), false);
  assert.equal(isDegraded(ac('a', { nic: 0 })), true);
});

test('isDegraded falls back to NACp below 8 only when NIC is absent', () => {
  assert.equal(isDegraded(ac('a', { nacP: 7 })), true);
  assert.equal(isDegraded(ac('a', { nacP: 8 })), false);
  // NIC wins when both are present, even if NACp says otherwise.
  assert.equal(isDegraded(ac('a', { nic: 9, nacP: 2 })), false);
  assert.equal(isDegraded(ac('a', { nic: 5, nacP: 11 })), true);
});

test('isDegraded returns null when no usable classification exists', () => {
  assert.equal(isDegraded(ac('a')), null);
  assert.equal(isDegraded(ac('a', { nic: 12 })), null);
  assert.equal(isDegraded(ac('a', { nic: 'low' })), null);
  assert.equal(isDegraded(null), null);
});

test('isDegraded returns null on the ground, without a position, or with a stale position', () => {
  assert.equal(isDegraded(ac('a', { nic: 2, alt_baro: 'ground' })), null);
  assert.equal(isDegraded({ hex: 'a', nic: 2, alt_baro: 1000 }), null);
  assert.equal(isDegraded({ hex: 'a', nic: 2, alt_baro: 1000, lon: 10 }), null);
  assert.equal(isDegraded(ac('a', { nic: 2, seen_pos: 61 })), null);
  assert.equal(isDegraded(ac('a', { nic: 2, seen_pos: 60 })), true);
});

test('each hex counts once per cell per bucket, first sighting decides', () => {
  const grid = createGpsJamGrid();
  grid.addSamples([ac('a', { nic: 3 }), ac('a', { nic: 3 })], T0);
  grid.addSamples([ac('a', { nic: 9 })], T0 + 60_000);
  assert.deepEqual(
    grid
      .cells({ nowMs: T0, minAircraft: 1 })
      .map((c) => [c.aircraft, c.degraded]),
    [[1, 1]],
  );
});

test('unjudgeable rows are skipped and do not dilute the ratio', () => {
  const grid = createGpsJamGrid();
  const rows = [
    ...fleet('p', 5, 1),
    ac('ground', { nic: 2, alt_baro: 'ground' }),
    { hex: 'nolevel', lat: 50.1, lon: 10.1, alt_baro: 1000 },
    { lat: 50.1, lon: 10.1, nic: 1 },
  ];
  grid.addSamples(rows, T0);
  const [cell] = grid.cells({ nowMs: T0 });
  assert.equal(cell.aircraft, 5);
  assert.equal(cell.degraded, 1);
});

test('buckets expire from the window as a whole', () => {
  const grid = createGpsJamGrid({ windowMs: 6 * HOUR });
  grid.addSamples(fleet('a', 5, 5), T0);
  const edge = T0 + 6 * HOUR;
  // The bucket ends at T0 + 10 min, which is after the cutoff at `edge`.
  assert.equal(grid.cells({ nowMs: edge }).length, 1);
  // One bucket later the bucket ends exactly at the cutoff and drops out.
  assert.equal(grid.cells({ nowMs: edge + GPS_JAM_BUCKET_MS }).length, 0);
});

test('prune drops expired buckets and empty cells from memory', () => {
  const grid = createGpsJamGrid({ windowMs: HOUR });
  grid.addSamples(fleet('a', 5, 0), T0);
  grid.addSamples(fleet('b', 5, 0, { lat: 20.5 }), T0 + 30 * 60_000);
  grid.prune(T0 + 2 * HOUR);
  const json = grid.toJSON();
  assert.equal(json.cells.length, 0);
});

test('window query narrows but never widens the grid window', () => {
  const grid = createGpsJamGrid({ windowMs: 24 * HOUR });
  grid.addSamples(fleet('a', 5, 5), T0);
  const later = T0 + 3 * HOUR;
  assert.equal(grid.cells({ nowMs: later, windowMs: 1 * HOUR }).length, 0);
  assert.equal(grid.cells({ nowMs: later, windowMs: 6 * HOUR }).length, 1);
  assert.equal(grid.cells({ nowMs: later, windowMs: 48 * HOUR }).length, 1);
});

test('levels follow the 2% and 10% thresholds', () => {
  assert.equal(gpsJamLevel(0), 'low');
  assert.equal(gpsJamLevel(0.0199), 'low');
  assert.equal(gpsJamLevel(0.02), 'medium');
  assert.equal(gpsJamLevel(0.1), 'medium');
  assert.equal(gpsJamLevel(0.1001), 'high');

  const cases = [
    [100, 1, 'low'],
    [100, 2, 'medium'],
    [100, 10, 'medium'],
    [100, 11, 'high'],
  ];
  for (const [total, bad, level] of cases) {
    const grid = createGpsJamGrid();
    grid.addSamples(fleet('x', total, bad), T0);
    const [cell] = grid.cells({ nowMs: T0 });
    assert.equal(cell.level, level, `${bad}/${total}`);
  }
});

test('cells need the minimum aircraft count and report exact ratios', () => {
  const grid = createGpsJamGrid();
  grid.addSamples(fleet('a', 4, 4), T0);
  assert.deepEqual(grid.cells({ nowMs: T0 }), []);
  assert.equal(grid.cells({ nowMs: T0, minAircraft: 4 }).length, 1);

  grid.addSamples(fleet('b', 5, 1), T0);
  const cell = grid.cells({ nowMs: T0 }).find((c) => c.aircraft === 9);
  assert.equal(cell.degraded, 5);
  assert.equal(cell.ratio, 0.5556);
  assert.equal(cell.level, 'high');
});

test('cells are keyed by south-west edge with floor indexing', () => {
  const grid = createGpsJamGrid({ cellDeg: 1 });
  grid.addSamples(fleet('a', 5, 0, { lat: 40.5, lon: -90.2 }), T0);
  const [cell] = grid.cells({ nowMs: T0 });
  assert.equal(cell.lat, 40);
  assert.equal(cell.lon, -91);
  assert.equal(cell.cellDeg, 1);
});

test('JSON round-trip reproduces cells and ignores a different cellDeg', () => {
  const grid = createGpsJamGrid();
  grid.addSamples(fleet('a', 6, 2), T0);
  grid.addSamples(fleet('b', 5, 5, { lat: 10.5 }), T0 + GPS_JAM_BUCKET_MS);

  const restored = createGpsJamGrid().fromJSON(
    JSON.parse(JSON.stringify(grid)),
  );
  const now = T0 + GPS_JAM_BUCKET_MS;
  assert.deepEqual(restored.cells({ nowMs: now }), grid.cells({ nowMs: now }));

  const mismatched = createGpsJamGrid({ cellDeg: 0.5 }).fromJSON(grid.toJSON());
  assert.deepEqual(mismatched.cells({ nowMs: now, minAircraft: 1 }), []);
});

test('fromJSON skips malformed entries without throwing', () => {
  const grid = createGpsJamGrid().fromJSON({
    cellDeg: 1,
    cells: [
      null,
      { i: 'x', j: 1, buckets: [] },
      { i: 1, j: 1, buckets: [{ at: 'soon', good: [], bad: [] }] },
      { i: 50, j: 10, buckets: [{ at: T0, good: ['a', 7], bad: ['b'] }] },
    ],
  });
  const [cell] = grid.cells({ nowMs: T0, minAircraft: 1 });
  assert.equal(cell.aircraft, 2);
  assert.equal(cell.degraded, 1);
});
