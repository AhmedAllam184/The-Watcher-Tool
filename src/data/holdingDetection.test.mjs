// src/data/holdingDetection.test.mjs
import test from 'node:test';
import assert from 'node:assert/strict';
import { detectHolding } from './holdingDetection.js';
import {
  formatAirborneSince,
  formatElapsed,
  formatHoldingSummary,
  tripSummary,
} from './tripSummary.js';

const LAT0 = 30.0;
const LON0 = 31.0;
const KM_PER_DEG_LAT = 111.2;

/** Offset a point by east/north kilometres. */
function offset(lat, lon, eastKm, northKm) {
  return {
    lat: lat + northKm / KM_PER_DEG_LAT,
    lon: lon + eastKm / (KM_PER_DEG_LAT * Math.cos(lat * Math.PI / 180)),
  };
}

/** Fixes around a circle: `loops` full circuits, `perLoop` fixes each, one fix every dtMs. */
function circle({ loops = 2, perLoop = 60, radiusKm = 8, dtMs = 8000, clockwise = true, startT = 0, lat = LAT0, lon = LON0 } = {}) {
  const out = [];
  const n = loops * perLoop;
  for (let i = 0; i <= n; i++) {
    const theta = (2 * Math.PI * i) / perLoop * (clockwise ? 1 : -1);
    const p = offset(lat, lon, radiusKm * Math.sin(theta), radiusKm * Math.cos(theta));
    out.push({ t: startT + i * dtMs, lat: p.lat, lon: p.lon });
  }
  return out;
}

/** Fixes flown along successive headings (degrees from north), each leg `stepKm` long. */
function legs(headings, { stepKm = 1.5, dtMs = 30_000, lat = LAT0, lon = LON0 } = {}) {
  const out = [{ t: 0, lat, lon }];
  let cur = { lat, lon };
  headings.forEach((hdg, i) => {
    const rad = (hdg * Math.PI) / 180;
    cur = offset(cur.lat, cur.lon, stepKm * Math.sin(rad), stepKm * Math.cos(rad));
    out.push({ t: (i + 1) * dtMs, lat: cur.lat, lon: cur.lon });
  });
  return out;
}

test('two full circuits in 16 minutes are one episode of two turns', () => {
  const episodes = detectHolding(circle({ loops: 2 }));
  assert.equal(episodes.length, 1);
  assert.equal(episodes[0].turns, 2);
  assert.ok(episodes[0].startT <= 16_000 && episodes[0].startT < episodes[0].endT);
  assert.ok(Math.abs(episodes[0].centerLat - LAT0) < 0.01);
  assert.ok(Math.abs(episodes[0].centerLon - LON0) < 0.01);
});

test('a counter-clockwise hold is detected the same way', () => {
  const episodes = detectHolding(circle({ loops: 1, clockwise: false }));
  assert.equal(episodes.length, 1);
  assert.equal(episodes[0].turns, 1);
});

test('a single circuit still counts as one turn', () => {
  const episodes = detectHolding(circle({ loops: 1, perLoop: 24 }));
  assert.equal(episodes.length, 1);
  assert.equal(episodes[0].turns, 1);
});

test('straight flight has no holding', () => {
  const line = legs(Array(60).fill(0), { stepKm: 2 });
  assert.deepEqual(detectHolding(line), []);
});

test('a gentle course change that is not a circuit is not holding', () => {
  // A 90-degree turn and then straight flight.
  assert.deepEqual(detectHolding(legs([0, 0, 0, 90, 90, 90, 90])), []);
});

test('an S-turn (right then left) nets to zero and is not holding', () => {
  const headings = [...Array(5).fill(0), ...Array(5).fill(90), ...Array(5).fill(0), ...Array(5).fill(270)];
  assert.deepEqual(detectHolding(legs(headings)), []);
});

test('repeated zig-zags never accumulate a circuit', () => {
  const headings = Array.from({ length: 80 }, (_, i) => (i % 2 ? 60 : 0));
  assert.deepEqual(detectHolding(legs(headings)), []);
});

