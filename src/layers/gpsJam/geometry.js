/**
 * Pure GPS-interference presentation: which cells draw, the rectangle each
 * one covers and the words shown for it. No Cesium here.
 */

import { GPS_JAM_STYLE } from '../../data/gpsJamLabels.js';

export { GPS_JAM_STYLE };

export const GPS_JAM_TOP_LIMIT = 10;
const REGION_MAX_KM = 1500;
const EARTH_RADIUS_KM = 6371;

export const isDrawnLevel = (level) => Object.hasOwn(GPS_JAM_STYLE, level);

/** Cells that are drawn: medium and high only. */
export function drawnCells(cells = []) {
  return cells.filter((cell) => isDrawnLevel(cell.level));
}

/** Stable id for a cell; the same string keys the map entity and the context record. */
export function cellId(cell) {
  return `gps-jam:${cell.cellDeg}:${cell.lat}:${cell.lon}`;
}

/** Degrees bounding box of a cell, in Cesium Rectangle.fromDegrees order. */
export function cellRectangle(cell) {
  return {
    west: cell.lon,
    south: cell.lat,
    east: cell.lon + cell.cellDeg,
    north: cell.lat + cell.cellDeg,
  };
}

/** Centre of a cell in degrees. */
export function cellCentre(cell) {
  return {
    latitude: cell.lat + cell.cellDeg / 2,
    longitude: cell.lon + cell.cellDeg / 2,
  };
}

/** Five-point closed outline ring, in lon/lat degrees, for the outline polyline. */
export function cellOutlineDegrees(cell) {
  const { west, south, east, north } = cellRectangle(cell);
  return [west, south, east, south, east, north, west, north, west, south];
}

export const percentText = (ratio) => `${Math.round(ratio * 100)}%`;

/** "14% of 52 aircraft" */
export function degradedShareText(cell) {
  return `${percentText(cell.ratio)} of ${cell.aircraft} aircraft`;
}

/** Context record label, e.g. "GPS interference high". */
export const cellLabel = (cell) => `GPS interference ${cell.level}`;

/** Strongest drawn cells first; ties keep server (south-west first) order. */
export function topCells(cells = [], limit = GPS_JAM_TOP_LIMIT) {
  return drawnCells(cells)
    .map((cell, index) => ({ cell, index }))
    .sort((a, b) => b.cell.ratio - a.cell.ratio || a.index - b.index)
    .slice(0, limit)
    .map(({ cell }) => cell);
}

/** Great-circle distance in km between two lat/lon points. */
export function distanceKm(aLat, aLon, bLat, bLon) {
  const rad = Math.PI / 180;
  const dLat = (bLat - aLat) * rad;
  const dLon = (bLon - aLon) * rad;
  const h =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(aLat * rad) * Math.cos(bLat * rad) * Math.sin(dLon / 2) ** 2;
  return 2 * EARTH_RADIUS_KM * Math.asin(Math.min(1, Math.sqrt(h)));
}

/**
 * Name of the sampled region nearest a cell, or a coordinate pair when none is
 * within REGION_MAX_KM.
 */
export function nearestPlaceName(cell, regions = []) {
  const { latitude, longitude } = cellCentre(cell);
  let best = null;
  for (const region of regions) {
    const km = distanceKm(latitude, longitude, region.lat, region.lon);
    if (km <= REGION_MAX_KM && (!best || km < best.km)) best = { region, km };
  }
  if (best) return best.region.name;
  return `${latitude.toFixed(1)}°, ${longitude.toFixed(1)}°`;
}

/** Counts behind the legend and the info line. */
export function summarizeCells(cells = []) {
  let medium = 0;
  let high = 0;
  let low = 0;
  let aircraft = 0;
  for (const cell of cells) {
    aircraft += cell.aircraft;
    if (cell.level === 'high') high += 1;
    else if (cell.level === 'medium') medium += 1;
    else low += 1;
  }
  return { medium, high, low, affected: medium + high, aircraft };
}

/** Properties shown on a selected cell in the details panel. */
export function cellProperties(cell, { windowHours, method, note }) {
  return {
    degradedShare: degradedShareText(cell),
    level: cell.level,
    window: `${windowHours} h`,
    cell: `${cell.cellDeg}° × ${cell.cellDeg}°`,
    method,
    note,
  };
}
