import test from 'node:test';
import assert from 'node:assert/strict';
import {
  buildSelectionDetails,
  compassPoint,
  flagFromMmsi,
  formatRelativeTime,
  satelliteNoradOf,
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

test('flight details show From and To city names when the route is known', () => {
  const details = buildSelectionDetails(
    flightRecord({
      route: 'LHR → JFK',
      routeFrom: 'London (LHR)',
      routeTo: 'New York (JFK)',
    }),
    { now: NOW },
  );
  assert.equal(rowValue(details, 'From'), 'London (LHR)');
  assert.equal(rowValue(details, 'To'), 'New York (JFK)');
  assert.equal(rowValue(details, 'Route'), undefined);
});

test('flight details fall back to the codes-only Route row', () => {
  const details = buildSelectionDetails(flightRecord({ route: 'LHR → JFK' }), {
    now: NOW,
  });
  assert.equal(rowValue(details, 'Route'), 'LHR → JFK');
  assert.equal(rowValue(details, 'From'), undefined);
  assert.equal(rowValue(details, 'To'), undefined);
});

test('flight details carry the lower-case hex for the photo lookup', () => {
  assert.equal(buildSelectionDetails(flightRecord(), { now: NOW }).photoHex, 'abc123');
  const upper = buildSelectionDetails(flightRecord({ icao24: 'ABC123' }), { now: NOW });
  assert.equal(upper.photoHex, 'abc123');
  const invalid = buildSelectionDetails(flightRecord({ icao24: 'nothex' }), { now: NOW });
  assert.equal(invalid.photoHex, null);
  const military = buildSelectionDetails(
    flightRecord({ icao24: '43c123' }, { layerId: 'military' }),
    { now: NOW },
  );
  assert.equal(military.photoHex, '43c123');
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
    flightRecord({ callsign: '', name: 'RCH401' }, { layerId: 'military' }),
    { now: NOW },
  );
  assert.equal(military.kind, 'flight');
  assert.equal(military.title, 'RCH401');
  assert.deepEqual(military.links.map((link) => link.label), ['ADS-B Exchange']);
});

