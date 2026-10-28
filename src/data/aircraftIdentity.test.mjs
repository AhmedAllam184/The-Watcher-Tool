import test from 'node:test';
import assert from 'node:assert/strict';
import {
  describeAircraft,
  emitterCategoryText,
  parseDescriptionCode,
  resolveAircraftName,
} from './aircraftIdentity.js';

test('HRON with the feed description is the IAI Heron, an unmanned military surveillance drone', () => {
  const identity = describeAircraft({
    typeCode: 'HRON',
    typeDescription: 'IAI Heron Drone',
    emitterCategory: 'B6',
    military: true,
  });
  assert.equal(identity.name, 'IAI Heron Drone');
  assert.equal(identity.kindLabel, 'Military surveillance drone');
  assert.deepEqual(identity.facts, ['Unmanned (no pilot on board)']);
  assert.equal(identity.military, true);
  assert.equal(identity.confidence, 'inferred');
});

test('HRON with no text is still the IAI Heron surveillance drone, from the designator rules', () => {
  const identity = describeAircraft({ typeCode: 'HRON', emitterCategory: 'B6', military: true });
  assert.equal(identity.name, 'IAI Heron');
  assert.equal(identity.kindLabel, 'Military surveillance drone');
  assert.equal(identity.confidence, 'inferred');
});

test('an unlisted designator with the feed drone category and the military flag is a military drone from the feed alone', () => {
  const identity = describeAircraft({ typeCode: 'ZZDR', emitterCategory: 'B6', military: true });
  assert.equal(identity.name, 'ZZDR');
  assert.equal(identity.kindLabel, 'Military drone (unmanned)');
  assert.deepEqual(identity.facts, ['Unmanned (no pilot on board)']);
  assert.equal(identity.confidence, 'feed');
});

test('a C-17 is a military transport with four jet engines, heavy class and a build year', () => {
  const identity = describeAircraft({
    typeCode: 'C17',
    typeDescription: 'BOEING C-17 Globemaster 3',
    emitterCategory: 'A5',
    buildYear: '2008',
    military: true,
  });
  assert.equal(identity.name, 'BOEING C-17 Globemaster 3');
  assert.equal(identity.kindLabel, 'Military transport');
  assert.deepEqual(identity.facts, [
    '4 jet engines',
    'Heavy (over 136 t)',
    'Heavy wake turbulence',
    'Built 2008',
  ]);
  assert.equal(identity.wakeCategory, 'H');
});

test('a KC-135 is an air-to-air refuelling tanker', () => {
  const identity = describeAircraft({
    typeCode: 'K35R',
    typeName: 'Boeing KC-135 Stratotanker',
    military: true,
  });
  assert.equal(identity.kindLabel, 'Air-to-air refuelling tanker');
  assert.deepEqual(identity.facts, ['4 jet engines']);
});

test('a KC-135 named only by its designator is still a tanker, from the designator rules', () => {
  const identity = describeAircraft({ typeCode: 'K35R', military: true });
  assert.equal(identity.name, 'KC-135 Stratotanker');
  assert.equal(identity.kindLabel, 'Air-to-air refuelling tanker');
  assert.equal(identity.confidence, 'inferred');
});

test('an A320 from the feed is a civil airliner, and the military flag rules that out', () => {
  const civil = describeAircraft({ typeCode: 'A320', typeName: 'Airbus A320', emitterCategory: 'A3' });
  assert.equal(civil.kindLabel, 'Airliner');
  assert.deepEqual(civil.facts, ['Large (34 to 136 t)']);
  const designatorOnly = describeAircraft({ typeCode: 'B738', emitterCategory: 'A3' });
  assert.equal(designatorOnly.kindLabel, 'Airliner');
  const military = describeAircraft({ typeCode: 'A320', typeName: 'Airbus A320', military: true });
  assert.notEqual(military.kindLabel, 'Airliner');
});

test('a Gulfstream is a business jet, and a military one is a transport', () => {
  const civil = describeAircraft({ typeCode: 'GLF5', typeName: 'Gulfstream G550' });
  assert.equal(civil.kindLabel, 'Business jet');
  assert.deepEqual(civil.facts, ['2 jet engines']);
  const military = describeAircraft({ typeCode: 'GLF5', typeName: 'Gulfstream C-37A', military: true });
  assert.equal(military.kindLabel, 'Military transport (executive jet)');
});

test('a Cessna 172 is a light private aircraft with a small piston-era weight class', () => {
  const identity = describeAircraft({ typeCode: 'C172', emitterCategory: 'A1' });
  assert.equal(identity.name, 'C172');
  assert.equal(identity.kindLabel, 'Light private aircraft');
  assert.deepEqual(identity.facts, ['Light (under 7 t)']);
  const named = describeAircraft({ typeCode: 'C172', typeName: 'Cessna 172 Skyhawk' });
  assert.equal(named.kindLabel, 'Light private aircraft');
});

