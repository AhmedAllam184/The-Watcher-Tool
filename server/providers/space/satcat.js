import path from 'node:path';
import { promises as fsp } from 'node:fs';
import { celestrakSatcatUrl } from '../../../src/data/spaceProviderRequests.js';
import {
  satcatLaunchSiteName,
  satcatObjectTypeText,
  satcatOwnerName,
  satcatStatusText,
} from '../../../src/data/satcatCodes.js';
import { WATCHER_USER_AGENT } from '../common/userAgent.js';

/**
 * CelesTrak SATCAT proxy: NORAD catalogue number → who owns the object, what
 * it is, its status, launch and orbit. Served by GET /api/satellites/info?norad=N
 * and cached on disk: a record for a week, "not in the catalogue" for a day.
 * Upstream failures are never cached and answer 503 {transient:true}. Memory
 * and disk hold at most 20,000 records; the oldest by time are evicted first.
 */
const RECORD_TTL_MS = 7 * 24 * 3600_000;
const MISS_TTL_MS = 24 * 3600_000;
/** Disk and memory hold at most this many catalogue numbers. */
const MAX_ENTRIES = 20000;
const UPSTREAM_TIMEOUT_MS = 10000;
const GEO_ALTITUDE_KM = 35786;
const GEO_TOLERANCE_KM = 500;

const text = (value) => {
  const trimmed = String(value ?? '').trim();
  return trimmed ? trimmed : null;
};

/** A finite number from a SATCAT field; blank or non-numeric is null. */
function number(value) {
  if (typeof value === 'number') return Number.isFinite(value) ? value : null;
  const trimmed = String(value ?? '').trim();
  if (!trimmed) return null;
  const parsed = Number(trimmed);
  return Number.isFinite(parsed) ? parsed : null;
}

/**
 * Orbit family from apogee and perigee. Eccentric orbits (apogee - perigee
 * above 10,000 km) are HEO whatever their altitude; otherwise the mean altitude
 * decides, with GEO requiring an inclination under 15 degrees.
 */
export function orbitClassOf({ apogeeKm, perigeeKm, inclinationDeg }) {
  if (apogeeKm === null || perigeeKm === null) return null;
  if (apogeeKm - perigeeKm > 10000) return 'HEO';
  const meanKm = (apogeeKm + perigeeKm) / 2;
  if (meanKm < 2000) return 'LEO';
  if (
    Math.abs(meanKm - GEO_ALTITUDE_KM) <= GEO_TOLERANCE_KM &&
    inclinationDeg !== null &&
    inclinationDeg < 15
  )
    return 'GEO';
  if (meanKm < GEO_ALTITUDE_KM - GEO_TOLERANCE_KM) return 'MEO';
  return 'HEO';
}

/** Radar cross-section band in square metres; null when CelesTrak has no value. */
export function rcsSizeOf(rcsM2) {
  if (rcsM2 === null) return null;
  if (rcsM2 < 0.1) return 'small';
  if (rcsM2 < 1) return 'medium';
  return 'large';
}

/**
 * Normalise one SATCAT JSON array into the record the panel renders.
 * @param {unknown} json Parsed records.php?FORMAT=JSON body.
 * @param {number} noradId The catalogue number that was asked for; rows for any other number are ignored.
 * @returns {object|null} The record, or null when the catalogue has no such object.
 */
export function parseSatcatRecord(json, noradId) {
  if (!Array.isArray(json)) return null;
  const row = json.find(
    (candidate) => Number(candidate?.NORAD_CAT_ID) === noradId,
  );
  if (!row || typeof row !== 'object') return null;
  const name = text(row.OBJECT_NAME);
  if (!name) return null;
  const objectType = text(row.OBJECT_TYPE);
  const status = text(row.OPS_STATUS_CODE);
  const ownerCode = text(row.OWNER);
  const siteCode = text(row.LAUNCH_SITE);
  const apogeeKm = number(row.APOGEE);
  const perigeeKm = number(row.PERIGEE);
  const inclinationDeg = number(row.INCLINATION);
  const rcsM2 = number(row.RCS);
  return {
    norad: noradId,
    name,
    intlDesignator: text(row.OBJECT_ID),
    objectType,
    objectTypeText: satcatObjectTypeText(objectType),
    status,
    statusText: satcatStatusText(status),
    owner: ownerCode
      ? { code: ownerCode, name: satcatOwnerName(ownerCode) }
      : null,
    launchDate: text(row.LAUNCH_DATE),
    launchSite: siteCode
      ? { code: siteCode, name: satcatLaunchSiteName(siteCode) }
      : null,
    decayDate: text(row.DECAY_DATE),
    periodMin: number(row.PERIOD),
    inclinationDeg,
    apogeeKm,
    perigeeKm,
    orbitClass: orbitClassOf({ apogeeKm, perigeeKm, inclinationDeg }),
    rcsM2,
    rcsSize: rcsSizeOf(rcsM2),
    source: 'CelesTrak SATCAT',
  };
}

