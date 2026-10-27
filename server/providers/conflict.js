import path from 'node:path';
import { promises as fsp } from 'node:fs';

import { WATCHER_USER_AGENT } from './common/userAgent.js';
import { coalesceProxyRequest, readResponseJsonCapped } from './common/http.js';

/**
 * Armed-conflict events, served at GET /api/conflicts. Two sources:
 *
 *   - ACLED (verified) when ACLED_EMAIL and ACLED_KEY are both set. Read
 *     server-side only; neither value is ever returned, logged or placed in
 *     an error. Battles, explosions/remote violence and violence against
 *     civilians are kept.
 *   - GDELT GEO 2.0 (keyless fallback). These are LOCATIONS of news reports
 *     that match fighting terms. They are not verified events, and one point
 *     can bundle many articles. Every response says so.
 *
 * Upstream data is cached per source and window (days), not per viewport:
 * the bounding box is applied as a filter after the cache. ACLED entries live
 * for 1 h and GDELT entries for 15 min. Concurrent misses share one upstream
 * request. Failures are never cached: they return 503 {transient:true}.
 * The cache is written atomically to .gev-cache/conflict-events.json.
 *
 * Routes:
 *   GET /api/conflicts?days=1|7&bbox=w,s,e,n
 *     → {generatedAt, source, verified, days, events, note, method, fetchedAt}
 *
 * @returns {import('vite').Plugin}
 */

export const ACLED_API_URL = 'https://api.acleddata.com/acled/read';
export const GDELT_GEO_URL = 'https://api.gdeltproject.org/api/v2/geo/geo';
export const CONFLICT_DAYS = Object.freeze([1, 7]);
export const CONFLICT_TTL_MS = Object.freeze({
  acled: 60 * 60_000,
  gdelt: 15 * 60_000,
});
export const CONFLICT_EVENT_CAP = 1500;
export const ACLED_EVENT_TYPES = Object.freeze([
  'Battles',
  'Explosions/Remote violence',
  'Violence against civilians',
]);

const ACLED_LIMIT = 5000;
const GDELT_MAX_POINTS = 500;
const GDELT_QUERY =
  '(airstrike OR "air strike" OR shelling OR "missile strike" OR "armed clashes" OR "drone strike" OR bombing OR "killed in fighting")';
const UPSTREAM_TIMEOUT_MS = 15_000;
const UPSTREAM_MAX_BYTES = 8 * 1024 * 1024;
const DAY_MS = 86_400_000;
const ACLED_NOTE =
  'Verified armed-conflict events from ACLED (Armed Conflict Location & Event Data), limited to battles, explosions or remote violence, and violence against civilians. ACLED data is subject to its terms of use.';
const ACLED_METHOD = (days) =>
  `ACLED events of type Battles, Explosions/Remote violence and Violence against civilians dated over the last ${days} day${days === 1 ? '' : 's'}.`;
const GDELT_NOTE =
  'Locations of news reports about fighting (GDELT), not verified events; one point can bundle many articles.';
const GDELT_METHOD = (days) =>
  `GDELT GEO 2.0 locations of news reports matching fighting terms over the last ${days === 1 ? '24 h' : '7 days'}, at most ${GDELT_MAX_POINTS} points.`;

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

function decodeEntities(value) {
  return String(value ?? '')
    .replace(/&amp;/g, '&')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>');
}

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

/** The first article link in a GDELT point's HTML, or null. */
export function firstGdeltArticle(html) {
  const match = /<a\s[^>]*href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/i.exec(
    String(html ?? ''),
  );
  if (!match) return null;
  let url;
  try {
    url = new URL(decodeEntities(match[1]));
  } catch {
    return null;
  }
  if (!['http:', 'https:'].includes(url.protocol)) return null;
  const title = decodeEntities(match[2].replace(/<[^>]+>/g, ' '))
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 180);
  return {
    title: title || null,
    url: url.href,
    sourceName: url.hostname.replace(/^www\./, ''),
  };
}

/**
 * GDELT GEO GeoJSON → events. Only the retrieval date is known for these
 * points, so each event carries it as its date.
 */
export function gdeltEventsFromGeoJson(json, fetchedAt) {
  if (!json || !Array.isArray(json.features))
    throw Object.assign(new Error('unexpected GDELT body'), {
      code: 'BAD_BODY',
    });
  const date = isoDate(fetchedAt);
  const events = [];
  json.features.forEach((feature, index) => {
    const lon = finiteNumber(feature?.geometry?.coordinates?.[0]);
    const lat = finiteNumber(feature?.geometry?.coordinates?.[1]);
    if (
      lat === null ||
      lon === null ||
      Math.abs(lat) > 90 ||
      Math.abs(lon) > 180
    )
      return;
    const location =
      String(feature.properties?.name ?? '').trim() || 'Unnamed location';
    const articles = Math.max(
      1,
      Math.round(finiteNumber(feature.properties?.count) ?? 1),
    );
    const article = firstGdeltArticle(feature.properties?.html);
    events.push({
      id: `gdelt:${index}:${lat.toFixed(3)}:${lon.toFixed(3)}`,
      lat,
      lon,
      date,
      type: 'News report',
      articles,
      actors: [],
      country: null,
      location,
      title:
        article?.title ||
        `${articles} news ${articles === 1 ? 'report' : 'reports'} near ${location}`,
      ...(article ? { url: article.url, sourceName: article.sourceName } : {}),
    });
  });
  return events;
}

