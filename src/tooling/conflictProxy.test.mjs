import test from 'node:test';
import assert from 'node:assert/strict';
import { promises as fsp } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  ACLED_API_URL,
  acledCredentials,
  acledEventFromRow,
  conflictProxy,
  inBbox,
  parseConflictQuery,
  roundBbox,
} from '../../server/providers/conflict.js';
import {
  createGdeltFeed,
  QUICK_FILES,
} from '../../server/providers/conflict/gdeltFeed.js';
import { MIN_ARTICLES } from '../../server/providers/conflict/gdelt.js';
import { WATCHER_USER_AGENT } from '../../server/providers/common/userAgent.js';
import { buildZip } from './zipTestWriter.mjs';

const KEY = 'secret-key-123';
const EMAIL = 'analyst@example.test';
const FETCHED = Date.UTC(2026, 9, 27, 12, 0, 0);
const LATEST = Date.UTC(2026, 9, 27, 9, 15, 0);
const LATEST_STAMP = '20261027091500';
const HOUR = 3_600_000;

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

/** One 61-field GDELT export row with the named columns set. */
function gdeltRow(values) {
  const columns = {
    GLOBALEVENTID: 0,
    Actor1Name: 6,
    Actor2Name: 16,
    EventCode: 26,
    EventRootCode: 28,
    QuadClass: 29,
    NumMentions: 31,
    NumSources: 32,
    NumArticles: 33,
    ActionGeo_Type: 51,
    ActionGeo_FullName: 52,
    ActionGeo_Lat: 56,
    ActionGeo_Long: 57,
    DATEADDED: 59,
    SOURCEURL: 60,
  };
  const fields = Array(61).fill('');
  const base = {
    Actor1Name: 'MILITARY FORCE',
    EventCode: '195',
    EventRootCode: '19',
    QuadClass: '4',
    NumMentions: '4',
    ActionGeo_Type: '4',
    NumSources: '3',
    NumArticles: '4',
    ...values,
  };
  for (const [name, value] of Object.entries(base))
    fields[columns[name]] = String(value);
  return fields.join('\t');
}

/** The rows of one 15-minute file: two kept points, and three that must not pass. */
function gdeltCsv(stamp) {
  return [
    gdeltRow({
      GLOBALEVENTID: `${stamp}1`,
      ActionGeo_Lat: '31.3457',
      ActionGeo_Long: '34.3030',
      ActionGeo_FullName:
        'Khan Yunis, Khan Yunis, Gaza Strip, Palestinian Territory',
      SOURCEURL: 'https://www.example-news.com/a1?x=1&y=2',
      DATEADDED: stamp,
    }),
    gdeltRow({
      GLOBALEVENTID: `${stamp}2`,
      EventCode: '180',
      EventRootCode: '18',
      ActionGeo_Lat: '48.0',
      ActionGeo_Long: '37.8',
      ActionGeo_FullName: 'Donetsk, Donetsk, Ukraine',
      NumArticles: '2',
      NumSources: '1',
      SOURCEURL: 'https://news.example.org/b',
      DATEADDED: stamp,
    }),
    gdeltRow({ GLOBALEVENTID: `${stamp}3`, QuadClass: '3', DATEADDED: stamp }),
    gdeltRow({
      GLOBALEVENTID: `${stamp}4`,
      ActionGeo_Type: '1',
      DATEADDED: stamp,
    }),
    gdeltRow({
      GLOBALEVENTID: `${stamp}5`,
      NumArticles: '1',
      NumSources: '1',
      ActionGeo_Lat: '10',
      ActionGeo_Long: '10',
      DATEADDED: stamp,
    }),
  ].join('\n');
}

