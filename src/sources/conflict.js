/** Armed-conflict events snapshot (ACLED or GDELT news locations): validated, normalized, portable. */

export const CONFLICT_DAYS = Object.freeze([1, 7]);
export const CONFLICT_DEFAULT_DAYS = 1;
export const CONFLICT_SOURCES = Object.freeze(['acled', 'gdelt']);

const malformed = () => new Error('Malformed conflict events snapshot');
const finite = (value) => (Number.isFinite(value) ? value : null);
const text = (value) => (typeof value === 'string' ? value.trim() : '');

/** An http(s) URL string, or undefined. */
function httpUrl(value) {
  try {
    const parsed = new URL(String(value ?? ''));
    return ['http:', 'https:'].includes(parsed.protocol)
      ? parsed.href
      : undefined;
  } catch {
    return undefined;
  }
}

/** One server event → plain record, or null when its position or identity is unusable. */
function normalizeEvent(raw) {
  const lat = finite(raw?.lat);
  const lon = finite(raw?.lon);
  const id = text(raw?.id);
  if (lat === null || lon === null || Math.abs(lat) > 90 || Math.abs(lon) > 180)
    return null;
  if (!id) return null;
  const fatalities = finite(raw.fatalities);
  const articles = finite(raw.articles);
  const url = httpUrl(raw.url);
  const subType = text(raw.subType);
  const sourceName = text(raw.sourceName);
  return {
    id,
    lat,
    lon,
    date: text(raw.date),
    type: text(raw.type) || 'Unclassified',
    ...(subType ? { subType } : {}),
    fatalities: fatalities === null ? null : Math.max(0, fatalities),
    articles: articles === null ? null : Math.max(1, articles),
    actors: Array.isArray(raw.actors)
      ? raw.actors.map(text).filter(Boolean)
      : [],
    country: text(raw.country) || null,
    location: text(raw.location) || null,
    title: text(raw.title) || text(raw.type) || 'Conflict event',
    ...(url ? { url } : {}),
    ...(sourceName ? { sourceName } : {}),
  };
}

/**
 * Validate one /api/conflicts payload. A malformed top-level shape is
 * rejected; individual events with unusable positions are dropped. Anything
 * other than an ACLED payload is presented as the unverified GDELT source.
 * @param {unknown} payload - Parsed JSON body.
 * @param {number} requestedDays - Window the caller asked for.
 * @returns {object} Normalized snapshot.
 */
export function normalizeConflictSnapshot(payload, requestedDays) {
  if (!payload || typeof payload !== 'object' || !Array.isArray(payload.events))
    throw malformed();
  const source = payload.source === 'acled' ? 'acled' : 'gdelt';
  return {
    generatedAt: finite(payload.generatedAt),
    source,
    verified: source === 'acled',
    days: CONFLICT_DAYS.includes(payload.days) ? payload.days : requestedDays,
    events: payload.events.map(normalizeEvent).filter(Boolean),
    note: text(payload.note),
    method: text(payload.method),
    fetchedAt: finite(payload.fetchedAt),
    coverageHours: finite(payload.coverageHours),
    backfilling: payload.backfilling === true,
  };
}

/**
 * The short reason a failed response gives, or null. The server sends a
 * sentence such as "GDELT HTTP 429 (rate limited)"; it is trimmed and capped.
 */
export function conflictFailureReason(payload) {
  const reason =
    typeof payload?.reason === 'string' ? payload.reason.trim() : '';
  return reason ? reason.slice(0, 160) : null;
}

/**
 * Query string value for a bounding box, or null when the box is unusable.
 * @param {?{west:number,south:number,east:number,north:number}} bbox
 */
export function conflictBboxParam(bbox) {
  if (!bbox) return null;
  const values = [bbox.west, bbox.south, bbox.east, bbox.north].map(finite);
  const [west, south, east, north] = values;
  if (
    values.some((value) => value === null) ||
    Math.abs(west) > 180 ||
    Math.abs(east) > 180 ||
    Math.abs(south) > 90 ||
    Math.abs(north) > 90 ||
    west >= east ||
    south >= north
  )
    return null;
  return values.join(',');
}

/**
 * Lazy same-origin acquisition of armed-conflict events for the window and
 * the viewed box (the box is optional; the server filters by it).
 */
export function createConflictSource({
  fetchImpl = (...args) => globalThis.fetch(...args),
  timeoutMs = 20_000,
} = {}) {
  return {
    async getSnapshot({ days = CONFLICT_DEFAULT_DAYS, bbox, signal } = {}) {
      if (!CONFLICT_DAYS.includes(days))
        throw new RangeError(`Unsupported conflict window: ${days}`);
      const params = new URLSearchParams({ days: String(days) });
      const bboxParam = conflictBboxParam(bbox);
      if (bboxParam) params.set('bbox', bboxParam);
      const controller = new AbortController();
      const abort = () => controller.abort(signal?.reason);
      signal?.addEventListener('abort', abort, { once: true });
      const timer = setTimeout(
        () => controller.abort(new Error('Conflict events request timed out')),
        timeoutMs,
      );
      try {
        signal?.throwIfAborted();
        const response = await fetchImpl(`/api/conflicts?${params}`, {
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
          throw new Error(
            conflictFailureReason(payload) ??
              `Conflict events HTTP ${response.status}`,
          );
        return normalizeConflictSnapshot(payload, days);
      } finally {
        clearTimeout(timer);
        signal?.removeEventListener('abort', abort);
      }
    },
  };
}
