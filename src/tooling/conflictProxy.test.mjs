import test from 'node:test';
import assert from 'node:assert/strict';
import { promises as fsp } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  ACLED_API_URL,
  GDELT_GEO_URL,
  acledCredentials,
  acledEventFromRow,
  conflictProxy,
  firstGdeltArticle,
  gdeltEventsFromGeoJson,
  inBbox,
  parseConflictQuery,
  roundBbox,
} from '../../server/providers/conflict.js';
import { WATCHER_USER_AGENT } from '../../server/providers/common/userAgent.js';

const KEY = 'secret-key-123';
const EMAIL = 'analyst@example.test';
const FETCHED = Date.UTC(2026, 9, 27, 12, 0, 0);

const ACLED_ROWS = [
  {
    event_id_cnty: 'SYR1234',
    event_date: '2026-10-26',
    event_type: 'Battles',
    sub_event_type: 'Armed clash',
    actor1: 'Militia A',
    actor2: 'Militia B',
    country: 'Syria',
    location: 'Deir ez-Zor',
    latitude: '35.3',
    longitude: '40.1',
    fatalities: '7',
    source: 'Example Wire',
  },
  {
    event_id_cnty: 'UKR9',
    event_date: '2026-10-26',
    event_type: 'Protests',
    sub_event_type: 'Peaceful protest',
    latitude: '50.4',
    longitude: '30.5',
    fatalities: '0',
  },
];

const GDELT_BODY = {
  type: 'FeatureCollection',
  features: [
    {
      type: 'Feature',
      geometry: { type: 'Point', coordinates: [34.31, 31.35] },
      properties: {
        name: 'Khan Younis, Gaza Strip',
        count: 4,
        html: '<a href="https://www.example-news.com/a1?x=1&amp;y=2" target="_blank">Strikes hit <b>Khan Younis</b></a>',
      },
    },
    {
      type: 'Feature',
      geometry: { type: 'Point', coordinates: [37.6, 47.9] },
      properties: {
        name: 'Donetsk',
        count: 1,
        html: '<a href="javascript:alert(1)">unsafe link</a>',
      },
    },
  ],
};

