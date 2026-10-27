import test from 'node:test';
import assert from 'node:assert/strict';
import { promises as fsp } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  GDELT_COLUMN_COUNT,
  GDELT_COLUMNS,
  MIN_ARTICLES,
  createGdeltStore,
  gdeltEventFromFields,
  gdeltEventType,
  gdeltEventsFromExport,
  gdeltPointsFromExport,
  gdeltStampFromMs,
  gdeltStampMs,
  parseLastUpdate,
  placeName,
} from '../../server/providers/conflict/gdelt.js';
import {
  BACKFILL_EVERY_MS,
  BACKFILL_SPAN_MS,
  IDLE_MS,
  QUICK_FILES,
  createGdeltFeed,
} from '../../server/providers/conflict/gdeltFeed.js';
import {
  UpstreamFailure,
  failureFrom,
} from '../../server/providers/conflict/failure.js';
import { buildZip } from './zipTestWriter.mjs';

const STEP = 15 * 60_000;
const LATEST = Date.UTC(2026, 9, 27, 9, 15, 0);
const HOUR = 3_600_000;

/** One 61-field export row; `values` names columns by GDELT_COLUMNS key. */
function exportRow(values = {}) {
  const fields = Array(GDELT_COLUMN_COUNT).fill('');
  const base = {
    GLOBALEVENTID: '1001',
    SQLDATE: '20261027',
    Actor1Name: 'MILITARY FORCE',
    Actor2Name: 'CIVILIANS',
    IsRootEvent: '1',
    EventCode: '195',
    EventBaseCode: '195',
    EventRootCode: '19',
    QuadClass: '4',
    GoldsteinScale: '-10',
    NumMentions: '3',
    NumSources: '2',
    NumArticles: '3',
    AvgTone: '-5',
    ActionGeo_Type: '4',
    ActionGeo_FullName:
      'Khan Yunis, Khan Yunis, Gaza Strip, Palestinian Territory',
    ActionGeo_CountryCode: 'GZ',
    ActionGeo_Lat: '31.3457',
    ActionGeo_Long: '34.3030',
    DATEADDED: '20261027091500',
    SOURCEURL: 'https://www.example-news.com/a1',
    ...values,
  };
  for (const [name, value] of Object.entries(base))
    fields[GDELT_COLUMNS[name]] = String(value);
  return fields.join('\t');
}

test('lastupdate lines name the newest export file, and other files are ignored', () => {
  const text = [
    '2048 0f9a http://data.gdeltproject.org/gdeltv2/20261027090000.export.CSV.zip',
    '6144 9b1c http://data.gdeltproject.org/gdeltv2/20261027090000.mentions.CSV.zip',
    '95311 a1b2 http://data.gdeltproject.org/gdeltv2/20261027091500.export.CSV.zip',
    '',
  ].join('\r\n');
  assert.deepEqual(parseLastUpdate(text), { stampMs: LATEST });
  assert.equal(parseLastUpdate('<html>not the feed</html>'), null);
  assert.equal(parseLastUpdate(''), null);
  assert.equal(gdeltStampFromMs(LATEST), '20261027091500');
  assert.equal(gdeltStampMs('20261327091500'), null, 'impossible month');
  assert.equal(gdeltStampMs('2026'), null);
});

test('the column indices match the GDELT 2.0 codebook positions', () => {
  assert.equal(GDELT_COLUMN_COUNT, 61);
  assert.equal(GDELT_COLUMNS.GLOBALEVENTID, 0);
  assert.equal(GDELT_COLUMNS.SQLDATE, 1);
  assert.equal(GDELT_COLUMNS.Actor1Name, 6);
  assert.equal(GDELT_COLUMNS.Actor2Name, 16);
  assert.equal(GDELT_COLUMNS.IsRootEvent, 25);
  assert.equal(GDELT_COLUMNS.EventCode, 26);
  assert.equal(GDELT_COLUMNS.EventRootCode, 28);
  assert.equal(GDELT_COLUMNS.QuadClass, 29);
  assert.equal(GDELT_COLUMNS.NumMentions, 31);
  assert.equal(GDELT_COLUMNS.NumSources, 32);
  assert.equal(GDELT_COLUMNS.NumArticles, 33);
  assert.equal(GDELT_COLUMNS.ActionGeo_Type, 51);
  assert.equal(GDELT_COLUMNS.ActionGeo_FullName, 52);
  assert.equal(GDELT_COLUMNS.ActionGeo_Lat, 56);
  assert.equal(GDELT_COLUMNS.ActionGeo_Long, 57);
  assert.equal(GDELT_COLUMNS.DATEADDED, 59);
  assert.equal(GDELT_COLUMNS.SOURCEURL, 60);
});

