import path from 'node:path';
import { promises as fsp } from 'node:fs';

import { WATCHER_USER_AGENT } from './common/userAgent.js';
import { coalesceProxyRequest, readResponseJsonCapped } from './common/http.js';
import {
  UpstreamFailure,
  failureFrom,
  httpFailure,
} from './conflict/failure.js';
import { createGdeltFeed } from './conflict/gdeltFeed.js';
import { MIN_ARTICLES } from './conflict/gdelt.js';

/**
 * Armed-conflict events, served at GET /api/conflicts. Two sources:
 *
 *   - ACLED (verified) when ACLED_EMAIL and ACLED_KEY are both set. Read
 *     server-side only; neither value is ever returned, logged or placed in
 *     an error. Battles, explosions/remote violence and violence against
 *     civilians are kept.
 *   - GDELT Event Database 2.0 (keyless fallback), read from its 15-minute
 *     export files into a rolling store. These are machine-coded, news-reported
 *     events at a located point, not verified events. See conflict/gdeltFeed.js.
 *
 * ACLED responses are cached per window (days) for 1 h; the bounding box is
 * applied as a filter after the cache. Concurrent misses share one upstream
 * request. Failures are never cached. A failure returns 503 {transient:true,
 * reason} where reason is a short sentence without any URL or credential.
 * The ACLED cache is written atomically to .gev-cache/conflict-events.json and
 * the GDELT store to .gev-cache/conflict-gdelt.json.
 *
 * Routes:
 *   GET /api/conflicts?days=1|7&bbox=w,s,e,n
 *     → {generatedAt, source, verified, days, events, note, method, fetchedAt}
 *     GDELT responses also carry coverageHours and backfilling.
 *
 * @returns {import('vite').Plugin}
 */

export const ACLED_API_URL = 'https://api.acleddata.com/acled/read';
export const CONFLICT_DAYS = Object.freeze([1, 7]);
export const CONFLICT_TTL_MS = Object.freeze({
  acled: 60 * 60_000,
});
export const CONFLICT_EVENT_CAP = 1500;
export const ACLED_EVENT_TYPES = Object.freeze([
  'Battles',
  'Explosions/Remote violence',
  'Violence against civilians',
]);

const ACLED_LIMIT = 5000;
const UPSTREAM_TIMEOUT_MS = 15_000;
const UPSTREAM_MAX_BYTES = 8 * 1024 * 1024;
const DAY_MS = 86_400_000;
const ACLED_NOTE =
  'Verified armed-conflict events from ACLED (Armed Conflict Location & Event Data), limited to battles, explosions or remote violence, and violence against civilians. ACLED data is subject to its terms of use.';
const ACLED_METHOD = (days) =>
  `ACLED events of type Battles, Explosions/Remote violence and Violence against civilians dated over the last ${days} day${days === 1 ? '' : 's'}.`;
const GDELT_NOTE =
  'News-reported conflict events (GDELT Event Database, machine-coded from news articles) — unverified; locations and types can be wrong.';
const GDELT_METHOD = (days) =>
  `GDELT Event Database 2.0 (15-minute files): material-conflict events with root codes 18 (assault), 19 (fight) or 20 (mass violence) at a city or site point, country-level points dropped. One point per location and type, kept when at least MIN_ARTICLES = ${MIN_ARTICLES} articles or sources report it, over the last ${days === 1 ? '24 h' : '7 days'}. Only the files loaded so far are shown; coverageHours says how many.`;

/** A finite number from a value, or null. Blank strings are absent, not zero. */
const finiteNumber = (value) => {
  if (value === null || value === undefined || String(value).trim() === '')
    return null;
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
};

/** Parse a query value, or {error}. Days must be 1 or 7; bbox is optional. */
export function parseConflictQuery(params) {
  let days = 1;
  const daysRaw = params.get('days');
  if (daysRaw !== null) {
    days = Number(daysRaw);
    if (!CONFLICT_DAYS.includes(days)) return { error: 'invalid days' };
  }
  let bbox = null;
  const bboxRaw = params.get('bbox');
  if (bboxRaw !== null) {
    const parts = bboxRaw.split(',').map(finiteNumber);
    if (parts.length !== 4 || parts.some((part) => part === null))
      return { error: 'invalid bbox' };
    const [west, south, east, north] = parts;
    if (
      Math.abs(west) > 180 ||
      Math.abs(east) > 180 ||
      Math.abs(south) > 90 ||
      Math.abs(north) > 90 ||
      west >= east ||
      south >= north
    )
      return { error: 'invalid bbox' };
    bbox = roundBbox([west, south, east, north]);
  }
  return { days, bbox };
}