test('a circuit slower than the 25-minute window is not holding', () => {
  // One circuit every 30 minutes: 300 degrees inside any 25-minute window.
  const slow = circle({ loops: 1, perLoop: 60, dtMs: 30_000 });
  assert.deepEqual(detectHolding(slow), []);
});

test('fixes closer than 300 m together add no turning', () => {
  const jitter = [];
  for (let i = 0; i < 200; i++) {
    const p = offset(LAT0, LON0, (i % 7) * 0.02, (i % 5) * 0.02);
    jitter.push({ t: i * 10_000, lat: p.lat, lon: p.lon });
  }
  assert.deepEqual(detectHolding(jitter), []);
});

test('an episode is named after a route airport within 80 km of its centre', () => {
  const airports = [
    { code: 'CAI', name: 'Cairo', lat: LAT0 + 3 / KM_PER_DEG_LAT, lon: LON0 },
    { code: 'LXR', name: 'Luxor', lat: LAT0 + 400 / KM_PER_DEG_LAT, lon: LON0 },
  ];
  const [episode] = detectHolding(circle({ loops: 2 }), { airports });
  assert.equal(episode.nearestAirport.code, 'CAI');
  assert.equal(episode.nearestAirport.name, 'Cairo');
  assert.ok(episode.nearestAirport.distanceKm < 5);
});

test('no airport is named when none is within 80 km', () => {
  const far = [{ code: 'LXR', name: 'Luxor', lat: LAT0 + 2, lon: LON0 }];
  const [episode] = detectHolding(circle({ loops: 2 }), { airports: far });
  assert.equal(episode.nearestAirport, undefined);
});

test('two separate holds are reported as two episodes in time order', () => {
  const first = circle({ loops: 1, startT: 0 });
  const second = circle({ loops: 1, startT: 60 * 60_000, lat: LAT0 + 0.5 });
  const episodes = detectHolding([...first, ...second]);
  assert.equal(episodes.length, 2);
  assert.ok(episodes[0].startT < episodes[1].startT);
});

test('unusable points are ignored and short inputs are safe', () => {
  assert.deepEqual(detectHolding([]), []);
  assert.deepEqual(detectHolding(null), []);
  assert.deepEqual(detectHolding([{ t: 0, lat: null, lon: 3 }, { t: 1, lat: 1, lon: 2 }]), []);
});

test('formatElapsed and the airborne line read like the panel shows them', () => {
  assert.equal(formatElapsed(92 * 60_000), '1 h 32 m');
  assert.equal(formatElapsed(45 * 60_000), '45 m');
  const start = Date.UTC(2026, 9, 26, 12, 41);
  assert.equal(formatAirborneSince(start, start + 92 * 60_000), '12:41 UTC (1 h 32 m)');
  assert.equal(formatAirborneSince(null, start), '');
});

test('holding summary names the airport and the window, or says none', () => {
  const t0 = Date.UTC(2026, 9, 26, 14, 5);
  const text = formatHoldingSummary([
    { startT: t0, endT: t0 + 17 * 60_000, turns: 2, nearestAirport: { code: 'CAI', name: 'Cairo', distanceKm: 4 } },
  ]);
  assert.equal(text, 'Circled 2× near Cairo (CAI), 14:05–14:22 UTC');
  assert.equal(formatHoldingSummary([]), 'None detected on this flight');
});

test('tripSummary reports no holding for a track too short to judge', () => {
  const summary = tripSummary({ points: [{ t: 0, lat: 1, lon: 1 }], startedAt: 0, nowMs: 60_000 });
  assert.equal(summary.holding, '');
  assert.equal(summary.airborneSince.length > 0, true);
});

test('tripSummary runs detection on the current flight', () => {
  const points = circle({ loops: 2 });
  const summary = tripSummary({ points, startedAt: 0, airports: [], nowMs: 60 * 60_000 });
  assert.equal(summary.holding.startsWith('Circled 2×'), true);
});