test('CAMEO codes map to the plain types, with the specific codes first', () => {
  const cases = {
    195: 'Airstrike / aerial weapons',
    1951: 'Airstrike / aerial weapons',
    1952: 'Airstrike / aerial weapons',
    194: 'Artillery / tank fire',
    190: 'Armed clash',
    193: 'Armed clash',
    183: 'Bombing',
    1833: 'Bombing',
    186: 'Assassination',
    180: 'Assault',
    185: 'Assault',
    200: 'Mass violence',
    196: 'Fighting',
    1961: 'Fighting',
    187: 'Assault',
    170: null,
    '': null,
  };
  for (const [code, type] of Object.entries(cases))
    assert.equal(gdeltEventType(code), type, `code ${code}`);
});

test('only material-conflict rows with a root code of 18, 19 or 20 are kept', () => {
  assert.ok(
    gdeltEventFromFields(exportRow().split('\t')),
    'a sample row is kept',
  );
  const rejected = {
    QuadClass: '3',
    EventRootCode: '17',
    ActionGeo_Type: '1',
    ActionGeo_Lat: '',
    ActionGeo_Long: '200',
    DATEADDED: 'soon',
    GLOBALEVENTID: 'x1',
  };
  for (const [name, value] of Object.entries(rejected))
    assert.equal(
      gdeltEventFromFields(exportRow({ [name]: value }).split('\t')),
      null,
      name,
    );
  assert.equal(gdeltEventFromFields(['too', 'short']), null);
  const ok = gdeltEventFromFields(
    exportRow({ EventRootCode: '20', EventCode: '200' }).split('\t'),
  );
  assert.equal(ok.type, 'Mass violence');
});

test('a file parses to events with its article link, dropping duplicate event ids and unsafe links', () => {
  const text = [
    exportRow({ GLOBALEVENTID: '1', SOURCEURL: 'javascript:alert(1)' }),
    exportRow({ GLOBALEVENTID: '1', NumArticles: '99' }),
    exportRow({ GLOBALEVENTID: '2', QuadClass: '1' }),
    exportRow({ GLOBALEVENTID: '3', ActionGeo_Type: '1' }),
    '',
  ].join('\n');
  const events = gdeltEventsFromExport(text);
  assert.equal(events.length, 1, 'duplicates and country rows are dropped');
  assert.equal(events[0].id, '1');
  assert.equal(events[0].url, null, 'a javascript: link is never kept');
  assert.equal(
    events[0].articles,
    3,
    'the first row for an id is the one kept',
  );
});

test('points group by type and rounded location, keep MIN_ARTICLES, and cite the most-cited link', () => {
  assert.equal(MIN_ARTICLES, 2);
  const text = [
    exportRow({
      GLOBALEVENTID: '1',
      NumArticles: '1',
      NumSources: '1',
      SOURCEURL: 'https://a.example/x',
      ActionGeo_Lat: '31.34571',
    }),
    exportRow({
      GLOBALEVENTID: '2',
      NumArticles: '5',
      NumSources: '3',
      SOURCEURL: 'https://b.example/y',
      Actor1Name: 'HAMAS',
    }),
    exportRow({
      GLOBALEVENTID: '3',
      NumArticles: '1',
      NumSources: '1',
      ActionGeo_Lat: '10',
      ActionGeo_Long: '10',
    }),
    exportRow({
      GLOBALEVENTID: '4',
      NumArticles: '1',
      NumSources: '2',
      ActionGeo_Lat: '20',
      ActionGeo_Long: '20',
    }),
    exportRow({
      GLOBALEVENTID: '5',
      EventCode: '186',
      NumArticles: '4',
      ActionGeo_Lat: '31.3457',
      ActionGeo_Long: '34.303',
    }),
  ].join('\n');
  const points = gdeltPointsFromExport(text);
  const airstrike = points.find(
    (point) => point.type === 'Airstrike / aerial weapons',
  );
  assert.equal(
    points.length,
    3,
    'the lone 1-article 1-source point is dropped',
  );
  assert.equal(airstrike.articles, 6, 'articles sum within the group');
  assert.equal(
    airstrike.url,
    'https://b.example/y',
    'the most-cited link wins',
  );
  assert.equal(airstrike.lat, 31.346);
  assert.deepEqual(
    airstrike.actors.map((actor) => actor.name),
    ['CIVILIANS', 'HAMAS'],
    'weighted by articles',
  );
  assert.ok(points.some((point) => point.type === 'Assassination'));
  assert.ok(
    points.some((point) => point.lat === 20 && point.articles === 1),
    'two sources is enough',
  );
});

