import path from 'node:path';
import { promises as fsp } from 'node:fs';

import {
  GPS_JAM_MIN_AIRCRAFT,
  createGpsJamGrid,
} from '../../../src/data/gpsJam.js';
import { WATCHER_USER_AGENT } from '../common/userAgent.js';

/**
 * GPS interference inference from aircraft GPS-quality broadcasts, served at
 * GET /api/gps-jam. Each aircraft's NIC (or NACp when NIC is absent) is read
 * from adsb.lol's keyless v2 point API and classified by src/data/gpsJam.js.
 * The result is an INFERENCE: degraded navigation integrity suggests
 * interference but can have other causes. Every response says so.
 *
 * Sampling: ONE region is polled every 20 s, round-robin, and only while the
 * endpoint is active. Active means a /api/gps-jam request arrived within the
 * last 10 min; the timer starts on the first request and stops on the first
 * tick after the window lapses. Nothing polls at import time. A request with
 * valid ?lat=&lon= adds a temporary viewport region (rounded to 1 degree, kept
 * 15 min, at most 3, oldest evicted first) to the rotation.
 *
 * Upstream failures back that region off for 5 min and are logged at most once
 * per region per 10 min. The grid is persisted to .gev-cache/gps-jam.json at
 * most every 60 s and reloaded on first start.
 *
 * Routes:
 *   GET /api/gps-jam[?lat=&lon=&window=1|6|24] → {generatedAt, windowHours,
 *     cellDeg, active, regions, cells, method, note, source}
 *
 * @returns {import('vite').Plugin}
 */

/**
 * Constant sampling regions. Each is polled with a 250 nm radius. The last
 * two are control regions where GPS is normally clean, so a spike there
 * would point to a noisy method rather than to interference.
 */
export const GPS_JAM_REGIONS = Object.freeze([
  { name: 'Baltic', lat: 57, lon: 21 },
  { name: 'Kaliningrad', lat: 54.7, lon: 20.5 },
  { name: 'Black Sea', lat: 43.5, lon: 34 },
  { name: 'Eastern Mediterranean', lat: 34.5, lon: 33.5 },
  { name: 'Israel/Lebanon', lat: 32.5, lon: 35.5 },
  { name: 'Syria/Iraq', lat: 35, lon: 40 },
  { name: 'Persian Gulf', lat: 27, lon: 51 },
  { name: 'Strait of Hormuz', lat: 26.5, lon: 56.5 },
  { name: 'Red Sea', lat: 20, lon: 39 },
  { name: 'Ukraine east', lat: 48.5, lon: 37.5 },
  { name: 'Finland/Russia border', lat: 61.5, lon: 29 },
  { name: 'Caucasus', lat: 41.5, lon: 45 },
  { name: 'Central Europe (control)', lat: 50, lon: 10 },
  { name: 'US Midwest (control)', lat: 40, lon: -90 },
]);

const RADIUS_NM = 250;
const POLL_INTERVAL_MS = 20_000;
const IDLE_MS = 10 * 60_000;
const VIEWPORT_TTL_MS = 15 * 60_000;
const VIEWPORT_MAX = 3;
const BACKOFF_MS = 5 * 60_000;
const LOG_EVERY_MS = 10 * 60_000;
const SAVE_EVERY_MS = 60_000;
const UPSTREAM_TIMEOUT_MS = 10_000;
const GRID_WINDOW_MS = 24 * 3_600_000;
const WINDOW_HOURS = Object.freeze([1, 6, 24]);
const DEFAULT_WINDOW_HOURS = 6;

const regionKey = (lat, lon) => `${lat},${lon}`;

/** Optional coordinate: null when absent, NaN-free and in range when present. */
function parseCoordinate(raw, limit) {
  if (raw === null || raw.trim() === '') return null;
  const value = Number(raw);
  return Number.isFinite(value) && Math.abs(value) <= limit ? value : null;
}

/**
 * Validate the query. Returns {error} for a bad parameter; otherwise the
 * window in hours and an optional rounded viewport.
 */
