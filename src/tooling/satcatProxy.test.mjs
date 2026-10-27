import test from 'node:test';
import assert from 'node:assert/strict';
import { promises as fsp } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  orbitClassOf,
  parseSatcatRecord,
  rcsSizeOf,
  satcatProxy,
} from '../../server/providers/space/satcat.js';
import { WATCHER_USER_AGENT } from '../../server/providers/common/userAgent.js';

const DAY = 24 * 3600_000;

/** A SATCAT row shaped like CelesTrak's JSON: every value is a string. */
const ROW = {
  OBJECT_NAME: 'SAMPLE-1',
  OBJECT_ID: '2004-012A',
  NORAD_CAT_ID: '28228',
  OBJECT_TYPE: 'PAY',
  OPS_STATUS_CODE: '+',
  OWNER: 'PRC',
  LAUNCH_DATE: '2004-04-18',
  LAUNCH_SITE: 'JSC',
  DECAY_DATE: '',
  PERIOD: '102.1',
  INCLINATION: '98.6',
  APOGEE: '883',
  PERIGEE: '870',
  RCS: '0.05',
  DATA_STATUS_CODE: '',
  ORBIT_CENTER: 'EA',
  ORBIT_TYPE: 'ORB',
};
const EXPECTED = {
  norad: 28228,
  name: 'SAMPLE-1',
  intlDesignator: '2004-012A',
  objectType: 'PAY',
  objectTypeText: 'Payload (working spacecraft)',
  status: '+',
  statusText: 'Operational',
  owner: { code: 'PRC', name: 'China' },
  launchDate: '2004-04-18',
  launchSite: { code: 'JSC', name: 'Jiuquan, China' },
  decayDate: null,
  periodMin: 102.1,
  inclinationDeg: 98.6,
  apogeeKm: 883,
  perigeeKm: 870,
  orbitClass: 'LEO',
  rcsM2: 0.05,
  rcsSize: 'small',
  source: 'CelesTrak SATCAT',
};

/** Fake CelesTrak: every request goes to `handler(url, init)`, which returns a Response or throws. */
function stubCelestrak(handler) {
  const calls = [];
  const fetchImpl = async (url, init = {}) => {
    calls.push({ url: String(url), headers: init.headers || {}, signal: init.signal });
    return handler(String(url), init);
  };
  return { fetchImpl, calls };
}

function jsonBody(body, status = 200) {
  return () => new Response(JSON.stringify(body), { status });
}

function textBody(body, status = 200) {
  return () => new Response(body, { status });
}

/** A fresh proxy with an isolated (absent) disk cache and an injectable clock. */
function proxy(fetchImpl, { cachePath, clock } = {}) {
  return satcatProxy({
    fetchImpl,
    cachePath:
      cachePath ??
      path.join(os.tmpdir(), `satcat-test-${process.pid}-${Math.random()}.json`),
    now: clock ?? (() => Date.now()),
  });
}

/** Drive the Vite middleware the way the dev server does (prefix already stripped). */
function harness(plugin) {
  let middleware;
  plugin.configureServer({
    middlewares: {
      use(route, handler) {
        assert.equal(route, '/api/satellites/info');
        middleware = handler;
      },
    },
  });
  return async (url) => {
    const response = { status: 0, headers: {}, body: '' };
    response.writeHead = (status, headers) => {
      response.status = status;
      response.headers = headers;
    };
    response.end = (body) => {
      response.body = body;
    };
    await middleware({ url }, response);
    return { status: response.status, body: JSON.parse(response.body) };
  };
}

test('invalid NORAD numbers are rejected before any upstream call', async () => {
  const { fetchImpl, calls } = stubCelestrak(jsonBody([]));
  const get = harness(proxy(fetchImpl));
  for (const url of [
    '/?norad=abc',
    '/?norad=',
    '/?',
    '/?norad=0',
    '/?norad=-5',
    '/?norad=12.5',
    '/?norad=1234567890',
    '/?norad=../../x',
  ]) {
    const res = await get(url);
    assert.equal(res.status, 400, url);
    assert.deepEqual(res.body, { error: 'invalid norad' });
  }
  assert.equal(calls.length, 0);
});

test('unknown sub-path is a 404', async () => {
  const get = harness(proxy(stubCelestrak(jsonBody([])).fetchImpl));
  assert.equal((await get('/extra?norad=25544')).status, 404);
});

