import test from 'node:test';
import assert from 'node:assert/strict';
import {
  aircraftTraceProxy,
  decimatePoints,
  parseTraceFlight,
  traceUrls,
  TRACE_MAX_POINTS,
} from '../../server/providers/aircraft/trace.js';

const BASE = 1_700_000_000; // epoch seconds

/** A readsb trace body from [dt, alt] pairs with a fixed position. */
function trace(rows) {
  return {
    icao: 'abc123',
    timestamp: BASE,
    trace: rows.map(([dt, alt], i) => [dt, 30 + i * 0.001, 31 + i * 0.001, alt, 420, 90, 0, 0]),
  };
}

test('parseTraceFlight returns the fixes after the last ground point', () => {
  const body = trace([
    [0, 'ground'],
    [10, 'ground'],
    [20, 800],
    [30, 3000],
    [40, 'ground'],
    [50, 1500],
    [60, 2500],
  ]);
  const flight = parseTraceFlight(body);
  assert.equal(flight.points.length, 2);
  assert.deepEqual(flight.points.map((p) => p.altFt), [1500, 2500]);
  assert.equal(flight.startedAt, (BASE + 50) * 1000);
  assert.equal(flight.points[0].onGround, false);
  assert.equal(flight.points[0].t, (BASE + 50) * 1000);
});

test('parseTraceFlight cuts at a gap longer than 30 minutes', () => {
  const body = trace([
    [0, 1000],
    [60, 2000],
    [60 + 31 * 60, 5000], // 31 min later: a previous leg
    [60 + 31 * 60 + 30, 6000],
  ]);
  const flight = parseTraceFlight(body);
  assert.deepEqual(flight.points.map((p) => p.altFt), [5000, 6000]);
});

test('a gap of exactly 30 minutes does not cut the flight', () => {
  const body = trace([
    [0, 1000],
    [30 * 60, 2000],
  ]);
  assert.equal(parseTraceFlight(body).points.length, 2);
});

test('a trace that ends on the ground is an empty current flight', () => {
  const flight = parseTraceFlight(trace([[0, 900], [60, 'ground']]));
  assert.deepEqual(flight, { points: [], startedAt: null });
});

test('null altitudes are kept as null and rows without a position are skipped', () => {
  const body = trace([[0, 1000], [10, null]]);
  body.trace.push([20, null, null, 1000]);
  const flight = parseTraceFlight(body);
  assert.deepEqual(flight.points.map((p) => p.altFt), [1000, null]);
});

test('non-trace bodies parse to null', () => {
  assert.equal(parseTraceFlight({}), null);
  assert.equal(parseTraceFlight({ timestamp: 'x', trace: [] }), null);
});

test('long flights are decimated evenly to the cap, keeping both ends', () => {
  const rows = [];
  for (let i = 0; i < 10_000; i++) rows.push([i * 5, 10_000 + i]);
  const flight = parseTraceFlight({ timestamp: BASE, trace: rows.map(([dt, alt]) => [dt, 30, 31, alt]) });
  assert.equal(flight.points.length, TRACE_MAX_POINTS);
  assert.equal(flight.points[0].t, (BASE + 0) * 1000);
  assert.equal(flight.points.at(-1).t, (BASE + 9999 * 5) * 1000);
  assert.ok(flight.points[1].altFt > flight.points[0].altFt);
});

test('decimatePoints leaves short lists alone and picks evenly', () => {
  const list = Array.from({ length: 10 }, (_, i) => i);
  assert.equal(decimatePoints(list, 20), list);
  assert.deepEqual(decimatePoints(list, 4), [0, 3, 6, 9]);
});

test('traceUrls use the last two hex digits as the directory', () => {
  assert.deepEqual(traceUrls('ABC123'), [
    'https://globe.adsb.lol/data/traces/23/trace_full_abc123.json',
    'https://globe.adsb.lol/data/traces/23/trace_recent_abc123.json',
  ]);
});

/** Stub upstream by exact URL; each route returns a Response or throws. */
function stubUpstream(routes) {
  const calls = [];
  const fetchImpl = async (url, init = {}) => {
    calls.push({ url: String(url), headers: init.headers || {} });
    const route = routes[String(url)];
    if (!route) return new Response('', { status: 404 });
    if (route instanceof Error) throw route;
    return route();
  };
  return { fetchImpl, calls };
}

const jsonBody = (body, status = 200) => () => new Response(JSON.stringify(body), { status });

/** Drive the Vite middleware the way the dev server does (prefix already stripped). */
function harness(proxy) {
  let middleware;
  proxy.configureServer({
    middlewares: {
      use(route, handler) {
        assert.equal(route, '/api/aircraft/trace');
        middleware = handler;
      },
    },
  });
  return async (url) => {
    const response = { status: 0, body: '' };
    response.writeHead = (status) => { response.status = status; };
    response.end = (body) => { response.body = body; };
    await middleware({ url }, response);
    return { status: response.status, body: JSON.parse(response.body) };
  };
}

