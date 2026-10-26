// src/data/tripLineGeometry.js
/**
 * Pure geometry for the trip line: altitude bands and the runs of fixes that
 * share one band. The Cesium controller turns these runs into polylines.
 */
export const TRIP_BAND_COLORS = Object.freeze({
  low: '#34d399', // ground to 10 000 ft
  mid: '#fbbf24', // 10 000 to 25 000 ft
  high: '#60a5fa', // above 25 000 ft
});

const FT_TO_M = 0.3048;
/** Unknown altitude keeps the trail's 10 km airborne default, not a dive to the ground. */
const DEFAULT_ALT_M = 10_000;

/** Altitude band for a barometric altitude in feet, or null when unknown. */
export function tripBand(altFt) {
  if (!Number.isFinite(altFt)) return null;
  if (altFt < 10_000) return 'low';
  if (altFt <= 25_000) return 'mid';
  return 'high';
}

/**
 * Split trace fixes into runs of one band. Each run starts with the fix that
 * ended the previous run, so the drawn line has no gap at a band change.
 * @param {Array<{lat: number, lon: number, altFt: number|null}>} points
 * @returns {Array<{band: string, coords: Array<{lat: number, lon: number, altM: number}>}>}
 */
export function tripSegments(points) {
  const segments = [];
  let current = null;
  let lastAltM = null;
  let lastBand = 'low';
  for (const p of Array.isArray(points) ? points : []) {
    if (!Number.isFinite(p?.lat) || !Number.isFinite(p?.lon)) continue;
    const altM = Number.isFinite(p.altFt)
      ? p.altFt * FT_TO_M
      : (lastAltM ?? DEFAULT_ALT_M);
    const band = tripBand(p.altFt) ?? lastBand;
    lastAltM = altM;
    lastBand = band;
    const coord = { lat: p.lat, lon: p.lon, altM };
    if (!current) {
      current = { band, coords: [coord] };
      segments.push(current);
    } else if (band === current.band) {
      current.coords.push(coord);
    } else {
      current.coords.push(coord); // shared boundary fix
      current = { band, coords: [coord] };
      segments.push(current);
    }
  }
  return segments;
}
