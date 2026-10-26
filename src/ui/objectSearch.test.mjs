import assert from 'node:assert/strict';
import test from 'node:test';
import {
  findLiveObject,
  objectLabel,
  searchableDisabledLayers,
} from './objectSearch.js';

/** Fake data manager: `modules` maps layer id to its module; `enabled` lists live layers. */
function dataManager(modules, enabled = Object.keys(modules)) {
  return {
    isEnabled: (layerId) => enabled.includes(layerId),
    layers: new Map(
      Object.entries(modules).map(([layerId, module]) => [layerId, { module }]),
    ),
  };
}

function searchModule(match, calls = []) {
  return {
    findByQuery(query) {
      calls.push(query);
      return match;
    },
  };
}

test('finds an enabled flight by callsign with trimmed query', () => {
  const calls = [];
  const found = { icao24: 'a1b2c3', callsign: 'UAL123' };
  const result = findLiveObject(
    dataManager({ flights: searchModule(found, calls) }),
    '  ual123 ',
  );
  assert.deepEqual(result, { layerId: 'flights', kind: 'aircraft', found });
  assert.deepEqual(calls, ['ual123']);
});

test('finds a vessel by name when no flight layer matches', () => {
  const found = {
    mmsi: 353136000,
    name: 'EVER GIVEN',
    latitude: 30,
    longitude: 32,
  };
  const result = findLiveObject(
    dataManager({
      flights: searchModule(null),
      military: searchModule(null),
      'ais-live-vessels': searchModule(found),
    }),
    'ever  given',
  );
  assert.deepEqual(result, {
    layerId: 'ais-live-vessels',
    kind: 'vessel',
    found,
  });
});

test('a partial name falls through to place search unless prefixed', () => {
  const found = {
    mmsi: 431000001,
    name: 'TOKYO EXPRESS',
    latitude: 35,
    longitude: 139,
  };
  const data = dataManager({ 'ais-live-vessels': searchModule(found) });
  assert.equal(findLiveObject(data, 'Tokyo'), null);
  assert.deepEqual(findLiveObject(data, 'ship: Tokyo'), {
    layerId: 'ais-live-vessels',
    kind: 'vessel',
    found,
  });
  assert.equal(findLiveObject(data, 'flight: Tokyo'), null);
});

test('search order puts flights before military when both match', () => {
  const flight = { icao24: 'abc123', callsign: 'DLH1' };
  const result = findLiveObject(
    dataManager({
      flights: searchModule(flight),
      military: searchModule({ icao24: 'ae0001', callsign: 'DLH1' }),
    }),
    'DLH1',
  );
  assert.equal(result.layerId, 'flights');
  assert.equal(result.found, flight);
});

test('skips a disabled layer even when its module would match', () => {
  const calls = [];
  const result = findLiveObject(
    dataManager(
      {
        flights: searchModule({ icao24: 'abc123' }, calls),
        satellites: searchModule(null),
      },
      ['satellites'],
    ),
    'abc123',
  );
  assert.equal(result, null);
  assert.deepEqual(calls, []);
});

test('skips an enabled layer whose module has no findByQuery', () => {
  const found = { noradId: 25544, name: 'ISS (ZARYA)' };
  const result = findLiveObject(
    dataManager({
      flights: {},
      satellites: searchModule(found),
    }),
    'sat: iss',
  );
  assert.deepEqual(result, { layerId: 'satellites', kind: 'satellite', found });
});

test('queries shorter than two characters are ignored', () => {
  const calls = [];
  const data = dataManager({ flights: searchModule({ icao24: 'a' }, calls) });
  assert.equal(findLiveObject(data, 'a'), null);
  assert.equal(findLiveObject(data, '   '), null);
  assert.equal(findLiveObject(data, ''), null);
  assert.equal(findLiveObject(data, undefined), null);
  assert.deepEqual(calls, []);
});

test('returns null when nothing matches', () => {
  assert.equal(
    findLiveObject(dataManager({ flights: searchModule(null) }), 'zzz999'),
    null,
  );
  assert.equal(findLiveObject(null, 'ual123'), null);
});

test('lists the searchable layers that are currently disabled, in search order', () => {
  const data = dataManager(
    { flights: {}, military: {}, 'ais-live-vessels': {}, satellites: {} },
    ['military', 'satellites'],
  );
  assert.deepEqual(searchableDisabledLayers(data), [
    'flights',
    'ais-live-vessels',
  ]);
  assert.deepEqual(searchableDisabledLayers(null), []);
});

test('objectLabel prefers callsign, then registration, name and identifiers', () => {
  assert.equal(
    objectLabel({ callsign: ' UAL123 ', registration: 'N1' }),
    'UAL123',
  );
  assert.equal(
    objectLabel({ callsign: '  ', registration: 'N123AB' }),
    'N123AB',
  );
  assert.equal(
    objectLabel({ name: 'EVER GIVEN', mmsi: 353136000 }),
    'EVER GIVEN',
  );
  assert.equal(objectLabel({ icao24: 'ae1fa4' }), 'ae1fa4');
  assert.equal(objectLabel({ mmsi: 353136000 }), '353136000');
  assert.equal(objectLabel({ noradId: 25544 }), '25544');
  assert.equal(objectLabel(null), '');
});