function parseQuery(params) {
  let hours = DEFAULT_WINDOW_HOURS;
  const windowRaw = params.get('window');
  if (windowRaw !== null) {
    hours = Number(windowRaw);
    if (!WINDOW_HOURS.includes(hours)) return { error: 'invalid window' };
  }
  const latRaw = params.get('lat');
  const lonRaw = params.get('lon');
  let viewport = null;
  if (latRaw !== null || lonRaw !== null) {
    const lat = parseCoordinate(latRaw ?? '', 90);
    const lon = parseCoordinate(lonRaw ?? '', 180);
    if (lat === null || lon === null) return { error: 'invalid lat/lon' };
    viewport = { lat: Math.round(lat), lon: Math.round(lon) };
  }
  return { hours, viewport };
}

export function gpsJamProxy({
  fetchImpl = globalThis.fetch,
  cachePath = path.join(process.cwd(), '.gev-cache', 'gps-jam.json'),
  now = Date.now,
} = {}) {
  const grid = createGpsJamGrid({ cellDeg: 1, windowMs: GRID_WINDOW_MS });
  const newRegion = (region, extra = {}) => ({
    ...region,
    key: regionKey(region.lat, region.lon),
    lastPolledAt: null,
    ok: null,
    backoffUntil: 0,
    lastLoggedAt: -Infinity,
    ...extra,
  });
  const base = GPS_JAM_REGIONS.map((region) => newRegion(region));
  /** @type {Array<ReturnType<typeof newRegion>>} */
  let viewports = [];
  let cursor = 0;
  let lastRequestAt = -Infinity;
  /** @type {?ReturnType<typeof setInterval>} */
  let timer = null;
  /** @type {?Promise<void>} */
  let loading = null;
  let dirty = false;
  let saving = false;
  let lastSaveAt = -Infinity;

  /** Base regions plus live viewports, in rotation order. */
  const rotation = () => [...base, ...viewports];

  function pruneViewports(t) {
    viewports = viewports.filter((region) => region.expiresAt > t);
  }

  function addViewport({ lat, lon }, t) {
    pruneViewports(t);
    const key = regionKey(lat, lon);
    if (base.some((region) => region.key === key)) return;
    const existing = viewports.find((region) => region.key === key);
    if (existing) {
      existing.expiresAt = t + VIEWPORT_TTL_MS;
      return;
    }
    if (viewports.length >= VIEWPORT_MAX) {
      const oldest = viewports.reduce((a, b) =>
        a.addedAt <= b.addedAt ? a : b,
      );
      viewports = viewports.filter((region) => region !== oldest);
    }
    viewports.push(
      newRegion(
        { name: 'Viewport', lat, lon },
        { addedAt: t, expiresAt: t + VIEWPORT_TTL_MS },
      ),
    );
  }

  /** Load the persisted grid once, before the first poll can overwrite it. */
  function loadOnce(t) {
    if (!loading) {
      loading = (async () => {
        try {
          grid.fromJSON(JSON.parse(await fsp.readFile(cachePath, 'utf8')));
        } catch {
          /* first run, or unreadable cache: start empty */
        }
        grid.prune(t);
      })();
    }
    return loading;
  }

  /** Write the grid when it changed and the last write is at least 60 s old. */
  async function save(t) {
    if (!dirty || saving || t - lastSaveAt < SAVE_EVERY_MS) return;
    dirty = false;
    saving = true;
    lastSaveAt = t;
    try {
      grid.prune(t);
      await fsp.mkdir(path.dirname(cachePath), { recursive: true });
      // Write then rename, so a reader (or a crash mid-write) never sees a
      // half-written cache file.
      const tmpPath = `${cachePath}.${process.pid}.tmp`;
      await fsp.writeFile(tmpPath, JSON.stringify(grid), 'utf8');
      await fsp.rename(tmpPath, cachePath);
    } catch (err) {
      dirty = true; // retry after the next 60 s window
      console.warn('[gps-jam] cache write failed:', err?.message || err);
    } finally {
      saving = false;
    }
  }

  async function pollRegion(region, t) {
    region.lastPolledAt = t;
    try {
      const upstream = await fetchImpl(
        `https://api.adsb.lol/v2/lat/${region.lat}/lon/${region.lon}/dist/${RADIUS_NM}`,
        {
          headers: {
            Accept: 'application/json',
            'User-Agent': WATCHER_USER_AGENT,
          },
          signal: AbortSignal.timeout(UPSTREAM_TIMEOUT_MS),
        },
      );
      if (!upstream.ok) throw new Error(`upstream HTTP ${upstream.status}`);
      const json = await upstream.json();
      if (!Array.isArray(json?.ac)) throw new Error('unexpected upstream body');
      grid.addSamples(json.ac, t);
      region.ok = true;
      dirty = true;
    } catch (err) {
      region.ok = false;
      region.backoffUntil = t + BACKOFF_MS;
      if (t - region.lastLoggedAt >= LOG_EVERY_MS) {
        region.lastLoggedAt = t;
        console.warn(
          `[gps-jam] ${region.name} poll failed (${err?.message || err}); backing off 5 min`,
        );
      }
    }
  }

  /** Next region in round-robin order that is not backing off, or null. */
  function nextRegion(t) {
    const regions = rotation();
    const count = regions.length;
    for (let step = 0; step < count; step++) {
      const index = (cursor + step) % count;
      if (regions[index].backoffUntil <= t) {
        cursor = (index + 1) % count;
        return regions[index];
      }
    }
    return null;
  }

  async function tick() {
    const t = now();
    if (t - lastRequestAt > IDLE_MS) {
      stop();
      await save(t);
      return;
    }
    pruneViewports(t);
    const region = nextRegion(t);
    if (region) await pollRegion(region, t);
    await save(now());
  }

  function stop() {
    if (timer) clearInterval(timer);
    timer = null;
  }

  /** Start the poll timer if idle; the first poll runs immediately. */
  function activate() {
    if (timer) return;
    void tick();
    timer = setInterval(() => void tick(), POLL_INTERVAL_MS);
    timer.unref?.();
  }

  const installMiddleware = (server) => {
    server.middlewares.use('/api/gps-jam', async (req, res) => {
      const send = (status, obj) => {
        res.writeHead(status, {
          'Content-Type': 'application/json',
          'Cache-Control': 'no-store',
        });
        res.end(JSON.stringify(obj));
      };
      try {
        const url = new URL(String(req.url || ''), 'http://localhost');
        if (url.pathname !== '/')
          return send(404, { error: 'unknown endpoint' });
        const query = parseQuery(url.searchParams);
        if (query.error) return send(400, { error: query.error });

        await loadOnce(now());
        const t = now();
        lastRequestAt = t;
        if (query.viewport) addViewport(query.viewport, t);
        activate();
        pruneViewports(t);

        const hours = query.hours;
        return send(200, {
          generatedAt: t,
          windowHours: hours,
          cellDeg: 1,
          active: true,
          regions: rotation().map(({ name, lat, lon, lastPolledAt, ok }) => ({
            name,
            lat,
            lon,
            lastPolledAt,
            ok,
          })),
          cells: grid.cells({
            nowMs: t,
            minAircraft: GPS_JAM_MIN_AIRCRAFT,
            windowMs: hours * 3_600_000,
          }),
          method: `Share of airborne aircraft broadcasting degraded GPS quality (NIC < 7, or NACp < 8 when NIC is absent), per ~1° cell over the last ${hours} h; cells need at least ${GPS_JAM_MIN_AIRCRAFT} aircraft.`,
          note: 'Inferred from aircraft GPS-quality broadcasts. High values suggest GPS interference (jamming or spoofing) but can have other causes. Coverage is limited to sampled regions.',
          source: 'adsb.lol (ODbL)',
        });
      } catch (err) {
        console.error('[gps-jam] request failed:', err?.message || err);
        return send(500, { error: 'gps jam proxy error' });
      }
    });
  };
  return {
    name: 'gps-jam-proxy',
    configureServer: installMiddleware,
    configurePreviewServer: installMiddleware,
  };
}
