import test from 'node:test';
import assert from 'node:assert/strict';
import {
  buildSelectionDetails,
  compassPoint,
  flagFromMmsi,
  formatRelativeTime,
} from './selectionDetailsModel.js';

const NOW = Date.UTC(2026, 9, 26, 12, 0, 0);

function rowValue(details, label) {
  return details.rows.find((row) => row.label === label)?.value;
}

function flightRecord(properties = {}, extra = {}) {
  return {
    id: 'abc123',
    layerId: 'flights',
    layerName: 'Live Flights',
    source: 'OpenSky',
    label: 'BAW117',
    latitude: 51.4775,
    longitude: -0.4614,
    properties: {
      name: 'British Airways 117',
      operator: 'British Airways',
      callsign: 'BAW117',
      registration: 'G-EUXA',
      type: 'Airbus A320',
      altitude: '35,000 ft',
      speed: '450 kt',
      heading: '270°',
      route: 'LHR → JFK',
      icao24: 'abc123',
      status: 'live',
      ...properties,
    },
    ...extra,
  };
}

function vesselRecord(entity = {}, properties = {}) {
  return {
    id: 'ais-232000001',
    layerId: 'ais-live-vessels',
    layerName: 'Live AIS Vessels',
    source: 'AIS',
    label: 'EVER GIVEN',
    latitude: 30.0,
    longitude: 32.5,
    properties: {
      mmsi: '232000001',
      type: '71',
      speedKt: 12.3,
      course: 88,
      destination: 'ROTTERDAM',
      ...properties,
    },
    entity: {
      name: 'EVER GIVEN',
      mmsi: '232000001',
      imo: '9811000',
      type: '71',
      destination: 'ROTTERDAM',
      speed: 12.3,
      course: 88,
      heading: 90,
      lastPositionUtc: '2026-10-26 11:58:00',
      lastPositionEpoch: Math.floor((NOW - 2 * 60000) / 1000),
      missedRefreshes: 0,
      ...entity,
    },
  };
}

function fireRecord(properties = {}) {
  return {
    id: 'firms-1',
    layerId: 'firms-fires',
    layerName: 'NASA FIRMS',
    source: 'NASA FIRMS',
    label: 'Fire · FRP 12.4 MW',
    latitude: -12.5,
    longitude: 45.25,
    properties: {
      frp: 12.4,
      confidence: 'high',
      age: '3h',
      sensor: 'VIIRS',
      ...properties,
    },
  };
}

test('compassPoint covers the 16 points and wraps edge bearings', () => {
  assert.equal(compassPoint(0), 'N');
  assert.equal(compassPoint(90), 'E');
  assert.equal(compassPoint(270), 'W');
  assert.equal(compassPoint(359), 'N');
  assert.equal(compassPoint(360), 'N');
  assert.equal(compassPoint(-10), 'N');
  assert.equal(compassPoint(-90), 'W');
  assert.equal(compassPoint(11.25), 'NNE');
  assert.equal(compassPoint(Number.NaN), '');
});

test('formatRelativeTime describes age in plain words', () => {
  assert.equal(formatRelativeTime(NOW - 10_000, NOW), 'just now');
  assert.equal(formatRelativeTime(NOW - 2 * 60_000, NOW), '2 min ago');
  assert.equal(formatRelativeTime(NOW - 5 * 3_600_000, NOW), '5 h ago');
  assert.equal(formatRelativeTime(NOW - 3 * 86_400_000, NOW), '3 d ago');
  assert.equal(formatRelativeTime(Number.NaN, NOW), '');
});

test('flagFromMmsi maps common MIDs and omits unknown ones', () => {
  assert.equal(flagFromMmsi('232000001'), 'United Kingdom');
  assert.equal(flagFromMmsi(338123456), 'United States');
  assert.equal(flagFromMmsi('370000000'), 'Panama');
  assert.equal(flagFromMmsi('999000000'), null);
  assert.equal(flagFromMmsi('12'), null);
  assert.equal(flagFromMmsi(''), null);
});

