import test from 'node:test';
import assert from 'node:assert/strict';
import { formatAirportLabel } from './airportLabels.js';

test('airport labels drop the generic suffix and append the IATA or ICAO code', () => {
  assert.equal(
    formatAirportLabel({
      name: 'London Heathrow Airport',
      iata: 'LHR',
      icao: 'EGLL',
    }),
    'London Heathrow (LHR)',
  );
  assert.equal(
    formatAirportLabel({
      name: 'Burton-Nibbs International Airport',
      iata: '',
      icao: 'TAPB',
    }),
    'Burton-Nibbs (TAPB)',
  );
  assert.equal(
    formatAirportLabel({
      name: 'Aleknagik / New Airport',
      iata: null,
      icao: '5A8',
    }),
    'Aleknagik / New (5A8)',
  );
  assert.equal(
    formatAirportLabel({ name: 'Honolulu Airport', iata: 'undefined' }),
    'Honolulu',
  );
  assert.equal(formatAirportLabel({ name: 'Airport' }), 'Airport');
  assert.equal(formatAirportLabel({ name: '  ', iata: 'XYZ' }), 'XYZ');
  assert.equal(formatAirportLabel(undefined), '');
});
