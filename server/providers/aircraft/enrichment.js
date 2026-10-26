import path from 'node:path';
import { promises as fsp } from 'node:fs';
import { WATCHER_USER_AGENT } from '../common/userAgent.js';
/**
 * adsbdb.com enrichment proxy: callsign → route (airline + origin/destination
 * airports) and hex → aircraft type/registration. Free community API — cached
 * aggressively: ONE upstream request per new key ever (404s negative-cached),
 * persisted to disk so restarts don't re-hammer it. Adapted from skylight
 * (MIT) server/src/enrich/routes.ts.
 *
 * Route fallback: when adsbdb has no route for a callsign, adsb.lol's routeset
 * API is asked with the plane's current position (see parseRouteset). Its
 * answers are cached per callsign — 24 h for a route, 6 h for a miss.
 *
 * Route answers keep "no route" apart from "upstream unavailable": a route is
 * 200 {found:true}; no route from every source that answered is 200
 * {found:false}; when any source errored and none found a route, the answer is
 * 503 {found:false, transient:true}. Transient outcomes are never cached, so
 * the client can retry them.
 */
const CACHE_PATH = path.join(process.cwd(), '.gev-cache', 'adsbdb.json');

/** Only an answer adsb.lol marks plausible is used (0/1, true/false or numeric strings). */
function plausibleFlag(value) {
  if (value === true) return true;
  if (typeof value === 'number') return value > 0;
  if (typeof value === 'string')
    return value.trim() !== '' && Number(value) > 0;
  return false;
}

/** One adsb.lol `_airports` entry in the route shape the client reads. */
function routesetAirport(a) {
  return {
    code: String(a?.iata || a?.icao || '')
      .trim()
      .toUpperCase(),
    name: String(a?.location || a?.name || '').trim(),
    lat: Number.isFinite(a?.lat) ? a.lat : null,
    lon: Number.isFinite(a?.lon) ? a.lon : null,
  };
}

/**
 * adsb.lol routeset answer → route, or null. The first and last airports of
 * the path are origin and destination; every airport is kept as `legs`.
 * Only answers adsb.lol marks plausible are accepted.
 */
export function parseRouteset(json, callsign = '') {
  const list = Array.isArray(json) ? json : [];
  const wanted = String(callsign).trim().toUpperCase();
  const entry =
    list.find(
      (e) =>
        String(e?.callsign || '')
          .trim()
          .toUpperCase() === wanted,
    ) ?? list[0];
  if (!entry || !plausibleFlag(entry.plausible)) return null;
  const airports = Array.isArray(entry._airports)
    ? entry._airports.map(routesetAirport)
    : [];
  if (airports.length < 2) return null;
  const origin = airports[0];
  const destination = airports[airports.length - 1];
  if (!origin.code || !destination.code) return null;
  return {
    airline: null,
    origin,
    destination,
    legs: airports.filter((a) => a.code),
    source: 'adsb.lol',
  };
}

