/**
 * GPS interference ("jamming") inference from ADS-B aircraft quality fields.
 *
 * An airborne aircraft that broadcasts a Navigation Integrity Category (NIC)
 * below 7, or a Navigation Accuracy Category for position (NACp) below 8 when
 * NIC is absent, is reporting degraded GPS. Counting those aircraft per ~1
 * degree cell gives a share that rises when GPS is jammed or spoofed. This is
 * an INFERENCE: avionics faults and older equipment set the same fields, so
 * every surface that shows the result must say so.
 *
 * Counting rules:
 * - Within one 10-minute bucket an aircraft hex is judged once: the first
 *   sighting in that bucket decides its class.
 * - Reporting is per cell over the requested window, by distinct hex. An
 *   aircraft counts once however many buckets it appears in. It is degraded
 *   when most of its judged buckets are degraded; a tie goes to its most
 *   recent judgement. So one loitering aircraft cannot inflate a cell.
 * - Buckets are kept or dropped whole. A bucket leaves the window once its
 *   end is at or before `nowMs - windowMs`.
 * - Aircraft without a usable classification are not counted at all, so they
 *   do not dilute the ratio.
 */

/** Degraded when NIC is strictly below this value. */
export const DEGRADED_NIC_BELOW = 7;
/** Degraded when NACp is strictly below this value and NIC is absent. */
export const DEGRADED_NACP_BELOW = 8;
/** Dedupe bucket length (ms). */
export const GPS_JAM_BUCKET_MS = 10 * 60_000;
/** Cells with fewer sightings in the window are not reported. */
export const GPS_JAM_MIN_AIRCRAFT = 5;
/** A position older than this (seconds since last seen) is not current. */
const MAX_POSITION_AGE_S = 60;

const isCategory = (value) =>
  Number.isInteger(value) && value >= 0 && value <= 11;

/**
 * Whether one aircraft (adsb.lol v2 `ac` entry) reports degraded GPS.
 * @returns {boolean|null} true/false, or null when it cannot be judged
 *   (on the ground, no position, stale position, or no usable NIC/NACp).
 */
export function isDegraded(aircraft) {
  if (!aircraft || typeof aircraft !== 'object') return null;
  if (aircraft.alt_baro === 'ground') return null;
  if (!Number.isFinite(aircraft.lat) || !Number.isFinite(aircraft.lon))
    return null;
  if (
    Number.isFinite(aircraft.seen_pos) &&
    aircraft.seen_pos > MAX_POSITION_AGE_S
  )
    return null;
  if (isCategory(aircraft.nic)) return aircraft.nic < DEGRADED_NIC_BELOW;
  if (isCategory(aircraft.nac_p)) return aircraft.nac_p < DEGRADED_NACP_BELOW;
  return null;
}

/** Share of degraded sightings → level. Boundaries: 2% and 10% inclusive upward. */
export function gpsJamLevel(ratio) {
  if (ratio > 0.1) return 'high';
  if (ratio >= 0.02) return 'medium';
  return 'low';
}

const roundTo = (value, places) => {
  const scale = 10 ** places;
  return Math.round(value * scale) / scale;
};

const cellKey = (i, j) => `${i},${j}`;

/**
 * Rolling per-cell grid of deduplicated GPS-quality sightings.
 * @param {{cellDeg?: number, windowMs?: number}} [options]
 */