test('a SATCAT row is normalised with plain-language owner, type, status, launch and orbit', async () => {
  const { fetchImpl, calls } = stubCelestrak(jsonBody([ROW]));
  const res = await harness(proxy(fetchImpl))('/?norad=28228');
  assert.equal(res.status, 200);
  assert.deepEqual(res.body, { norad: 28228, satellite: EXPECTED });
  assert.equal(calls.length, 1);
  assert.equal(
    calls[0].url,
    'https://celestrak.org/satcat/records.php?CATNR=28228&FORMAT=JSON',
  );
  assert.equal(calls[0].headers['User-Agent'], WATCHER_USER_AGENT);
});

test('rows for another catalogue number are ignored', async () => {
  const { fetchImpl } = stubCelestrak(jsonBody([{ ...ROW, NORAD_CAT_ID: '99999' }]));
  const res = await harness(proxy(fetchImpl))('/?norad=28228');
  assert.deepEqual(res.body, { norad: 28228, satellite: null });
});

test('an empty catalogue answer is a cached miss: upstream is not asked again within a day', async () => {
  const { fetchImpl, calls } = stubCelestrak(textBody('[]'));
  const get = harness(proxy(fetchImpl));
  assert.deepEqual((await get('/?norad=12345')).body, { norad: 12345, satellite: null });
  assert.deepEqual((await get('/?norad=12345')).body, { norad: 12345, satellite: null });
  assert.equal(calls.length, 1);
});

test('upstream failures answer 503 transient and are never cached', async () => {
  let attempts = 0;
  const { fetchImpl, calls } = stubCelestrak(() => {
    attempts += 1;
    throw new Error('socket hang up');
  });
  const get = harness(proxy(fetchImpl));
  const first = await get('/?norad=28228');
  assert.equal(first.status, 503);
  assert.deepEqual(first.body, { error: 'satcat unavailable', transient: true });
  await get('/?norad=28228');
  assert.equal(attempts, 2, 'a failed lookup is retried on the next request');
  assert.equal(calls.length, 2);
});

test('an HTTP error or a non-JSON body is an upstream failure, not a record', async () => {
  const http = harness(proxy(stubCelestrak(textBody('nope', 503)).fetchImpl));
  assert.equal((await http('/?norad=28228')).status, 503);
  const html = harness(proxy(stubCelestrak(textBody('<html>maintenance</html>')).fetchImpl));
  const res = await html('/?norad=28228');
  assert.equal(res.status, 503);
  assert.equal(res.body.transient, true);
});

test('concurrent requests for one NORAD share a single upstream lookup', async () => {
  const { fetchImpl, calls } = stubCelestrak(jsonBody([ROW]));
  const get = harness(proxy(fetchImpl));
  const results = await Promise.all([
    get('/?norad=28228'),
    get('/?norad=28228'),
    get('/?norad=28228'),
  ]);
  assert.ok(results.every((r) => r.body.satellite?.owner?.name === 'China'));
  assert.equal(calls.length, 1);
});

test('a record is kept for seven days and a miss for one day', async () => {
  let clock = Date.UTC(2026, 9, 1);
  const { fetchImpl, calls } = stubCelestrak((url) =>
    url.includes('CATNR=28228') ? jsonBody([ROW])() : jsonBody([])(),
  );
  const get = harness(proxy(fetchImpl, { clock: () => clock }));
  await get('/?norad=28228');
  await get('/?norad=12345');
  clock += 2 * DAY;
  await get('/?norad=28228');
  await get('/?norad=12345');
  assert.equal(calls.length, 3, 'the record is still fresh; the miss has expired');
  clock += 6 * DAY;
  await get('/?norad=28228');
  assert.equal(calls.length, 4, 'a record expires after seven days');
});

test('records survive a restart through the disk cache with no upstream call', async (t) => {
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'satcat-test-'));
  t.after(() => fsp.rm(dir, { recursive: true, force: true }));
  const file = path.join(dir, 'satcat.json');
  t.mock.timers.enable({ apis: ['setInterval'] });
  const first = stubCelestrak(jsonBody([ROW]));
  await harness(proxy(first.fetchImpl, { cachePath: file }))('/?norad=28228');
  t.mock.timers.tick(15_000);
  for (let i = 0; i < 300; i++) {
    try {
      if (JSON.parse(await fsp.readFile(file, 'utf8')).records['28228']) break;
    } catch {
      /* not written yet */
    }
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  const second = stubCelestrak(jsonBody([]));
  const res = await harness(proxy(second.fetchImpl, { cachePath: file }))('/?norad=28228');
  assert.equal(res.body.satellite.owner.name, 'China');
  assert.equal(second.calls.length, 0);
  assert.deepEqual(await fsp.readdir(dir), ['satcat.json']);
});

