// src/data/holdingDetection.js
/**
 * Holding / circling detection over a flight's trace fixes. A holding pattern
 * shows as a run of same-sense heading changes: the signed heading change
 * between successive segments is summed over a rolling 25-minute window, and
 * an episode is a stretch where that sum stays at least 330 degrees. The signed
 * sum is what separates a hold from an S-turn (left then right nets to zero).
 * Pure: no Cesium, no DOM.
 */
import { greatCircleKm } from './routePlausible.js';

const D2R = Math.PI / 180;
/** Fixes closer than this to the last kept fix add only noise to the bearings. */
const MIN_STEP_M = 300;
const WINDOW_MS = 25 * 60_000;
/** Net heading change that counts as a circuit: a full 360 less 30 degrees, so a
 *  circuit flown across a sampling gap still counts. */
const CIRCUIT_DEG = 330;
const AIRPORT_KM = 80;

function bearingDeg(a, b) {
  const p1 = a.lat * D2R;
  const p2 = b.lat * D2R;
  const dl = (b.lon - a.lon) * D2R;
  const y = Math.sin(dl) * Math.cos(p2);
  const x =
    Math.cos(p1) * Math.sin(p2) - Math.sin(p1) * Math.cos(p2) * Math.cos(dl);
  return (Math.atan2(y, x) / D2R + 360) % 360;
}

/** Signed difference wrapped into [-180, 180). */
function wrap180(deg) {
  return ((((deg + 180) % 360) + 360) % 360) - 180;
}

/** Fixes ordered by time, with anything closer than MIN_STEP_M to the last kept one dropped. */
function keptFixes(points) {
  const sorted = (Array.isArray(points) ? points : [])
    .filter(
      (p) =>
        Number.isFinite(p?.t) &&
        Number.isFinite(p?.lat) &&
        Number.isFinite(p?.lon),
    )
    .sort((a, b) => a.t - b.t);
  const kept = [];
  for (const p of sorted) {
    const last = kept[kept.length - 1];
    if (
      last &&
      greatCircleKm(last.lat, last.lon, p.lat, p.lon) * 1000 < MIN_STEP_M
    )
      continue;
    kept.push(p);
  }
  return kept;
}

/**
 * Signed heading change at every kept fix from the second segment on.
 * `i` is the kept index of the fix where the turn ends.
 */
function headingChanges(fixes) {
  const turns = [];
  let previous = null;
  for (let i = 1; i < fixes.length; i++) {
    const bearing = bearingDeg(fixes[i - 1], fixes[i]);
    if (previous !== null)
      turns.push({ i, t: fixes[i].t, deg: wrap180(bearing - previous) });
    previous = bearing;
  }
  return turns;
}

function episodeCenter(fixes, from, to) {
  let lat = 0;
  let lon = 0;
  for (let k = from; k <= to; k++) {
    lat += fixes[k].lat;
    lon += fixes[k].lon;
  }
  const count = to - from + 1;
  return { lat: lat / count, lon: lon / count };
}

function nearestAirport(center, airports) {
  let best = null;
  for (const airport of airports) {
    if (!Number.isFinite(airport?.lat) || !Number.isFinite(airport?.lon))
      continue;
    const distanceKm = greatCircleKm(
      center.lat,
      center.lon,
      airport.lat,
      airport.lon,
    );
    if (distanceKm <= AIRPORT_KM && (!best || distanceKm < best.distanceKm))
      best = {
        code: airport.code || '',
        name: airport.name || '',
        distanceKm: Math.round(distanceKm * 10) / 10,
      };
  }
  return best;
}

/**
 * @param {Array<{t: number, lat: number, lon: number}>} points Trace fixes, t in ms.
 * @param {object} [options]
 * @param {Array<{code?: string, name?: string, lat: number, lon: number}>} [options.airports]
 *   Route airports; the nearest within 80 km of an episode is named on it.
 * @returns {Array<{startT: number, endT: number, turns: number, centerLat: number,
 *   centerLon: number, nearestAirport?: {code: string, name: string, distanceKm: number}}>}
 */
export function detectHolding(points, { airports = [] } = {}) {
  const fixes = keptFixes(points);
  const turns = headingChanges(fixes);
  const episodes = [];
  let a = 0; // first turn still inside the window
  let net = 0; // signed heading change over turns[a..j]
  let open = null; // { start, last } turn indices of the episode being built

  const close = () => {
    if (!open) return;
    let total = 0;
    for (let j = open.start; j <= open.last; j++) total += turns[j].deg;
    const fromFix = Math.max(0, turns[open.start].i - 1);
    const toFix = turns[open.last].i;
    const center = episodeCenter(fixes, fromFix, toFix);
    const episode = {
      startT: fixes[fromFix].t,
      endT: fixes[toFix].t,
      turns: Math.max(1, Math.floor((Math.abs(total) + 30) / 360)),
      centerLat: center.lat,
      centerLon: center.lon,
    };
    const airport = nearestAirport(center, airports);
    if (airport) episode.nearestAirport = airport;
    episodes.push(episode);
    open = null;
  };

  for (let j = 0; j < turns.length; j++) {
    net += turns[j].deg;
    while (turns[j].t - turns[a].t > WINDOW_MS) {
      net -= turns[a].deg;
      a++;
    }
    if (Math.abs(net) >= CIRCUIT_DEG) {
      if (!open) {
        // Start as late as the window allows while still holding the threshold.
        let start = a;
        let sum = net;
        while (start < j && Math.abs(sum - turns[start].deg) >= CIRCUIT_DEG) {
          sum -= turns[start].deg;
          start++;
        }
        open = { start, last: j };
      } else {
        open.last = j;
      }
    } else {
      close();
    }
  }
  close();
  return episodes;
}
