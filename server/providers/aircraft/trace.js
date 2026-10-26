import { readCappedResponseText } from '../common/http.js';
import { WATCHER_USER_AGENT } from '../common/userAgent.js';
/**
 * Aircraft trace proxy: ICAO hex → the fixes of the CURRENT flight, from the
 * adsb.lol trace archive (readsb trace format). The full and the recent trace
 * are fetched together; recent fixes newer than the full trace's last fix are
 * appended, so the newest minutes are never missing. Only the current flight is
 * returned: the walk runs back
 * from the newest fix and stops at the last point on the ground or at a gap of
 * more than 30 minutes. Long flights are decimated evenly to TRACE_MAX_POINTS.
 * Answers are cached for 60 s per hex (misses too); a failed upstream is not
 * cached, and a stale answer is served instead when one exists.
 */
export const TRACE_MAX_POINTS = 4000;
const FLIGHT_GAP_MS = 30 * 60_000;
const CACHE_MS = 60_000;
const UPSTREAM_TIMEOUT_MS = 10_000;
const MAX_TRACE_BYTES = 32 * 1024 * 1024;
const TRACE_BASE = 'https://globe.adsb.lol/data/traces';

/** Full then recent trace URLs for a hex (the directory is its last two hex digits). */
export function traceUrls(hex) {
  const id = String(hex).toLowerCase();
  const dir = `${TRACE_BASE}/${id.slice(-2)}`;
  return [`${dir}/trace_full_${id}.json`, `${dir}/trace_recent_${id}.json`];
}

const round6 = (value) => Math.round(value * 1e6) / 1e6;

/**
 * Evenly decimate an ordered list to at most `max` entries; the first and last
 * entries are always kept.
 */
export function decimatePoints(points, max = TRACE_MAX_POINTS) {
  if (points.length <= max) return points;
  const step = (points.length - 1) / (max - 1);
  const out = [];
  for (let i = 0; i < max; i++) out.push(points[Math.round(i * step)]);
  return out;
}

/**
 * readsb trace JSON → every usable fix, oldest first. Rows are
 * [dtSeconds, lat, lon, altBaroFt | "ground" | null, ...]; `timestamp` is the
 * epoch-second base for every dt. Returns null when the body is not a trace.
 */
export function parseTraceFixes(json) {
  const base = Number(json?.timestamp);
  if (!Number.isFinite(base) || !Array.isArray(json?.trace)) return null;
  const fixes = [];
  for (const row of json.trace) {
    if (!Array.isArray(row)) continue;
    const dt = Number(row[0]);
    const lat = row[1];
    const lon = row[2];
    if (!Number.isFinite(dt) || !Number.isFinite(lat) || !Number.isFinite(lon))
      continue;
    const alt = row[3];
    fixes.push({
      t: Math.round((base + dt) * 1000),
      lat,
      lon,
      altFt: Number.isFinite(alt) ? alt : null,
      onGround: alt === 'ground',
    });
  }
  return fixes.sort((a, b) => a.t - b.t);
}

/**
 * Full-trace fixes, then the recent-trace fixes newer than the full trace's
 * last fix. Both lists are oldest first; a time present in both is kept once.
 */
export function mergeTraceFixes(full = [], recent = []) {
  const lastT = full.length > 0 ? full[full.length - 1].t : -Infinity;
  const merged = [...full, ...recent.filter((fix) => fix.t > lastT)];
  return merged.filter((fix, i) => i === 0 || fix.t !== merged[i - 1].t);
}

/**
 * The current flight from ordered fixes. Walks back from the newest fix and
 * stops before a ground fix or a gap longer than 30 minutes, then decimates.
 */
export function currentFlight(fixes) {
  // Walk back from the newest fix: stop before a ground fix, or before a gap.
  let start = fixes.length;
  for (let i = fixes.length - 1; i >= 0; i--) {
    if (fixes[i].onGround) break;
    start = i;
    if (i > 0 && fixes[i].t - fixes[i - 1].t > FLIGHT_GAP_MS) break;
  }
  const flight = decimatePoints(
    fixes.slice(start).map((fix) => ({
      t: fix.t,
      lat: round6(fix.lat),
      lon: round6(fix.lon),
      altFt: fix.altFt === null ? null : Math.round(fix.altFt),
      onGround: false,
    })),
  );
  return { points: flight, startedAt: flight[0]?.t ?? null };
}