test('the cache holds at most 20,000 records and the oldest go first', async (t) => {
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'satcat-test-'));
  t.after(() => fsp.rm(dir, { recursive: true, force: true }));
  const file = path.join(dir, 'satcat.json');
  t.mock.timers.enable({ apis: ['setInterval'] });
  const now = Date.now();
  const records = {};
  for (let i = 1; i <= 20005; i++) {
    records[String(i)] = { at: now - 1000 * (20005 - i), data: null };
  }
  await fsp.writeFile(file, JSON.stringify({ records }));
  const { fetchImpl } = stubCelestrak(jsonBody([]));
  await harness(proxy(fetchImpl, { cachePath: file }))('/?norad=99999');
  t.mock.timers.tick(15_000);
  let saved;
  for (let i = 0; i < 300; i++) {
    saved = JSON.parse(await fsp.readFile(file, 'utf8'));
    if (saved.records['99999']) break;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  assert.equal(Object.keys(saved.records).length, 20000);
  assert.equal(saved.records['1'], undefined, 'the oldest is evicted');
  assert.ok(saved.records['100'], 'newer entries stay');
});

test('expired disk entries are dropped on load', async (t) => {
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'satcat-test-'));
  t.after(() => fsp.rm(dir, { recursive: true, force: true }));
  const file = path.join(dir, 'satcat.json');
  await fsp.writeFile(
    file,
    JSON.stringify({
      records: {
        '1': { at: Date.now() - 8 * DAY, data: EXPECTED },
        '2': { at: Date.now() - DAY / 2, data: null },
      },
    }),
  );
  const { fetchImpl, calls } = stubCelestrak(jsonBody([]));
  const get = harness(proxy(fetchImpl, { cachePath: file }));
  assert.deepEqual((await get('/?norad=2')).body, { norad: 2, satellite: null });
  assert.equal(calls.length, 0, 'the fresh miss answered without upstream');
  await get('/?norad=1');
  assert.equal(calls.length, 1, 'the expired record is looked up again');
});

test('the upstream lookup carries an abort signal', async () => {
  const { fetchImpl, calls } = stubCelestrak(jsonBody([ROW]));
  await harness(proxy(fetchImpl))('/?norad=28228');
  assert.ok(calls[0].signal, 'an abort signal is attached');
  assert.equal(typeof calls[0].signal.aborted, 'boolean');
});

test('orbit family follows apogee, perigee and inclination', () => {
  assert.equal(orbitClassOf({ apogeeKm: 420, perigeeKm: 413, inclinationDeg: 51.6 }), 'LEO');
  assert.equal(orbitClassOf({ apogeeKm: 20230, perigeeKm: 20170, inclinationDeg: 55 }), 'MEO');
  assert.equal(orbitClassOf({ apogeeKm: 35800, perigeeKm: 35770, inclinationDeg: 0.1 }), 'GEO');
  assert.equal(orbitClassOf({ apogeeKm: 35800, perigeeKm: 35770, inclinationDeg: 60 }), 'HEO');
  assert.equal(orbitClassOf({ apogeeKm: 39700, perigeeKm: 480, inclinationDeg: 63 }), 'HEO');
  assert.equal(orbitClassOf({ apogeeKm: null, perigeeKm: 480, inclinationDeg: 63 }), null);
});

test('radar cross-section bands', () => {
  assert.equal(rcsSizeOf(0.05), 'small');
  assert.equal(rcsSizeOf(0.5), 'medium');
  assert.equal(rcsSizeOf(4), 'large');
  assert.equal(rcsSizeOf(null), null);
});

test('parseSatcatRecord keeps blank optional fields as null and ignores rows without a name', () => {
  const bare = parseSatcatRecord([{ ...ROW, OWNER: '', LAUNCH_SITE: '', RCS: '', OBJECT_TYPE: 'DEB' }], 28228);
  assert.equal(bare.owner, null);
  assert.equal(bare.launchSite, null);
  assert.equal(bare.rcsM2, null);
  assert.equal(bare.rcsSize, null);
  assert.equal(bare.objectTypeText, 'Debris');
  assert.equal(parseSatcatRecord([{ ...ROW, OBJECT_NAME: ' ' }], 28228), null);
  assert.equal(parseSatcatRecord({ not: 'an array' }, 28228), null);
});