test('a gone-dark vessel reads as inferred, explains itself and raises an amber alert', () => {
  const dark = buildSelectionDetails(
    vesselRecord({
      dark: true,
      inference: 'Silent 60 min while nearby ships still report',
      lastPositionEpoch: NOW - 60 * 60000,
    }),
    { now: NOW },
  );
  assert.equal(rowValue(dark, 'Status'), 'Gone dark (inferred)');
  assert.equal(
    rowValue(dark, 'Why flagged'),
    'Silent 60 min while nearby ships still report',
  );
  assert.equal(rowValue(dark, 'Last position'), '1 h ago');
  assert.equal(
    dark.alert,
    'No AIS signal for 1 h while under way. Inferred from silence where nearby ships still report — not confirmed.',
  );
  assert.equal(dark.alertTone, 'warn');

  const live = buildSelectionDetails(vesselRecord(), { now: NOW });
  assert.equal(live.alert, null);
  assert.equal(live.alertTone, undefined);
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
    flightRecord({ squawk: '7600' }, { layerId: 'military' }),
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

test('an unnamed mapped installation reads as other, never as a flight', () => {
  const details = buildSelectionDetails(
    {
      id: 'ofm:installation:1',
      layerId: 'military-installations',
      layerName: 'Mapped Military Installations',
      source: 'OpenStreetMap',
      label: 'Military area',
      latitude: 30.3523,
      longitude: 33.0885,
      properties: { class: 'military_land', validation: 'unreviewed' },
    },
    { now: NOW },
  );
  assert.equal(details.kind, 'other');
  assert.equal(details.title, 'Military area');
  assert.equal(rowValue(details, 'Altitude'), undefined);
  assert.equal(rowValue(details, 'Callsign'), undefined);
  assert.equal(details.rows.some((row) => /flight/i.test(row.label)), false);
  assert.equal(details.links.some((link) => /adsb|flightradar/i.test(link.href)), false);
});

const SATELLITE_RECORD = {
  id: '25544',
  layerId: 'satellites',
  layerName: 'Satellites',
  source: 'CelesTrak',
  label: 'ISS (ZARYA)',
  latitude: 51.6,
  longitude: -0.1,
  properties: {
    name: 'ISS (ZARYA)',
    operator: '',
    noradId: '25544',
    class: 'STATION · ISS',
    altitude: '420 km',
  },
};

const SATELLITE_INFO = {
  norad: 25544,
  name: 'ISS (ZARYA)',
  intlDesignator: '1998-067A',
  objectType: 'PAY',
  objectTypeText: 'Payload (working spacecraft)',
  status: '+',
  statusText: 'Operational',
  owner: { code: 'ISS', name: 'International Space Station partners' },
  launchDate: '1998-11-20',
  launchSite: { code: 'TYMSC', name: 'Baikonur, Kazakhstan' },
  decayDate: null,
  periodMin: 92.9,
  inclinationDeg: 51.6,
  apogeeKm: 420,
  perigeeKm: 413,
  orbitClass: 'LEO',
  rcsM2: 399.2,
  rcsSize: 'large',
  source: 'CelesTrak SATCAT',
};

test('satellites are kind satellite and wait for the catalogue record', () => {
  const pending = buildSelectionDetails(SATELLITE_RECORD, {
    now: NOW,
    satelliteInfo: { norad: '25544', status: 'loading', satellite: null },
  });
  assert.equal(pending.kind, 'satellite');
  assert.equal(pending.title, 'ISS (ZARYA)');
  assert.equal(rowValue(pending, 'NORAD ID'), '25544');
  assert.equal(rowValue(pending, 'Catalogue'), 'Loading catalogue data…');
  assert.equal(rowValue(pending, 'Owner / country'), undefined);
  assert.equal(rowValue(pending, 'Class'), 'STATION · ISS');
  assert.equal(rowValue(pending, 'Altitude'), '420 km');
  assert.equal(rowValue(pending, 'Coordinates'), '51.6000° N, 0.1000° W');
});

test('a loaded catalogue record shows who owns the satellite and its orbit, launch and size', () => {
  const details = buildSelectionDetails(SATELLITE_RECORD, {
    now: NOW,
    satelliteInfo: { norad: '25544', status: 'ok', satellite: SATELLITE_INFO },
  });
  assert.equal(details.subtitle, 'Payload (working spacecraft)');
  assert.equal(rowValue(details, 'Owner / country'), 'International Space Station partners');
  assert.equal(rowValue(details, 'Type'), 'Payload (working spacecraft)');
  assert.equal(rowValue(details, 'Status'), 'Operational');
  assert.equal(rowValue(details, 'Launched'), '1998-11-20 · Baikonur, Kazakhstan');
  assert.equal(rowValue(details, 'International ID'), '1998-067A');
  assert.equal(rowValue(details, 'Orbit'), 'LEO · 420 km × 413 km · 51.6° · 93 min');
  assert.equal(rowValue(details, 'Size'), 'Large (399 m²)');
  assert.equal(rowValue(details, 'Data source'), 'CelesTrak SATCAT');
  assert.equal(rowValue(details, 'Decayed'), undefined);
  assert.equal(rowValue(details, 'Catalogue'), undefined);
  assert.equal(rowValue(details, 'Class'), 'STATION · ISS');
});

test('a satellite record without a size, decay or owner omits those rows', () => {
  const details = buildSelectionDetails(SATELLITE_RECORD, {
    now: NOW,
    satelliteInfo: {
      norad: '25544',
      status: 'ok',
      satellite: {
        ...SATELLITE_INFO,
        owner: null,
        rcsM2: null,
        rcsSize: null,
        decayDate: '2030-01-01',
        launchSite: null,
      },
    },
  });
  assert.equal(rowValue(details, 'Owner / country'), undefined);
  assert.equal(rowValue(details, 'Size'), undefined);
  assert.equal(rowValue(details, 'Decayed'), '2030-01-01');
  assert.equal(rowValue(details, 'Launched'), '1998-11-20');
});

test('a failed lookup says so, and an absent catalogue entry adds nothing', () => {
  const failed = buildSelectionDetails(SATELLITE_RECORD, {
    now: NOW,
    satelliteInfo: { norad: '25544', status: 'failed', satellite: null },
  });
  assert.equal(rowValue(failed, 'Catalogue'), 'Info unavailable');
  const absent = buildSelectionDetails(SATELLITE_RECORD, {
    now: NOW,
    satelliteInfo: { norad: '25544', status: 'ok', satellite: null },
  });
  assert.equal(rowValue(absent, 'Catalogue'), undefined);
  assert.equal(rowValue(absent, 'Owner / country'), undefined);
});

test('a lookup state for another NORAD id is not applied to this satellite', () => {
  const details = buildSelectionDetails(SATELLITE_RECORD, {
    now: NOW,
    satelliteInfo: { norad: '99999', status: 'ok', satellite: SATELLITE_INFO },
  });
  assert.equal(rowValue(details, 'Owner / country'), undefined);
});

test('the rocket-body and debris names show their type before any data arrives', () => {
  const rocketBody = buildSelectionDetails(
    {
      ...SATELLITE_RECORD,
      id: '28228',
      label: 'CZ-2C R/B',
      properties: { name: 'CZ-2C R/B', noradId: '28228', class: 'VISUAL', altitude: '' },
    },
    { now: NOW },
  );
  assert.equal(
    rowValue(rocketBody, 'Type'),
    'Rocket body — spent upper stage, not a working satellite',
  );
  assert.equal(rowValue(rocketBody, 'Altitude'), undefined);
  const debris = buildSelectionDetails(
    { ...SATELLITE_RECORD, label: 'COSMOS 1408 DEB', properties: { name: 'COSMOS 1408 DEB', noradId: '30000' } },
    { now: NOW },
  );
  assert.equal(rowValue(debris, 'Type'), 'Debris');
});

test('satellite links go to N2YO and the CelesTrak SATCAT page for the same id', () => {
  const details = buildSelectionDetails(SATELLITE_RECORD, { now: NOW });
  assert.deepEqual(details.links, [
    { label: 'N2YO', href: 'https://www.n2yo.com/satellite/?s=25544' },
    {
      label: 'CelesTrak',
      href: 'https://celestrak.org/satcat/table-satcat.php?CATNR=25544&PAYLOAD=0',
    },
  ]);
  assert.equal(details.satelliteNorad, '25544');
});

test('satelliteNoradOf reads only satellite records with a usable catalogue number', () => {
  assert.equal(satelliteNoradOf(SATELLITE_RECORD), '25544');
  assert.equal(satelliteNoradOf({ layerId: 'satellites', id: 'SAT-1' }), null);
  assert.equal(satelliteNoradOf({ layerId: 'satellites', id: '0' }), null);
  assert.equal(satelliteNoradOf({ layerId: 'flights', id: '25544' }), null);
  assert.equal(satelliteNoradOf(null), null);
});
