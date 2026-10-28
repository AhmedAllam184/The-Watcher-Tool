import test from 'node:test';
import assert from 'node:assert/strict';
import { describeSatellite, VISIBILITY_FACT } from './satelliteIdentity.js';

test('a Starlink satellite is named as SpaceX broadband, with the Starlink article', () => {
  const identity = describeSatellite({ name: 'STARLINK-1007', classLabel: 'COMMS · STARLINK', owner: { name: 'SpaceX' } });
  assert.equal(identity.programme, 'Starlink');
  assert.equal(identity.kindLabel, 'Starlink internet satellite');
  assert.equal(identity.wikiQuery, 'Starlink');
  assert.ok(identity.facts.includes('Operated by SpaceX'));
  assert.ok(identity.facts.some((fact) => /SpaceX/.test(fact)));
});

test('the ISS is a crewed station, bright enough to see, and is named by its article', () => {
  const identity = describeSatellite({ name: 'ISS (ZARYA)', classLabel: 'STATION · ISS', objectType: 'PAY' });
  assert.equal(identity.programme, 'ISS');
  assert.equal(identity.kindLabel, 'International Space Station (crewed)');
  assert.equal(identity.wikiQuery, 'International Space Station');
  assert.ok(identity.facts.includes(VISIBILITY_FACT));
  assert.ok(identity.facts.some((fact) => /Crewed/.test(fact)));
});

test('a GPS satellite is a US navigation satellite', () => {
  const identity = describeSatellite({ name: 'GPS BIIR-2  (PRN 13)', classLabel: 'NAV · GPS' });
  assert.equal(identity.programme, 'GPS');
  assert.equal(identity.kindLabel, 'GPS navigation satellite (US)');
  assert.equal(identity.wikiQuery, 'Global Positioning System');
  assert.deepEqual(identity.facts, []);
});

test('a Cosmos satellite is a Russian military series, and a GLONASS one is named as navigation', () => {
  const cosmos = describeSatellite({ name: 'COSMOS 2543', classLabel: 'MILITARY' });
  assert.equal(cosmos.programme, 'Cosmos');
  assert.equal(cosmos.kindLabel, 'Kosmos satellite (Russian military series)');
  assert.equal(cosmos.wikiQuery, 'Kosmos satellite');
  const glonass = describeSatellite({ name: 'COSMOS 2251 [GLONASS]', classLabel: 'NAV · GLONASS' });
  assert.equal(glonass.programme, 'GLONASS');
  assert.equal(glonass.wikiQuery, 'GLONASS');
});

test('a Yaogan satellite is a Chinese military reconnaissance satellite', () => {
  const identity = describeSatellite({ name: 'YAOGAN-30 02', classLabel: 'MILITARY', militaryRule: 'name: Yaogan (Chinese military remote sensing)' });
  assert.equal(identity.programme, 'Yaogan');
  assert.equal(identity.kindLabel, 'Yaogan Chinese military reconnaissance satellite');
  assert.equal(identity.wikiQuery, 'Yaogan');
});

test('a Long March 2C upper stage is a rocket body, named for its rocket, and not a working satellite', () => {
  const identity = describeSatellite({ name: 'CZ-2C R/B', objectType: 'R/B', classLabel: 'VISUAL' });
  assert.equal(identity.programme, 'Long March 2C');
  assert.equal(
    identity.kindLabel,
    'Rocket body — the spent upper stage of a Long March 2C rocket; space junk, not a working satellite',
  );
  assert.equal(identity.wikiQuery, 'Long March 2C');
  assert.ok(identity.facts.includes('Not a working satellite'));
});

test('an SL-14 upper stage is a rocket body for the rocket its SL designation names', () => {
  const identity = describeSatellite({ name: 'SL-14 R/B', classLabel: 'VISUAL' });
  assert.equal(identity.programme, 'Tsyklon');
  assert.match(identity.kindLabel, /^Rocket body — the spent upper stage of a Tsyklon rocket;/);
  assert.equal(identity.wikiQuery, 'Tsyklon');
});

test('a large rocket body is bright enough to see, a small one is not', () => {
  const large = describeSatellite({ name: 'FALCON 9 R/B', classLabel: 'STATIONS' });
  assert.equal(large.programme, 'Falcon 9');
  assert.ok(large.facts.includes(VISIBILITY_FACT));
  const small = describeSatellite({ name: 'PSLV R/B', classLabel: 'NAV' });
  assert.equal(small.programme, 'PSLV');
  assert.ok(!small.facts.includes(VISIBILITY_FACT));
});

test('a rocket body with no mapped rocket is named generically', () => {
  const identity = describeSatellite({ name: 'MYSTERY R/B', classLabel: 'VISUAL' });
  assert.equal(identity.programme, 'Rocket body');
  assert.equal(identity.wikiQuery, null);
});

test('debris is not a working satellite and has no article to look up', () => {
  const identity = describeSatellite({ name: 'COSMOS 1408 DEB', objectType: 'DEB', classLabel: 'MILITARY' });
  assert.equal(identity.programme, 'Debris');
  assert.equal(identity.kindLabel, 'Debris: a fragment from a past break-up, explosion or collision; not a working satellite');
  assert.equal(identity.wikiQuery, null);
  assert.deepEqual(identity.facts, ['Not a working satellite']);
});

test('the visual group is bright enough to see with the naked eye', () => {
  const identity = describeSatellite({ name: 'SOME VISUAL OBJECT', classLabel: 'VISUAL' });
  assert.equal(identity.programme, null);
  assert.ok(identity.facts.includes(VISIBILITY_FACT));
});

test('an unnamed satellite falls back to its class, and a military one says so', () => {
  assert.equal(describeSatellite({ name: 'XYZ-1', classLabel: 'GEO' }).kindLabel, 'Geostationary satellite (fixed over the equator)');
  assert.equal(describeSatellite({ name: 'XYZ-2', classLabel: 'COMMS' }).kindLabel, 'Communications satellite (broadband shell)');
  assert.equal(describeSatellite({ name: 'XYZ-3', classLabel: 'MILITARY' }).kindLabel, 'Military satellite');
  const unknown = describeSatellite({ name: 'XYZ-4' });
  assert.equal(unknown.programme, null);
  assert.equal(unknown.kindLabel, 'Satellite');
  assert.equal(unknown.wikiQuery, null);
  assert.equal(describeSatellite({ name: 'XYZ-5', militaryRule: 'CelesTrak military list' }).kindLabel, 'Military satellite');
});

test('a NOAA weather satellite names its programme and says who operates it', () => {
  const identity = describeSatellite({ name: 'NOAA 19', classLabel: 'VISUAL', owner: { name: 'NOAA' } });
  assert.equal(identity.programme, 'NOAA');
  assert.equal(identity.wikiQuery, 'NOAA weather satellite');
  assert.ok(identity.facts.includes('Operated by NOAA'));
});
