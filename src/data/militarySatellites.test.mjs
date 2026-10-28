import test from 'node:test';
import assert from 'node:assert/strict';
import {
  classifyMilitarySatellite,
  isCivil,
  isMilitary,
  MILITARY_GROUP_TAG,
  MILITARY_LIST_RULE,
} from './militarySatellites.js';

const military = (name, noradId = 1) => classifyMilitarySatellite({ noradId, name });

test('programme names classify as military and say which rule matched', () => {
  assert.deepEqual(military('USA 314'), {
    military: true,
    rule: 'name: USA-numbered (US government, mainly military)',
  });
  assert.equal(military('NROL 76').rule, 'name: NROL (US National Reconnaissance Office)');
  assert.equal(military('COSMOS 2558').rule, 'name: Cosmos (Russian military series)');
  assert.equal(military('YAOGAN-30').rule, 'name: Yaogan (Chinese military remote sensing)');
  assert.equal(military('WGS-10').military, true);
  assert.equal(military('AEHF-4').military, true);
  assert.equal(military('MUOS-5').military, true);
  assert.equal(military('SBIRS GEO-5').military, true);
  assert.equal(military('DSP 23').military, true);
  assert.equal(military('GSSAP 5').military, true);
  assert.equal(military('SKYNET 5B').military, true);
  assert.equal(military('ZHONGXING-2').military, true);
  assert.equal(military('ZHONGXING 2').military, true);
  assert.equal(military('IGS 7').military, true);
  assert.equal(military('SHIYAN 21').military, true);
});

test('names are matched after trimming and collapsing spaces, case-insensitively', () => {
  assert.equal(military('  cosmos   2558  ').military, true);
  assert.equal(military('usa-270').military, true);
});

test('the list rule is authoritative and carries the CelesTrak wording', () => {
  assert.deepEqual(
    classifyMilitarySatellite({
      noradId: 40123,
      name: 'SOME BUS 1',
      militaryNoradIds: new Set([40123]),
    }),
    { military: true, rule: MILITARY_LIST_RULE },
  );
  assert.equal(MILITARY_LIST_RULE, 'CelesTrak military list');
  assert.equal(MILITARY_GROUP_TAG, 'military');
  // Membership is by NORAD id, not by name: a neighbour with another id is not military.
  assert.equal(
    classifyMilitarySatellite({
      noradId: 40124,
      name: 'SOME BUS 2',
      militaryNoradIds: new Set([40123]),
    }).military,
    false,
  );
});

test('civil names are not military, including GPS, KOMPSAT and the ISS', () => {
  for (const name of [
    'GPS BIII-1',
    'GPS BIIR-2',
    'NAVSTAR 77',
    'KOMPSAT-5',
    'ISS (ZARYA)',
    'STARLINK-1007',
    'NOAA 19',
    'TERRA',
    'USAF ACADEMY',
    'LANDSAT 9',
    'COSMOSPHERE',
    'CSOFT 1',
  ]) {
    assert.equal(military(name).military, false, name);
  }
});

test('rocket bodies and debris are never military payloads, even on the military list', () => {
  const militaryNoradIds = new Set([11111, 22222, 33333]);
  for (const name of ['COSMOS 1408 DEB', 'SL-16 R/B', 'USA 193 DEB', 'FENGYUN 1C DEB', 'ROCKET BODY 9']) {
    assert.deepEqual(
      classifyMilitarySatellite({ noradId: 11111, name, militaryNoradIds }),
      { military: false, rule: null },
      name,
    );
  }
  assert.equal(military('COSMOS 1408 DEB').military, false);
  assert.equal(military('TITAN 3C R/B').military, false);
});

test('the layer filters partition a catalogue with no overlap and no loss', () => {
  const militaryNoradIds = new Set([50001]);
  const catalogue = [
    { noradId: 25544, name: 'ISS (ZARYA)' },
    { noradId: 50001, name: 'OPAQUE SAT' },
    { noradId: 50002, name: 'USA 270' },
    { noradId: 50003, name: 'GPS BIII-2' },
    { noradId: 50004, name: 'COSMOS 1408 DEB' },
    { noradId: 50005, name: 'STARLINK-30' },
  ];
  const verdicts = catalogue.map((sat) =>
    classifyMilitarySatellite({ ...sat, militaryNoradIds }),
  );
  const civil = catalogue.filter((_, i) => isCivil(verdicts[i]));
  const mil = catalogue.filter((_, i) => isMilitary(verdicts[i]));
  assert.deepEqual(
    civil.map((s) => s.noradId),
    [25544, 50003, 50004, 50005],
  );
  assert.deepEqual(
    mil.map((s) => s.noradId),
    [50001, 50002],
  );
  assert.equal(civil.length + mil.length, catalogue.length);
  for (const sat of catalogue) {
    assert.equal(civil.includes(sat) && mil.includes(sat), false, sat.name);
  }
});