export function createGpsJamGrid({
  cellDeg = 1,
  windowMs = 6 * 3_600_000,
} = {}) {
  /**
   * cell key → { i, j, buckets: Map<bucketStart, {good: Set<hex>, bad: Set<hex>}> }
   * @type {Map<string, {i: number, j: number, buckets: Map<number, {good: Set<string>, bad: Set<string>}>}>}
   */
  let cellsByKey = new Map();

  const bucketStartOf = (nowMs) =>
    Math.floor(nowMs / GPS_JAM_BUCKET_MS) * GPS_JAM_BUCKET_MS;
  const expired = (start, cutoff) => start + GPS_JAM_BUCKET_MS <= cutoff;

  /** Drop whole buckets that have left the window, then empty cells. */
  function prune(nowMs) {
    const cutoff = nowMs - windowMs;
    for (const [key, cell] of cellsByKey) {
      for (const start of cell.buckets.keys()) {
        if (expired(start, cutoff)) cell.buckets.delete(start);
      }
      if (cell.buckets.size === 0) cellsByKey.delete(key);
    }
  }

  /** Count each hex at most once per cell per bucket; rows without a judgement are skipped. */
  function addSamples(rows, nowMs) {
    if (!Array.isArray(rows)) return;
    const start = bucketStartOf(nowMs);
    for (const aircraft of rows) {
      const degraded = isDegraded(aircraft);
      const hex =
        typeof aircraft?.hex === 'string' ? aircraft.hex.toLowerCase() : '';
      if (degraded === null || !hex) continue;
      const i = Math.floor(aircraft.lat / cellDeg);
      const j = Math.floor(aircraft.lon / cellDeg);
      const key = cellKey(i, j);
      let cell = cellsByKey.get(key);
      if (!cell) {
        cell = { i, j, buckets: new Map() };
        cellsByKey.set(key, cell);
      }
      let sightings = cell.buckets.get(start);
      if (!sightings) {
        sightings = { good: new Set(), bad: new Set() };
        cell.buckets.set(start, sightings);
      }
      if (sightings.good.has(hex) || sightings.bad.has(hex)) continue;
      (degraded ? sightings.bad : sightings.good).add(hex);
    }
    prune(nowMs);
  }

  /**
   * Distinct aircraft and distinct degraded aircraft across the buckets that
   * are still in the window. Legacy count-only buckets never reach this point
   * (fromJSON drops them), so every entry here carries its hexes.
   */
  function tallyCell(buckets, cutoff) {
    const tallies = new Map(); // hex → {bad, good, latestAt, latestBad}
    for (const [start, sightings] of buckets) {
      if (expired(start, cutoff)) continue;
      const judged = [
        ...[...sightings.bad].map((hex) => [hex, true]),
        ...[...sightings.good]
          .filter((hex) => !sightings.bad.has(hex))
          .map((hex) => [hex, false]),
      ];
      for (const [hex, isBad] of judged) {
        let tally = tallies.get(hex);
        if (!tally) {
          tally = { bad: 0, good: 0, latestAt: -Infinity, latestBad: false };
          tallies.set(hex, tally);
        }
        if (isBad) tally.bad += 1;
        else tally.good += 1;
        if (start >= tally.latestAt) {
          tally.latestAt = start;
          tally.latestBad = isBad;
        }
      }
    }
    let degraded = 0;
    for (const tally of tallies.values()) {
      const isDegradedAircraft =
        tally.bad === tally.good ? tally.latestBad : tally.bad > tally.good;
      if (isDegradedAircraft) degraded += 1;
    }
    return { aircraft: tallies.size, degraded };
  }

  /**
   * Cells that meet the sighting floor, with ratio and level.
   * `windowMs` may narrow the grid's window (never widen it).
   */
  function cells({
    nowMs,
    minAircraft = GPS_JAM_MIN_AIRCRAFT,
    windowMs: queryWindowMs = windowMs,
  }) {
    const cutoff = nowMs - Math.min(queryWindowMs, windowMs);
    const out = [];
    for (const { i, j, buckets } of cellsByKey.values()) {
      const { aircraft, degraded } = tallyCell(buckets, cutoff);
      if (aircraft === 0 || aircraft < minAircraft) continue;
      const ratio = degraded / aircraft;
      out.push({
        lat: roundTo(i * cellDeg, 6),
        lon: roundTo(j * cellDeg, 6),
        cellDeg,
        aircraft,
        degraded,
        ratio: roundTo(ratio, 4),
        level: gpsJamLevel(ratio),
      });
    }
    return out.sort((a, b) => a.lat - b.lat || a.lon - b.lon);
  }

  /** Plain-object snapshot; JSON.stringify(grid) uses it. */
  function toJSON() {
    return {
      cellDeg,
      windowMs,
      cells: [...cellsByKey.values()].map(({ i, j, buckets }) => ({
        i,
        j,
        buckets: [...buckets].map(([at, sightings]) => ({
          at,
          good: [...sightings.good],
          bad: [...sightings.bad],
        })),
      })),
    };
  }

  /**
   * Replace contents from a toJSON() snapshot. Malformed entries are skipped,
   * and a snapshot made with a different cellDeg is ignored entirely.
   */
  function fromJSON(json) {
    cellsByKey = new Map();
    if (!json || json.cellDeg !== cellDeg || !Array.isArray(json.cells))
      return api;
    const strings = (list) =>
      new Set(list.filter((hex) => typeof hex === 'string'));
    for (const cell of json.cells) {
      if (
        !Number.isInteger(cell?.i) ||
        !Number.isInteger(cell?.j) ||
        !Array.isArray(cell.buckets)
      )
        continue;
      const buckets = new Map();
      for (const bucket of cell.buckets) {
        if (
          !Number.isFinite(bucket?.at) ||
          !Array.isArray(bucket.good) ||
          !Array.isArray(bucket.bad)
        )
          continue;
        buckets.set(bucket.at, {
          good: strings(bucket.good),
          bad: strings(bucket.bad),
        });
      }
      if (buckets.size > 0)
        cellsByKey.set(cellKey(cell.i, cell.j), {
          i: cell.i,
          j: cell.j,
          buckets,
        });
    }
    return api;
  }

  const api = {
    cellDeg,
    windowMs,
    addSamples,
    prune,
    cells,
    toJSON,
    fromJSON,
  };
  return api;
}
