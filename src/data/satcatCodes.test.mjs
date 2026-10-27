import assert from 'node:assert/strict';
import test from 'node:test';
import {
  SATCAT_LAUNCH_SITES,
  SATCAT_OWNERS,
  satcatLaunchSiteName,
  satcatObjectTypeText,
  satcatOwnerName,
  satcatStatusText,
} from './satcatCodes.js';

test('common owner codes resolve to a country or organisation', () => {
  assert.equal(satcatOwnerName('US'), 'United States');
  assert.equal(satcatOwnerName('CIS'), 'Russia / USSR (CIS)');
  assert.equal(satcatOwnerName('PRC'), 'China');
  assert.equal(satcatOwnerName('ISS'), 'International Space Station partners');
  assert.equal(satcatOwnerName('ITSO'), 'Intelsat');
  assert.ok(Object.keys(SATCAT_OWNERS).length >= 60, 'at least the common owners are listed');
});

test('an unlisted owner code is shown raw, and an empty one is null', () => {
  assert.equal(satcatOwnerName('XYZQ'), 'XYZQ');
  assert.equal(satcatOwnerName('  '), null);
  assert.equal(satcatOwnerName(undefined), null);
  assert.equal(satcatOwnerName('constructor'), 'constructor', 'prototype keys are not owners');
});

test('launch site codes resolve to the launch complex', () => {
  assert.equal(satcatLaunchSiteName('AFETR'), 'Cape Canaveral, Florida');
  assert.equal(satcatLaunchSiteName('TYMSC'), 'Baikonur, Kazakhstan');
  assert.equal(satcatLaunchSiteName('FRGUI'), 'Kourou, French Guiana');
  assert.equal(satcatLaunchSiteName('NOPE'), 'NOPE');
  assert.equal(satcatLaunchSiteName(''), null);
  assert.ok(Object.keys(SATCAT_LAUNCH_SITES).length >= 15);
});

test('object type codes read as plain language', () => {
  assert.equal(satcatObjectTypeText('PAY'), 'Payload (working spacecraft)');
  assert.equal(
    satcatObjectTypeText('R/B'),
    'Rocket body — spent upper stage, not a working satellite',
  );
  assert.equal(satcatObjectTypeText('DEB'), 'Debris');
  assert.equal(satcatObjectTypeText('UNK'), 'Unknown');
  assert.equal(satcatObjectTypeText(''), null);
});

test('operational status codes read as plain language', () => {
  assert.equal(satcatStatusText('+'), 'Operational');
  assert.equal(satcatStatusText('-'), 'Non-operational');
  assert.equal(satcatStatusText('P'), 'Partially operational');
  assert.equal(satcatStatusText('B'), 'Backup');
  assert.equal(satcatStatusText('S'), 'Spare');
  assert.equal(satcatStatusText('X'), 'Extended mission');
  assert.equal(satcatStatusText('D'), 'Decayed');
  assert.equal(satcatStatusText('?'), 'Unknown');
  assert.equal(satcatStatusText('Z'), 'Z');
});
