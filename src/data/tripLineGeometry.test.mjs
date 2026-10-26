// src/data/tripLineGeometry.test.mjs
import test from 'node:test';
import assert from 'node:assert/strict';
import { tripBand, tripSegments, TRIP_BAND_COLORS } from './tripLineGeometry.js';

test('altitude bands follow the trip line colours', () => {
  assert.equal(tripBand(0), 'low');
  assert.equal(tripBand(9_999), 'low');
  assert.equal(tripBand(10_000), 'mid');
  assert.equal(tripBand(25_000), 'mid');
  assert.equal(tripBand(25_001), 'high');
  assert.equal(tripBand(null), null);
  assert.deepEqual(TRIP_BAND_COLORS, { low: '#34d399', mid: '#fbbf24', high: '#60a5fa' });
});

test('runs of one band share their boundary fix', () => {
  const points = [
    { lat: 1, lon: 1, altFt: 2000 },
    { lat: 2, lon: 2, altFt: 5000 },
    { lat: 3, lon: 3, altFt: 15000 },
    { lat: 4, lon: 4, altFt: 30000 },
    { lat: 5, lon: 5, altFt: 31000 },
  ];
  const segments = tripSegments(points);
  assert.deepEqual(segments.map((s) => s.band), ['low', 'mid', 'high']);
  assert.deepEqual(segments[0].coords.map((c) => c.lat), [1, 2, 3]);
  assert.deepEqual(segments[1].coords.map((c) => c.lat), [3, 4]);
  assert.deepEqual(segments[2].coords.map((c) => c.lat), [4, 5]);
});

test('altitudes convert to metres and unknown altitudes keep the previous fix', () => {
  const segments = tripSegments([
    { lat: 1, lon: 1, altFt: 1000 },
    { lat: 2, lon: 2, altFt: null },
  ]);
  assert.equal(segments.length, 1);
  assert.ok(Math.abs(segments[0].coords[0].altM - 304.8) < 1e-9);
  assert.ok(Math.abs(segments[0].coords[1].altM - 304.8) < 1e-9);
  const first = tripSegments([{ lat: 1, lon: 1, altFt: null }]);
  assert.equal(first[0].coords[0].altM, 10_000);
});

test('fixes without a position are skipped', () => {
  assert.deepEqual(tripSegments([{ lat: null, lon: 1, altFt: 100 }]), []);
  assert.deepEqual(tripSegments(null), []);
});