test('location names are shortened to the place and the last region', () => {
  assert.equal(
    placeName('Khan Yunis, Khan Yunis, Gaza Strip, Palestinian Territory'),
    'Khan Yunis, Palestinian Territory',
  );
  assert.equal(placeName('Donetsk'), 'Donetsk');
  assert.equal(placeName(null), 'Unnamed location');
});

test('the store merges points across files for a window, filters by box, prunes and caps', () => {
  const store = createGdeltStore({ cap: 4, retentionMs: 3 * HOUR });
  const point = (t, articles, url) => ({
    key: 'Fighting|1|1',
    type: 'Fighting',
    lat: 1,
    lon: 1,
    t,
    location: 'Here, Somewhere',
    articles,
    mentions: articles,
    sources: 2,
    url,
    urlArticles: articles,
    actors: [{ name: 'A', n: articles }],
  });
  store.addFile(LATEST, [point(LATEST, 2, 'https://one.example/a')], LATEST);
  store.addFile(
    LATEST - STEP,
    [point(LATEST - STEP, 5, 'https://two.example/b')],
    LATEST,
  );
  const merged = store.query({ sinceMs: LATEST - HOUR });
  assert.equal(merged.length, 1);
  assert.equal(merged[0].articles, 7);
  assert.equal(merged[0].url, 'https://two.example/b');
  assert.equal(merged[0].sourceName, 'two.example');
  assert.equal(merged[0].date, '2026-10-27');
  assert.equal(
    store.query({ sinceMs: LATEST + 1 }).length,
    0,
    'older than the window',
  );
  assert.equal(
    store.query({ sinceMs: 0, bbox: [10, 10, 20, 20] }).length,
    0,
    'outside the box',
  );
  assert.equal(
    store.coverageHours(LATEST + STEP, 24 * HOUR),
    0.8,
    'two files span 45 min from the older one',
  );

  store.addFile(LATEST - 4 * STEP, [point(LATEST - 4 * STEP, 1, null)], LATEST);
  assert.equal(store.has(LATEST - 4 * STEP), true);
  store.addFile(
    LATEST + 10 * HOUR,
    [point(LATEST + 10 * HOUR, 1, null)],
    LATEST + 10 * HOUR,
  );
  assert.equal(store.has(LATEST), false, 'files past the retention are pruned');
  for (let i = 0; i < 6; i++)
    store.addFile(
      LATEST + 10 * HOUR + i * STEP,
      [point(LATEST + 10 * HOUR + i * STEP, 1, null)],
      LATEST + 10 * HOUR + i * STEP,
    );
  assert.ok(store.pointCount <= 4, 'the cap keeps the newest points');
});

test('the persisted form restores the same points and file record', () => {
  const store = createGdeltStore();
  const text = [
    exportRow({ GLOBALEVENTID: '1' }),
    exportRow({ GLOBALEVENTID: '2' }),
  ].join('\n');
  store.addFile(LATEST, gdeltPointsFromExport(text), LATEST);
  const json = JSON.parse(JSON.stringify(store.toJSON()));
  const reopened = createGdeltStore();
  reopened.restore(json, LATEST);
  assert.deepEqual(reopened.query({ sinceMs: 0 }), store.query({ sinceMs: 0 }));
  assert.equal(reopened.has(LATEST), true);
  const junk = createGdeltStore();
  junk.restore({ processed: ['x'], points: [{ key: 1 }] }, LATEST);
  assert.equal(junk.pointCount, 0);
});

