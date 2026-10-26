import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { promises as fsp } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  gpsJamProxy,
  GPS_JAM_REGIONS,
} from '../../server/providers/aircraft/gps-jam.js';

const MIN = 60_000;
const url = (lat, lon) =>
  `https://api.adsb.lol/v2/lat/${lat}/lon/${lon}/dist/250`;
const BALTIC = url(57, 21);
const KALININGRAD = url(54.7, 20.5);

/** Degraded aircraft (NIC 3) around a point, `total` of them, distinct hexes. */
function degraded(prefix, total, lat = 57.2, lon = 21.3) {
  return Array.from({ length: total }, (_, n) => ({
    hex: `${prefix}${n}`,
    lat,
    lon,
    alt_baro: 36000,
    nic: 3,
  }));
}

/** Stub upstream: `reply(href)` returns a Response; every call is recorded. */
function stubUpstream(reply = () => json({ ac: [] })) {
  const calls = [];
  const fetchImpl = async (href) => {
    calls.push(String(href));
    return reply(String(href));
  };
  return { fetchImpl, calls };
}

function json(body, status = 200) {
  return new Response(JSON.stringify(body), { status });
}

/** Injected clock shared by the proxy and the fake timers. */
function clockFrom(start = 1_000_000_000_000) {
  return {
    t: start,
    now() {
      return this.t;
    },
  };
}

/** Let pending promise chains (fetch, JSON parse, file writes) settle. */
async function settle() {
  for (let i = 0; i < 4; i++)
    await new Promise((resolve) => setImmediate(resolve));
}

function harness(plugin) {
  let middleware;
  plugin.configureServer({
    middlewares: {
      use(route, handler) {
        assert.equal(route, '/api/gps-jam');
        middleware = handler;
      },
    },
  });
  return async (search = '') => {
    const response = { status: 0, headers: {}, body: '' };
    response.writeHead = (status, headers) => {
      response.status = status;
      response.headers = headers;
    };
    response.end = (body) => {
      response.body = body;
    };
    await middleware({ url: `/${search}` }, response);
    return {
      status: response.status,
      headers: response.headers,
      body: JSON.parse(response.body),
    };
  };
}

/** Advance the shared clock and the fake interval timer together, one second at a time. */
async function advance(t, clock, ms) {
  for (let i = 0; i < ms / 1000; i++) {
    clock.t += 1000;
    t.mock.timers.tick(1000);
    await settle();
  }
}

function setup(t, { reply, cachePath } = {}) {
  t.mock.timers.enable({ apis: ['setInterval'] });
  const clock = clockFrom();
  const upstream = stubUpstream(reply);
  const file =
    cachePath ??
    path.join(os.tmpdir(), `gps-jam-test-${process.pid}-${Math.random()}.json`);
  t.after(() => fsp.rm(file, { force: true }));
  const get = harness(
    gpsJamProxy({
      fetchImpl: upstream.fetchImpl,
      cachePath: file,
      now: () => clock.now(),
    }),
  );
  return { clock, calls: upstream.calls, get, file };
}

test('polling does not start until the first request, then polls Baltic at once', async (t) => {
  const { clock, calls, get } = setup(t);
  await advance(t, clock, 60_000);
  assert.deepEqual(calls, []);

  const response = await get();
  await settle();
  assert.equal(response.status, 200);
  assert.equal(response.headers['Cache-Control'], 'no-store');
  assert.deepEqual(calls, [BALTIC]);
});

test('round-robin polls one region every 20 s and wraps around', async (t) => {
  const { clock, calls, get } = setup(t);
  await get();
  await advance(t, clock, 20_000);
  await advance(t, clock, 20_000);
  assert.deepEqual(calls.slice(0, 3), [BALTIC, KALININGRAD, url(43.5, 34)]);

  await advance(t, clock, 20_000 * (GPS_JAM_REGIONS.length - 3));
  assert.equal(calls.length, GPS_JAM_REGIONS.length);
  await advance(t, clock, 20_000);
  assert.equal(calls.length, GPS_JAM_REGIONS.length + 1);
  assert.equal(calls.at(-1), BALTIC);
});

test('a viewport joins the rotation rounded to 1 degree and expires after 15 min', async (t) => {
  const { clock, calls, get } = setup(t);
  const response = await get('?lat=10.4&lon=20.6');
  const viewport = response.body.regions.find((r) => r.name === 'Viewport');
  assert.deepEqual([viewport.lat, viewport.lon], [10, 21]);

  await advance(t, clock, 280_000);
  assert.ok(calls.includes(url(10, 21)), 'viewport polled in rotation');

  // Keep the endpoint active while the viewport lapses.
  for (let i = 0; i < 4; i++) {
    await advance(t, clock, 5 * MIN);
    await get();
  }
  const after = await get();
  assert.equal(
    after.body.regions.some((r) => r.name === 'Viewport'),
    false,
  );
});

test('at most three viewports; the oldest is evicted first', async (t) => {
  const { get } = setup(t);
  for (const [lat, lon] of [
    [1, 1],
    [2, 2],
    [3, 3],
    [4, 4],
  ])
    await get(`?lat=${lat}&lon=${lon}`);
  const { body } = await get();
  const viewports = body.regions.filter((r) => r.name === 'Viewport');
  assert.deepEqual(
    viewports.map((r) => [r.lat, r.lon]),
    [
      [2, 2],
      [3, 3],
      [4, 4],
    ],
  );
});

