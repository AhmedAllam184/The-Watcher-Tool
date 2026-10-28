import test from 'node:test';
import assert from 'node:assert/strict';
import {
  normalizeOpenSkyAircraft,
  normalizeReadsbAircraft,
} from './aircraft.js';
import { normalizeAdsbLolAircraftState } from '../../data/adsbLolFallback.js';

const READSB_HERON = {
  hex: '738BE8',
  lat: 32.1,
  lon: 34.8,
  t: 'HRON',
  desc: 'IAI Heron Drone',
  ownOp: 'Israeli Air Force',
  year: '2014',
  category: 'B6',
  dbFlags: 1,
  r: '4X-HRN',
  alt_baro: 20000,
  gs: 120,
};

test('a readsb row carries its description, operator, build year, emitter category and military flag', () => {
  const record = normalizeReadsbAircraft(READSB_HERON, 1_000_000);
  assert.equal(record.typeCode, 'HRON');
  assert.equal(record.typeDescription, 'IAI Heron Drone');
  assert.equal(record.operator, 'Israeli Air Force');
  assert.equal(record.buildYear, 2014);
  assert.equal(record.emitterCategory, 'B6');
  assert.equal(record.dbMilitary, true);
});

test('missing or implausible identity fields are null, and a civil row is not military', () => {
  const record = normalizeReadsbAircraft({ hex: 'abc123', lat: 1, lon: 2, year: '1', category: 'Z9', dbFlags: 0 }, 1_000_000);
  assert.equal(record.typeDescription, null);
  assert.equal(record.buildYear, null);
  assert.equal(record.emitterCategory, null);
  assert.equal(record.dbMilitary, false);
});

test('an OpenSky-shaped row carries the adsb.lol identity from its trailing element', () => {
  const state = normalizeAdsbLolAircraftState(READSB_HERON, 1_000_000);
  assert.equal(state.length, 19);
  const record = normalizeOpenSkyAircraft(state);
  assert.equal(record.typeCode, 'HRON');
  assert.equal(record.typeDescription, 'IAI Heron Drone');
  assert.equal(record.operator, 'Israeli Air Force');
  assert.equal(record.buildYear, 2014);
  assert.equal(record.dbMilitary, true);
  assert.equal(record.emitterCategory, 'B6');
});

test('a plain OpenSky row with no trailing element keeps the old null identity', () => {
  const row = [
    'abc123', 'BAW117', 'United Kingdom', 1000, 1000, -0.4, 51.4, 10000, false, 200, 90, 0, null, 10100, null, false, 0, 3,
  ];
  const record = normalizeOpenSkyAircraft(row);
  assert.equal(record.typeCode, null);
  assert.equal(record.typeDescription, null);
  assert.equal(record.buildYear, null);
  assert.equal(record.operator, null);
  assert.equal(record.dbMilitary, false);
  assert.equal(record.emitterCategory, 'A2');
});

test('an adsb.lol record with no identity fields keeps the 18-element OpenSky shape', () => {
  const state = normalizeAdsbLolAircraftState({ hex: 'abc123', lat: 1, lon: 2, flight: 'BAW117' }, 1000);
  assert.equal(state.length, 18);
});