test('flight details translate units, heading and status', () => {
  const details = buildSelectionDetails(flightRecord(), { now: NOW });
  assert.equal(details.kind, 'flight');
  assert.equal(details.title, 'BAW117');
  assert.equal(details.subtitle, 'British Airways');
  assert.equal(rowValue(details, 'Route'), 'LHR → JFK');
  assert.equal(rowValue(details, 'Aircraft'), 'Airbus A320');
  assert.equal(rowValue(details, 'Registration'), 'G-EUXA');
  assert.equal(rowValue(details, 'Altitude'), '35,000 ft (10,668 m)');
  assert.equal(rowValue(details, 'Speed'), '450 kt (833 km/h)');
  assert.equal(rowValue(details, 'Heading'), '270° (W)');
  assert.equal(rowValue(details, 'ICAO hex'), 'ABC123');
  assert.equal(rowValue(details, 'Status'), 'Live');
  assert.equal(rowValue(details, 'Data source'), 'OpenSky');
  assert.equal(rowValue(details, 'Coordinates'), '51.4775° N, 0.4614° W');
  assert.deepEqual(details.links, [
    { label: 'FlightRadar24', href: 'https://www.flightradar24.com/BAW117' },
    {
      label: 'ADS-B Exchange',
      href: 'https://globe.adsbexchange.com/?icao=abc123',
    },
  ]);
  assert.equal(details.latitude, 51.4775);
  assert.equal(details.longitude, -0.4614);
});

test('flight details handle ground contacts, stale status and military layers', () => {
  const grounded = buildSelectionDetails(
    flightRecord({ altitude: 'on ground', status: 'stale (missed polls)' }),
    { now: NOW },
  );
  assert.equal(rowValue(grounded, 'Altitude'), 'On the ground');
  assert.equal(
    rowValue(grounded, 'Status'),
    'Last known — missed updates',
  );

  const military = buildSelectionDetails(
    flightRecord({ callsign: '', name: 'RCH401' }, { layerId: 'military-flights' }),
    { now: NOW },
  );
  assert.equal(military.kind, 'flight');
  assert.equal(military.title, 'RCH401');
  assert.deepEqual(military.links.map((link) => link.label), ['ADS-B Exchange']);
});

test('flight squawk shows the code, names emergencies and raises an alert', () => {
  const routine = buildSelectionDetails(flightRecord({ squawk: '1200' }), {
    now: NOW,
  });
  assert.equal(rowValue(routine, 'Squawk'), '1200');
  assert.equal(routine.alert, null);

  const emergency = buildSelectionDetails(
    flightRecord({ squawk: '7700' }),
    { now: NOW },
  );
  assert.equal(rowValue(emergency, 'Squawk'), '7700 — General emergency');
  assert.equal(
    emergency.alert,
    'Emergency squawk 7700 — General emergency',
  );

  const military = buildSelectionDetails(
    flightRecord({ squawk: '7600' }, { layerId: 'military-flights' }),
    { now: NOW },
  );
  assert.equal(military.alert, 'Emergency squawk 7600 — Radio failure');

  const unknown = buildSelectionDetails(flightRecord({ squawk: null }), {
    now: NOW,
  });
  assert.equal(rowValue(unknown, 'Squawk'), undefined);
  assert.equal(unknown.alert, null);
});

test('only flight details carry a squawk alert', () => {
  const vessel = buildSelectionDetails(vesselRecord(), { now: NOW });
  assert.equal(vessel.alert, null);
});

test('vessel details give plain type, flag, relative time and speed in km/h', () => {
  const details = buildSelectionDetails(vesselRecord(), { now: NOW });
  assert.equal(details.kind, 'vessel');
  assert.equal(details.title, 'EVER GIVEN');
  assert.equal(details.subtitle, 'Cargo');
  assert.equal(rowValue(details, 'Type'), 'Cargo');
  assert.equal(rowValue(details, 'Destination'), 'ROTTERDAM');
  assert.equal(rowValue(details, 'Speed'), '12.3 kt (23 km/h)');
  assert.equal(rowValue(details, 'Course'), '88° (E)');
  assert.equal(rowValue(details, 'Heading'), '90° (E)');
  assert.equal(rowValue(details, 'MMSI'), '232000001');
  assert.equal(rowValue(details, 'IMO'), '9811000');
  assert.equal(rowValue(details, 'Flag'), 'United Kingdom');
  assert.equal(rowValue(details, 'Last position'), '2 min ago');
  assert.equal(rowValue(details, 'Status'), 'Live');
  assert.deepEqual(details.links, [
    {
      label: 'MarineTraffic',
      href: 'https://www.marinetraffic.com/en/ais/details/ships/mmsi:232000001',
    },
    {
      label: 'VesselFinder',
      href: 'https://www.vesselfinder.com/vessels/details/232000001',
    },
  ]);
});

test('vessel last position accepts epoch milliseconds and flags missed updates', () => {
  const details = buildSelectionDetails(
    vesselRecord({
      lastPositionEpoch: NOW - 30 * 60_000,
      missedRefreshes: 2,
      heading: 511,
    }),
    { now: NOW },
  );
  assert.equal(rowValue(details, 'Last position'), '30 min ago');
  assert.equal(rowValue(details, 'Status'), 'Stale — missed updates');
  assert.equal(rowValue(details, 'Heading'), undefined);
});

