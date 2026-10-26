import test from 'node:test';
import assert from 'node:assert/strict';
import { createTripLine } from './tripLine.js';
import { tripSummary, formatAirborneSince } from '../../data/tripSummary.js';

const HEX = 'abc123';
const START = 1_700_000_000_000;
const AIRPORT_IST = { code: 'IST', name: 'Istanbul', lat: 41.2, lon: 28.7 };
const AIRPORT_CAI = { code: 'CAI', name: 'Cairo', lat: 30.1, lon: 31.4 };

/** A short, straight trace: enough fixes that the summary has work to do. */
function fixes(count = 40) {
  return Array.from({ length: count }, (_, n) => ({
    t: START + n * 30_000,
    lat: 41 - n * 0.05,
    lon: 29 + n * 0.02,
    altM: 10_000,
  }));
}

async function settle() {
  for (let i = 0; i < 6; i++)
    await new Promise((resolve) => setImmediate(resolve));
}

/**
 * A trip line over injected seams. `summarize` is a spy around the real
 * tripSummary, so tests can count how often the holding detection runs.
 */
function harness(
  t,
  { route = null, trace = () => ({ points: fixes(), startedAt: START }) } = {},
) {
  const clock = { t: START + 600_000 };
  const calls = [];
  const subject = { route };
  const tripLine = createTripLine({
    getViewer: () => null,
    fetchTrace: async () => trace(),
    getSubject: () => subject,
    now: () => clock.t,
    refreshMs: 60_000,
    summarize: (input) => {
      calls.push(input);
      return tripSummary(input);
    },
  });
  // start() arms a refresh interval; stop it so the test process can exit.
  t.after(() => tripLine.stop());
  return { tripLine, clock, calls, subject };
}

test('repeated summary() calls reuse the holding result instead of re-running detection', async (t) => {
  const { tripLine, clock, calls } = harness(t);
  tripLine.start(HEX);
  await settle();

  const first = tripLine.summary(HEX);
  for (let n = 0; n < 5; n++) tripLine.summary(HEX);
  assert.equal(calls.length, 1, 'detection ran once for this set of fixes');
  assert.match(first.holding, /./);

  clock.t += 120_000;
  const later = tripLine.summary(HEX);
  assert.equal(
    calls.length,
    1,
    'a later clock reading does not re-run detection',
  );
  assert.equal(later.holding, first.holding);
  assert.equal(
    later.airborneSince,
    formatAirborneSince(START, START + 720_000),
    'elapsed time stays current',
  );
});

test('the cached holding text matches a direct tripSummary call', async (t) => {
  const { tripLine, clock } = harness(t, {
    route: { origin: AIRPORT_IST, destination: AIRPORT_CAI },
  });
  tripLine.start(HEX);
  await settle();
  const direct = tripSummary({
    points: fixes(),
    startedAt: START,
    airports: [AIRPORT_IST, AIRPORT_CAI],
    nowMs: clock.t,
  });
  assert.deepEqual(tripLine.summary(HEX), direct);
  assert.deepEqual(tripLine.summary(HEX), direct);
});

test('a refreshed trace re-runs detection once for the new fixes', async (t) => {
  t.mock.timers.enable({ apis: ['setInterval'] });
  const { tripLine, calls } = harness(t);
  tripLine.start(HEX);
  await settle();
  tripLine.summary(HEX);
  tripLine.summary(HEX);
  assert.equal(calls.length, 1);

  // The one-minute refresh replaces the stored fixes with a new array.
  t.mock.timers.tick(60_000);
  await settle();
  tripLine.summary(HEX);
  tripLine.summary(HEX);
  assert.equal(calls.length, 2);
});

test('a route change re-runs detection so the airports are current', async (t) => {
  const { tripLine, calls, subject } = harness(t, {
    route: { origin: AIRPORT_IST, destination: AIRPORT_CAI },
  });
  tripLine.start(HEX);
  await settle();
  tripLine.summary(HEX);
  tripLine.summary(HEX);
  assert.equal(calls.length, 1);

  subject.route = { origin: AIRPORT_IST, destination: null };
  tripLine.overlayChanged(HEX);
  tripLine.summary(HEX);
  tripLine.summary(HEX);
  assert.equal(calls.length, 2);
  assert.deepEqual(
    calls[1].airports.map((a) => a.code),
    ['IST'],
  );
});

test('stop() and a new hex drop the cached result', async (t) => {
  const { tripLine, calls } = harness(t);
  tripLine.start(HEX);
  await settle();
  tripLine.summary(HEX);
  assert.equal(calls.length, 1);

  tripLine.stop();
  assert.deepEqual(tripLine.summary(HEX), { airborneSince: '', holding: '' });
  assert.equal(
    calls.length,
    1,
    'nothing is detected once the trip line is gone',
  );

  tripLine.start(HEX);
  await settle();
  tripLine.summary(HEX);
  assert.equal(calls.length, 2, 'the new trip starts from a fresh detection');
});

test('a different hex gets blank facts and never touches the cache', async (t) => {
  const { tripLine, calls } = harness(t);
  tripLine.start(HEX);
  await settle();
  assert.deepEqual(tripLine.summary('zzz999'), {
    airborneSince: '',
    holding: '',
  });
  assert.equal(calls.length, 0);
});