const FULL = 'https://globe.adsb.lol/data/traces/23/trace_full_abc123.json';
const RECENT = 'https://globe.adsb.lol/data/traces/23/trace_recent_abc123.json';

test('invalid hex is rejected before any upstream call', async () => {
  const { fetchImpl, calls } = stubUpstream({});
  const get = harness(aircraftTraceProxy({ fetchImpl }));
  for (const url of ['/?hex=nope', '/?hex=abc12', '/?', '/?hex=../../x']) {
    assert.equal((await get(url)).status, 400, url);
  }
  assert.equal((await get('/extra?hex=abc123')).status, 404);
  assert.equal(calls.length, 0);
});

test('the full trace is used when it exists, with the required headers', async () => {
  const { fetchImpl, calls } = stubUpstream({ [FULL]: jsonBody(trace([[0, 800], [60, 3000]])) });
  const res = await harness(aircraftTraceProxy({ fetchImpl }))('/?hex=ABC123');
  assert.equal(res.status, 200);
  assert.equal(res.body.hex, 'abc123');
  assert.equal(res.body.source, 'adsb.lol');
  assert.equal(res.body.points.length, 2);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].headers['User-Agent'], 'TheWatcher/1.0 (+https://github.com/AhmedAllam184/The-Watcher-Tool)');
  assert.equal(calls[0].headers.Accept, 'application/json');
});

test('the recent trace is tried when the full one is missing or fails', async () => {
  const missing = stubUpstream({ [RECENT]: jsonBody(trace([[0, 800]])) });
  const a = await harness(aircraftTraceProxy({ fetchImpl: missing.fetchImpl }))('/?hex=abc123');
  assert.equal(a.body.points.length, 1);
  assert.deepEqual(missing.calls.map((c) => c.url), [FULL, RECENT]);

  const failing = stubUpstream({ [FULL]: jsonBody({}, 500), [RECENT]: jsonBody(trace([[0, 900]])) });
  const b = await harness(aircraftTraceProxy({ fetchImpl: failing.fetchImpl }))('/?hex=abc123');
  assert.equal(b.body.points.length, 1);
});

test('a hex with no trace anywhere answers an empty flight', async () => {
  const { fetchImpl } = stubUpstream({});
  const res = await harness(aircraftTraceProxy({ fetchImpl }))('/?hex=abc123');
  assert.deepEqual(res.body, { hex: 'abc123', source: 'adsb.lol', points: [], startedAt: null });
});

test('upstream failure answers 502 and is not cached', async () => {
  let attempts = 0;
  const fetchImpl = async () => {
    attempts += 1;
    if (attempts <= 2) return new Response('', { status: 503 });
    return new Response(JSON.stringify(trace([[0, 2000]])), { status: 200 });
  };
  const get = harness(aircraftTraceProxy({ fetchImpl }));
  assert.equal((await get('/?hex=abc123')).status, 502);
  assert.equal((await get('/?hex=abc123')).body.points.length, 1);
});

test('answers are cached for 60 s and concurrent requests share one upstream call', async () => {
  let clock = 1_000_000;
  const { fetchImpl, calls } = stubUpstream({ [FULL]: jsonBody(trace([[0, 800]])) });
  const get = harness(aircraftTraceProxy({ fetchImpl, now: () => clock }));
  const [first, second] = await Promise.all([get('/?hex=abc123'), get('/?hex=abc123')]);
  assert.equal(first.body.points.length, 1);
  assert.equal(second.body.points.length, 1);
  assert.equal(calls.length, 1, 'single-flight');
  clock += 59_000;
  await get('/?hex=abc123');
  assert.equal(calls.length, 1, 'fresh cache hit');
  clock += 2_000;
  await get('/?hex=abc123');
  assert.equal(calls.length, 2, 'refetched after 60 s');
});

test('a stale answer is served when upstream fails later', async () => {
  let clock = 1_000_000;
  let fail = false;
  const fetchImpl = async () => {
    if (fail) throw new Error('socket hang up');
    return new Response(JSON.stringify(trace([[0, 2100]])), { status: 200 });
  };
  const get = harness(aircraftTraceProxy({ fetchImpl, now: () => clock }));
  assert.equal((await get('/?hex=abc123')).body.points[0].altFt, 2100);
  clock += 61_000;
  fail = true;
  const res = await get('/?hex=abc123');
  assert.equal(res.status, 200);
  assert.equal(res.body.points[0].altFt, 2100);
});