/** Outward-rounded bounding box to whole degrees, clamped to the world. */
export function roundBbox([west, south, east, north]) {
  return [
    Math.max(-180, Math.floor(west)),
    Math.max(-90, Math.floor(south)),
    Math.min(180, Math.ceil(east)),
    Math.min(90, Math.ceil(north)),
  ];
}

/** True when the event lies inside the box, or no box was given. */
export function inBbox(event, bbox) {
  if (!bbox) return true;
  const [west, south, east, north] = bbox;
  return (
    event.lon >= west &&
    event.lon <= east &&
    event.lat >= south &&
    event.lat <= north
  );
}

/** ACLED credentials, or null unless both values are present. */
export function acledCredentials(env = process.env) {
  const email = String(env.ACLED_EMAIL ?? '').trim();
  const key = String(env.ACLED_KEY ?? '').trim();
  return email && key ? { email, key } : null;
}

const isoDate = (ms) => new Date(ms).toISOString().slice(0, 10);

/** One ACLED row → event, or null when it is unusable or outside the kept types. */
export function acledEventFromRow(row) {
  const lat = finiteNumber(row?.latitude);
  const lon = finiteNumber(row?.longitude);
  if (lat === null || lon === null || Math.abs(lat) > 90 || Math.abs(lon) > 180)
    return null;
  if (!ACLED_EVENT_TYPES.includes(row?.event_type)) return null;
  const id = String(row.event_id_cnty ?? '').trim();
  if (!id) return null;
  const subType = String(row.sub_event_type ?? '').trim();
  const location = String(row.location ?? '').trim();
  const sourceName = String(row.source ?? '').trim();
  return {
    id: `acled:${id}`,
    lat,
    lon,
    date: String(row.event_date ?? ''),
    type: row.event_type,
    ...(subType ? { subType } : {}),
    fatalities: Math.max(0, Math.round(finiteNumber(row.fatalities) ?? 0)),
    actors: [row.actor1, row.actor2]
      .map((actor) => String(actor ?? '').trim())
      .filter(Boolean),
    country: String(row.country ?? '').trim() || null,
    location: location || null,
    title: [subType || row.event_type, location]
      .filter(Boolean)
      .join(' · ')
      .slice(0, 180),
    ...(sourceName ? { sourceName } : {}),
  };
}

/** Sort key shared by the response and the layer: fatalities, then article count. */
export function eventSeverity(event) {
  return event.fatalities ?? event.articles ?? 0;
}

/**
 * Fetch one ACLED window. Throws an UpstreamFailure (with a reason) on any
 * HTTP, body or network failure; the reason never carries the request URL.
 */
export async function fetchAcledRecord({ fetchImpl, credentials, days, now }) {
  const to = now();
  const from = to - days * DAY_MS;
  const params = new URLSearchParams({
    key: credentials.key,
    email: credentials.email,
    event_date: `${isoDate(from)}|${isoDate(to)}`,
    event_date_where: 'BETWEEN',
    limit: String(ACLED_LIMIT),
  });
  let json;
  try {
    const upstream = await fetchImpl(`${ACLED_API_URL}?${params}`, {
      headers: { Accept: 'application/json', 'User-Agent': WATCHER_USER_AGENT },
      signal: AbortSignal.timeout(UPSTREAM_TIMEOUT_MS),
    });
    if (upstream.status === 401 || upstream.status === 403)
      throw new UpstreamFailure(
        `ACLED rejected the key (HTTP ${upstream.status})`,
      );
    if (!upstream.ok) throw httpFailure('ACLED', upstream.status);
    json = await readResponseJsonCapped(upstream, UPSTREAM_MAX_BYTES);
  } catch (err) {
    throw failureFrom(err, 'ACLED');
  }
  if (json?.success === false || !Array.isArray(json?.data))
    throw failureFrom(
      Object.assign(new Error('unexpected ACLED body'), { code: 'BAD_BODY' }),
      'ACLED',
    );
  const events = [];
  for (const row of json.data) {
    const event = acledEventFromRow(row);
    if (event) events.push(event);
  }
  return {
    source: 'acled',
    days,
    fetchedAt: now(),
    events,
    note: ACLED_NOTE,
    method: ACLED_METHOD(days),
  };
}

