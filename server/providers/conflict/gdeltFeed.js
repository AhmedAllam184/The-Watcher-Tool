import path from 'node:path';
import { promises as fsp } from 'node:fs';

import { WATCHER_USER_AGENT } from '../common/userAgent.js';
import {
  readResponseBytesCapped,
  readResponseTextCapped,
} from '../common/http.js';
import { extractSingleZipEntry } from '../common/zipEntry.js';
import {
  GDELT_STEP_MS,
  createGdeltStore,
  gdeltPointsFromExport,
  gdeltStampFromMs,
  parseLastUpdate,
} from './gdelt.js';
import { UpstreamFailure, failureFrom, httpFailure } from './failure.js';

/**
 * The keyless GDELT feed: the Events 2.0 15-minute export files, read into a
 * rolling store. Driven by timers, and only while requested: the first request
 * loads the newest QUICK_FILES files (2 h) one per second, then the timers run
 * while a request has arrived in the last IDLE_MS.
 *
 *   - Backfill: one older file every BACKFILL_EVERY_MS until the store reaches
 *     BACKFILL_SPAN_MS (24 h). Files already recorded are skipped without a
 *     download. Older history (up to 7 days) only accumulates while the app
 *     runs or from the persisted store, so it is not backfilled actively.
 *   - Newest: lastupdate.txt is read every 15 min and its file loaded if new.
 *   - Persistence: the store is written atomically to the cache at most every
 *     SAVE_EVERY_MS, and when the timers stop.
 *
 * Origins are tried in order (https, then http) for lastupdate.txt; file URLs
 * are rebuilt from the origin that answered, so a feed value never picks the
 * host. Failures are reported as reasons; a file that fails is skipped, not
 * retried.
 */

export const GDELT_ORIGINS = Object.freeze([
  'https://data.gdeltproject.org',
  'http://data.gdeltproject.org',
]);
export const GDELT_FILE_MAX_BYTES = 20 * 1024 * 1024;
const LASTUPDATE_MAX_BYTES = 64 * 1024;
const REQUEST_TIMEOUT_MS = 20_000;
export const QUICK_FILES = 8;
export const QUICK_SPACING_MS = 1_000;
export const QUICK_BUDGET_MS = 12_000;
export const BACKFILL_EVERY_MS = 10_000;
export const BACKFILL_SPAN_MS = 24 * 3_600_000;
export const IDLE_MS = 10 * 60_000;
export const SAVE_EVERY_MS = 60_000;
const LOG_EVERY_MS = 10 * 60_000;

const request = () => ({
  headers: { Accept: '*/*', 'User-Agent': WATCHER_USER_AGENT },
  signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
});

/**
 * @param {object} [options]
 * @param {Function} [options.fetchImpl]
 * @param {() => number} [options.now] - epoch ms.
 * @param {{setTimeout: Function, clearTimeout: Function}} [options.timers]
 * @param {(ms: number) => Promise<void>} [options.sleep] - pause between quick loads.
 * @param {string} [options.cachePath]
 * @param {string[]} [options.origins]
 * @param {(line: string) => void} [options.log]
 * @param {object} [options.store] - a createGdeltStore() instance.
 */