/** Sort key shared by the response and the layer: fatalities, then article count. */
export function eventSeverity(event) {
  return event.fatalities ?? event.articles ?? 0;
}

/**
 * Fetch one ACLED window. Throws on any HTTP, body or network failure; the
 * error never carries the request URL.
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
  const upstream = await fetchImpl(`${ACLED_API_URL}?${params}`, {
    headers: { Accept: 'application/json', 'User-Agent': WATCHER_USER_AGENT },
    signal: AbortSignal.timeout(UPSTREAM_TIMEOUT_MS),
  });
  if (!upstream.ok)
    throw Object.assign(new Error('ACLED upstream status'), {
      code: `HTTP_${upstream.status}`,
    });
  const json = await readResponseJsonCapped(upstream, UPSTREAM_MAX_BYTES);
  if (json?.success === false || !Array.isArray(json?.data))
    throw Object.assign(new Error('unexpected ACLED body'), {
      code: 'BAD_BODY',
    });
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

/** Fetch one GDELT window. Same error contract as fetchAcledRecord. */
export async function fetchGdeltRecord({ fetchImpl, days, now }) {
  const params = new URLSearchParams({
    query: GDELT_QUERY,
    mode: 'PointData',
    format: 'GeoJSON',
    timespan: days === 1 ? '24h' : '7d',
    maxpoints: String(GDELT_MAX_POINTS),
  });
  const upstream = await fetchImpl(`${GDELT_GEO_URL}?${params}`, {
    headers: { Accept: 'application/json', 'User-Agent': WATCHER_USER_AGENT },
    signal: AbortSignal.timeout(UPSTREAM_TIMEOUT_MS),
  });
  if (!upstream.ok)
    throw Object.assign(new Error('GDELT upstream status'), {
      code: `HTTP_${upstream.status}`,
    });
  const json = await readResponseJsonCapped(upstream, UPSTREAM_MAX_BYTES);
  const fetchedAt = now();
  return {
    source: 'gdelt',
    days,
    fetchedAt,
    events: gdeltEventsFromGeoJson(json, fetchedAt).slice(0, GDELT_MAX_POINTS),
    note: GDELT_NOTE,
    method: GDELT_METHOD(days),
  };
}

const isRecord = (value) =>
  value &&
  (value.source === 'acled' || value.source === 'gdelt') &&
  CONFLICT_DAYS.includes(value.days) &&
  Number.isFinite(value.fetchedAt) &&
  Array.isArray(value.events);

export function conflictProxy({
  fetchImpl = globalThis.fetch,
  cachePath = path.join(process.cwd(), '.gev-cache', 'conflict-events.json'),
  now = Date.now,
  env = process.env,
} = {}) {
  /** @type {Map<string, object>} "source|days" → record */
  const records = new Map();
  const inFlight = new Map();
  let loading = null;

  /** Read the persisted records once; an unreadable file starts empty. */
  function loadOnce() {
    loading ??= (async () => {
      try {
        const parsed = JSON.parse(await fsp.readFile(cachePath, 'utf8'));
        for (const [key, record] of Object.entries(parsed?.records ?? {}))
          if (isRecord(record)) records.set(key, record);
      } catch {
        /* first run, or unreadable cache: start empty */
      }
    })();
    return loading;
  }

  /** Write every record to a temp file and rename it into place. */
  async function save() {
    try {
      await fsp.mkdir(path.dirname(cachePath), { recursive: true });
      const tmpPath = `${cachePath}.${process.pid}.tmp`;
      const body = JSON.stringify({
        records: Object.fromEntries(records),
      });
      await fsp.writeFile(tmpPath, body, 'utf8');
      await fsp.rename(tmpPath, cachePath);
    } catch {
      console.warn('[conflict] cache write failed');
    }
  }

  /** A fresh record from the cache, or one fetched now (single-flight, never cached on failure). */
  function recordFor(source, days, credentials) {
    const key = `${source}|${days}`;
    const cached = records.get(key);
    const t = now();
    if (cached && t - cached.fetchedAt < CONFLICT_TTL_MS[source]) return cached;
    return coalesceProxyRequest(inFlight, key, async () => {
      const record =
        source === 'acled'
          ? await fetchAcledRecord({ fetchImpl, credentials, days, now })
          : await fetchGdeltRecord({ fetchImpl, days, now });
      records.set(key, record);
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
          record = await recordFor(source, query.days, credentials);
        } catch (err) {
          console.warn(
            `[conflict] ${source} upstream failed (${err?.code || err?.name || 'error'}); nothing cached`,
          );
          return send(503, {
            error: 'conflict upstream unavailable',
            transient: true,
          });
        }
        const events = record.events
          .filter((event) => inBbox(event, query.bbox))
          .sort((a, b) => eventSeverity(b) - eventSeverity(a))
          .slice(0, CONFLICT_EVENT_CAP);
        return send(200, {
          generatedAt: now(),
          source,
          verified: source === 'acled',
          days: query.days,
          events,
          note: record.note,
          method: record.method,
          fetchedAt: record.fetchedAt,
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