test('a UH-60 is a military helicopter, from its designator or its name', () => {
  const byCode = describeAircraft({ typeCode: 'H60', military: true, emitterCategory: 'A7' });
  assert.equal(byCode.name, 'UH-60 Black Hawk');
  assert.equal(byCode.kindLabel, 'Military helicopter');
  assert.deepEqual(byCode.facts, ['2 turboprop engines']);
  const byName = describeAircraft({ typeDescription: 'Sikorsky UH-60 Black Hawk', military: true });
  assert.equal(byName.kindLabel, 'Military helicopter');
});

test('an unknown aircraft with no text, no designator and no military flag says so', () => {
  const identity = describeAircraft({});
  assert.equal(identity.name, null);
  assert.equal(identity.kindLabel, 'Aircraft (type not identified)');
  assert.deepEqual(identity.facts, []);
  assert.equal(identity.military, false);
});

test('a military aircraft with no name says it is military, not unidentified', () => {
  assert.equal(describeAircraft({ military: true }).kindLabel, 'Military aircraft');
});

test('a feed category names a helicopter, a glider or a ground vehicle without any text', () => {
  assert.equal(describeAircraft({ emitterCategory: 'A7' }).kindLabel, 'Helicopter');
  assert.equal(describeAircraft({ emitterCategory: 'B1' }).kindLabel, 'Glider');
  assert.equal(describeAircraft({ emitterCategory: 'C2' }).kindLabel, 'Ground vehicle (not an aircraft)');
});

test('drone words in the name are told apart: surveillance, armed, and plain drone', () => {
  assert.equal(describeAircraft({ typeDescription: 'General Atomics MQ-9 Reaper', military: true }).kindLabel, 'Military armed drone');
  assert.equal(describeAircraft({ typeDescription: 'Bayraktar TB2', military: false }).kindLabel, 'Armed drone (unmanned)');
  assert.equal(describeAircraft({ typeDescription: 'Commercial UAV' }).kindLabel, 'Drone (unmanned)');
});

test('a reconnaissance aircraft that is not a drone is not called a surveillance drone', () => {
  const identity = describeAircraft({ typeDescription: 'Boeing RC-135 Rivet Joint', military: true });
  assert.equal(identity.kindLabel, 'Reconnaissance / intelligence');
});

test('the engine count and type come from the description code, only when there is one', () => {
  assert.deepEqual(parseDescriptionCode('L1P'), { kind: 'landplane', engines: 1, engineType: 'piston' });
  assert.deepEqual(parseDescriptionCode('H2T'), { kind: 'helicopter', engines: 2, engineType: 'turboprop' });
  assert.deepEqual(parseDescriptionCode('X9Z'), { kind: null, engines: null, engineType: null });
  assert.deepEqual(parseDescriptionCode(null), { kind: null, engines: null, engineType: null });
});

test('the wake and weight facts follow the emitter category', () => {
  assert.equal(describeAircraft({ emitterCategory: 'A2' }).wakeCategory, 'L');
  assert.equal(describeAircraft({ emitterCategory: 'A3' }).wakeCategory, 'M');
  assert.equal(describeAircraft({ emitterCategory: 'A6' }).facts[0], 'High performance (fast military or aerobatic)');
});

test('the build year is kept only when it is a plausible year', () => {
  assert.deepEqual(describeAircraft({ buildYear: 2014 }).facts, ['Built 2014']);
  assert.deepEqual(describeAircraft({ buildYear: '1' }).facts, []);
  assert.deepEqual(describeAircraft({ buildYear: 'soon' }).facts, []);
});

test('resolveAircraftName prefers the feed description, then adsbdb, then the mapped name, then the designator', () => {
  assert.deepEqual(
    resolveAircraftName({ typeDescription: 'IAI Heron Drone', typeName: 'Other', typeCode: 'HRON' }),
    { name: 'IAI Heron Drone', code: 'HRON', named: true },
  );
  assert.deepEqual(resolveAircraftName({ typeName: 'Airbus A320', typeCode: 'A320' }), {
    name: 'Airbus A320',
    code: 'A320',
    named: true,
  });
  assert.deepEqual(resolveAircraftName({ typeCode: 'C17' }), {
    name: 'C-17 Globemaster III',
    code: 'C17',
    named: true,
  });
  assert.deepEqual(resolveAircraftName({ typeCode: 'ZZZ9' }), { name: 'ZZZ9', code: 'ZZZ9', named: false });
  assert.deepEqual(resolveAircraftName({}), { name: null, code: null, named: false });
});

test('emitter category text accepts ADS-B strings and OpenSky integers, and nothing else', () => {
  assert.equal(emitterCategoryText('a3'), 'A3');
  assert.equal(emitterCategoryText(14), 'B6');
  assert.equal(emitterCategoryText(99), '');
  assert.equal(emitterCategoryText('Z9'), '');
  assert.equal(emitterCategoryText(null), '');
});