test('the failure reasons name the upstream and never include a URL', () => {
  assert.equal(
    failureFrom(new TypeError('fetch failed'), 'GDELT').reason,
    'GDELT unreachable (network/DNS)',
  );
  assert.equal(
    failureFrom(new DOMException('slow', 'TimeoutError'), 'GDELT').reason,
    'GDELT timed out',
  );
  assert.equal(
    failureFrom(
      Object.assign(new Error('x'), { code: 'RESPONSE_TOO_LARGE' }),
      'ACLED',
    ).reason,
    'ACLED response too large',
  );
  const direct = new UpstreamFailure('GDELT HTTP 429 (rate limited)');
  assert.equal(failureFrom(direct, 'GDELT'), direct);
  assert.equal(
    failureFrom(new Error('https://x.example/?key=1'), 'GDELT').reason,
    'GDELT request failed',
  );
});

/* ----- feed scheduling, driven by an injected clock and timers ----- */

function makeClock(start) {
  return {
    t: start,
    now() {
      return this.t;
    },
  };
}

/** Fake timers that never fire by themselves: a test runs them through advance(). */
function makeTimers(clock) {
  const pending = new Map();
  let nextId = 1;
  return {
    pending,
    setTimeout(fn, ms) {
      const handle = { id: nextId++, fn, at: clock.t + ms, unref() {} };
      pending.set(handle.id, handle);
      return handle;
    },
    clearTimeout(handle) {
      if (handle) pending.delete(handle.id);
    },
  };
}

/** Run every timer due by clock.t + ms in time order, awaiting each tick. */
async function advance(clock, timers, ms) {
  const end = clock.t + ms;
  for (;;) {
    const due = [...timers.pending.values()]
      .filter((handle) => handle.at <= end)
      .sort((a, b) => a.at - b.at || a.id - b.id)[0];
    if (!due) break;
    timers.pending.delete(due.id);
    clock.t = Math.max(clock.t, due.at);
    await due.fn();
  }
  clock.t = end;
}

/**
 * A stub GDELT: lastupdate names the newest file at latestAt() (LATEST by
 * default); each file has one row at its own time.
 */
function gdeltServer({
  lastupdate = null,
  fileReply = null,
  latestAt = () => LATEST,
} = {}) {
  const calls = [];
  const fetchImpl = async (href) => {
    calls.push(String(href));
    const url = new URL(href);
    if (url.pathname === '/gdeltv2/lastupdate.txt') {
      if (lastupdate) return lastupdate(url);
      return new Response(
        `1 a http://data.gdeltproject.org/gdeltv2/${gdeltStampFromMs(latestAt())}.export.CSV.zip\n`,
      );
    }
    const stamp = /\/(\d{14})\.export\.CSV\.zip$/.exec(url.pathname)?.[1];
    if (!stamp) return new Response('', { status: 404 });
    if (fileReply) return fileReply(stamp, url);
    const csv = exportRow({
      GLOBALEVENTID: stamp,
      DATEADDED: stamp,
      NumArticles: '3',
      NumSources: '2',
      SOURCEURL: 'https://www.example-news.com/a1',
    });
    return new Response(buildZip(`${stamp}.export.CSV`, `${csv}\n`), {
      status: 200,
    });
  };
  return {
    calls,
    fetchImpl,
    fileCalls: () => calls.filter((href) => href.includes('.export.CSV.zip')),
  };
}

