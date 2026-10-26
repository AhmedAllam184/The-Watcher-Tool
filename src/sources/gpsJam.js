/** GPS-interference (jamming inference) snapshot: validated, normalized, portable. */

export const GPS_JAM_WINDOW_HOURS = Object.freeze([1, 6, 24]);
export const GPS_JAM_DEFAULT_WINDOW_HOURS = 6;
export const GPS_JAM_LEVELS = Object.freeze(['low', 'medium', 'high']);
export const GPS_JAM_SOURCE_LABEL = 'adsb.lol (inferred)';

const malformed = () => new Error('Malformed GPS interference snapshot');
const finite = (value) => (Number.isFinite(value) ? value : null);
const clamp01 = (value) => Math.min(1, Math.max(0, value));
const text = (value) => (typeof value === 'string' ? value : '');

/** One server cell → plain record, or null when its position or counts are unusable. */
function normalizeCell(raw, cellDeg) {
  const lat = finite(raw?.lat);
  const lon = finite(raw?.lon);
  const aircraft = finite(raw?.aircraft);
  if (lat === null || lon === null || aircraft === null || aircraft < 0)
    return null;
  const degraded = finite(raw?.degraded);
  const derived = aircraft > 0 && degraded !== null ? degraded / aircraft : 0;
  const ratio = finite(raw?.ratio) ?? derived;
  return {
    lat,
    lon,
    cellDeg: finite(raw?.cellDeg) ?? cellDeg,
    aircraft,
    degraded: degraded ?? 0,
    ratio: clamp01(ratio),
    level: GPS_JAM_LEVELS.includes(raw?.level) ? raw.level : 'low',
  };
}

function normalizeRegion(raw) {
  const lat = finite(raw?.lat);
  const lon = finite(raw?.lon);
  if (lat === null || lon === null || typeof raw?.name !== 'string')
    return null;
  return {
    name: raw.name,
    lat,
    lon,
    lastPolledAt: finite(raw.lastPolledAt),
    ok: raw.ok === true,
  };
}

/**
 * Validate one /api/gps-jam payload. Malformed top-level shape is rejected;
 * individual cells or regions with unusable numbers are dropped, and an
 * unknown level is read as 'low' so it can never draw.
 * @param {unknown} payload - Parsed JSON body.
 * @param {number} requestedWindowHours - Window the caller asked for.
 * @returns {object} Normalized snapshot.
 */
export function normalizeGpsJamSnapshot(payload, requestedWindowHours) {
  if (!payload || typeof payload !== 'object' || !Array.isArray(payload.cells))
    throw malformed();
  const cellDeg = finite(payload.cellDeg) > 0 ? payload.cellDeg : 1;
  const windowHours = GPS_JAM_WINDOW_HOURS.includes(payload.windowHours)
    ? payload.windowHours
    : requestedWindowHours;
  return {
    generatedAt: finite(payload.generatedAt),
    windowHours,
    cellDeg,
    active: payload.active === true,
    regions: Array.isArray(payload.regions)
      ? payload.regions.map(normalizeRegion).filter(Boolean)
      : [],
    cells: payload.cells
      .map((cell) => normalizeCell(cell, cellDeg))
      .filter(Boolean),
    method: text(payload.method),
    note: text(payload.note),
    source: text(payload.source) || GPS_JAM_SOURCE_LABEL,
  };
}

/**
 * Lazy same-origin acquisition of the inferred GPS-interference grid.
 * `area` adds a viewport sampling region on the server (rounded there).
 */
export function createGpsJamSource({
  fetchImpl = (...args) => globalThis.fetch(...args),
  timeoutMs = 15_000,
} = {}) {
  return {
    async getSnapshot({
      windowHours = GPS_JAM_DEFAULT_WINDOW_HOURS,
      area,
      signal,
    } = {}) {
      if (!GPS_JAM_WINDOW_HOURS.includes(windowHours))
        throw new RangeError(
          `Unsupported GPS interference window: ${windowHours}`,
        );
      const params = new URLSearchParams({ window: String(windowHours) });
      if (area) {
        const lat = finite(area.lat);
        const lon = finite(area.lon);
        if (
          lat === null ||
          lon === null ||
          Math.abs(lat) > 90 ||
          Math.abs(lon) > 180
        )
          throw new RangeError('GPS interference area must be a valid lat/lon');
        params.set('lat', String(lat));
        params.set('lon', String(lon));
      }
      const controller = new AbortController();
      const abort = () => controller.abort(signal?.reason);
      signal?.addEventListener('abort', abort, { once: true });
      const timer = setTimeout(
        () => controller.abort(new Error('GPS interference request timed out')),
        timeoutMs,
      );
      try {
        signal?.throwIfAborted();
        const response = await fetchImpl(`/api/gps-jam?${params}`, {
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
          throw new Error(`GPS interference HTTP ${response.status}`);
        return normalizeGpsJamSnapshot(payload, windowHours);
      } finally {
        clearTimeout(timer);
        signal?.removeEventListener('abort', abort);
      }
    },
  };
}
