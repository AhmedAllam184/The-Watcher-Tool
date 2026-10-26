import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { promises as fsp } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  AIRPORT_WATCHLIST,
  airportWatchProxy,
} from '../../server/providers/aircraft/airport-watch.js';
import { WATCHER_USER_AGENT } from '../../server/providers/common/userAgent.js';

const MIN = 60_000;
const UNASSESSED = 'holding not assessed (sampled every ~16 min)';
const LHR = {
  icao: 'EGLL',
  iata: 'LHR',
  name: 'London Heathrow Airport',
  city: 'London',
  lat: 51.4706,
  lon: -0.4619,
};
const CDG = {
  icao: 'LFPG',
  iata: 'CDG',
  name: 'Paris Charles de Gaulle Airport',
  city: 'Paris',
  lat: 49.0097,
  lon: 2.5479,
};
const RUH = {
  icao: 'OERK',
  iata: 'RUH',
  name: 'King Khalid International Airport',
  city: 'Riyadh',
  lat: 24.9576,
  lon: 46.6988,
};
const JED = {
  icao: 'OEJN',
  iata: 'JED',
  name: 'King Abdulaziz International Airport',
  city: 'Jeddah',
  lat: 21.6796,
  lon: 39.1565,
};
const DXB = {
  icao: 'OMDB',
  iata: 'DXB',
  name: 'Dubai International Airport',
  city: 'Dubai',
  lat: 25.2532,
  lon: 55.3657,
};
const url = (airport) =>
  `https://api.adsb.lol/v2/lat/${airport.lat}/lon/${airport.lon}/dist/40`;