function json(body, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

/** Upstream stub: `reply(href)` returns a Response or throws; every call is recorded. */
function stubUpstream(
  reply = (href) =>
    json(
      href.startsWith(GDELT_GEO_URL)
        ? GDELT_BODY
        : { success: true, data: ACLED_ROWS },
    ),
) {
  const calls = [];
  const fetchImpl = async (href) => {
    calls.push(String(href));
    return reply(String(href));
  };
  return { fetchImpl, calls };
}

function clockFrom(start = FETCHED) {
  return {
    t: start,
    now() {
      return this.t;
    },
  };
}

/** Route the plugin's middleware and return a request function. */
function harness(plugin) {
  let middleware;
  plugin.configureServer({
    middlewares: {
      use(route, handler) {
        assert.equal(route, '/api/conflicts');
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
      raw: response.body,
      body: JSON.parse(response.body),
    };
  };
}

/** Capture console output for the duration of one callback. */
async function captureLogs(fn) {
  const lines = [];
  const original = {
    warn: console.warn,
    error: console.error,
    log: console.log,
  };
  for (const level of ['warn', 'error', 'log'])
    console[level] = (...args) => lines.push(args.map(String).join(' '));
  try {
    await fn();
  } finally {
    Object.assign(console, original);
  }
  return lines.join('\n');
}

function setup(t, { reply, env = {}, now = clockFrom(), cachePath } = {}) {
  const upstream = stubUpstream(reply);
  const file =
    cachePath ??
    path.join(
      os.tmpdir(),
      `conflict-test-${process.pid}-${Math.random()}.json`,
    );
  t.after(() => fsp.rm(file, { force: true }));
  const plugin = conflictProxy({
    fetchImpl: upstream.fetchImpl,
    cachePath: file,
    now: () => now.now(),
    env,
  });
  return { get: harness(plugin), calls: upstream.calls, now, file, plugin };
}

test('query parsing: days default to 1, only 1 and 7 are accepted, bbox is validated and rounded outward', () => {
  assert.deepEqual(parseConflictQuery(new URLSearchParams('')), {
    days: 1,
    bbox: null,
  });
  assert.equal(parseConflictQuery(new URLSearchParams('days=7')).days, 7);
  assert.deepEqual(parseConflictQuery(new URLSearchParams('days=2')), {
    error: 'invalid days',
  });
  assert.deepEqual(parseConflictQuery(new URLSearchParams('days=')), {
    error: 'invalid days',
  });
  assert.deepEqual(
    parseConflictQuery(new URLSearchParams('bbox=10.2,20.4,30.1,40.9')).bbox,
    [10, 20, 31, 41],
  );
  for (const bbox of [
    'a,b,c,d',
    '1,2,3',
    '10,20,5,40',
    '0,95,1,96',
    '-181,0,0,1',
  ]) {
    assert.deepEqual(
      parseConflictQuery(new URLSearchParams({ bbox })),
      { error: 'invalid bbox' },
      bbox,
    );
  }
  assert.deepEqual(roundBbox([-180, -90.2, 180, 89.1]), [-180, -90, 180, 90]);
  assert.equal(inBbox({ lat: 31, lon: 34 }, [30, 30, 40, 40]), true);
  assert.equal(inBbox({ lat: 50, lon: 34 }, [30, 30, 40, 40]), false);
  assert.equal(inBbox({ lat: 0, lon: 0 }, null), true);
});

test('ACLED rows keep the three conflict types and drop unusable positions', () => {
  const battle = acledEventFromRow(ACLED_ROWS[0]);
  assert.deepEqual(battle, {
    id: 'acled:SYR1234',
    lat: 35.3,
    lon: 40.1,
    date: '2026-10-26',
    type: 'Battles',
    subType: 'Armed clash',
    fatalities: 7,
    actors: ['Militia A', 'Militia B'],
    country: 'Syria',
    location: 'Deir ez-Zor',
    title: 'Armed clash · Deir ez-Zor',
    sourceName: 'Example Wire',
  });
  assert.equal(acledEventFromRow(ACLED_ROWS[1]), null, 'protests are not kept');
  assert.equal(acledEventFromRow({ ...ACLED_ROWS[0], latitude: '' }), null);
  assert.equal(acledEventFromRow({ ...ACLED_ROWS[0], longitude: '200' }), null);
  assert.equal(
    acledEventFromRow({ ...ACLED_ROWS[0], event_id_cnty: '' }),
    null,
  );
});

test('GDELT GeoJSON maps points to news-report events and keeps only http(s) article links', () => {
  const events = gdeltEventsFromGeoJson(GDELT_BODY, FETCHED);
  assert.equal(events.length, 2);
  assert.deepEqual(events[0], {
    id: 'gdelt:0:31.350:34.310',
    lat: 31.35,
    lon: 34.31,
    date: '2026-10-27',
    type: 'News report',
    articles: 4,
    actors: [],
    country: null,
    location: 'Khan Younis, Gaza Strip',
    title: 'Strikes hit Khan Younis',
    url: 'https://www.example-news.com/a1?x=1&y=2',
    sourceName: 'example-news.com',
  });
  assert.equal(
    events[1].url,
    undefined,
    'javascript: links are never passed on',
  );
  assert.equal(events[1].title, '1 news report near Donetsk');
  assert.equal(firstGdeltArticle(''), null);
  assert.throws(() => gdeltEventsFromGeoJson({}, FETCHED), {
    code: 'BAD_BODY',
  });
});

test('keyless: GDELT answers, is labelled unverified, and the fighting query is sent', async (t) => {
  const env = {};
  const { get, calls } = setup(t, { env });
  const response = await get('?days=1');
  assert.equal(response.status, 200);
  assert.equal(response.headers['Cache-Control'], 'no-store');
  assert.equal(response.body.source, 'gdelt');
  assert.equal(response.body.verified, false);
  assert.equal(response.body.events.length, 2);
  assert.match(response.body.note, /not verified events/);
  assert.equal(calls.length, 1);
  assert.ok(calls[0].startsWith(GDELT_GEO_URL));
  const url = new URL(calls[0]);
  assert.equal(url.searchParams.get('timespan'), '24h');
  assert.equal(url.searchParams.get('mode'), 'PointData');
  assert.equal(url.searchParams.get('format'), 'GeoJSON');
  assert.equal(url.searchParams.get('maxpoints'), '500');
  assert.match(url.searchParams.get('query'), /airstrike/);
});

test('ACLED is used when both values are set, keeps verified types only, and never exposes the secret', async (t) => {
  const { get, calls, file } = setup(t, {
    env: { ACLED_EMAIL: EMAIL, ACLED_KEY: KEY },
  });
  const logs = await captureLogs(async () => {
    const response = await get('?days=7');
    assert.equal(response.status, 200);
    assert.equal(response.body.source, 'acled');
    assert.equal(response.body.verified, true);
    assert.equal(response.body.days, 7);
    assert.deepEqual(
      response.body.events.map((event) => event.id),
      ['acled:SYR1234'],
    );
    assert.doesNotMatch(
      response.body.note + response.body.method,
      /secret|analyst/,
    );
    assert.doesNotMatch(response.raw, new RegExp(KEY));
    assert.doesNotMatch(response.raw, new RegExp(EMAIL));
  });
  assert.equal(logs, '');
  assert.equal(calls.length, 1);
  assert.ok(calls[0].startsWith(`${ACLED_API_URL}?`));
  const url = new URL(calls[0]);
  assert.equal(url.searchParams.get('key'), KEY);
  assert.equal(url.searchParams.get('email'), EMAIL);
  assert.equal(url.searchParams.get('event_date_where'), 'BETWEEN');
  assert.match(
    url.searchParams.get('event_date'),
    /^\d{4}-\d{2}-\d{2}\|\d{4}-\d{2}-\d{2}$/,
  );
  const disk = await fsp.readFile(file, 'utf8');
  assert.doesNotMatch(
    disk,
    new RegExp(KEY),
    'the cache never stores credentials',
  );
});

test('a single ACLED value does not switch the source; the secret stays out of logs on upstream failure', async (t) => {
  const partial = setup(t, { env: { ACLED_KEY: KEY } });
  const onlyKey = await partial.get('');
  assert.equal(onlyKey.body.source, 'gdelt', 'both values are required');

  const failing = setup(t, {
    env: { ACLED_EMAIL: EMAIL, ACLED_KEY: KEY },
    reply: () => new Response('forbidden', { status: 403 }),
  });
  const logs = await captureLogs(async () => {
    const response = await failing.get('');
    assert.equal(response.status, 503);
    assert.deepEqual(response.body, {
      error: 'conflict upstream unavailable',
      transient: true,
    });
    assert.doesNotMatch(response.raw, new RegExp(KEY));
  });
  assert.match(logs, /acled upstream failed \(HTTP_403\)/i);
  assert.doesNotMatch(logs, new RegExp(KEY));
  assert.doesNotMatch(logs, new RegExp(EMAIL));
});

test('the bounding box filters events on the server, and bad parameters are rejected before any fetch', async (t) => {
  const { get, calls } = setup(t);
  const inside = await get('?days=1&bbox=30,30,40,40');
  assert.equal(inside.status, 200);
  assert.deepEqual(
    inside.body.events.map((event) => event.location),
    ['Khan Younis, Gaza Strip'],
  );
  const bad = ['?days=3', '?bbox=1,2,3', '?bbox=10,10,5,20'];
  for (const search of bad) {
    const response = await get(search);
    assert.equal(response.status, 400, search);
  }
  assert.equal((await get('x')).status, 404);
  assert.equal(calls.length, 1, 'only the valid request reached upstream');
});

test('a cached window is reused for 15 min (GDELT) and refetched after it', async (t) => {
  const now = clockFrom();
  const { get, calls } = setup(t, { now });
  await get('');
  now.t += 14 * 60_000;
  await get('');
  assert.equal(calls.length, 1);
  now.t += 2 * 60_000;
  await get('');
  assert.equal(calls.length, 2);
});

test('transient upstream failures return 503 and are never cached', async (t) => {
  let attempt = 0;
  const { get, calls } = setup(t, {
    reply: () => {
      attempt += 1;
      if (attempt === 1) return new Response('busy', { status: 500 });
      if (attempt === 2) throw new TypeError('network down');
      return json(GDELT_BODY);
    },
  });
  const first = await captureLogs(async () => {
    const response = await get('');
    assert.equal(response.status, 503);
    assert.equal(response.body.transient, true);
  });
  assert.match(first, /gdelt upstream failed \(HTTP_500\)/);
  assert.equal((await get('')).status, 503);
  const recovered = await get('');
  assert.equal(recovered.status, 200);
  assert.equal(calls.length, 3, 'each failure left nothing cached');
});

test('concurrent misses for one window share a single upstream request', async (t) => {
  const { get, calls } = setup(t);
  const responses = await Promise.all([get(''), get(''), get(''), get('')]);
  assert.ok(responses.every((response) => response.status === 200));
  assert.equal(calls.length, 1);
});

test('the disk cache is written atomically and reloads in a new process', async (t) => {
  const cachePath = path.join(
    os.tmpdir(),
    `conflict-cache-${process.pid}-${Math.random()}.json`,
  );
  t.after(() => fsp.rm(cachePath, { force: true }));
  const first = setup(t, { cachePath });
  assert.equal((await first.get('')).status, 200);
  const dir = await fsp.readdir(path.dirname(cachePath));
  assert.equal(
    dir.filter(
      (name) =>
        name.startsWith(path.basename(cachePath)) && name.endsWith('.tmp'),
    ).length,
    0,
    'no temp file is left behind',
  );
  const reopened = setup(
    { after() {} },
    { cachePath, reply: () => new Response('down', { status: 500 }) },
  );
  const response = await reopened.get('');
  assert.equal(response.status, 200, 'answered from the persisted record');
  assert.equal(reopened.calls.length, 0);
});

test('user agent and endpoints match the project conventions', async (t) => {
  const { calls } = setup(t);
  const plugin = conflictProxy({
    fetchImpl: async (href, init) => {
      calls.push({ href: String(href), agent: init.headers['User-Agent'] });
      return json(GDELT_BODY);
    },
    cachePath: path.join(os.tmpdir(), `conflict-ua-${process.pid}.json`),
    env: {},
  });
  t.after(() =>
    fsp.rm(path.join(os.tmpdir(), `conflict-ua-${process.pid}.json`), {
      force: true,
    }),
  );
  await harness(plugin)('');
  assert.equal(calls.at(-1).agent, WATCHER_USER_AGENT);
  assert.equal(plugin.name, 'conflict-events-proxy');
  assert.equal(typeof plugin.configurePreviewServer, 'function');
});

test('credential parsing needs both values and trims them', () => {
  assert.equal(acledCredentials({}), null);
  assert.equal(acledCredentials({ ACLED_EMAIL: EMAIL }), null);
  assert.deepEqual(
    acledCredentials({ ACLED_EMAIL: ` ${EMAIL} `, ACLED_KEY: ` ${KEY} ` }),
    {
      email: EMAIL,
      key: KEY,
    },
  );
});

test('repeated cold and warm cycles give identical answers (10 rounds)', async (t) => {
  const answers = [];
  for (let round = 0; round < 10; round++) {
    const { get } = setup(t);
    const cold = await get('?days=7');
    const warm = await get('?days=7');
    answers.push(JSON.stringify([cold.body.events, warm.body.events]));
  }
  assert.equal(new Set(answers).size, 1);
});
