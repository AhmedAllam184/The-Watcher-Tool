/**
 * @module aircraftPhoto
 * @description Client loader for the selected aircraft's photo, served by the
 * /api/aircraft/photo proxy. Failures resolve to null so the details panel
 * simply shows no photo; a failed lookup is retried on the next selection.
 * An optional aircraft type lets the proxy fall back to a photo of that type
 * (kind 'type') when it has no photo of this airframe.
 */

function httpsUrlOrNull(value) {
  if (typeof value !== 'string' || !value) return null;
  try {
    const url = new URL(value);
    return url.protocol === 'https:' ? url.href : null;
  } catch {
    return null;
  }
}

/** The type text sent to the proxy: the proxy's own rules, else no type. */
function typeOrNull(value) {
  if (typeof value !== 'string') return null;
  const text = value.trim().replace(/\s+/g, ' ');
  return /^[A-Za-z0-9 .\-()]{2,80}$/.test(text) ? text : null;
}

/** Keep only the fields the panel renders, and only https URLs. */
function normalizePhoto(photo) {
  if (!photo || typeof photo !== 'object') return null;
  const src = httpsUrlOrNull(photo.src);
  if (!src) return null;
  return {
    src,
    link: httpsUrlOrNull(photo.link),
    photographer:
      typeof photo.photographer === 'string' && photo.photographer.trim()
        ? photo.photographer.trim()
        : null,
    source: typeof photo.source === 'string' ? photo.source.trim() : '',
    kind: photo.kind === 'type' ? 'type' : 'airframe',
    title:
      typeof photo.title === 'string' && photo.title.trim()
        ? photo.title.trim()
        : null,
  };
}

/**
 * @param {object} [options]
 * @param {(url: string) => Promise<Response>} [options.fetchImpl] Fetch used for the proxy call.
 * @returns {{load: (hex: string, options?: {type?: string|null}) => Promise<{src: string, link: string|null, photographer: string|null, source: string, kind: 'airframe'|'type', title: string|null}|null>}}
 */
export function createAircraftPhotoLoader({
  fetchImpl = globalThis.fetch,
} = {}) {
  /** hex + type → Promise of the photo (or null); one request per pair per session. */
  const cache = new Map();

  function load(hex, { type = null } = {}) {
    const key = String(hex || '').toLowerCase();
    if (!/^[0-9a-f]{6}$/.test(key)) return Promise.resolve(null);
    const typeText = typeOrNull(type);
    const cacheKey = typeText ? `${key}|${typeText.toLowerCase()}` : key;
    if (!cache.has(cacheKey)) {
      // Deferred one microtask so a synchronous fetch throw still sees the entry set below.
      const pending = Promise.resolve().then(async () => {
        try {
          const query = typeText
            ? `hex=${key}&type=${encodeURIComponent(typeText)}`
            : `hex=${key}`;
          const res = await fetchImpl(`/api/aircraft/photo?${query}`);
          if (!res.ok) throw new Error('photo lookup failed');
          const body = await res.json();
          return normalizePhoto(body?.photo);
        } catch {
          cache.delete(cacheKey); // a failure is not remembered; retry later
          return null;
        }
      });
      cache.set(cacheKey, pending);
    }
    return cache.get(cacheKey);
  }

  return { load };
}
