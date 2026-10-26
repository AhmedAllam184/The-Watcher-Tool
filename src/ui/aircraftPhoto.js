/**
 * @module aircraftPhoto
 * @description Client loader for the selected aircraft's photo, served by the
 * /api/aircraft/photo proxy. Failures resolve to null so the details panel
 * simply shows no photo; a failed lookup is retried on the next selection.
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
  };
}

/**
 * @param {object} [options]
 * @param {(url: string) => Promise<Response>} [options.fetchImpl] Fetch used for the proxy call.
 * @returns {{load: (hex: string) => Promise<{src: string, link: string|null, photographer: string|null, source: string}|null>}}
 */
export function createAircraftPhotoLoader({
  fetchImpl = globalThis.fetch,
} = {}) {
  /** hex → Promise of the photo (or null); one request per hex per session. */
  const cache = new Map();

  function load(hex) {
    const key = String(hex || '').toLowerCase();
    if (!/^[0-9a-f]{6}$/.test(key)) return Promise.resolve(null);
    if (!cache.has(key)) {
      // Deferred one microtask so a synchronous fetch throw still sees the entry set below.
      const pending = Promise.resolve().then(async () => {
        try {
          const res = await fetchImpl(`/api/aircraft/photo?hex=${key}`);
          if (!res.ok) throw new Error('photo lookup failed');
          const body = await res.json();
          return normalizePhoto(body?.photo);
        } catch {
          cache.delete(key); // a failure is not remembered; retry later
          return null;
        }
      });
      cache.set(key, pending);
    }
    return cache.get(key);
  }

  return { load };
}