function json(body, status = 200) {
  return new Response(JSON.stringify(body), { status });
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

/** Injected clock shared by the proxy and the fake interval timer. */
function clockFrom(start = 1_000_000_000_000) {
  return {
    t: start,
    now() {
      return this.t;
    },
  };
}

/** Let pending promise chains (fetch, JSON parse) settle. */
async function settle() {
  for (let i = 0; i < 4; i++)
    await new Promise((resolve) => setImmediate(resolve));
}

function harness(plugin) {
  let middleware;
  plugin.configureServer({
    middlewares: {
      use(route, handler) {
        assert.equal(route, '/api/airports/status');
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

/**
 * Aircraft circling `center` at `radiusKm`, one full circle per `periodS`,
 * each with its own phase so several can hold at once.
 */
function circlers(clock, start, count, { radiusKm = 8, periodS = 120 } = {}) {
  return (airport) =>
    Array.from({ length: count }, (_, i) => {
      const seconds = (clock.t - start) / 1000;
      const angle = (2 * Math.PI * seconds) / periodS + (i * Math.PI) / 3;
      const lat = airport.lat + (radiusKm * Math.cos(angle)) / 111.2;
      const lon =
        airport.lon +
        (radiusKm * Math.sin(angle)) /
          (111.2 * Math.cos((airport.lat * Math.PI) / 180));
      return {
        hex: `c${i}`,
        flight: `HOLD${i}`,
        lat,
        lon,
        alt_baro: 9000,
        nic: 9,
        seen_pos: 1,
      };
    });
}

async function tempDir(t) {
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'airport-watch-test-'));
  t.after(async () => {
    // Let a pending cache write land before the directory goes.
    await new Promise((resolve) => setTimeout(resolve, 50));
    await fsp.rm(dir, { recursive: true, force: true });
  });
  return path.join(dir, 'airport-watch.json');
}

async function setup(
  t,
  {
    watchlist = [RUH],
    catalogue = [],
    reply,
    cachePath,
    start,
    clock: given,
  } = {},
) {
  t.mock.timers.enable({ apis: ['setInterval'] });
  const clock = given ?? clockFrom(start);
  const upstream = stubUpstream(reply);
  const file = cachePath ?? (await tempDir(t));
  const get = harness(
    airportWatchProxy({
      fetchImpl: upstream.fetchImpl,
      cachePath: file,
      now: () => clock.now(),
      watchlist,
      catalogue,
    }),
  );
  return { clock, calls: upstream.calls, get, file };
}

test('polling does not start until the first request, then polls the first airport at once', async (t) => {
  const { clock, calls, get } = await setup(t, { watchlist: [RUH, JED] });
  await advance(t, clock, 60_000);
  assert.deepEqual(calls, []);

  const response = await get();
  await settle();
  assert.equal(response.status, 200);
  assert.equal(response.headers['Cache-Control'], 'no-store');
  assert.deepEqual(calls, [url(RUH)]);
});

test('round-robin polls one base airport every 10 s and wraps around', async (t) => {
  const { clock, calls, get } = await setup(t, {
    watchlist: [RUH, JED, DXB],
  });
  await get();
  await advance(t, clock, 10_000);
  await advance(t, clock, 10_000);
  assert.deepEqual(calls, [url(RUH), url(JED), url(DXB)]);
  await advance(t, clock, 10_000);
  assert.equal(calls.at(-1), url(RUH));
});

/** Gaps between consecutive times, in ms. */
const gaps = (times) => times.slice(1).map((time, i) => time - times[i]);

test('a viewed airport is polled about every 60 s while the base keeps going', async (t) => {
  const start = 1_000_000_000_000;
  const clock = clockFrom(start);
  const polls = [];
  const { get } = await setup(t, {
    clock,
    watchlist: [RUH, DXB],
    catalogue: [JED],
    reply: (href) => {
      polls.push({ href, t: clock.t });
      return json({ ac: [] });
    },
  });
  await get('?codes=OEJN');
  await settle();
  await advance(t, clock, 5 * MIN);
  const viewed = polls.filter((p) => p.href === url(JED)).map((p) => p.t);
  const base = polls.filter((p) => p.href !== url(JED)).map((p) => p.t);
  assert.ok(
    viewed.length >= 4 && viewed.length <= 6,
    `viewed polls: ${viewed.length}`,
  );
  for (const gap of gaps(viewed)) {
    assert.ok(gap >= 50_000 && gap <= 75_000, `viewed gap ${gap} ms`);
  }
  assert.ok(base.length >= 8, 'the base kept being polled');
  assert.ok(Math.max(...gaps(base)) <= 30_000, 'no base gap over 30 s');
});

test('four priority airports do not starve the base: a base poll at least every 30 s', async (t) => {
  const start = 1_000_000_000_000;
  const clock = clockFrom(start);
  const polls = [];
  const viewed = [JED, DXB, LHR, CDG];
  const { get } = await setup(t, {
    clock,
    watchlist: [RUH],
    catalogue: viewed,
    reply: (href) => {
      polls.push({ href, t: clock.t });
      return json({ ac: [] });
    },
  });
  await get(`?codes=${viewed.map((a) => a.icao).join(',')}`);
  await settle();
  await advance(t, clock, 5 * MIN);
  const base = polls.filter((p) => p.href === url(RUH)).map((p) => p.t);
  assert.ok(base.length >= 9, `base polls: ${base.length}`);
  assert.ok(Math.max(...gaps(base)) <= 30_000, 'no base gap over 30 s');
  for (const airport of viewed) {
    const count = polls.filter((p) => p.href === url(airport)).length;
    assert.ok(count >= 4, `${airport.icao} polled ${count} times`);
  }
});

test('holding is not assessed until three polls are at most 3 min apart', async (t) => {
  const { clock, get } = await setup(t, { watchlist: [RUH] });
  let { body } = await get();
  await settle();
  assert.equal(body.airports[0].holdingReliable, false);
  assert.equal(body.airports[0].holding, null);
  assert.ok(body.airports[0].reasons.includes(UNASSESSED));

  await advance(t, clock, 10_000);
  await advance(t, clock, 10_000);
  ({ body } = await get());
  assert.equal(body.airports[0].holdingReliable, true, 'three dense samples');
  assert.equal(body.airports[0].holding, 0);
  assert.ok(!body.airports[0].reasons.includes(UNASSESSED));
});

test('codes name temporary airports that expire after 15 min', async (t) => {
  const { clock, get } = await setup(t, {
    watchlist: [RUH],
    catalogue: [JED],
  });
  const first = await get('?codes=oejn');
  assert.deepEqual(
    first.body.airports.map((a) => a.icao),
    ['OERK', 'OEJN'],
  );

  // Keep the endpoint active while the temporary airport lapses.
  for (let i = 0; i < 4; i++) {
    await advance(t, clock, 4 * MIN);
    await get();
  }
  const later = await get();
  assert.deepEqual(
    later.body.airports.map((a) => a.icao),
    ['OERK'],
  );
});

test('malformed or oversized codes return 400 without touching upstream', async (t) => {
  const { calls, get } = await setup(t);
  const nine = Array.from({ length: 9 }, (_, i) => `AB${10 + i}`).join(',');
  for (const search of [
    '?codes=abc',
    '?codes=OERK,',
    '?codes=OERK;OEJN',
    '?codes=',
    `?codes=${nine}`,
  ]) {
    const response = await get(search);
    assert.equal(response.status, 400, search);
  }
  assert.deepEqual(calls, []);
});

test('polling stops once the endpoint has been idle for more than 10 min', async (t) => {
  const { clock, calls, get } = await setup(t, { watchlist: [RUH, JED] });
  await get();
  await advance(t, clock, 11 * MIN);
  const atIdle = calls.length;
  assert.ok(atIdle > 0);
  await advance(t, clock, 15 * MIN);
  assert.equal(calls.length, atIdle);

  await get();
  await settle();
  assert.equal(calls.length, atIdle + 1);
});

test('a failing airport backs off for 5 min and is logged once', async (t) => {
  const warnings = [];
  t.mock.method(console, 'warn', (...args) => warnings.push(args.join(' ')));
  const { clock, calls, get } = await setup(t, {
    reply: () => new Response('no', { status: 500 }),
  });
  await get();
  assert.equal(calls.length, 1);
  await advance(t, clock, 4 * MIN);
  await get();
  assert.equal(calls.length, 1, 'no retry inside the 5 min backoff');
  await advance(t, clock, 90_000);
  await get();
  assert.equal(calls.length, 2, 'retried once the backoff expired');
  assert.equal(
    warnings.length,
    1,
    'second failure inside 10 min is not logged',
  );
  assert.match(warnings[0], /OERK/);
  assert.doesNotMatch(warnings[0], /api\.adsb\.lol/);
});

test('an airport never sampled successfully is unknown, not normal', async (t) => {
  const { get } = await setup(t, {
    reply: () => new Response('no', { status: 503 }),
  });
  const { body } = await get();
  const [airport] = body.airports;
  assert.equal(airport.level, 'unknown');
  assert.equal(airport.reasons[0], 'no successful poll yet');
  assert.equal(airport.holding, null);
  assert.equal(airport.degradedShare, null);
});

test('response carries the inference labels', async (t) => {
  const { get } = await setup(t);
  const { body } = await get();
  assert.equal(body.source, 'adsb.lol (ODbL)');
  assert.match(body.note, /Not official airport status\.$/);
  assert.match(body.method, /Holding:/);
  assert.ok(Number.isFinite(body.generatedAt));
});

/** Poll a fleet that circles RUH from the start, for `minutes` of injected time. */
async function circlingFleet(t, count, minutes) {
  const start = 1_000_000_000_000;
  const clock = clockFrom(start);
  const { get } = await setup(t, {
    start,
    reply: () => json({ ac: circlers(clock, start, count)(RUH) }),
  });
  await get();
  for (let i = 0; i < minutes * 2; i++) await advance(t, clock, 30_000);
  return (await get()).body.airports[0];
}

test('one circling aircraft rates the airport watch', async (t) => {
  // Three minutes of circling at a 15 s cadence: enough for a full hold.
  const one = await circlingFleet(t, 1, 3);
  assert.equal(one.holding, 1);
  assert.equal(one.level, 'watch');
  assert.deepEqual(one.reasons, ['1 aircraft holding']);
  assert.deepEqual(one.holdingCallsigns, ['HOLD0']);
});

test('an aircraft circling on the ground is not a hold', async (t) => {
  const start = 1_000_000_000_000;
  const clock = clockFrom(start);
  const { get } = await setup(t, {
    start,
    reply: () =>
      json({
        ac: circlers(
          clock,
          start,
          1,
        )(RUH).map((aircraft) => ({
          ...aircraft,
          alt_baro: 'ground',
        })),
      }),
  });
  await get();
  for (let i = 0; i < 6; i++) await advance(t, clock, 30_000);
  const { body } = await get();
  assert.equal(body.airports[0].holding, 0);
  assert.equal(body.airports[0].level, 'normal');
});

test('three circling aircraft rate the airport disrupted', async (t) => {
  const three = await circlingFleet(t, 3, 3);
  assert.equal(three.holding, 3);
  assert.equal(three.level, 'disrupted');
  assert.deepEqual(three.reasons, ['3 aircraft holding']);
});

test('degraded GPS share rates watch at 10% and disrupted at 25%, with 6 judged', async (t) => {
  const degraded = (n) =>
    Array.from({ length: n }, (_, i) => ({
      hex: `d${i}`,
      lat: RUH.lat + 0.01 * i,
      lon: RUH.lon,
      alt_baro: 36000,
      nic: 3,
      seen_pos: 1,
    }));
  const good = (n) =>
    Array.from({ length: n }, (_, i) => ({
      hex: `g${i}`,
      lat: RUH.lat - 0.01 * i,
      lon: RUH.lon,
      alt_baro: 36000,
      nic: 9,
      seen_pos: 1,
    }));
  const sample = [...degraded(2), ...good(4)];
  const { get } = await setup(t, { reply: () => json({ ac: sample }) });
  await get();
  await settle();
  const { body } = await get();
  const [share] = body.airports;
  assert.equal(share.judged, 6);
  assert.equal(share.degradedGps, 2);
  assert.equal(share.level, 'disrupted');
  assert.deepEqual(share.reasons, ['33% report degraded GPS', UNASSESSED]);
});

test('a 10% to 25% GPS share is watch', async (t) => {
  const sample = [
    {
      hex: 'w1',
      lat: RUH.lat,
      lon: RUH.lon,
      alt_baro: 36000,
      nic: 3,
      seen_pos: 1,
    },
    ...Array.from({ length: 5 }, (_, i) => ({
      hex: `w${i + 2}`,
      lat: RUH.lat + 0.01 * i,
      lon: RUH.lon,
      alt_baro: 36000,
      nic: 9,
      seen_pos: 1,
    })),
  ];
  const { get } = await setup(t, { reply: () => json({ ac: sample }) });
  await get();
  await settle();
  const { body } = await get();
  assert.equal(body.airports[0].level, 'watch');
  assert.deepEqual(body.airports[0].reasons, [
    '17% report degraded GPS',
    UNASSESSED,
  ]);
});

test('a GPS share is not rated on fewer than 6 judged aircraft', async (t) => {
  const sample = [
    {
      hex: 'x1',
      lat: RUH.lat,
      lon: RUH.lon,
      alt_baro: 36000,
      nic: 1,
      seen_pos: 1,
    },
    {
      hex: 'x2',
      lat: RUH.lat,
      lon: RUH.lon,
      alt_baro: 36000,
      nic: 1,
      seen_pos: 1,
    },
  ];
  const { get } = await setup(t, { reply: () => json({ ac: sample }) });
  await get();
  await settle();
  const { body } = await get();
  const [airport] = body.airports;
  assert.equal(airport.judged, 2);
  assert.equal(airport.degradedShare, 1);
  assert.equal(airport.level, 'normal');
  assert.deepEqual(airport.reasons, [UNASSESSED]);
});

test('the bundled watchlist resolves from the dataset, with KWI found by IATA', async (t) => {
  assert.equal(AIRPORT_WATCHLIST.length, 32);
  const { get, calls } = await setup(t, { watchlist: null });
  const { body } = await get();
  await settle();
  assert.equal(calls[0], url(RUH), 'Riyadh polled first');
  assert.equal(body.airports.length, AIRPORT_WATCHLIST.length);
  const kuwait = body.airports.find((a) => a.iata === 'KWI');
  assert.equal(kuwait.icao, 'OKKK');
  assert.equal(kuwait.city, 'Kuwait City');
  const riyadh = body.airports.find((a) => a.icao === 'OERK');
  assert.equal(riyadh.name, 'King Khalid International Airport');
  assert.equal(riyadh.level, 'unknown');
});

test('persisted samples reload in a new instance and keep their holding', async (t) => {
  const start = 1_000_000_000_000;
  const clock = clockFrom(start);
  const cachePath = await tempDir(t);
  t.mock.timers.enable({ apis: ['setInterval'] });
  const first = harness(
    airportWatchProxy({
      fetchImpl: stubUpstream(() =>
        json({ ac: circlers(clock, start, 1)(RUH) }),
      ).fetchImpl,
      cachePath,
      now: () => clock.now(),
      watchlist: [RUH],
    }),
  );
  await first();
  // Let the activation poll finish, so the 10 s ticks below are not skipped.
  await settle();
  await new Promise((resolve) => setTimeout(resolve, 20));
  // Three minutes: the saves at 60, 120 and 180 s; the last holds all 19 fixes.
  for (let i = 0; i < 18; i++) {
    clock.t += 10_000;
    t.mock.timers.tick(10_000);
    await settle();
    // Let each cache write finish: a save still in flight skips the next one.
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  // File writes run on the libuv thread pool. Wait in real time until the
  // cache holds the circle through the 180 s save.
  const fixesSaved = async () => {
    try {
      const saved = JSON.parse(await fsp.readFile(cachePath, 'utf8'));
      return saved.airports[0].tracks[0]?.[2].length ?? 0;
    } catch {
      return 0;
    }
  };
  for (let i = 0; i < 200 && (await fixesSaved()) < 19; i++)
    await new Promise((resolve) => setTimeout(resolve, 10));
  // Eight 45° turns need nine bearings, so ten fixes: the 330° threshold.
  assert.ok((await fixesSaved()) >= 19, 'the full circle reached the cache');

  const restarted = harness(
    airportWatchProxy({
      fetchImpl: stubUpstream(() => json({ ac: [] })).fetchImpl,
      cachePath,
      now: () => clock.now(),
      watchlist: [RUH],
    }),
  );
  // Restarted samples carry no poll history: holding is assessed again only
  // after three polls, so poll the restarted instance twice more first.
  await restarted();
  await settle();
  await new Promise((resolve) => setTimeout(resolve, 20));
  for (let i = 0; i < 2; i++) {
    clock.t += 10_000;
    t.mock.timers.tick(10_000);
    await settle();
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  const { body } = await restarted();
  assert.equal(body.airports[0].holdingReliable, true);
  assert.equal(body.airports[0].holding, 1);
  assert.equal(body.airports[0].level, 'watch');
});

/** Eight viewed airports, none on the watchlist. */
const VIEWED = Array.from({ length: 8 }, (_, i) => ({
  icao: `V${i + 1}AA`,
  iata: '',
  name: `Viewed airport ${i + 1}`,
  city: '',
  lat: 10 + i,
  lon: 20,
}));
const VIEWED_CODES = `?codes=${VIEWED.map((a) => a.icao).join(',')}`;

test('eight viewed airports are all polled within one base cycle', async (t) => {
  const start = 1_000_000_000_000;
  const clock = clockFrom(start);
  const polls = [];
  const { get } = await setup(t, {
    clock,
    watchlist: [RUH],
    catalogue: VIEWED,
    reply: (href) => {
      polls.push({ href, t: clock.t });
      return json({ ac: [] });
    },
  });
  await get(VIEWED_CODES);
  await settle();
  await advance(t, clock, 5 * MIN);
  for (const airport of VIEWED) {
    const first = polls.find((p) => p.href === url(airport));
    assert.ok(first, `${airport.icao} was never polled`);
    assert.ok(
      first.t - start <= 3 * MIN,
      `${airport.icao} first polled after ${(first.t - start) / 1000} s`,
    );
  }
});

test('a disrupted watchlist airport keeps its priority cadence when eight airports are viewed', async (t) => {
  const start = 1_000_000_000_000;
  const clock = clockFrom(start);
  const degraded = Array.from({ length: 6 }, (_, i) => ({
    hex: `d${i}`,
    lat: RUH.lat + 0.01 * i,
    lon: RUH.lon,
    alt_baro: 36000,
    nic: 3,
    seen_pos: 1,
  }));
  const polls = [];
  const { get } = await setup(t, {
    clock,
    watchlist: [RUH, JED, DXB],
    catalogue: VIEWED,
    reply: (href) => {
      polls.push({ href, t: clock.t });
      return json({ ac: href === url(RUH) ? degraded : [] });
    },
  });
  await get(VIEWED_CODES);
  await settle();
  await advance(t, clock, 2 * MIN);
  const { body } = await get();
  assert.equal(body.airports.find((a) => a.icao === 'OERK').level, 'disrupted');

  const from = clock.t;
  await advance(t, clock, 5 * MIN);
  const riyadh = polls
    .filter((p) => p.href === url(RUH) && p.t >= from)
    .map((p) => p.t);
  assert.ok(riyadh.length >= 4, `Riyadh polled ${riyadh.length} times`);
  assert.ok(
    Math.max(...gaps(riyadh)) <= 75_000,
    'priority cadence of about 60 s',
  );
});

test('a viewed airport outside the priority tier is never holding-reliable', async (t) => {
  const { clock, get } = await setup(t, {
    watchlist: [RUH],
    catalogue: VIEWED,
  });
  await get(VIEWED_CODES);
  await settle();
  await advance(t, clock, 6 * MIN);
  const { body } = await get();
  const byIcao = new Map(body.airports.map((a) => [a.icao, a]));
  // The first four viewed airports fill the priority tier, polled about every 60 s.
  for (const airport of VIEWED.slice(0, 4)) {
    assert.equal(byIcao.get(airport.icao).holdingReliable, true, airport.icao);
  }
  // The rest are only sampled on the base rotation.
  for (const airport of VIEWED.slice(4)) {
    const status = byIcao.get(airport.icao);
    assert.equal(status.holdingReliable, false, airport.icao);
    assert.equal(status.holding, null, airport.icao);
    assert.ok(status.reasons.includes(UNASSESSED), airport.icao);
    assert.ok(status.lastPolledAt !== null, `${airport.icao} is still sampled`);
  }
});

test('airport-watch identifies itself with the shared Watcher User-Agent', async (t) => {
  t.mock.timers.enable({ apis: ['setInterval'] });
  const headers = [];
  const plugin = airportWatchProxy({
    fetchImpl: async (href, init) => {
      headers.push(init.headers);
      return json({ ac: [] });
    },
    cachePath: await tempDir(t),
    now: () => 1_000_000_000_000,
    watchlist: [RUH],
  });
  const get = harness(plugin);
  await get();
  await settle();
  assert.equal(headers.length, 1);
  assert.equal(headers[0]['User-Agent'], WATCHER_USER_AGENT);
});