const isRecord = (value) =>
  value &&
  value.source === 'acled' &&
  CONFLICT_DAYS.includes(value.days) &&
  Number.isFinite(value.fetchedAt) &&
  Array.isArray(value.events);

export function conflictProxy({
  fetchImpl = globalThis.fetch,
  cachePath = path.join(process.cwd(), '.gev-cache', 'conflict-events.json'),
  now = Date.now,
  env = process.env,
  gdelt = null,
  timers = globalThis,
} = {}) {
  /** @type {Map<number, object>} days → ACLED record */
  const records = new Map();
  const inFlight = new Map();
  let loading = null;
  const gdeltFeed =
    gdelt ??
    createGdeltFeed({
      fetchImpl,
      now,
      timers,
      cachePath: path.join(path.dirname(cachePath), 'conflict-gdelt.json'),
    });

  /** Read the persisted ACLED records once; an unreadable file starts empty. */
  function loadOnce() {
    loading ??= (async () => {
      try {
        const parsed = JSON.parse(await fsp.readFile(cachePath, 'utf8'));
        for (const record of Object.values(parsed?.records ?? {}))
          if (isRecord(record)) records.set(record.days, record);
      } catch {
        /* first run, or unreadable cache: start empty */
      }
    })();
    return loading;
  }

  /** Write every ACLED record to a temp file and rename it into place. */
  async function save() {
    try {
      await fsp.mkdir(path.dirname(cachePath), { recursive: true });
      const tmpPath = `${cachePath}.${process.pid}.tmp`;
      const body = JSON.stringify({
        records: Object.fromEntries(
          [...records].map(([days, record]) => [`acled|${days}`, record]),
        ),
      });
      await fsp.writeFile(tmpPath, body, 'utf8');
      await fsp.rename(tmpPath, cachePath);
    } catch {
      console.warn('[conflict] cache write failed');
    }
  }

  /** A fresh ACLED record from the cache, or one fetched now (single-flight, never cached on failure). */
  function acledRecordFor(days, credentials) {
    const cached = records.get(days);
    if (cached && now() - cached.fetchedAt < CONFLICT_TTL_MS.acled)
      return cached;
    return coalesceProxyRequest(inFlight, `acled|${days}`, async () => {
      const record = await fetchAcledRecord({
        fetchImpl,
        credentials,
        days,
        now,
      });
      records.set(days, record);
      await save();
      return record;
    }).promise;
  }

  const installMiddleware = (server) => {
    server.middlewares.use('/api/conflicts', async (req, res) => {
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
        const query = parseConflictQuery(url.searchParams);
        if (query.error) return send(400, { error: query.error });

        await loadOnce();
        const credentials = acledCredentials(env);
        const source = credentials ? 'acled' : 'gdelt';
        let record;
        try {
          record =
            source === 'acled'
              ? await acledRecordFor(query.days, credentials)
              : await gdeltFeed.snapshot({
                  days: query.days,
                  bbox: query.bbox,
                });
        } catch (err) {
          const failure = failureFrom(
            err,
            source === 'acled' ? 'ACLED' : 'GDELT',
          );
          console.warn(`[conflict] ${failure.reason}; nothing cached`);
          return send(503, {
            error: 'conflict upstream unavailable',
            transient: true,
            reason: failure.reason,
          });
        }
        const events = record.events
          .filter((event) => inBbox(event, query.bbox))
          .sort((a, b) => eventSeverity(b) - eventSeverity(a))
          .slice(0, CONFLICT_EVENT_CAP);
        if (source === 'acled')
          return send(200, {
            generatedAt: now(),
            source,
            verified: true,
            days: query.days,
            events,
            note: ACLED_NOTE,
            method: ACLED_METHOD(query.days),
            fetchedAt: record.fetchedAt,
          });
        return send(200, {
          generatedAt: now(),
          source,
          verified: false,
          days: query.days,
          events,
          note: GDELT_NOTE,
          method: GDELT_METHOD(query.days),
          fetchedAt: record.fetchedAt,
          coverageHours: record.coverageHours,
          backfilling: record.backfilling,
        });
      } catch (err) {
        console.error('[conflict] request failed:', err?.name || 'error');
        return send(500, { error: 'conflict proxy error' });
      }
    });
  };
  return {
    name: 'conflict-events-proxy',
    configureServer: installMiddleware,
    configurePreviewServer: installMiddleware,
  };
}
