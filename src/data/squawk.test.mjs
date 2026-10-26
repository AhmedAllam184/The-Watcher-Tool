import test from 'node:test';
import assert from 'node:assert/strict';
import {
  EMERGENCY_SQUAWKS,
  SQUAWK_EMERGENCY_EVENT,
  describeSquawk,
  diffEmergencies,
  emitSquawkEmergencies,
  normalizeSquawk,
} from './squawk.js';

test('emergency codes carry their plain meanings', () => {
  assert.deepEqual(EMERGENCY_SQUAWKS, {
    '7500': 'Hijack / unlawful interference',
    '7600': 'Radio failure',
    '7700': 'General emergency',
  });
  assert.equal(Object.isFrozen(EMERGENCY_SQUAWKS), true);
});

test('normalizeSquawk keeps four decimal digits and rejects anything else', () => {
  assert.equal(normalizeSquawk(' 7700 '), '7700');
  assert.equal(normalizeSquawk(1200), '1200');
  assert.equal(normalizeSquawk('770'), null);
  assert.equal(normalizeSquawk('77000'), null);
  assert.equal(normalizeSquawk('77A0'), null);
  assert.equal(normalizeSquawk(''), null);
  assert.equal(normalizeSquawk(null), null);
  assert.equal(normalizeSquawk(undefined), null);
});

test('describeSquawk separates emergency codes from routine ones', () => {
  assert.deepEqual(describeSquawk('7500'), {
    code: '7500',
    meaning: 'Hijack / unlawful interference',
    emergency: true,
  });
  assert.deepEqual(describeSquawk('1200'), {
    code: '1200',
    meaning: null,
    emergency: false,
  });
  assert.equal(describeSquawk('bogus'), null);
  assert.equal(describeSquawk(undefined), null);
});

test('diffEmergencies announces a contact once per code, not on every poll', () => {
  const first = diffEmergencies(new Map(), [
    {
      id: 'abc123',
      callsign: ' UAL123 ',
      squawk: '7700',
      latitude: 51.5,
      longitude: -0.1,
    },
    { id: 'def456', callsign: '', squawk: '1200' },
  ]);
  assert.deepEqual(first.alerts, [
    {
      icao24: 'abc123',
      callsign: 'UAL123',
      code: '7700',
      meaning: 'General emergency',
      latitude: 51.5,
      longitude: -0.1,
    },
  ]);
  assert.equal(first.next.get('abc123'), '7700');
  assert.equal(first.next.has('def456'), false);

  const repeat = diffEmergencies(first.next, [
    { id: 'abc123', callsign: 'UAL123', squawk: '7700' },
  ]);
  assert.deepEqual(repeat.alerts, []);
  assert.equal(repeat.next.get('abc123'), '7700');
});

test('diffEmergencies re-announces when the code changes and forgets cleared contacts', () => {
  const start = new Map([['abc123', '7700']]);
  const changed = diffEmergencies(start, [
    { id: 'abc123', callsign: 'UAL123', squawk: '7600' },
  ]);
  assert.equal(changed.alerts.length, 1);
  assert.equal(changed.alerts[0].code, '7600');
  assert.equal(changed.alerts[0].latitude, null);

  const cleared = diffEmergencies(changed.next, [
    { id: 'abc123', callsign: 'UAL123', squawk: '1200' },
  ]);
  assert.deepEqual(cleared.alerts, []);
  assert.equal(cleared.next.size, 0);

  const again = diffEmergencies(cleared.next, [
    { id: 'abc123', callsign: 'UAL123', squawk: '7700' },
  ]);
  assert.equal(again.alerts.length, 1);
});

test('diffEmergencies keeps a remembered contact through a missing poll', () => {
  const kept = diffEmergencies(new Map([['abc123', '7700']]), []);
  assert.deepEqual(kept.alerts, []);
  assert.equal(kept.next.get('abc123'), '7700');
  const back = diffEmergencies(kept.next, [
    { id: 'abc123', squawk: '7700' },
  ]);
  assert.deepEqual(back.alerts, []);
});

test('diffEmergencies tolerates missing input and bounds its memory', () => {
  assert.deepEqual(diffEmergencies(null, undefined), {
    alerts: [],
    next: new Map(),
  });
  const records = Array.from({ length: 510 }, (_, index) => ({
    id: `c${index}`,
    squawk: '7700',
  }));
  const { next, alerts } = diffEmergencies(null, records);
  assert.equal(alerts.length, 510);
  assert.equal(next.size, 500);
  assert.equal(next.has('c0'), false);
  assert.equal(next.has('c509'), true);
});

test('emitSquawkEmergencies dispatches one event per alert and ignores a missing target', () => {
  const target = new EventTarget();
  target.CustomEvent = globalThis.CustomEvent;
  const seen = [];
  target.addEventListener(SQUAWK_EMERGENCY_EVENT, (event) =>
    seen.push(event.detail),
  );
  const alerts = [
    {
      icao24: 'abc123',
      callsign: 'UAL123',
      code: '7700',
      meaning: 'General emergency',
      latitude: 1,
      longitude: 2,
    },
  ];
  assert.equal(emitSquawkEmergencies(target, 'flights', alerts), 1);
  assert.deepEqual(seen, [{ layerId: 'flights', ...alerts[0] }]);
  assert.equal(emitSquawkEmergencies(null, 'flights', alerts), 0);
  assert.equal(emitSquawkEmergencies(target, 'flights', []), 0);
});