test('vessel details omit flag, IMO and links when identity is missing', () => {
  const details = buildSelectionDetails(
    vesselRecord(
      { imo: '', heading: null, lastPositionEpoch: null, mmsi: '' },
      { mmsi: '' },
    ),
    { now: NOW },
  );
  assert.equal(rowValue(details, 'IMO'), undefined);
  assert.equal(rowValue(details, 'Flag'), undefined);
  assert.equal(rowValue(details, 'Last position'), undefined);
  assert.deepEqual(details.links, []);
});

test('fire details describe the detection in plain language', () => {
  const details = buildSelectionDetails(fireRecord(), { now: NOW });
  assert.equal(details.kind, 'fire');
  assert.equal(details.title, 'Active fire');
  assert.equal(details.subtitle, 'Satellite detection (NASA FIRMS)');
  assert.equal(rowValue(details, 'Detected'), '3h ago');
  assert.equal(rowValue(details, 'Satellite/sensor'), 'VIIRS');
  assert.equal(rowValue(details, 'Confidence'), 'High');
  assert.equal(rowValue(details, 'Fire radiative power'), '12.4 MW');
  assert.equal(rowValue(details, 'Coordinates'), '12.5000° S, 45.2500° E');
  assert.deepEqual(details.links, [
    {
      label: 'NASA FIRMS map',
      href: 'https://firms.modaps.eosdis.nasa.gov/map/#d:24hrs;@45.25,-12.5,10z',
    },
  ]);
});

test('fire age is not doubled when it already says ago or is unknown', () => {
  const ago = buildSelectionDetails(fireRecord({ age: '<1h ago' }), { now: NOW });
  assert.equal(rowValue(ago, 'Detected'), '<1h ago');
  const unknown = buildSelectionDetails(fireRecord({ age: 'unknown' }), {
    now: NOW,
  });
  assert.equal(rowValue(unknown, 'Detected'), 'Unknown');
});

test('fire is recognised by its FIRMS source even under another layer id', () => {
  const details = buildSelectionDetails(
    fireRecord({}),
    { now: NOW },
  );
  assert.equal(details.kind, 'fire');
  const byLayer = buildSelectionDetails(
    { ...fireRecord(), source: 'other', layerId: 'firms' },
    { now: NOW },
  );
  assert.equal(byLayer.kind, 'fire');
});

test('other objects list their properties with human labels', () => {
  const details = buildSelectionDetails(
    {
      id: 'x-1',
      layerId: 'local-geojson',
      layerName: 'Local GeoJSON',
      label: 'Depot',
      latitude: 1,
      longitude: 2,
      properties: {
        owner_name: 'Port Authority',
        lastUpdated: '2026-10-01',
        capacity: 40,
        notes: '',
        nested: { a: 1 },
        missing: null,
      },
    },
    { now: NOW },
  );
  assert.equal(details.kind, 'other');
  assert.equal(details.title, 'Depot');
  assert.equal(details.subtitle, 'Local GeoJSON');
  assert.deepEqual(details.rows, [
    { label: 'Owner Name', value: 'Port Authority' },
    { label: 'Last Updated', value: '2026-10-01' },
    { label: 'Capacity', value: '40' },
    { label: 'Coordinates', value: '1.0000° N, 2.0000° E' },
  ]);
  assert.deepEqual(details.links, []);
});

test('missing values are omitted and coordinates are optional', () => {
  const details = buildSelectionDetails(
    {
      id: 'x-2',
      layerId: 'flights',
      label: 'UNKNOWN',
      latitude: Number.NaN,
      longitude: null,
      properties: { callsign: '', altitude: '', speed: '', heading: '' },
    },
    { now: NOW },
  );
  assert.equal(details.kind, 'flight');
  assert.equal(details.title, 'UNKNOWN');
  assert.deepEqual(details.rows, []);
  assert.deepEqual(details.links, []);
  assert.equal(details.latitude, null);
  assert.equal(details.longitude, null);
});

test('heading 0 and southern-western coordinates are kept', () => {
  const details = buildSelectionDetails(
    flightRecord({ heading: '0°', altitude: '0 ft', speed: '0 kt' }, {
      latitude: -33.5,
      longitude: -70.25,
    }),
    { now: NOW },
  );
  assert.equal(rowValue(details, 'Heading'), '0° (N)');
  assert.equal(rowValue(details, 'Altitude'), '0 ft (0 m)');
  assert.equal(rowValue(details, 'Speed'), '0 kt (0 km/h)');
  assert.equal(rowValue(details, 'Coordinates'), '33.5000° S, 70.2500° W');
});

test('buildSelectionDetails returns null without a record', () => {
  assert.equal(buildSelectionDetails(null), null);
  assert.equal(buildSelectionDetails(undefined), null);
});
