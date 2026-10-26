import test from 'node:test';
import assert from 'node:assert/strict';
import { createSquawkAlerts } from './squawkAlerts.js';
import { SQUAWK_EMERGENCY_EVENT } from '../data/squawk.js';

function harness() {
  let clock = 1_000_000;
  const timers = [];
  const toasts = [];
  const target = new EventTarget();
  const alerts = createSquawkAlerts({
    showToast: (message) => toasts.push(message),
    target,
    now: () => clock,
    setTimer: (fn, ms) => {
      const timer = { fn, ms, cleared: false };
      timers.push(timer);
      return timer;
    },
    clearTimer: (timer) => {
      timer.cleared = true;
    },
  });
  const emit = (detail) =>
    target.dispatchEvent(
      new CustomEvent(SQUAWK_EMERGENCY_EVENT, { detail }),
    );
  const fire = () => {
    const pending = timers.filter((timer) => !timer.cleared && timer.fn);
    for (const timer of pending) {
      timer.cleared = true;
      timer.fn();
    }
  };
  return {
    alerts,
    target,
    toasts,
    timers,
    emit,
    fire,
    advance: (ms) => {
      clock += ms;
    },
  };
}

const alert = (code, callsign = 'UAL123') => ({
  layerId: 'flights',
  icao24: 'abc123',
  callsign,
  code,
  meaning: code === '7700' ? 'General emergency' : 'Radio failure',
});

test('the first emergency toasts immediately with the callsign, code and meaning', () => {
  const h = harness();
  h.emit(alert('7700'));
  assert.equal(h.timers.length, 1);
  assert.equal(h.timers[0].ms, 0);
  h.fire();
  assert.deepEqual(h.toasts, ['⚠ UAL123 squawking 7700 — General emergency']);
  h.alerts.destroy();
});

test('alerts inside the 10 s window coalesce into one toast with a +N more count', () => {
  const h = harness();
  h.emit(alert('7700', 'UAL123'));
  h.fire();
  h.advance(4000);
  h.emit(alert('7600', 'DAL9'));
  h.emit(alert('7500', 'AAL7'));
  h.emit(alert('7700', 'SWA5'));
  assert.equal(h.timers.length, 2, 'one follow-up timer for the queue');
  assert.equal(h.timers[1].ms, 6000, 'waits for the 10 s window to close');
  h.advance(6000);
  h.fire();
  assert.equal(h.toasts.length, 2);
  assert.equal(
    h.toasts[1],
    '⚠ DAL9 squawking 7600 — Radio failure (+2 more)',
  );
  h.alerts.destroy();
});

test('recent keeps the last 20 alerts and destroy removes the listener', () => {
  const h = harness();
  for (let index = 0; index < 22; index += 1) h.emit(alert('7700', `X${index}`));
  const recent = h.alerts.recent();
  assert.equal(recent.length, 20);
  assert.equal(recent[0].callsign, 'X2');
  assert.equal(recent[19].callsign, 'X21');
  h.alerts.destroy();
  h.emit(alert('7500'));
  assert.equal(h.alerts.recent().length, 20);
  assert.equal(h.timers.filter((timer) => !timer.cleared).length, 0);
});

test('destroy cancels a pending toast and ignores events without a code', () => {
  const h = harness();
  h.emit(alert('7700'));
  h.emit({ icao24: 'x' });
  h.alerts.destroy();
  assert.equal(h.timers[0].cleared, true);
  assert.deepEqual(h.toasts, []);
  assert.equal(h.alerts.recent().length, 1);
});
