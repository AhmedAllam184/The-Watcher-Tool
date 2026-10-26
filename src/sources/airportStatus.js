/**
 * Airport disruption status (inferred from live aircraft): validated,
 * normalized and portable. The server rates holding and degraded GPS per
 * airport; this module only reads that payload and never trusts an unknown
 * level or a non-finite number.
 */

export const AIRPORT_STATUS_LEVELS = Object.freeze([
  'normal',
  'watch',
  'disrupted',
  'unknown',
]);
export const AIRPORT_STATUS_SOURCE_LABEL = 'adsb.lol (inferred)';
/** Most ICAO codes one request may name (the server enforces the same limit). */
export const AIRPORT_STATUS_MAX_CODES = 8;

const ICAO_PATTERN = /^[A-Z0-9]{4}$/;
const malformed = () => new Error('Malformed airport status payload');
const finite = (value) => (Number.isFinite(value) ? value : null);
const text = (value) => (typeof value === 'string' ? value.trim() : '');
const count = (value) => (Number.isInteger(value) && value >= 0 ? value : 0);

/** One server airport → plain record, or null when its code or position is unusable. */
function normalizeAirport(raw) {
  const icao = text(raw?.icao);
  const lat = finite(raw?.lat);
  const lon = finite(raw?.lon);
  if (!ICAO_PATTERN.test(icao) || lat === null || lon === null) return null;
  const share = finite(raw.degradedShare);
  return {
    icao,
    iata: text(raw.iata),
    name: text(raw.name) || icao,
    city: text(raw.city),
    lat,
    lon,
    lastPolledAt: finite(raw.lastPolledAt),
    aircraftNearby: count(raw.aircraftNearby),
    /** Null when holding was not assessed (sparse samples), never a fact of zero. */
    holdingReliable: raw.holdingReliable === true,
    holding: raw.holding === null ? null : count(raw.holding),
    holdingCallsigns: Array.isArray(raw.holdingCallsigns)
      ? raw.holdingCallsigns
          .filter((callsign) => typeof callsign === 'string')
          .slice(0, 5)
      : [],
    degradedGps: count(raw.degradedGps),
    judged: count(raw.judged),
    degradedShare: share === null ? null : Math.min(1, Math.max(0, share)),
    level: AIRPORT_STATUS_LEVELS.includes(raw.level) ? raw.level : 'unknown',
    reasons: Array.isArray(raw.reasons)
      ? raw.reasons.filter((reason) => typeof reason === 'string')
      : [],
  };
}

/**
 * Validate one /api/airports/status payload. A malformed top level is
 * rejected; an airport with an unusable code or position is dropped.
 * @param {unknown} payload Parsed JSON body.
 * @returns {{generatedAt: number|null, airports: object[], method: string,
 *   note: string, source: string}}
 */
export function normalizeAirportStatus(payload) {
  if (
    !payload ||
    typeof payload !== 'object' ||
    !Array.isArray(payload.airports)
  )
    throw malformed();
  return {
    generatedAt: finite(payload.generatedAt),
    airports: payload.airports.map(normalizeAirport).filter(Boolean),
    method: text(payload.method),
    note: text(payload.note),
    source: text(payload.source) || 'adsb.lol (ODbL)',
  };
}

/**
 * Lazy same-origin acquisition of the airport status. `codes` asks the server
 * to watch up to 8 more airports for 15 min; the watched list is always returned.
 */
export function createAirportStatusSource({
  fetchImpl = (...args) => globalThis.fetch(...args),
  timeoutMs = 15_000,
} = {}) {
  return {
    async getStatus({ codes = [], signal } = {}) {
      const list = [
        ...new Set(codes.map((code) => String(code).toUpperCase())),
      ];
      if (
        list.length > AIRPORT_STATUS_MAX_CODES ||
        list.some((code) => !ICAO_PATTERN.test(code))
      )
        throw new RangeError(
          `Airport status takes up to ${AIRPORT_STATUS_MAX_CODES} ICAO codes`,
        );
      const query = list.length
        ? `?${new URLSearchParams({ codes: list.join(',') })}`
        : '';
      const controller = new AbortController();
      const abort = () => controller.abort(signal?.reason);
      signal?.addEventListener('abort', abort, { once: true });
      const timer = setTimeout(
        () => controller.abort(new Error('Airport status request timed out')),
        timeoutMs,
      );
      try {
        signal?.throwIfAborted();
        const response = await fetchImpl(`/api/airports/status${query}`, {
          signal: controller.signal,
          cache: 'no-store',
          redirect: 'error',
        });
        let payload;
        try {
          payload = await response.json();
        } catch {
          /* the status below remains authoritative */
        }
        controller.signal.throwIfAborted();
        if (!response.ok)
          throw new Error(`Airport status HTTP ${response.status}`);
        return normalizeAirportStatus(payload);
      } finally {
        clearTimeout(timer);
        signal?.removeEventListener('abort', abort);
      }
    },
  };
}
