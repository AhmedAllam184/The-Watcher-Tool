import path from 'node:path';
import { promises as fsp } from 'node:fs';
/**
 * Aircraft photo proxy: ICAO hex → one photo of that airframe, with the
 * photographer credited and a link to its source page. Planespotters.net is
 * tried first (its terms require the photographer and link to be shown); the
 * airport-data.com thumbnail that adsbdb lists for the hex is the fallback.
 * Cached on disk like the adsbdb proxy: photos for a week, "no photo" answers
 * for a day, and upstream failures are never cached.
 */
const PHOTO_TTL_MS = 7 * 24 * 3600_000;
const MISS_TTL_MS = 24 * 3600_000;
const UPSTREAM_TIMEOUT_MS = 8000;
const USER_AGENT =
  'TheWatcher/1.0 (+https://github.com/AhmedAllam184/The-Watcher-Tool)';

/** Only https image and page URLs reach the browser. */
function httpsUrl(value) {
  if (typeof value !== 'string' || !value) return null;
  try {
    const url = new URL(value);
    return url.protocol === 'https:' ? url.href : null;
  } catch {
    return null;
  }
}

/** First photo of a Planespotters hex lookup, or null when it has none. */
export function parsePlanespottersPhoto(json) {
  const first = Array.isArray(json?.photos) ? json.photos[0] : null;
  if (!first) return null;
  const src =
    httpsUrl(first.thumbnail_large?.src) || httpsUrl(first.thumbnail?.src);
  if (!src) return null;
  const photographer =
    typeof first.photographer === 'string' && first.photographer.trim()
      ? first.photographer.trim()
      : null;
  return {
    src,
    link: httpsUrl(first.link),
    photographer,
    source: 'Planespotters.net',
  };
}

/** adsbdb's airport-data.com photo for a hex, or null when it has none. */
export function parseAdsbdbPhoto(json) {
  const aircraft = json?.response?.aircraft;
  const full = httpsUrl(aircraft?.url_photo);
  const thumb = httpsUrl(aircraft?.url_photo_thumbnail);
  const src = thumb || full;
  if (!src) return null;
  return {
    src,
    link: full,
    photographer: null,
    source: 'airport-data.com via adsbdb',
  };
}

export function aircraftPhotoProxy({
  fetchImpl = globalThis.fetch,
  cachePath = path.join(process.cwd(), '.gev-cache', 'aircraft-photos.json'),
} = {}) {
  let cache = {};
  let dirty = false;
  let loaded = false;
  const inflight = new Map();

  async function loadOnce() {
    if (loaded) return;
    loaded = true;
    try {
      const parsed = JSON.parse(await fsp.readFile(cachePath, 'utf8'));
      cache = parsed.photos ?? {};
    } catch {
      /* first run */
    }
    setInterval(async () => {
      if (!dirty) return;
      dirty = false;
      try {
        await fsp.mkdir(path.dirname(cachePath), { recursive: true });
        await fsp.writeFile(
          cachePath,
          JSON.stringify({ photos: cache }),
          'utf8',
        );
      } catch {
        dirty = true;
      } // retry next tick
    }, 15_000).unref?.();
  }

  const fresh = (e) =>
    e && Date.now() - e.at < (e.data ? PHOTO_TTL_MS : MISS_TTL_MS);

  /** GET JSON from an upstream; 404 is reported as missing, other failures throw. */
  async function fetchJson(url, headers) {
    const res = await fetchImpl(url, {
      headers,
      signal: AbortSignal.timeout(UPSTREAM_TIMEOUT_MS),
    });
    if (res.status === 404) return { missing: true };
    if (!res.ok) throw new Error('upstream status');
    return { json: await res.json() };
  }

  /** Try Planespotters, then adsbdb. `uncertain` means an upstream failed. */
  async function resolve(hex) {
    let uncertain = false;
    try {
      const { json } = await fetchJson(
        `https://api.planespotters.net/pub/photos/hex/${hex.toUpperCase()}`,
        { 'User-Agent': USER_AGENT },
      );
      const photo = json ? parsePlanespottersPhoto(json) : null;
      if (photo) return { photo, uncertain: false };
    } catch {
      uncertain = true;
    }
    try {
      const { json } = await fetchJson(
        `https://api.adsbdb.com/v0/aircraft/${hex}`,
        { 'User-Agent': USER_AGENT },
      );
      const photo = json ? parseAdsbdbPhoto(json) : null;
      return { photo, uncertain: uncertain && !photo };
    } catch {
      return { photo: null, uncertain: true };
    }
  }

  function lookup(hex) {
    if (fresh(cache[hex])) return Promise.resolve(cache[hex].data);
    if (!inflight.has(hex)) {
      inflight.set(
        hex,
        (async () => {
          try {
            const { photo, uncertain } = await resolve(hex);
            if (photo || !uncertain) {
              cache[hex] = { at: Date.now(), data: photo }; // null = known miss
              dirty = true;
              return photo;
            }
            // Upstream failed: serve a stale answer if there is one, else none.
            return cache[hex]?.data ?? null;
          } finally {
            inflight.delete(hex);
          }
        })(),
      );
    }
    return inflight.get(hex);
  }

  const installMiddleware = (server) => {
    server.middlewares.use('/api/aircraft/photo', async (req, res) => {
      await loadOnce();
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
        const photo = await lookup(hex);
        return send(200, { hex, photo });
      } catch {
        console.error('[aircraft-photo] request failed');
        return send(500, { error: 'aircraft photo proxy error' });
      }
    });
  };
  return {
    name: 'aircraft-photo-proxy',
    configureServer: installMiddleware,
    configurePreviewServer: installMiddleware,
  };
}
