import path from 'node:path';
import { promises as fsp } from 'node:fs';
import { WATCHER_USER_AGENT } from '../common/userAgent.js';
import { MILITARY_TYPE_NAMES } from '../../../src/data/militaryTypeNames.js';
/**
 * Aircraft photo proxy: ICAO hex → one photo of that airframe, with the
 * photographer credited and a link to its source page. Planespotters.net is
 * tried first (its terms require the photographer and link to be shown); the
 * airport-data.com thumbnail that adsbdb lists for the hex is the fallback.
 * When neither has the airframe and the caller gives its aircraft type, a
 * Wikipedia image of that type stands in (kind 'type', not this exact
 * aircraft). Cached on disk like the adsbdb proxy: airframe photos for a week,
 * "no photo" answers for a day; type photos for 30 days, type misses for 7
 * days. Upstream failures are never cached. Memory and disk hold at most 5,000
 * entries; the oldest by time are evicted first.
 */
const PHOTO_TTL_MS = 7 * 24 * 3600_000;
const MISS_TTL_MS = 24 * 3600_000;
const TYPE_PHOTO_TTL_MS = 30 * 24 * 3600_000;
const TYPE_MISS_TTL_MS = 7 * 24 * 3600_000;
/** Type lookups share the photo cache under keys with this prefix (hexes never start with it). */
const TYPE_PREFIX = 'type:';
/** Disk and memory hold at most this many entries. */
const MAX_ENTRIES = 5000;
const UPSTREAM_TIMEOUT_MS = 8000;
/** 2–80 letters, digits, spaces, hyphens, dots and parentheses. */
const TYPE_PATTERN = /^[A-Za-z0-9 .\-()]{2,80}$/;

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

/** Wikimedia image URLs only: https on upload.wikimedia.org. */
function wikimediaImageUrl(value) {
  const url = httpsUrl(value);
  if (!url) return null;
  return new URL(url).hostname === 'upload.wikimedia.org' ? url : null;
}

/** The aircraft type text the route accepts (trimmed, spaces collapsed), or null. */
export function parseAircraftType(value) {
  if (typeof value !== 'string') return null;
  const text = value.trim().replace(/\s+/g, ' ');
  return TYPE_PATTERN.test(text) ? text : null;
}

/** The name to search for: a military designator's common name, else the text itself. */
export function searchNameForType(text) {
  const code = text.replace(/\s+/g, '').toUpperCase();
  return Object.hasOwn(MILITARY_TYPE_NAMES, code)
    ? MILITARY_TYPE_NAMES[code]
    : text;
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
    kind: 'airframe',
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
    kind: 'airframe',
  };
}

/** The Wikipedia search URL for a type: the best-matching article's thumbnail. */
export function wikipediaTypeUrl(searchName) {
  const params = new URLSearchParams({
    action: 'query',
    format: 'json',
    formatversion: '2',
    generator: 'search',
    gsrsearch: `${searchName} aircraft`,
    gsrlimit: '1',
    prop: 'pageimages|info',
    piprop: 'thumbnail',
    pithumbsize: '640',
    inprop: 'url',
  });
  return `https://en.wikipedia.org/w/api.php?${params}`;
}

/** The Wikipedia article's image for a type search, or null when it has none. */
export function parseWikipediaTypePhoto(json) {
  const page = Array.isArray(json?.query?.pages) ? json.query.pages[0] : null;
  const src = wikimediaImageUrl(page?.thumbnail?.source);
  if (!src) return null;
  const title =
    typeof page.title === 'string' && page.title.trim()
      ? page.title.trim()
      : null;
  return {
    src,
    link: httpsUrl(page.fullurl),
    photographer: null,
    source: 'Wikipedia',
    kind: 'type',
    title,
  };
}

export function aircraftPhotoProxy({
  fetchImpl = globalThis.fetch,
  cachePath = path.join(process.cwd(), '.gev-cache', 'aircraft-photos.json'),
} = {}) {
  let cache = {};
  let dirty = false;
  let saving = false;
  /** The one disk read; every caller awaits the same promise. */
  let loading = null;
  const inflight = new Map();

  /** How long an entry lives: by its key (hex or type) and whether it has a photo. */
  function ttlFor(key, data) {
    const typed = key.startsWith(TYPE_PREFIX);
    if (data) return typed ? TYPE_PHOTO_TTL_MS : PHOTO_TTL_MS;
    return typed ? TYPE_MISS_TTL_MS : MISS_TTL_MS;
  }

  const fresh = (key, e) => e && Date.now() - e.at < ttlFor(key, e.data);

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
      .filter(([key, entry]) => fresh(key, entry))
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
        JSON.stringify({ photos: persistable() }),
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
        cache = parsed.photos ?? {};
      } catch {
        /* first run */
      }
      // Expired entries are dropped on load, then the cap applies.
      for (const key of Object.keys(cache)) {
        if (!fresh(key, cache[key])) {
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
  async function resolveAirframe(hex) {
    let uncertain = false;
    try {
      const { json } = await fetchJson(
        `https://api.planespotters.net/pub/photos/hex/${hex.toUpperCase()}`,
        { 'User-Agent': WATCHER_USER_AGENT },
      );
      const photo = json ? parsePlanespottersPhoto(json) : null;
      if (photo) return { photo, uncertain: false };
    } catch {
      uncertain = true;
    }
    try {
      const { json } = await fetchJson(
        `https://api.adsbdb.com/v0/aircraft/${hex}`,
        { 'User-Agent': WATCHER_USER_AGENT },
      );
      const photo = json ? parseAdsbdbPhoto(json) : null;
      return { photo, uncertain: uncertain && !photo };
    } catch {
      return { photo: null, uncertain: true };
    }
  }

  /** Wikipedia's best article for the type; `uncertain` when the request failed. */
  async function resolveType(text) {
    try {
      const { json } = await fetchJson(
        wikipediaTypeUrl(searchNameForType(text)),
        { 'User-Agent': WATCHER_USER_AGENT },
      );
      const photo = json ? parseWikipediaTypePhoto(json) : null;
      return { photo, uncertain: false };
    } catch {
      return { photo: null, uncertain: true };
    }
  }

  /**
   * One cached answer per key. A definitive answer (photo or known miss) is
   * stored; an upstream failure is not, and serves the stale entry if any.
   */
  function cached(key, resolveFn) {
    if (fresh(key, cache[key])) return Promise.resolve(cache[key].data);
    if (!inflight.has(key)) {
      inflight.set(
        key,
        (async () => {
          try {
            const { photo, uncertain } = await resolveFn();
            if (photo || !uncertain) {
              cache[key] = { at: Date.now(), data: photo }; // null = known miss
              enforceCap();
              dirty = true;
              return photo;
            }
            // Upstream failed: serve a stale answer if there is one, else none.
            return cache[key]?.data ?? null;
          } finally {
            inflight.delete(key);
          }
        })(),
      );
    }
    return inflight.get(key);
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
        const rawType = String(url.searchParams.get('type') || '').trim();
        const type = rawType ? parseAircraftType(rawType) : null;
        if (rawType && !type) return send(400, { error: 'invalid type' });
        const airframe = await cached(hex, () => resolveAirframe(hex));
        const photo =
          airframe ??
          (type
            ? await cached(`${TYPE_PREFIX}${type.toLowerCase()}`, () =>
                resolveType(type),
              )
            : null);
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