export function createGdeltFeed({
  fetchImpl = globalThis.fetch,
  now = Date.now,
  timers = globalThis,
  sleep = (ms) => new Promise((resolve) => timers.setTimeout(resolve, ms)),
  cachePath = path.join(process.cwd(), '.gev-cache', 'conflict-gdelt.json'),
  origins = GDELT_ORIGINS,
  log = (line) => console.warn(`[conflict] ${line}`),
  store = createGdeltStore(),
} = {}) {
  let origin = null;
  let latestMs = null;
  let cursorMs = null;
  let lastRequestAt = -Infinity;
  let timersRunning = false;
  let latestTimer = null;
  let backfillTimer = null;
  let loaded = null;
  let startPromise = null;
  let lock = Promise.resolve();
  let dirty = false;
  let lastSaveAt = -Infinity;
  let lastFailure = null;
  let lastLoggedReason = null;
  let lastLoggedAt = -Infinity;

  const withLock = (task) => {
    const run = lock.then(task, task);
    lock = run.catch(() => {});
    return run;
  };

  const idle = () => now() - lastRequestAt > IDLE_MS;

  /** A failure line in the background, at most once per reason per 10 min. */
  function logBackground(reason) {
    const t = now();
    if (reason === lastLoggedReason && t - lastLoggedAt < LOG_EVERY_MS) return;
    lastLoggedReason = reason;
    lastLoggedAt = t;
    log(reason);
  }

  async function loadOnce() {
    loaded ??= (async () => {
      try {
        store.restore(JSON.parse(await fsp.readFile(cachePath, 'utf8')), now());
      } catch {
        /* first run, or an unreadable cache: start empty */
      }
    })();
    return loaded;
  }

  /** Write the store to a temp file and rename it into place. */
  async function save() {
    try {
      await fsp.mkdir(path.dirname(cachePath), { recursive: true });
      const tmpPath = `${cachePath}.${process.pid}.tmp`;
      await fsp.writeFile(tmpPath, JSON.stringify(store.toJSON()), 'utf8');
      await fsp.rename(tmpPath, cachePath);
    } catch {
      dirty = true;
      logBackground('GDELT cache write failed');
    }
  }

  async function maybeSave(force = false) {
    if (!dirty) return;
    const t = now();
    if (!force && t - lastSaveAt < SAVE_EVERY_MS) return;
    lastSaveAt = t;
    dirty = false;
    await save();
  }

  /** The newest file's time from lastupdate.txt, trying each origin in turn. */
  async function fetchLatest() {
    let failure = null;
    for (const base of origins) {
      try {
        const upstream = await fetchImpl(
          `${base}/gdeltv2/lastupdate.txt`,
          request(),
        );
        if (!upstream.ok) throw httpFailure('GDELT', upstream.status);
        const text = await readResponseTextCapped(
          upstream,
          LASTUPDATE_MAX_BYTES,
        );
        const latest = parseLastUpdate(text);
        if (!latest)
          throw new UpstreamFailure('GDELT file list could not be read');
        origin = base;
        return latest.stampMs;
      } catch (err) {
        failure = failureFrom(err, 'GDELT');
      }
    }
    throw failure;
  }

  /**
   * Load one export file into the store. Returns 'known' (already recorded),
   * 'missing' (404: not recorded, so the cursor simply moves on), 'loaded' or
   * 'failed' (the reason is kept in lastFailure).
   */
  async function loadStamp(fileMs) {
    if (store.has(fileMs)) return 'known';
    const base = origin ?? origins[0];
    try {
      const upstream = await fetchImpl(
        `${base}/gdeltv2/${gdeltStampFromMs(fileMs)}.export.CSV.zip`,
        request(),
      );
      if (upstream.status === 404) {
        void upstream.body?.cancel?.().catch?.(() => {});
        return 'missing';
      }
      if (!upstream.ok) throw httpFailure('GDELT', upstream.status);
      const bytes = await readResponseBytesCapped(
        upstream,
        GDELT_FILE_MAX_BYTES,
      );
      let csv;
      try {
        csv = extractSingleZipEntry(bytes).toString('utf8');
      } catch {
        throw new UpstreamFailure('GDELT file could not be unpacked');
      }
      store.addFile(fileMs, gdeltPointsFromExport(csv), now());
      lastFailure = null;
      dirty = true;
      return 'loaded';
    } catch (err) {
      lastFailure = failureFrom(err, 'GDELT');
      return 'failed';
    }
  }

  /** Quick start: the newest files, one per second, within the request budget. */
  async function start() {
    await loadOnce();
    latestMs = await fetchLatest();
    const begun = now();
    for (let index = 0; index < QUICK_FILES; index++) {
      if (index > 0) {
        if (now() - begun > QUICK_BUDGET_MS) break;
        await sleep(QUICK_SPACING_MS);
      }
      const fileMs = latestMs - index * GDELT_STEP_MS;
      await withLock(() => loadStamp(fileMs));
    }
    if (store.filesSince(now() - BACKFILL_SPAN_MS) === 0 && lastFailure)
      throw lastFailure;
    await maybeSave(true);
    startTimers(GDELT_STEP_MS);
  }

  function scheduleLatest(delayMs) {
    if (latestTimer) timers.clearTimeout(latestTimer);
    latestTimer = timers.setTimeout(() => latestTick(), delayMs);
    latestTimer?.unref?.();
  }

  function scheduleBackfill(delayMs) {
    if (backfillTimer) timers.clearTimeout(backfillTimer);
    backfillTimer = timers.setTimeout(() => backfillTick(), delayMs);
    backfillTimer?.unref?.();
  }

  /** Begin the poll and backfill timers from the newest file, one window back. */
  function startTimers(latestDelayMs) {
    timersRunning = true;
    cursorMs = latestMs - QUICK_FILES * GDELT_STEP_MS;
    scheduleLatest(latestDelayMs);
    scheduleBackfill(BACKFILL_EVERY_MS);
  }

  function stopTimers() {
    timersRunning = false;
    if (latestTimer) timers.clearTimeout(latestTimer);
    if (backfillTimer) timers.clearTimeout(backfillTimer);
    latestTimer = null;
    backfillTimer = null;
    void maybeSave(true);
  }

  async function latestTick() {
    latestTimer = null;
    if (idle()) return stopTimers();
    try {
      const stampMs = await fetchLatest();
      if (latestMs === null || stampMs > latestMs) latestMs = stampMs;
      const result = await withLock(() => loadStamp(stampMs));
      if (result === 'failed') logBackground(lastFailure.reason);
      await maybeSave();
    } catch (err) {
      lastFailure = failureFrom(err, 'GDELT');
      logBackground(lastFailure.reason);
    }
    if (timersRunning) scheduleLatest(GDELT_STEP_MS);
  }

  async function backfillTick() {
    backfillTimer = null;
    if (idle()) return stopTimers();
    const floor = latestMs - BACKFILL_SPAN_MS;
    while (cursorMs > floor && store.has(cursorMs)) cursorMs -= GDELT_STEP_MS;
    if (cursorMs > floor) {
      const fileMs = cursorMs;
      cursorMs -= GDELT_STEP_MS;
      const result = await withLock(() => loadStamp(fileMs));
      if (result === 'failed') logBackground(lastFailure.reason);
      await maybeSave();
    }
    if (timersRunning && cursorMs > latestMs - BACKFILL_SPAN_MS)
      scheduleBackfill(BACKFILL_EVERY_MS);
  }

  /**
   * The window's events plus coverage. The first call waits for the quick
   * start; a failed start rejects with the reason and is retried next time.
   * @param {{days: number, bbox?: ?number[]}} query
   */
  async function snapshot({ days, bbox = null }) {
    const t = now();
    lastRequestAt = t;
    startPromise ??= start().catch((err) => {
      startPromise = null;
      throw err;
    });
    await startPromise;
    if (!timersRunning) startTimers(0);
    const windowMs = days * 86_400_000;
    return {
      events: store.query({ sinceMs: t - windowMs, bbox }),
      coverageHours: store.coverageHours(t, windowMs),
      backfilling:
        cursorMs !== null &&
        latestMs !== null &&
        cursorMs > latestMs - BACKFILL_SPAN_MS,
      fetchedAt: latestMs ?? t,
    };
  }

  return {
    snapshot,
    /** Stop the timers and persist now (tests, and clean shutdown). */
    async stop() {
      stopTimers();
      await maybeSave(true);
    },
  };
}