function feedFixture(t, options = {}) {
  const clock = makeClock(LATEST);
  const timers = makeTimers(clock);
  const server = gdeltServer({
    latestAt: () => LATEST + Math.floor((clock.t - LATEST) / STEP) * STEP,
    ...(options.server ?? {}),
  });
  const dir = path.join(
    os.tmpdir(),
    `gdelt-feed-${process.pid}-${Math.random()}`,
  );
  const cachePath = path.join(dir, 'conflict-gdelt.json');
  t.after(() => fsp.rm(dir, { recursive: true, force: true }));
  const feed = createGdeltFeed({
    fetchImpl: server.fetchImpl,
    now: () => clock.now(),
    timers,
    sleep: async (ms) => {
      clock.t += ms;
    },
    cachePath,
    log: () => {},
    ...(options.feed ?? {}),
  });
  t.after(() => feed.stop());
  return { clock, timers, server, feed, cachePath };
}

test('the first request quick-loads 2 h, then backfills one older file every 10 s to 24 h', async (t) => {
  const { clock, timers, server, feed } = feedFixture(t);
  const first = await feed.snapshot({ days: 1 });
  assert.equal(
    server.fileCalls().length,
    QUICK_FILES,
    'the newest 8 files first',
  );
  assert.equal(first.coverageHours, 2);
  assert.equal(first.backfilling, true);
  assert.equal(first.events.length, 1);
  const [event] = first.events;
  assert.equal(event.type, 'Airstrike / aerial weapons');
  assert.equal(event.articles, 3 * QUICK_FILES);
  assert.equal(
    event.title,
    'Airstrike / aerial weapons · Khan Yunis, Palestinian Territory',
  );
  assert.equal(event.url, 'https://www.example-news.com/a1');
  assert.equal(event.sourceName, 'example-news.com');
  assert.equal(event.date, '2026-10-27');

  await advance(clock, timers, BACKFILL_EVERY_MS);
  assert.equal(
    server.fileCalls().length,
    QUICK_FILES + 1,
    'one older file at 10 s',
  );
  await advance(clock, timers, BACKFILL_EVERY_MS * 3);
  assert.equal(
    server.fileCalls().length,
    QUICK_FILES + 4,
    'then one every 10 s',
  );

  for (let elapsed = 0; elapsed < BACKFILL_SPAN_MS; elapsed += 5 * 60_000) {
    await advance(clock, timers, 5 * 60_000);
    await feed.snapshot({ days: 1 });
  }
  const after = await feed.snapshot({ days: 1 });
  assert.equal(after.backfilling, false, 'backfill stops at 24 h');
  assert.equal(after.coverageHours, 24);
  const requested = server.fileCalls();
  assert.equal(
    new Set(requested).size,
    requested.length,
    'no file is downloaded twice',
  );
  const stamps = new Set(
    requested.map((href) => /(\d{14})\.export/.exec(href)[1]),
  );
  for (let back = 0; back < 96; back++)
    assert.ok(
      stamps.has(gdeltStampFromMs(LATEST - back * STEP)),
      `file ${back} steps back`,
    );
});

test('the timers stop after 10 min without a request and restart on the next one', async (t) => {
  const { clock, timers, feed } = feedFixture(t);
  await feed.snapshot({ days: 1 });
  await advance(clock, timers, IDLE_MS + 2 * 60_000);
  assert.equal(timers.pending.size, 0, 'idle: nothing is scheduled');
  await feed.snapshot({ days: 1 });
  assert.ok(
    [...timers.pending.values()].some((handle) => handle.at === clock.t),
    'the newest file is checked at once',
  );
});

test('the latest file is checked every 15 min and a new one is loaded when it appears', async (t) => {
  let latest = LATEST;
  const { clock, timers, server, feed } = feedFixture(t, {
    server: { latestAt: () => latest },
  });
  await feed.snapshot({ days: 1 });
  const before = server.fileCalls().length;
  latest = LATEST + STEP;
  for (let elapsed = 0; elapsed < STEP; elapsed += 5 * 60_000) {
    await advance(clock, timers, 5 * 60_000);
    await feed.snapshot({ days: 1 });
  }
  assert.ok(
    server
      .fileCalls()
      .some((href) => href.includes(gdeltStampFromMs(LATEST + STEP))),
    'the newest file was requested',
  );
  assert.ok(server.fileCalls().length > before, 'the new file is loaded');
});

