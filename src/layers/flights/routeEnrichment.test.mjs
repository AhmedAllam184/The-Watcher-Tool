import test from 'node:test';
import assert from 'node:assert/strict';
import { createFlightState } from './state.js';
import {
  createEnrichment,
  rememberRouteOutcome,
  ROUTE_OUTCOME_CAP,
  ROUTE_RETRY_MS,
} from './enrichment.js';
import { createFlightSource } from '../../sources/live/standalone.js';
import { ENRICH_DISPATCH_GAP_MS } from './policy.js';

const HEX = 'abc123';
const CALLSIGN = 'UAL123';
const ROUTE_ANSWER = {
  found: true,
  origin: { code: 'IST', name: 'Istanbul', lat: 41.2, lon: 28.7 },
  destination: { code: 'CAI', name: 'Cairo', lat: 30.1, lon: 31.4 },
  airline: 'Turkish',
};

function services() {
  const names = [
    'picking',
    'sprites',
    'trails',
    'aircraftPresentation',
    'camera',
    'militaryRegistry',
    'labels',
    'groundFloor',
    'meshFloor',
    'geoid',
    'focus',
    'readout',
    'context',
    'render',
    'recession',
  ];
  return {
    ...Object.fromEntries(names.map((name) => [name, {}])),
    groundSnap: { createGroundSnap: () => ({ clear() {} }) },
  };
}

const json = (body, status = 200) =>
  new Response(JSON.stringify(body), { status });

/** Let the fetch, JSON parse and queue promise chains settle. */
async function settle() {
  for (let i = 0; i < 8; i++)
    await new Promise((resolve) => setImmediate(resolve));
}

/**
 * A tracked flight wired to the real flights source. `reply(n)` answers the
 * n-th upstream call (1-based); a thrown reply stands for a network failure.
 */
function routeHarness(t, reply) {
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'], now: 1_000_000 });
  const calls = [];
  const source = createFlightSource({
    fetchImpl: async (href) => {
      calls.push(String(href));
      return reply(calls.length);
    },
  });
  const flightState = createFlightState({ source, services: services() });
  flightState.records.data.set(HEX, {
    callsign: CALLSIGN,
    rawLat: 41,
    rawLon: 29,
    route: null,
    routeStatus: null,
  });
  flightState._trackedIcao = HEX;
  const enrichment = createEnrichment({ flightState, services: {}, parts: {} });
  const meta = () => flightState.records.data.get(HEX);
  // Each selection comes after the drip gap, so the dispatch is not parked.
  const request = () => {
    t.mock.timers.tick(ENRICH_DISPATCH_GAP_MS);
    enrichment._requestRouteEnrichment(HEX);
  };
  t.after(() => flightState.lifetime.abort());
  return { flightState, calls, meta, request };
}

test('a transient HTTP 503 is not cached; the retry after 60 s shows the route', async (t) => {
  const { flightState, calls, meta, request } = routeHarness(t, (n) =>
    n === 1 ? json({ found: false, transient: true }, 503) : json(ROUTE_ANSWER),
  );
  request();
  await settle();
  assert.equal(calls.length, 1);
  assert.equal(meta().routeStatus, 'unknown');
  assert.equal(meta().route, null);
  assert.equal(flightState._routeOutcomes.has(CALLSIGN), false);
  assert.equal(flightState._enrichSeen.has(`r:${CALLSIGN}`), false);

  t.mock.timers.tick(ROUTE_RETRY_MS);
  await settle();
  assert.equal(calls.length, 2, 'asked again while still tracked');
  assert.equal(meta().routeStatus, 'known');
  assert.equal(meta().route.origin.code, 'IST');
  assert.equal(meta().route.destination.code, 'CAI');
  assert.equal(meta().airline, 'Turkish');
});

test('a network error is transient too, and the next selection asks again', async (t) => {
  const { calls, meta, request } = routeHarness(t, (n) => {
    if (n === 1) throw new TypeError('fetch failed');
    return json(ROUTE_ANSWER);
  });
  request();
  await settle();
  assert.equal(calls.length, 1);
  assert.equal(meta().routeStatus, 'unknown');

  request(); // the user selects the plane again before the 60 s retry
  await settle();
  assert.equal(calls.length, 2);
  assert.equal(meta().routeStatus, 'known');
});

test('a 200 payload flagged transient:true is not a permanent miss', async (t) => {
  const { flightState, calls, meta, request } = routeHarness(t, (n) =>
    n === 1 ? json({ found: false, transient: true }) : json(ROUTE_ANSWER),
  );
  request();
  await settle();
  assert.equal(flightState._routeOutcomes.has(CALLSIGN), false);

  request();
  await settle();
  assert.equal(calls.length, 2);
  assert.equal(meta().routeStatus, 'known');
});

test('a retry does not fire once the plane is no longer tracked', async (t) => {
  const { flightState, calls, request } = routeHarness(t, () =>
    json({ found: false, transient: true }, 503),
  );
  request();
  await settle();
  flightState._trackedIcao = null;
  t.mock.timers.tick(ROUTE_RETRY_MS);
  await settle();
  assert.equal(calls.length, 1);
});

test('a definitive {found:false} miss is cached for the session', async (t) => {
  const { flightState, calls, meta, request } = routeHarness(t, () =>
    json({ found: false }),
  );
  request();
  await settle();
  assert.equal(flightState._routeOutcomes.get(CALLSIGN), null);
  assert.equal(meta().routeStatus, 'unknown');

  request();
  t.mock.timers.tick(ROUTE_RETRY_MS);
  await settle();
  assert.equal(calls.length, 1, 'no repeat request for a settled miss');
  assert.equal(meta().routeStatus, 'unknown');
});

test('the route outcome memory is capped and drops the oldest callsign', () => {
  assert.equal(ROUTE_OUTCOME_CAP, 2000);
  const outcomes = new Map();
  for (let n = 0; n < ROUTE_OUTCOME_CAP; n++)
    rememberRouteOutcome(outcomes, `C${n}`, null);
  assert.equal(outcomes.size, ROUTE_OUTCOME_CAP);

  rememberRouteOutcome(outcomes, 'NEWEST', null);
  assert.equal(outcomes.size, ROUTE_OUTCOME_CAP);
  assert.equal(outcomes.has('C0'), false, 'oldest entry dropped');
  assert.equal(outcomes.has('C1'), true);
  assert.equal(outcomes.has('NEWEST'), true);
});

test('re-settling a callsign refreshes its place in the capped memory', () => {
  const outcomes = new Map();
  rememberRouteOutcome(outcomes, 'A', null, 2);
  rememberRouteOutcome(outcomes, 'B', null, 2);
  rememberRouteOutcome(outcomes, 'A', null, 2);
  rememberRouteOutcome(outcomes, 'C', null, 2);
  assert.deepEqual([...outcomes.keys()], ['A', 'C']);
});
