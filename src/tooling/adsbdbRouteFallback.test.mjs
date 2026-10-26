import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

// The proxy reads its disk cache from process.cwd() when the module loads, so
// run from a fresh directory to keep the repository's .gev-cache out of it.
process.chdir(mkdtempSync(path.join(os.tmpdir(), 'adsbdb-route-test-')));
const { adsbdbProxy, parseRouteset } = await import('../../server/providers/aircraft/enrichment.js');

const ROUTESET_OK = [
  {
    callsign: 'THY5040',
    plausible: 1,
    _airports: [
      { iata: 'IST', icao: 'LTFM', location: 'Istanbul', name: 'Istanbul Airport', lat: 41.27, lon: 28.74, countryiso2: 'TR' },
      { iata: 'CAI', icao: 'HECA', location: 'Cairo', name: 'Cairo International', lat: 30.12, lon: 31.41, countryiso2: 'EG' },
    ],
  },
];

const ADSBDB_ROUTE = {
  response: {
    flightroute: {
      airline: { name: 'Pegasus' },
      origin: { iata_code: 'SAW', municipality: 'Istanbul', latitude: 40.9, longitude: 29.3 },
      destination: { iata_code: 'DXB', municipality: 'Dubai', latitude: 25.25, longitude: 55.36 },
    },
  },
};

/** Replace global fetch with a route table keyed by "METHOD host/path". */
function stubFetch(handler) {
  const calls = [];
  const original = globalThis.fetch;
  globalThis.fetch = async (url, init = {}) => {
    calls.push({ url: String(url), method: init.method || 'GET', body: init.body ? JSON.parse(init.body) : null });
    return handler(String(url), init);
  };
  return { calls, restore: () => { globalThis.fetch = original; } };
}

const json = (body, status = 200) => new Response(JSON.stringify(body), { status });