test('origins are tried in turn: an https failure falls back to http, and file URLs use the origin that answered', async (t) => {
  const { server, feed } = feedFixture(t, {
    server: {
      lastupdate: (url) => {
        if (url.protocol === 'https:') throw new TypeError('fetch failed');
        return new Response(
          `1 a http://data.gdeltproject.org/gdeltv2/${gdeltStampFromMs(LATEST)}.export.CSV.zip\n`,
        );
      },
    },
  });
  const result = await feed.snapshot({ days: 1 });
  assert.equal(result.events.length, 1);
  assert.ok(
    server
      .fileCalls()
      .every((href) => href.startsWith('http://data.gdeltproject.org/')),
  );
});

test('a rate-limited or unreachable feed rejects with the reason, and the next request tries again', async (t) => {
  let mode = 'rate';
  const { feed } = feedFixture(t, {
    server: {
      lastupdate: () => {
        if (mode === 'rate') return new Response('slow down', { status: 429 });
        return new Response(
          `1 a http://data.gdeltproject.org/gdeltv2/${gdeltStampFromMs(LATEST)}.export.CSV.zip\n`,
        );
      },
    },
  });
  await assert.rejects(
    feed.snapshot({ days: 1 }),
    (err) => err.reason === 'GDELT HTTP 429 (rate limited)',
  );
  mode = 'ok';
  const recovered = await feed.snapshot({ days: 1 });
  assert.equal(recovered.events.length, 1);
});

test('a feed without a usable file list, and files that cannot be unpacked, are named as such', async (t) => {
  const page = feedFixture(t, {
    server: { lastupdate: () => new Response('<html>') },
  });
  await assert.rejects(
    page.feed.snapshot({ days: 1 }),
    (err) => err.reason === 'GDELT file list could not be read',
  );

  const broken = feedFixture(t, {
    server: { fileReply: () => new Response('not a zip at all') },
  });
  await assert.rejects(
    broken.feed.snapshot({ days: 1 }),
    (err) => err.reason === 'GDELT file could not be unpacked',
  );
  assert.equal(
    broken.server.fileCalls().length,
    QUICK_FILES,
    'each file was tried once',
  );
});

test('a file answered with 404 is skipped and left unrecorded; a timeout is named', async (t) => {
  const { feed, server } = feedFixture(t, {
    server: {
      fileReply: (stamp) =>
        stamp === gdeltStampFromMs(LATEST - STEP)
          ? new Response('', { status: 404 })
          : new Response(
              buildZip(
                'a.csv',
                `${exportRow({ GLOBALEVENTID: stamp, DATEADDED: stamp })}\n`,
              ),
            ),
    },
  });
  const result = await feed.snapshot({ days: 1 });
  assert.equal(result.coverageHours, 2);
  assert.equal(result.events.length, 1);
  assert.equal(server.fileCalls().length, QUICK_FILES);

  const slow = feedFixture(t, {
    server: {
      lastupdate: () => {
        throw new DOMException('slow', 'TimeoutError');
      },
    },
  });
  await assert.rejects(
    slow.feed.snapshot({ days: 1 }),
    (err) => err.reason === 'GDELT timed out',
  );
});

test('persisted files are not downloaded again after a restart, and the cache is written atomically', async (t) => {
  const first = feedFixture(t);
  await first.feed.snapshot({ days: 1 });
  await first.feed.stop();
  const dir = path.dirname(first.cachePath);
  const names = await fsp.readdir(dir);
  assert.deepEqual(
    names.filter((name) => name.endsWith('.tmp')),
    [],
  );
  assert.ok(names.includes('conflict-gdelt.json'));

  const clock = makeClock(LATEST + 5 * 60_000);
  const timers = makeTimers(clock);
  const server = gdeltServer();
  const reopened = createGdeltFeed({
    fetchImpl: server.fetchImpl,
    now: () => clock.now(),
    timers,
    sleep: async () => {},
    cachePath: first.cachePath,
    log: () => {},
  });
  t.after(() => reopened.stop());
  const result = await reopened.snapshot({ days: 1 });
  assert.equal(
    server.fileCalls().length,
    0,
    'the recorded files are used as they are',
  );
  assert.equal(result.events.length, 1);
  assert.equal(result.events[0].articles, 3 * QUICK_FILES);
});
