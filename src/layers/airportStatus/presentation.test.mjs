import test from 'node:test';
import assert from 'node:assert/strict';
import {
  affectedAirports,
  airportContextProperties,
  airportRowList,
  candidateAirportCodes,
  statusCounts,
} from './presentation.js';

const airport = (overrides) => ({
  icao: 'OERK',
  iata: 'RUH',
  name: 'King Khalid International Airport',
  city: 'Riyadh',
  lat: 24.9576,
  lon: 46.6988,
  lastPolledAt: 1,
  aircraftNearby: 10,
  holdingReliable: true,
  holding: 0,
  holdingCallsigns: [],
  degradedGps: 0,
  judged: 0,
  degradedShare: null,
  level: 'normal',
  reasons: [],
  ...overrides,
});

test('affected airports list disrupted first, then by holding and GPS share', () => {
  const list = affectedAirports([
    airport({ icao: 'AAAA', name: 'Alpha', level: 'watch', holding: 1 }),
    airport({ icao: 'BBBB', name: 'Beta', level: 'disrupted', holding: 3 }),
    airport({ icao: 'CCCC', name: 'Gamma', level: 'disrupted', holding: 5 }),
    airport({ icao: 'DDDD', name: 'Delta', level: 'normal' }),
    airport({ icao: 'EEEE', name: 'Epsilon', level: 'unknown' }),
  ]);
  assert.deepEqual(
    list.map((a) => a.icao),
    ['CCCC', 'BBBB', 'AAAA'],
  );
});

test('counts cover every level and ignore unknown labels', () => {
  assert.deepEqual(
    statusCounts([
      airport({ level: 'disrupted' }),
      airport({ level: 'watch' }),
      airport({ level: 'watch' }),
      airport({ level: 'bogus' }),
    ]),
    { disrupted: 1, watch: 2, normal: 0, unknown: 0 },
  );
});

test('row items fly to the airport, with the reasons after the name', () => {
  const [item] = airportRowList([
    airport({
      level: 'disrupted',
      iata: 'RUH',
      holding: 4,
      reasons: ['4 aircraft holding', '31% report degraded GPS'],
    }),
    airport({
      icao: 'OKKK',
      iata: '',
      name: 'Kuwait',
      level: 'watch',
      reasons: ['1 aircraft holding'],
    }),
  ]);
  assert.equal(item.id, 'airport-status:OERK');
  assert.equal(item.lead, 'DISRUPTED');
  assert.equal(
    item.text,
    'King Khalid International Airport (RUH) · 4 aircraft holding, 31% report degraded GPS',
  );
  assert.deepEqual(item.params, { focusAirport: 'OERK' });
});

test('an unassessed holding reads as not assessed in the context', () => {
  const props = airportContextProperties(
    airport({ level: 'normal', holdingReliable: false, holding: null }),
  );
  assert.equal(
    props.holding,
    'Not assessed — view the airport to sample it every minute',
  );
  assert.equal(props.holdingCallsigns, props.holding);
});

test('context properties are flat strings and numbers, with no data spelled out', () => {
  const props = airportContextProperties(
    airport({
      level: 'watch',
      holding: 1,
      holdingCallsigns: ['SVA12', 'THY7'],
      degradedShare: 0.125,
      judged: 8,
      reasons: ['1 aircraft holding', '13% report degraded GPS'],
    }),
  );
  assert.deepEqual(props, {
    status: 'watch (inferred)',
    holding: 1,
    holdingCallsigns: 'SVA12, THY7',
    degradedGpsShare: '13% of 8 judged',
    reasons: '1 aircraft holding; 13% report degraded GPS',
  });

  const quiet = airportContextProperties(airport({ level: 'unknown' }));
  assert.equal(quiet.status, 'unknown');
  assert.equal(quiet.degradedGpsShare, 'no data');
  assert.equal(quiet.holdingCallsigns, 'none');
  assert.equal(quiet.reasons, 'none');
});

const LARGE = [
  { icao: 'OERK', lat: 24.9576, lon: 46.6988 },
  { icao: 'OMDB', lat: 25.2532, lon: 55.3657 },
  { icao: 'EGLL', lat: 51.47, lon: -0.4543 },
  { icao: 'KJFK', lat: 40.6413, lon: -73.7781 },
  { icao: 'NOPE', lat: Number.NaN, lon: 1 },
];

test('viewed candidates are inside the view rectangle, nearest the centre first', () => {
  const codes = candidateAirportCodes(LARGE, {
    rect: { west: 44, south: 20, east: 60, north: 35 },
  });
  assert.deepEqual(codes.sort(), ['OERK', 'OMDB']);
});

test('a view across the antimeridian keeps airports on both sides', () => {
  const codes = candidateAirportCodes(
    [
      { icao: 'PHNL', lat: 21.3, lon: -157.9 },
      { icao: 'RJTT', lat: 35.5, lon: 139.8 },
      { icao: 'EGLL', lat: 51.47, lon: -0.45 },
    ],
    { rect: { west: 130, south: 20, east: -150, north: 40 } },
  );
  assert.deepEqual(codes.sort(), ['PHNL', 'RJTT']);
});

test('without a rectangle, the nearest airports to the camera ground point are used', () => {
  const codes = candidateAirportCodes(LARGE, {
    centre: { lat: 51, lon: 0 },
    limit: 2,
  });
  assert.deepEqual(codes, ['EGLL', 'OERK']);
});

test('no view means no candidates, and the limit is 8', () => {
  assert.deepEqual(candidateAirportCodes(LARGE, {}), []);
  const many = Array.from({ length: 20 }, (_, i) => ({
    icao: `Z${String(i).padStart(3, '0')}`,
    lat: 10,
    lon: 10 + i * 0.01,
  }));
  assert.equal(
    candidateAirportCodes(many, { centre: { lat: 10, lon: 10 } }).length,
    8,
  );
});