/** Drive the Vite middleware the way the dev server does. */
function harness() {
  let middleware;
  const plugin = adsbdbProxy();
  plugin.configureServer({
    middlewares: {
      use(route, handler) {
        assert.equal(route, '/api/adsbdb');
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

test('adsbdb route is used first and tagged as adsbdb', async () => {
  const stub = stubFetch(() => json(ADSBDB_ROUTE));
  try {
    const get = harness();
    const res = await get('/route/PGT100?lat=41.0&lon=29.0');
    assert.equal(res.status, 200);
    assert.equal(res.body.found, true);
    assert.equal(res.body.source, 'adsbdb');
    assert.equal(res.body.origin.code, 'SAW');
    assert.equal(stub.calls.length, 1, 'adsb.lol is not asked when adsbdb answers');
    assert.match(stub.calls[0].url, /api\.adsbdb\.com\/v0\/callsign\/PGT100$/);
  } finally {
    stub.restore();
  }
});

test('adsb.lol routeset fills in when adsbdb has no route, using the position', async () => {
  const stub = stubFetch((url) => (url.includes('adsbdb') ? json({}, 404) : json(ROUTESET_OK)));
  try {
    const res = await harness()('/route/THY5040?lat=30.9&lon=31.24');
    assert.equal(res.status, 200);
    assert.equal(res.body.found, true);
    assert.equal(res.body.source, 'adsb.lol');
    assert.equal(res.body.origin.code, 'IST');
    assert.equal(res.body.origin.name, 'Istanbul');
    assert.equal(res.body.destination.code, 'CAI');
    assert.equal(res.body.destination.name, 'Cairo');
    assert.equal(res.body.destination.lat, 30.12);
    assert.equal(res.body.legs.length, 2);
    const routeset = stub.calls.find((c) => c.url === 'https://api.adsb.lol/api/0/routeset');
    assert.equal(routeset.method, 'POST');
    assert.deepEqual(routeset.body, { planes: [{ callsign: 'THY5040', lat: 30.9, lng: 31.24 }] });
  } finally {
    stub.restore();
  }
});

test('multi-leg routesets keep every airport and take the first and last as ends', () => {
  const route = parseRouteset([
    {
      callsign: 'XYZ1',
      plausible: true,
      _airports: [
        { iata: 'AAA', location: 'A' },
        { iata: 'BBB', location: 'B' },
        { iata: 'CCC', location: 'C' },
      ],
    },
  ], 'XYZ1');
  assert.equal(route.origin.code, 'AAA');
  assert.equal(route.destination.code, 'CCC');
  assert.deepEqual(route.legs.map((a) => a.code), ['AAA', 'BBB', 'CCC']);
});

test('implausible, one-airport or uncoded routesets are rejected', () => {
  const airports = [{ iata: 'IST' }, { iata: 'CAI' }];
  assert.equal(parseRouteset([{ callsign: 'A', plausible: 0, _airports: airports }], 'A'), null);
  assert.equal(parseRouteset([{ callsign: 'A', plausible: '0', _airports: airports }], 'A'), null);
  assert.equal(parseRouteset([{ callsign: 'A', plausible: 1, _airports: [{ iata: 'IST' }] }], 'A'), null);
  assert.equal(parseRouteset([{ callsign: 'A', plausible: 1, _airports: [{ location: 'x' }, { iata: 'CAI' }] }], 'A'), null);
  assert.equal(parseRouteset([], 'A'), null);
  assert.equal(parseRouteset([{ callsign: 'A', plausible: '1', _airports: airports }], 'A').origin.code, 'IST');
});

test('an implausible routeset answers found:false and the miss is cached per callsign', async () => {
  const implausible = [{ callsign: 'THY5040', plausible: 0, _airports: ROUTESET_OK[0]._airports }];
  const stub = stubFetch((url) => (url.includes('adsbdb') ? json({}, 404) : json(implausible)));
  try {
    const get = harness();
    assert.deepEqual((await get('/route/THY5040?lat=30.9&lon=31.24')).body, { found: false });
    assert.deepEqual((await get('/route/THY5040?lat=30.9&lon=31.24')).body, { found: false });
    const routesets = stub.calls.filter((c) => c.url.includes('adsb.lol'));
    assert.equal(routesets.length, 1, 'the negative answer is served from cache');
  } finally {
    stub.restore();
  }
});

test('without a position the adsb.lol fallback is not asked', async () => {
  const stub = stubFetch(() => json({}, 404));
  try {
    const res = await harness()('/route/THY5040');
    assert.deepEqual(res.body, { found: false });
    assert.equal(stub.calls.some((c) => c.url.includes('adsb.lol')), false);
  } finally {
    stub.restore();
  }
});

test('out-of-range or malformed coordinates skip the fallback', async () => {
  const stub = stubFetch(() => json({}, 404));
  try {
    const get = harness();
    for (const q of ['?lat=95&lon=10', '?lat=10&lon=190', '?lat=abc&lon=10', '?lat=10', '?lat=&lon=']) {
      assert.deepEqual((await get(`/route/QTR22${q}`)).body, { found: false }, q);
    }
    assert.equal(stub.calls.some((c) => c.url.includes('adsb.lol')), false);
  } finally {
    stub.restore();
  }
});

test('an upstream failure is not cached, so the next request retries', async () => {
  let attempt = 0;
  const stub = stubFetch((url) => {
    if (url.includes('adsbdb')) return json({}, 404);
    attempt += 1;
    return attempt === 1 ? json({}, 503) : json(ROUTESET_OK);
  });
  try {
    const get = harness();
    const first = await get('/route/THY5040?lat=30.9&lon=31.24');
    assert.equal(first.status, 503);
    assert.deepEqual(first.body, { found: false, transient: true });
    const retry = await get('/route/THY5040?lat=30.9&lon=31.24');
    assert.equal(retry.status, 200);
    assert.equal(retry.body.found, true);
    assert.equal(retry.body.source, 'adsb.lol');
  } finally {
    stub.restore();
  }
});

/** Route for adsbdb and adsb.lol: each is a Response, an Error (thrown), or a function. */
function sources({ adsbdb, routeset }) {
  return (url) => {
    const reply = url.includes('adsbdb') ? adsbdb : routeset;
    if (reply instanceof Error) throw reply;
    return reply();
  };
}

const IMPLAUSIBLE = [{ callsign: 'THY5040', plausible: 0, _airports: ROUTESET_OK[0]._airports }];

test('adsbdb 5xx and an adsb.lol 503 answer 503 transient, and neither is negative-cached', async () => {
  let adsbdbCalls = 0;
  let routesetCalls = 0;
  const stub = stubFetch((url) => {
    if (url.includes('adsbdb')) {
      adsbdbCalls += 1;
      return json({}, 502);
    }
    routesetCalls += 1;
    return json({}, 503);
  });
  try {
    const get = harness();
    for (let i = 0; i < 2; i++) {
      const res = await get('/route/THY5040?lat=30.9&lon=31.24');
      assert.equal(res.status, 503);
      assert.deepEqual(res.body, { found: false, transient: true });
    }
    assert.equal(adsbdbCalls, 2, 'adsbdb 5xx is retried, not cached');
    assert.equal(routesetCalls, 2, 'adsb.lol 503 is retried, not cached');
  } finally {
    stub.restore();
  }
});

test('an adsbdb network error with an implausible adsb.lol answer is transient, not a miss', async () => {
  const stub = stubFetch(sources({
    adsbdb: new Error('socket hang up'),
    routeset: () => json(IMPLAUSIBLE),
  }));
  try {
    const res = await harness()('/route/THY5040?lat=30.9&lon=31.24');
    assert.equal(res.status, 503);
    assert.deepEqual(res.body, { found: false, transient: true });
  } finally {
    stub.restore();
  }
});

test('a 404 from adsbdb with a throwing adsb.lol is transient', async () => {
  const stub = stubFetch(sources({
    adsbdb: () => json({}, 404),
    routeset: new Error('connection reset'),
  }));
  try {
    const res = await harness()('/route/THY5040?lat=30.9&lon=31.24');
    assert.equal(res.status, 503);
    assert.deepEqual(res.body, { found: false, transient: true });
  } finally {
    stub.restore();
  }
});

test('an unavailable adsbdb with no position cannot be decided, so it is transient', async () => {
  const stub = stubFetch(() => json({}, 500));
  try {
    const res = await harness()('/route/THY5040');
    assert.equal(res.status, 503);
    assert.deepEqual(res.body, { found: false, transient: true });
  } finally {
    stub.restore();
  }
});

test('no route from either source, both answered definitively, is a cached found:false', async () => {
  const stub = stubFetch(sources({
    adsbdb: () => json({}, 404),
    routeset: () => json([]),
  }));
  try {
    const get = harness();
    for (let i = 0; i < 2; i++) {
      const res = await get('/route/THY5040?lat=30.9&lon=31.24');
      assert.equal(res.status, 200);
      assert.deepEqual(res.body, { found: false });
    }
    assert.equal(stub.calls.filter((c) => c.url.includes('adsb.lol')).length, 1);
  } finally {
    stub.restore();
  }
});

test('an adsbdb 5xx is covered by an adsb.lol route', async () => {
  const stub = stubFetch(sources({
    adsbdb: () => json({}, 500),
    routeset: () => json(ROUTESET_OK),
  }));
  try {
    const res = await harness()('/route/THY5040?lat=30.9&lon=31.24');
    assert.equal(res.status, 200);
    assert.equal(res.body.found, true);
    assert.equal(res.body.source, 'adsb.lol');
  } finally {
    stub.restore();
  }
});

test('callsigns must be 3-8 characters starting with a letter', async () => {
  const stub = stubFetch(() => json({}, 404));
  try {
    const get = harness();
    for (const cs of ['AB', '1ABC', 'A-B-C', 'TOOLONGCALL']) {
      assert.equal((await get(`/route/${cs}`)).status, 400, cs);
    }
    assert.equal((await get('/route/N123AB')).status, 200);
    assert.equal((await get('/route/ABC')).status, 200);
  } finally {
    stub.restore();
  }
});
