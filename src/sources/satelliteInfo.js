/**
 * @module satelliteInfo
 * @description Client loader for a satellite's CelesTrak catalogue record,
 * served by the /api/satellites/info proxy. One request per NORAD id per
 * session; a failed lookup is forgotten so the next selection retries it.
 */

const text = (value) =>
  typeof value === 'string' && value.trim() ? value.trim() : null;
const finite = (value) =>
  typeof value === 'number' && Number.isFinite(value) ? value : null;

/** Keep only the fields the details panel renders, with their types checked. */
export function normalizeSatelliteInfo(raw) {
  if (!raw || typeof raw !== 'object') return null;
  const named = (value) =>
    value && typeof value === 'object'
      ? { code: text(value.code), name: text(value.name) }
      : null;
  return {
    norad: finite(raw.norad),
    name: text(raw.name),
    intlDesignator: text(raw.intlDesignator),
    objectType: text(raw.objectType),
    objectTypeText: text(raw.objectTypeText),
    status: text(raw.status),
    statusText: text(raw.statusText),
    owner: named(raw.owner),
    launchDate: text(raw.launchDate),
    launchSite: named(raw.launchSite),
    decayDate: text(raw.decayDate),
    periodMin: finite(raw.periodMin),
    inclinationDeg: finite(raw.inclinationDeg),
    apogeeKm: finite(raw.apogeeKm),
    perigeeKm: finite(raw.perigeeKm),
    orbitClass: text(raw.orbitClass),
    rcsM2: finite(raw.rcsM2),
    rcsSize: text(raw.rcsSize),
  };
}

/**
 * @param {object} [options]
 * @param {(url: string) => Promise<Response>} [options.fetchImpl] Fetch used for the proxy call.
 * @returns {{load: (norad: number|string) => Promise<{satellite: object|null}>}}
 *   Resolves with `satellite: null` when CelesTrak has no such object; rejects when the lookup failed.
 */
export function createSatelliteInfoLoader({
  fetchImpl = (...args) => globalThis.fetch(...args),
} = {}) {
  /** NORAD id → Promise of the answer; one request per id per session. */
  const cache = new Map();

  function load(norad) {
    const key = Number(norad);
    if (!Number.isSafeInteger(key) || key <= 0)
      return Promise.resolve({ satellite: null });
    if (!cache.has(key)) {
      // Deferred one microtask so a synchronous fetch throw still sees the entry set below.
      const pending = Promise.resolve().then(async () => {
        try {
          const res = await fetchImpl(`/api/satellites/info?norad=${key}`);
          if (!res.ok) throw new Error('satellite info lookup failed');
          const body = await res.json();
          return { satellite: normalizeSatelliteInfo(body?.satellite) };
        } catch (error) {
          cache.delete(key); // a failure is not remembered; retry later
          throw error;
        }
      });
      cache.set(key, pending);
    }
    return cache.get(key);
  }

  return { load };
}