test('polling stops once the endpoint has been idle for more than 10 min', async (t) => {
  const { clock, calls, get } = setup(t);
  await get();
  await advance(t, clock, 11 * MIN);
  const atIdle = calls.length;
  assert.ok(atIdle > 0);
  await advance(t, clock, 15 * MIN);
  assert.equal(calls.length, atIdle);

  // A new request restarts polling.
  await get();
  await settle();
  assert.equal(calls.length, atIdle + 1);
});

test('an upstream error backs its region off for 5 min and logs once per 10 min', async (t) => {
  const warnings = [];
  t.mock.method(console, 'warn', (...args) => warnings.push(args.join(' ')));
  const { clock, calls, get } = setup(t, {
    reply: (href) =>
      href === BALTIC ? new Response('no', { status: 500 }) : json({ ac: [] }),
  });
  // Keep the endpoint active (a request every 5 min) so polling continues.
  const keepActive = async (ms) => {
    for (let left = ms; left > 0; left -= 5 * MIN) {
      await advance(t, clock, Math.min(5 * MIN, left));
      await get();
    }
  };
  await get();
  const baltic = () => calls.filter((href) => href === BALTIC).length;
  assert.equal(baltic(), 1);

  await keepActive(290_000);
  assert.equal(baltic(), 1, 'no retry inside the 5 min backoff');

  // The rotation reaches Baltic again at 540 s, after its backoff has ended.
  await keepActive(270_000); // t = 560 s
  assert.equal(baltic(), 2, 'retried once the backoff expired');
  assert.equal(
    warnings.length,
    1,
    'second failure within 10 min is not logged',
  );

  // The rotation skips Baltic at 820 s, so the next retry is at 1080 s. That
  // failure is more than 10 min after the first log, so it is logged again.
  await keepActive(300_000); // t = 860 s
  assert.equal(baltic(), 2, 'still backing off after the 840 s slot');
  await keepActive(240_000); // t = 1100 s
  assert.equal(baltic(), 3);
  assert.equal(warnings.length, 2);
  assert.match(warnings[0], /Baltic/);
  assert.doesNotMatch(
    warnings[0],
    /api\.adsb\.lol/,
    'logs never carry the upstream URL',
  );

  const { body } = await get();
  const region = body.regions.find((r) => r.name === 'Baltic');
  assert.equal(region.ok, false);
});

test('response shape carries the inference labels and cells once aircraft are sampled', async (t) => {
  const { get } = setup(t, {
    reply: (href) =>
      href === BALTIC ? json({ ac: degraded('g', 6) }) : json({ ac: [] }),
  });
  await get();
  await settle();
  const { body } = await get('?window=24');
  assert.equal(body.windowHours, 24);
  assert.equal(body.cellDeg, 1);
  assert.equal(body.active, true);
  assert.equal(body.source, 'adsb.lol (ODbL)');
  assert.match(body.note, /Inferred from aircraft GPS-quality broadcasts/);
  assert.match(
    body.method,
    /over the last 24 h; cells need at least 5 aircraft\./,
  );
  assert.equal(body.regions.length, GPS_JAM_REGIONS.length);
  assert.deepEqual(
    body.cells.map((c) => [
      c.lat,
      c.lon,
      c.aircraft,
      c.degraded,
      c.ratio,
      c.level,
    ]),
    [[57, 21, 6, 6, 1, 'high']],
  );
  const { body: sixHours } = await get();
  assert.equal(sixHours.windowHours, 6);
  assert.match(
    sixHours.method,
    /over the last 6 h; cells need at least 5 aircraft\./,
  );
});

test('bad lat, lon or window return 400 without touching upstream', async (t) => {
  const { calls, get } = setup(t);
  for (const search of [
    '?lat=abc&lon=1',
    '?lat=91&lon=1',
    '?lat=1&lon=181',
    '?lat=1',
    '?lon=1',
    '?lat=&lon=',
    '?window=3',
    '?window=abc',
  ]) {
    const response = await get(search);
    assert.equal(response.status, 400, search);
  }
  assert.deepEqual(calls, []);
});

test('persisted grid reloads in a new instance and serves cells before polling', async (t) => {
  const { clock, get, file } = setup(t, {
    reply: (href) =>
      href === BALTIC ? json({ ac: degraded('p', 6) }) : json({ ac: [] }),
  });
  await get();
  await settle();
  // File writes run on the libuv thread pool, so wait in real time (up to
  // 2 s) rather than a fixed number of event-loop turns.
  for (let i = 0; i < 200 && !existsSync(file); i++)
    await new Promise((resolve) => setTimeout(resolve, 10));
  assert.ok(existsSync(file), 'grid written to the cache path');

  const restarted = harness(
    gpsJamProxy({
      fetchImpl: stubUpstream(() => json({ ac: [] })).fetchImpl,
      cachePath: file,
      now: () => clock.now(),
    }),
  );
  const { body } = await restarted('?window=24');
  assert.deepEqual(
    body.cells.map((c) => [c.lat, c.lon, c.aircraft]),
    [[57, 21, 6]],
  );
  const saved = JSON.parse(await fsp.readFile(file, 'utf8'));
  assert.equal(saved.cellDeg, 1);
});
