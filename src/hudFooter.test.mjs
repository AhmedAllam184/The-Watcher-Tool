import { test } from 'node:test';
import assert from 'node:assert/strict';
import { formatFooterAltitude, formatFooterPosition } from './hudFooterFormat.js';

test('the footer camera line reads decimal position, MGRS and altitude', () => {
  assert.equal(
    formatFooterPosition({ latDeg: 26.8, lonDeg: 30.8, mgrs: '36R TQ 8130 6617', altMslM: 2200000 }),
    '26.8000° N, 30.8000° E · MGRS 36R TQ 8130 6617 · Alt 2,200 km',
  );
});

test('southern and western hemispheres carry S and W, not a minus sign', () => {
  assert.equal(
    formatFooterPosition({ latDeg: -33.8688, lonDeg: -151.2093, mgrs: '56H LH 3459 5108', altMslM: 850 }),
    '33.8688° S, 151.2093° W · MGRS 56H LH 3459 5108 · Alt 850 m',
  );
});

test('altitude stays in metres below 10 km and switches to kilometres above', () => {
  assert.equal(formatFooterAltitude(9999), 'Alt 9,999 m');
  assert.equal(formatFooterAltitude(10000), 'Alt 10 km');
  assert.equal(formatFooterAltitude(-15), 'Alt -15 m');
  assert.equal(formatFooterAltitude(Number.NaN), 'Alt --');
});

test('a missing position shows a placeholder rather than NaN', () => {
  assert.equal(formatFooterPosition({ latDeg: Number.NaN, lonDeg: 1, mgrs: '---', altMslM: 0 }), '--');
});
