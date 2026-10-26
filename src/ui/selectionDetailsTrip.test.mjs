import test from 'node:test';
import assert from 'node:assert/strict';
import { buildSelectionDetails } from './selectionDetailsModel.js';

const NOW = Date.UTC(2026, 9, 26, 14, 30);

function flight(properties = {}) {
  return {
    id: '4b1234',
    layerId: 'flights',
    source: 'OpenSky',
    label: 'THY5040',
    latitude: 30.9,
    longitude: 31.24,
    properties: {
      name: 'THY5040',
      operator: 'Turkish Airlines',
      callsign: 'THY5040',
      type: 'Airbus A321',
      altitude: '35,000 ft',
      icao24: '4b1234',
      status: 'live',
      ...properties,
    },
  };
}

function rowValue(details, label) {
  return details.rows.find((row) => row.label === label)?.value;
}

test('a pending route lookup reads Looking up', () => {
  const details = buildSelectionDetails(flight({ routeStatus: 'pending' }), { now: NOW });
  assert.equal(rowValue(details, 'Route'), 'Looking up…');
  assert.equal(rowValue(details, 'From'), undefined);
});

test('an unknown route names the callsign it could not find', () => {
  const details = buildSelectionDetails(flight({ routeStatus: 'unknown' }), { now: NOW });
  assert.equal(rowValue(details, 'Route'), 'Not published for THY5040');
});

test('an unknown route with no callsign falls back to the hex', () => {
  const details = buildSelectionDetails(flight({ callsign: '', routeStatus: 'unknown' }), { now: NOW });
  assert.equal(rowValue(details, 'Route'), 'Not published for 4B1234');
});

test('a known route shows From and To, not the status', () => {
  const details = buildSelectionDetails(
    flight({ routeStatus: 'known', routeFrom: 'Istanbul (IST)', routeTo: 'Cairo (CAI)' }),
    { now: NOW },
  );
  assert.equal(rowValue(details, 'From'), 'Istanbul (IST)');
  assert.equal(rowValue(details, 'To'), 'Cairo (CAI)');
  assert.equal(rowValue(details, 'Route'), undefined);
});

test('trip facts appear when the trace has loaded', () => {
  const details = buildSelectionDetails(
    flight({
      airborneSince: '12:41 UTC (1 h 32 m)',
      holding: 'Circled 2× near Cairo (CAI), 14:05–14:22 UTC',
    }),
    { now: NOW },
  );
  assert.equal(rowValue(details, 'Airborne since'), '12:41 UTC (1 h 32 m)');
  assert.equal(rowValue(details, 'Holding'), 'Circled 2× near Cairo (CAI), 14:05–14:22 UTC');
});

test('trip rows stay absent while no trace is known', () => {
  const details = buildSelectionDetails(flight(), { now: NOW });
  assert.equal(rowValue(details, 'Airborne since'), undefined);
  assert.equal(rowValue(details, 'Holding'), undefined);
});