export function adsbdbProxy() {
  const TTL_MS = 24 * 3600_000;
  const ROUTE_MISS_TTL_MS = 6 * 3600_000;
  const ROUTESET_URL = 'https://api.adsb.lol/api/0/routeset';
  let cache = { routes: {}, aircraft: {}, routesLol: {} };
  let dirty = false;
  let loaded = false;
  const inflight = new Map();

  async function loadOnce() {
    if (loaded) return;
    loaded = true;
    try {
      const parsed = JSON.parse(await fsp.readFile(CACHE_PATH, 'utf8'));
      cache = {
        routes: parsed.routes ?? {},
        aircraft: parsed.aircraft ?? {},
        routesLol: parsed.routesLol ?? {},
      };
    } catch {
      /* first run */
    }
    setInterval(async () => {
      if (!dirty) return;
      dirty = false;
      try {
        await fsp.mkdir(path.dirname(CACHE_PATH), { recursive: true });
        await fsp.writeFile(CACHE_PATH, JSON.stringify(cache), 'utf8');
      } catch {
        dirty = true;
      } // retry next tick
    }, 15_000).unref?.();
  }

  const fresh = (e) => e && Date.now() - e.at < TTL_MS;
  const freshRouteset = (e) =>
    e && Date.now() - e.at < (e.data ? TTL_MS : ROUTE_MISS_TTL_MS);

  function parseRoute(json) {
    const fr = json?.response?.flightroute;
    if (!fr?.origin || !fr?.destination) return null;
    const airport = (a) => ({
      code: a.iata_code || a.icao_code || '',
      name: a.municipality || a.name || '',
      lat: Number.isFinite(a.latitude) ? a.latitude : null,
      lon: Number.isFinite(a.longitude) ? a.longitude : null,
    });
    return {
      airline: fr.airline?.name || null,
      origin: airport(fr.origin),
      destination: airport(fr.destination),
      source: 'adsbdb',
    };
  }

  function parseAircraft(json) {
    const a = json?.response?.aircraft;
    if (!a) return null;
    return {
      typeCode: a.icao_type || null, // ICAO designator, e.g. "B738" — feeds classifyAircraft
      typeName:
        a.manufacturer && a.type
          ? `${a.manufacturer} ${a.type}`
          : a.type || null,
      registration: a.registration || null,
      // adsbdb's airport-data.com photo of this airframe (aircraft/photos.js
      // is the photo route; these are kept for callers that want them).
      photoUrl: a.url_photo || null,
      photoThumbUrl: a.url_photo_thumbnail || null,
    };
  }

  /**
   * One adsbdb answer, as { data, transient }. A 200 or a 404 is definitive and
   * cached (null = known miss). Any other failure is transient: not cached.
   */
  function lookup(kind, key) {
    const store = kind === 'route' ? cache.routes : cache.aircraft;
    if (fresh(store[key]))
      return Promise.resolve({ data: store[key].data, transient: false });
    const ik = `${kind}:${key}`;
    if (!inflight.has(ik)) {
      inflight.set(
        ik,
        (async () => {
          try {
            const url =
              kind === 'route'
                ? `https://api.adsbdb.com/v0/callsign/${encodeURIComponent(key)}`
                : `https://api.adsbdb.com/v0/aircraft/${encodeURIComponent(key)}`;
            const res = await fetch(url, { signal: AbortSignal.timeout(8000) });
            if (res.ok) {
              const data =
                kind === 'route'
                  ? parseRoute(await res.json())
                  : parseAircraft(await res.json());
              store[key] = { at: Date.now(), data }; // data may be null — negative cache
              dirty = true;
              return { data, transient: false };
            }
            if (res.status === 404) {
              store[key] = { at: Date.now(), data: null }; // known-missing — cache the miss
              dirty = true;
              return { data: null, transient: false };
            }
            // other statuses: leave uncached so we retry later
            return { data: null, transient: true };
          } catch {
            return { data: null, transient: true }; // network error: retry later
          } finally {
            inflight.delete(ik);
          }
        })(),
      );
    }
    return inflight.get(ik);
  }

  /**
   * adsb.lol routeset for one callsign at the plane's position (single-flight),
   * as { data, transient }. A non-OK answer or a throw is transient.
   */
  function lookupRouteset(callsign, lat, lon) {
    const hit = cache.routesLol[callsign];
    if (freshRouteset(hit))
      return Promise.resolve({ data: hit.data, transient: false });
    const ik = `routeset:${callsign}`;
    if (!inflight.has(ik)) {
      inflight.set(
        ik,
        (async () => {
          try {
            const res = await fetch(ROUTESET_URL, {
              method: 'POST',
              headers: {
                'Content-Type': 'application/json',
                Accept: 'application/json',
                'User-Agent': WATCHER_USER_AGENT,
              },
              body: JSON.stringify({ planes: [{ callsign, lat, lng: lon }] }),
              signal: AbortSignal.timeout(8000),
            });
            // Upstream trouble is not cached: serve a stale answer if there is one.
            if (!res.ok) return { data: hit?.data ?? null, transient: true };
            const data = parseRouteset(await res.json(), callsign);
            cache.routesLol[callsign] = { at: Date.now(), data }; // data may be null — negative cache
            dirty = true;
            return { data, transient: false };
          } catch {
            return { data: hit?.data ?? null, transient: true };
          } finally {
            inflight.delete(ik);
          }
        })(),
      );
    }
    return inflight.get(ik);
  }

  const installMiddleware = (server) => {
    server.middlewares.use('/api/adsbdb', async (req, res) => {
      await loadOnce();
      const send = (status, obj) => {
        res.writeHead(status, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(obj));
      };
      try {
        const [, kind, rawKey] = String(req.url || '')
          .split('?')[0]
          .split('/');
        if (kind === 'route') {
          const cs = String(rawKey || '').toUpperCase();
          // Any callsign of 3–8 characters that starts with a letter.
          if (!/^[A-Z][A-Z0-9]{2,7}$/.test(cs))
            return send(400, { error: 'invalid callsign' });
          const adsbdb = await lookup('route', cs);
          if (adsbdb.data)
            return send(200, {
              found: true,
              ...adsbdb.data,
              source: adsbdb.data.source || 'adsbdb',
            });
          let unavailable = adsbdb.transient;
          // adsbdb has no route: ask adsb.lol, which needs the plane's position.
          const params = new URLSearchParams(
            String(req.url || '').split('?')[1] || '',
          );
          const coordinate = (name, limit) => {
            const raw = params.get(name);
            if (raw === null || raw.trim() === '') return null;
            const value = Number(raw);
            return Number.isFinite(value) && Math.abs(value) <= limit
              ? value
              : null;
          };
          const lat = coordinate('lat', 90);
          const lon = coordinate('lon', 180);
          if (lat !== null && lon !== null) {
            const fallback = await lookupRouteset(cs, lat, lon);
            if (fallback.data)
              return send(200, { found: true, ...fallback.data });
            unavailable = unavailable || fallback.transient;
          }
          // "No route" needs every source that was asked to answer; an errored
          // source makes it a transient outcome the client may retry.
          if (unavailable) return send(503, { found: false, transient: true });
          return send(200, { found: false });
        }
        if (kind === 'type') {
          const hex = String(rawKey || '').toLowerCase();
          if (!/^[0-9a-f]{6}$/.test(hex))
            return send(400, { error: 'invalid hex' });
          const { data } = await lookup('aircraft', hex);
          return send(200, data ? { found: true, ...data } : { found: false });
        }
        return send(404, { error: 'unknown endpoint' });
      } catch (err) {
        console.error('[adsbdb-proxy] request failed');
        return send(500, { error: 'adsbdb proxy error' });
      }
    });
  };
  return {
    name: 'adsbdb-proxy',
    configureServer: installMiddleware,
    configurePreviewServer: installMiddleware,
  };
}
