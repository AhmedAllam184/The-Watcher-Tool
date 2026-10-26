/**
 * Pure presentation for the airport disruption overlay: which airports are
 * affected, row items, context properties and the viewed airports to ask
 * about. No Cesium and no DOM, so the rules are testable on their own.
 */

import { AIRPORT_STATUS_STYLE } from '../../data/airportStatusLabels.js';

export { AIRPORT_STATUS_STYLE };

/** Ring diameter in pixels. */
export const AIRPORT_RING_PIXELS = 22;
/** Most affected airports listed in the row. */
export const AIRPORT_ROW_LIMIT = 25;
const CANDIDATE_LIMIT = 8;

const isAffected = (airport) =>
  airport?.level === 'disrupted' || airport?.level === 'watch';

/** Disrupted before watch; then more holding, a higher GPS share, then name. */
function compareAffected(a, b) {
  if (a.level !== b.level) return a.level === 'disrupted' ? -1 : 1;
  if (b.holding !== a.holding) return b.holding - a.holding;
  if ((b.degradedShare ?? 0) !== (a.degradedShare ?? 0))
    return (b.degradedShare ?? 0) - (a.degradedShare ?? 0);
  return String(a.name).localeCompare(String(b.name));
}

/** Disrupted and watch airports, strongest first. */
export function affectedAirports(airports = []) {
  return airports.filter(isAffected).sort(compareAffected);
}

/** Counts per level, for the legend. */
export function statusCounts(airports = []) {
  const counts = { disrupted: 0, watch: 0, normal: 0, unknown: 0 };
  for (const airport of airports) {
    if (Object.hasOwn(counts, airport?.level)) counts[airport.level] += 1;
  }
  return counts;
}

/** "Name (IATA)", or "Name (ICAO)" when there is no IATA code. */
export function airportLabel(airport) {
  const code = airport.iata || airport.icao;
  return code ? `${airport.name} (${code})` : airport.name;
}

/** Row items for the affected airports; each one flies the camera to its airport. */
export function airportRowList(airports = []) {
  return affectedAirports(airports)
    .slice(0, AIRPORT_ROW_LIMIT)
    .map((airport) => ({
      id: `airport-status:${airport.icao}`,
      lead: airport.level === 'disrupted' ? 'DISRUPTED' : 'WATCH',
      text: [airportLabel(airport), airport.reasons.join(', ')]
        .filter(Boolean)
        .join(' · '),
      params: { focusAirport: airport.icao },
    }));
}

/** Shown in place of a holding count the server could not assess. */
export const HOLDING_NOT_ASSESSED =
  'Not assessed — view the airport to sample it every minute';

/**
 * Flat, string-valued properties for the details panel. Every airport with a
 * status gets them; the details panel shows them as plain rows.
 */
export function airportContextProperties(airport) {
  const assessed = airport.holdingReliable !== false;
  const share =
    airport.degradedShare === null || airport.degradedShare === undefined
      ? 'no data'
      : `${Math.round(airport.degradedShare * 100)}% of ${airport.judged} judged`;
  return {
    status:
      airport.level === 'unknown' ? 'unknown' : `${airport.level} (inferred)`,
    holding: assessed ? airport.holding : HOLDING_NOT_ASSESSED,
    holdingCallsigns: assessed
      ? airport.holdingCallsigns.join(', ') || 'none'
      : HOLDING_NOT_ASSESSED,
    degradedGpsShare: share,
    reasons: airport.reasons.join('; ') || 'none',
  };
}

const wrapLon = (lon) => ((((lon + 180) % 360) + 360) % 360) - 180;

/**
 * The large airports to ask the server about: nearest the centre of the view,
 * up to 8, inside the view rectangle when one is known. The server also
 * returns its own watchlist, so this only adds viewed airports.
 * @param {Array<{icao: string, lat: number, lon: number}>} airports
 * @param {{rect?: {west: number, south: number, east: number, north: number}|null,
 *   centre?: {lat: number, lon: number}|null, limit?: number}} [view]
 *   rect in degrees; west > east spans the antimeridian.
 * @returns {string[]} ICAO codes, nearest first.
 */
export function candidateAirportCodes(
  airports,
  { rect = null, centre = null, limit = CANDIDATE_LIMIT } = {},
) {
  let origin = centre;
  let inside = () => true;
  if (rect) {
    const { west, south, east, north } = rect;
    const wraps = west > east;
    inside = (airport) =>
      airport.lat >= south &&
      airport.lat <= north &&
      (wraps
        ? airport.lon >= west || airport.lon <= east
        : airport.lon >= west && airport.lon <= east);
    origin = {
      lat: (south + north) / 2,
      lon: wrapLon(wraps ? (west + east + 360) / 2 : (west + east) / 2),
    };
  }
  if (!origin) return [];
  const distance = (airport) => {
    const dLat = airport.lat - origin.lat;
    const dLon =
      wrapLon(airport.lon - origin.lon) *
      Math.cos((origin.lat * Math.PI) / 180);
    return dLat * dLat + dLon * dLon;
  };
  return airports
    .filter(
      (airport) =>
        airport &&
        typeof airport.icao === 'string' &&
        Number.isFinite(airport.lat) &&
        Number.isFinite(airport.lon) &&
        inside(airport),
    )
    .sort((a, b) => distance(a) - distance(b))
    .slice(0, limit)
    .map((airport) => airport.icao);
}
