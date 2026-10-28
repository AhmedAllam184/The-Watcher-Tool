/**
 * @module identifyInfo
 * @description Client loader for a Wikipedia summary, image and link about the
 * selected aircraft type or satellite programme, served by /api/identify. One
 * request per kind and query per session; a failed lookup is forgotten so the
 * next selection retries it, and the panel simply shows no article meanwhile.
 */

/** Only https article links and Wikimedia image URLs reach the page. */
function httpsUrlOrNull(value, hostname = null) {
  if (typeof value !== 'string' || !value) return null;
  try {
    const url = new URL(value);
    if (url.protocol !== 'https:') return null;
    if (hostname && url.hostname !== hostname) return null;
    return url.href;
  } catch {
    return null;
  }
}

const text = (value) =>
  typeof value === 'string' && value.trim() ? value.trim() : null;

/** Keep only the fields the panel renders, with their URLs checked. */
export function normalizeArticle(raw) {
  if (!raw || typeof raw !== 'object') return null;
  const title = text(raw.title);
  const summary = text(raw.summary);
  if (!title || !summary) return null;
  return {
    title,
    summary,
    image: httpsUrlOrNull(raw.image, 'upload.wikimedia.org'),
    link: httpsUrlOrNull(raw.link),
  };
}

/**
 * @param {object} [options]
 * @param {(url: string) => Promise<Response>} [options.fetchImpl] Fetch used for the proxy call.
 * @returns {{load: (kind: 'aircraft'|'satellite', query: string) => Promise<object|null>}}
 *   Resolves with the article, or null when Wikipedia has none or the lookup failed.
 */
export function createIdentifyLoader({
  fetchImpl = (...args) => globalThis.fetch(...args),
} = {}) {
  /** kind|query → Promise of the article (or null); one request per key per session. */
  const cache = new Map();

  function load(kind, query) {
    const q = String(query ?? '').trim();
    if (!q || (kind !== 'aircraft' && kind !== 'satellite'))
      return Promise.resolve(null);
    const key = `${kind}|${q.toLowerCase()}`;
    if (!cache.has(key)) {
      // Deferred one microtask so a synchronous fetch throw still sees the entry set below.
      const pending = Promise.resolve().then(async () => {
        try {
          const params = new URLSearchParams({ kind, q });
          const res = await fetchImpl(`/api/identify?${params}`);
          if (!res.ok) throw new Error('identify lookup failed');
          return normalizeArticle(await res.json());
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