function json(body, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

/** The default upstream: lastupdate names LATEST, every file has rows, ACLED returns its rows. */
function defaultReply(href) {
  if (href.includes('/gdeltv2/lastupdate.txt'))
    return new Response(
      `2048 0f9a http://data.gdeltproject.org/gdeltv2/${LATEST_STAMP}.export.CSV.zip\n`,
    );
  const stamp = /\/(\d{14})\.export\.CSV\.zip/.exec(href)?.[1];
  if (stamp)
    return new Response(
      buildZip(`${stamp}.export.CSV`, `${gdeltCsv(stamp)}\n`),
      {
        status: 200,
      },
    );
  return json({ success: true, data: ACLED_ROWS });
}

/** Upstream stub: `reply(href)` returns a Response or throws; every call is recorded. */
function stubUpstream(reply = defaultReply) {
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

/** Timers that never fire on their own, so no background tick reaches a stub. */
const idleTimers = () => ({
  setTimeout: () => ({ unref() {} }),
  clearTimeout() {},
});

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
  const gdeltFile = file.replace(/\.json$/, '-gdelt.json');
  const feed = createGdeltFeed({
    fetchImpl: upstream.fetchImpl,
    now: () => now.now(),
    timers: idleTimers(),
    sleep: async () => {},
    cachePath: gdeltFile,
    log: () => {},
  });
  t.after(async () => {
    await feed.stop();
    await fsp.rm(file, { force: true });
    await fsp.rm(gdeltFile, { force: true });
  });
  const plugin = conflictProxy({
    fetchImpl: upstream.fetchImpl,
    cachePath: file,
    now: () => now.now(),
    env,
    gdelt: feed,
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

test('keyless: GDELT events come from the export files, are labelled unverified, and no GEO API is called', async (t) => {
  const { get, calls } = setup(t, {
    env: {},
    now: clockFrom(LATEST + 5 * 60_000),
  });
  const response = await get('?days=1');
  assert.equal(response.status, 200);
  assert.equal(response.headers['Cache-Control'], 'no-store');
  assert.equal(response.body.source, 'gdelt');
  assert.equal(response.body.verified, false);
  assert.match(response.body.note, /unverified/);
  assert.match(
    response.body.method,
    new RegExp(`MIN_ARTICLES = ${MIN_ARTICLES}`),
  );
  assert.equal(
    response.body.coverageHours,
    2.1,
    'the newest 8 files, 2 h, five minutes after the newest',
  );
  assert.equal(response.body.backfilling, true);
  assert.deepEqual(
    response.body.events.map((event) => [event.location, event.articles]),
    [
      [
        'Khan Yunis, Khan Yunis, Gaza Strip, Palestinian Territory',
        4 * QUICK_FILES,
      ],
      ['Donetsk, Donetsk, Ukraine', 2 * QUICK_FILES],
    ],
  );
  const khan = response.body.events[0];
  assert.equal(khan.type, 'Airstrike / aerial weapons');
  assert.equal(
    khan.title,
    'Airstrike / aerial weapons · Khan Yunis, Palestinian Territory',
  );
  assert.equal(khan.url, 'https://www.example-news.com/a1?x=1&y=2');
  assert.equal(khan.sourceName, 'example-news.com');
  assert.equal(
    calls[0],
    'https://data.gdeltproject.org/gdeltv2/lastupdate.txt',
  );
  assert.equal(calls.length, 1 + QUICK_FILES);
  assert.ok(
    calls
      .slice(1)
      .every((href) => /\/gdeltv2\/\d{14}\.export\.CSV\.zip$/.test(href)),
  );
  assert.ok(
    calls.every((href) => !href.includes('/api/v2/geo')),
    'the GEO API is not used',
  );
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
    assert.equal(
      'coverageHours' in response.body,
      false,
      'ACLED answers keep their shape',
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

test('a rejected ACLED key returns the reason, and the secret stays out of the body and the logs', async (t) => {
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
      reason: 'ACLED rejected the key (HTTP 403)',
    });
    assert.doesNotMatch(response.raw, new RegExp(KEY));
  });
  assert.match(
    logs,
    /\[conflict\] ACLED rejected the key \(HTTP 403\); nothing cached/,
  );
  assert.doesNotMatch(logs, new RegExp(KEY));
  assert.doesNotMatch(logs, new RegExp(EMAIL));
  assert.doesNotMatch(logs, /https?:\/\//, 'no URL in the log');
});

test('a single ACLED value does not switch the source away from GDELT', async (t) => {
  const partial = setup(t, { env: { ACLED_KEY: KEY } });
  const onlyKey = await partial.get('');
  assert.equal(onlyKey.body.source, 'gdelt', 'both values are required');
});

test('the bounding box filters events on the server, and bad parameters are rejected before any fetch', async (t) => {
  const { get, calls } = setup(t);
  const inside = await get('?days=1&bbox=30,30,40,40');
  assert.equal(inside.status, 200);
  assert.deepEqual(
    inside.body.events.map((event) => event.location),
    ['Khan Yunis, Khan Yunis, Gaza Strip, Palestinian Territory'],
  );
  const before = calls.length;
  const bad = ['?days=3', '?bbox=1,2,3', '?bbox=10,10,5,20'];
  for (const search of bad) {
    const response = await get(search);
    assert.equal(response.status, 400, search);
  }
  assert.equal((await get('x')).status, 404);
  assert.equal(
    calls.length,
    before,
    'the invalid requests reached no upstream',
  );
});

test('an ACLED window is reused for 1 h and refetched after it', async (t) => {
  const now = clockFrom();
  const { get, calls } = setup(t, {
    now,
    env: { ACLED_EMAIL: EMAIL, ACLED_KEY: KEY },
  });
  await get('');
  now.t += 59 * 60_000;
  await get('');
  assert.equal(calls.length, 1);
  now.t += 2 * 60_000;
  await get('');
  assert.equal(calls.length, 2);
});

test('transient upstream failures return 503 with the reason, and are never cached', async (t) => {
  let attempt = 0;
  const { get, calls } = setup(t, {
    env: { ACLED_EMAIL: EMAIL, ACLED_KEY: KEY },
    reply: () => {
      attempt += 1;
      if (attempt === 1) return new Response('busy', { status: 500 });
      if (attempt === 2) throw new TypeError('network down');
      return json({ success: true, data: ACLED_ROWS });
    },
  });
  const first = await captureLogs(async () => {
    const response = await get('');
    assert.equal(response.status, 503);
    assert.equal(response.body.transient, true);
    assert.equal(response.body.reason, 'ACLED HTTP 500');
  });
  assert.match(first, /\[conflict\] ACLED HTTP 500; nothing cached/);
  const second = await get('');
  assert.equal(second.body.reason, 'ACLED unreachable (network/DNS)');
  const recovered = await get('');
  assert.equal(recovered.status, 200);
  assert.equal(calls.length, 3, 'each failure left nothing cached');
});

test('GDELT feed failures return 503 with the reason, and the log names it without a URL', async (t) => {
  const { get } = setup(t, {
    reply: (href) =>
      href.includes('lastupdate')
        ? new Response('slow down', { status: 429 })
        : new Response('', { status: 500 }),
  });
  const logs = await captureLogs(async () => {
    const response = await get('?days=1');
    assert.equal(response.status, 503);
    assert.deepEqual(response.body, {
      error: 'conflict upstream unavailable',
      transient: true,
      reason: 'GDELT HTTP 429 (rate limited)',
    });
  });
  assert.match(
    logs,
    /\[conflict\] GDELT HTTP 429 \(rate limited\); nothing cached/,
  );
  assert.doesNotMatch(logs, /https?:\/\//);
});

test('concurrent misses share one feed start: one lastupdate and one set of quick files', async (t) => {
  const { get, calls } = setup(t);
  const responses = await Promise.all([get(''), get(''), get(''), get('')]);
  assert.ok(responses.every((response) => response.status === 200));
  assert.equal(calls.filter((href) => href.includes('lastupdate')).length, 1);
  assert.equal(
    calls.filter((href) => href.includes('.export.CSV.zip')).length,
    QUICK_FILES,
  );
});

test('the ACLED disk cache is written atomically and reloads in a new process', async (t) => {
  const cachePath = path.join(
    os.tmpdir(),
    `conflict-cache-${process.pid}-${Math.random()}.json`,
  );
  const env = { ACLED_EMAIL: EMAIL, ACLED_KEY: KEY };
  const first = setup(t, { cachePath, env });
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
  const reopened = setup(t, {
    cachePath,
    env,
    reply: () => new Response('down', { status: 500 }),
  });
  const response = await reopened.get('');
  assert.equal(response.status, 200, 'answered from the persisted record');
  assert.equal(reopened.calls.length, 0);
});

test('user agent and endpoints match the project conventions for both sources', async (t) => {
  const { calls, get, plugin } = setup(t);
  const agents = [];
  const recording = conflictProxy({
    fetchImpl: async (href, init) => {
      agents.push(init.headers['User-Agent']);
      return defaultReply(String(href));
    },
    cachePath: path.join(os.tmpdir(), `conflict-ua-${process.pid}.json`),
    env: {},
    gdelt: createGdeltFeed({
      fetchImpl: async (href, init) => {
        agents.push(init.headers['User-Agent']);
        return defaultReply(String(href));
      },
      now: () => FETCHED,
      timers: idleTimers(),
      sleep: async () => {},
      cachePath: path.join(
        os.tmpdir(),
        `conflict-ua-${process.pid}-gdelt.json`,
      ),
      log: () => {},
    }),
  });
  t.after(() =>
    Promise.all([
      fsp.rm(path.join(os.tmpdir(), `conflict-ua-${process.pid}.json`), {
        force: true,
      }),
      fsp.rm(path.join(os.tmpdir(), `conflict-ua-${process.pid}-gdelt.json`), {
        force: true,
      }),
    ]),
  );
  await harness(recording)('');
  assert.ok(agents.length > 1);
  assert.ok(agents.every((agent) => agent === WATCHER_USER_AGENT));
  assert.equal(plugin.name, 'conflict-events-proxy');
  assert.equal(typeof plugin.configurePreviewServer, 'function');
  void calls;
  void get;
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