export function satcatProxy({
  fetchImpl = globalThis.fetch,
  cachePath = path.join(process.cwd(), '.gev-cache', 'satcat.json'),
  now = () => Date.now(),
} = {}) {
  let cache = {};
  let dirty = false;
  let saving = false;
  /** The one disk read; every caller awaits the same promise. */
  let loading = null;
  const inflight = new Map();

  const fresh = (entry) =>
    entry && now() - entry.at < (entry.data ? RECORD_TTL_MS : MISS_TTL_MS);

  /** Keep the newest MAX_ENTRIES in memory; the oldest by `at` go first. */
  function enforceCap() {
    const keys = Object.keys(cache);
    if (keys.length <= MAX_ENTRIES) return;
    keys.sort((a, b) => cache[a].at - cache[b].at);
    for (const key of keys.slice(0, keys.length - MAX_ENTRIES))
      delete cache[key];
  }

  /** What reaches the disk: fresh entries only, capped. */
  function persistable() {
    const entries = Object.entries(cache)
      .filter(([, entry]) => fresh(entry))
      .sort(([, a], [, b]) => b.at - a.at)
      .slice(0, MAX_ENTRIES);
    return Object.fromEntries(entries);
  }

  /** Write temp-then-rename, so a crash mid-write never leaves a partial file. */
  async function save() {
    if (!dirty || saving) return;
    dirty = false;
    saving = true;
    const tmpPath = `${cachePath}.${process.pid}.tmp`;
    try {
      await fsp.mkdir(path.dirname(cachePath), { recursive: true });
      await fsp.writeFile(
        tmpPath,
        JSON.stringify({ records: persistable() }),
        'utf8',
      );
      await fsp.rename(tmpPath, cachePath);
    } catch {
      dirty = true; // retry next tick
      await fsp.rm(tmpPath, { force: true }).catch(() => {});
    } finally {
      saving = false;
    }
  }

  /** Read the disk cache once and start the periodic save. Concurrent callers share the load. */
  function loadOnce() {
    loading ??= (async () => {
      try {
        const parsed = JSON.parse(await fsp.readFile(cachePath, 'utf8'));
        cache = parsed.records ?? {};
      } catch {
        /* first run */
      }
      // Expired entries are dropped on load, then the cap applies.
      for (const key of Object.keys(cache)) {
        if (!fresh(cache[key])) {
          delete cache[key];
          dirty = true;
        }
      }
      if (Object.keys(cache).length > MAX_ENTRIES) {
        enforceCap();
        dirty = true;
      }
      setInterval(() => void save(), 15_000).unref?.();
    })();
    return loading;
  }

  /** One upstream lookup. A body that is neither a JSON array nor the empty array throws. */
  async function fetchRecord(noradId) {
    const res = await fetchImpl(celestrakSatcatUrl(noradId).toString(), {
      headers: { 'User-Agent': WATCHER_USER_AGENT },
      signal: AbortSignal.timeout(UPSTREAM_TIMEOUT_MS),
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const body = await res.text();
    if (/^\s*\[\s*\]\s*$/.test(body)) return null; // not in the catalogue
    return parseSatcatRecord(JSON.parse(body), noradId);
  }

  /** Cached record for one catalogue number, or null when the catalogue has none. Upstream failure throws. */
  function lookup(noradId) {
    const key = String(noradId);
    if (fresh(cache[key])) return Promise.resolve(cache[key].data);
    if (!inflight.has(key)) {
      inflight.set(
        key,
        (async () => {
          try {
            const data = await fetchRecord(noradId);
            cache[key] = { at: now(), data };
            enforceCap();
            dirty = true;
            return data;
          } finally {
            inflight.delete(key);
          }
        })(),
      );
    }
    return inflight.get(key);
  }

  const installMiddleware = (server) => {
    server.middlewares.use('/api/satellites/info', async (req, res) => {
      await loadOnce();
      const send = (status, obj) => {
        res.writeHead(status, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(obj));
      };
      try {
        const url = new URL(String(req.url || ''), 'http://localhost');
        if (url.pathname !== '/')
          return send(404, { error: 'unknown endpoint' });
        const raw = String(url.searchParams.get('norad') || '');
        const norad = Number(raw);
        if (!/^\d{1,9}$/.test(raw) || norad <= 0)
          return send(400, { error: 'invalid norad' });
        const satellite = await lookup(norad);
        return send(200, { norad, satellite });
      } catch {
        console.warn('[satcat-proxy] upstream lookup failed');
        return send(503, {
          error: 'satcat unavailable',
          transient: true,
        });
      }
    });
  };
  return {
    name: 'satcat-proxy',
    configureServer: installMiddleware,
    configurePreviewServer: installMiddleware,
  };
}
