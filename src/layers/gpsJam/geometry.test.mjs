import test from 'node:test';
import assert from 'node:assert/strict';
import {
  GPS_JAM_STYLE,
  cellCentre,
  cellId,
  cellLabel,
  cellOutlineDegrees,
  cellProperties,
  cellRectangle,
  degradedShareText,
  drawnCells,
  nearestPlaceName,
  summarizeCells,
  topCells,
} from './geometry.js';

const cell = (lat, lon, level, ratio, aircraft = 20) => ({
  lat,
  lon,
  cellDeg: 1,
  aircraft,
  degraded: Math.round(ratio * aircraft),
  ratio,
  level,
});

test('only medium and high cells are drawn; low cells stay out of the scene', () => {
  const cells = [
    cell(10, 20, 'low', 0.01),
    cell(11, 20, 'medium', 0.05),
    cell(12, 20, 'high', 0.2),
  ];
  assert.deepEqual(
    drawnCells(cells).map((item) => item.level),
    ['medium', 'high'],
  );
  assert.equal(drawnCells(undefined).length, 0);
});

test('the two drawn levels carry the specified fill and outline colours', () => {
  assert.equal(GPS_JAM_STYLE.medium.fill, 'rgba(251,191,36,0.35)');
  assert.equal(GPS_JAM_STYLE.medium.outline, 'rgba(251,191,36,0.8)');
  assert.equal(GPS_JAM_STYLE.high.fill, 'rgba(248,113,113,0.45)');
  assert.equal(GPS_JAM_STYLE.high.outline, 'rgba(248,113,113,0.8)');
  assert.equal(GPS_JAM_STYLE.medium.label, 'Some interference (2–10%)');
  assert.equal(GPS_JAM_STYLE.high.label, 'Strong interference (>10%)');
});

test('a cell covers its south-west corner plus one cell width in each direction', () => {
  const sample = cell(51, -1, 'high', 0.2);
  assert.deepEqual(cellRectangle(sample), {
    west: -1,
    south: 51,
    east: 0,
    north: 52,
  });
  assert.deepEqual(cellCentre(sample), { latitude: 51.5, longitude: -0.5 });
  const ring = cellOutlineDegrees(sample);
  assert.equal(ring.length, 10, 'five closed points');
  assert.deepEqual(ring.slice(0, 2), ring.slice(8, 10));
});

test('cell ids are stable and distinct per position and size', () => {
  assert.equal(cellId(cell(51, -1, 'high', 0.2)), 'gps-jam:1:51:-1');
  assert.notEqual(
    cellId(cell(51, -1, 'high', 0.2)),
    cellId(cell(52, -1, 'high', 0.2)),
  );
});

test('top cells are ordered by ratio, drawn only, and limited', () => {
  const cells = [
    cell(1, 1, 'medium', 0.03),
    cell(2, 1, 'low', 0.9),
    cell(3, 1, 'high', 0.25),
    cell(4, 1, 'high', 0.5),
    cell(5, 1, 'medium', 0.02),
  ];
  assert.deepEqual(
    topCells(cells).map((item) => item.lat),
    [4, 3, 1, 5],
  );
  assert.equal(topCells(cells, 2).length, 2);
});

test('the degraded-share wording matches the details panel contract', () => {
  assert.equal(
    degradedShareText(cell(1, 1, 'high', 0.14, 52)),
    '14% of 52 aircraft',
  );
  assert.equal(cellLabel(cell(1, 1, 'high', 0.14)), 'GPS interference high');
  assert.deepEqual(
    cellProperties(cell(1, 1, 'high', 0.14, 52), {
      windowHours: 6,
      method: 'M',
      note: 'N',
    }),
    {
      degradedShare: '14% of 52 aircraft',
      level: 'high',
      window: '6 h',
      cell: '1° × 1°',
      method: 'M',
      note: 'N',
    },
  );
});

test('summaries count drawn levels, low cells and every sighting', () => {
  const summary = summarizeCells([
    cell(1, 1, 'low', 0, 10),
    cell(2, 1, 'medium', 0.05, 20),
    cell(3, 1, 'high', 0.2, 30),
  ]);
  assert.deepEqual(summary, {
    medium: 1,
    high: 1,
    low: 1,
    affected: 2,
    aircraft: 60,
  });
});

test('a cell is named for the nearby sampled region, or by coordinates when none is near', () => {
  const regions = [{ name: 'Baltic', lat: 57, lon: 21 }];
  assert.equal(nearestPlaceName(cell(56, 20, 'high', 0.2), regions), 'Baltic');
  assert.equal(
    nearestPlaceName(cell(-30, 150, 'high', 0.2), regions),
    '-29.5°, 150.5°',
  );
  assert.equal(nearestPlaceName(cell(56, 20, 'high', 0.2), []), '56.5°, 20.5°');
});