/**
 * readsb trace JSON → the current flight. Returns null when the body is not a trace.
 */
export function parseTraceFlight(json) {
  const fixes = parseTraceFixes(json);
  return fixes === null ? null : currentFlight(fixes);
}

export function aircraftTraceProxy({
  fetchImpl = globalThis.fetch,
  now = () => Date.now(),
} = {}) {
  const cache = new Map(); // hex → { at, data }
  const inflight = new Map();

  /** GET one trace; 404 is reported as missing, other failures throw. */
  async function getTrace(url) {
    const res = await fetchImpl(url, {
      headers: { 'User-Agent': WATCHER_USER_AGENT, Accept: 'application/json' },
      signal: AbortSignal.timeout(UPSTREAM_TIMEOUT_MS),
    });
    if (res.status === 404) return { missing: true };
    if (!res.ok) throw new Error('upstream status');
    const { tooLarge, text } = await readCappedResponseText(
      res,
      MAX_TRACE_BYTES,
    );
    if (tooLarge) throw new Error('trace too large');
    return { json: JSON.parse(text) };
  }

  /**
   * Full and recent traces, fetched in parallel and merged. One success is
   * enough; null when neither exists; throws when no trace answered and one
   * of the requests failed.
   */
  async function resolveTrace(hex) {
    const [full, recent] = await Promise.allSettled(
      traceUrls(hex).map((url) => getTrace(url)),
    );
    const fixesOf = (result) =>
      result.status === 'fulfilled' && result.value.json
        ? (parseTraceFixes(result.value.json) ?? [])
        : null;
    const fullFixes = fixesOf(full);
    const recentFixes = fixesOf(recent);
    if (fullFixes === null && recentFixes === null) {
      const failure = [full, recent].find(
        (result) => result.status === 'rejected',
      );
      if (failure) throw failure.reason;
      return null;
    }
    return currentFlight(mergeTraceFixes(fullFixes ?? [], recentFixes ?? []));
  }

  function lookup(hex) {
    const hit = cache.get(hex);
    if (hit && now() - hit.at < CACHE_MS) return Promise.resolve(hit.data);
    if (!inflight.has(hex)) {
      inflight.set(
        hex,
        (async () => {
          try {
            const flight = await resolveTrace(hex);
            const data = {
              hex,
              source: 'adsb.lol',
              points: flight?.points ?? [],
              startedAt: flight?.startedAt ?? null,
            };
            if (cache.size >= 1000) cache.delete(cache.keys().next().value);
            cache.set(hex, { at: now(), data });
            return data;
          } catch (err) {
            if (hit) return hit.data; // upstream trouble: stale answer if we have one
            throw err;
          } finally {
            inflight.delete(hex);
          }
        })(),
      );
    }
    return inflight.get(hex);
  }

  const installMiddleware = (server) => {
    server.middlewares.use('/api/aircraft/trace', async (req, res) => {
      const send = (status, obj) => {
        res.writeHead(status, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(obj));
      };
      try {
        const url = new URL(String(req.url || ''), 'http://localhost');
        if (url.pathname !== '/')
          return send(404, { error: 'unknown endpoint' });
        const hex = String(url.searchParams.get('hex') || '').toLowerCase();
        if (!/^[0-9a-f]{6}$/.test(hex))
          return send(400, { error: 'invalid hex' });
        return send(200, await lookup(hex));
      } catch {
        console.error('[aircraft-trace] request failed');
        return send(502, { error: 'aircraft trace unavailable' });
      }
    });
  };
  return {
    name: 'aircraft-trace-proxy',
    configureServer: installMiddleware,
    configurePreviewServer: installMiddleware,
  };
}
