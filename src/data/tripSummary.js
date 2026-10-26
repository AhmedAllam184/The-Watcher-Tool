// src/data/tripSummary.js
/**
 * Plain-text trip facts for the details panel: when the current flight got
 * airborne and any holding episodes. Pure; the trip line controller calls it.
 */
import { detectHolding } from './holdingDetection.js';

/** "14:05" — UTC clock time of an epoch-ms instant. */
export function formatUtcClock(ms) {
  if (!Number.isFinite(ms)) return '';
  return new Date(ms).toISOString().slice(11, 16);
}

/** "1 h 32 m" or "45 m". */
export function formatElapsed(ms) {
  const minutes = Math.max(0, Math.floor(ms / 60_000));
  const hours = Math.floor(minutes / 60);
  const rest = minutes % 60;
  return hours ? `${hours} h ${rest} m` : `${rest} m`;
}

/** "12:41 UTC (1 h 32 m)", or '' without a start time. */
export function formatAirborneSince(startedAtMs, nowMs) {
  if (!Number.isFinite(startedAtMs) || !Number.isFinite(nowMs)) return '';
  return `${formatUtcClock(startedAtMs)} UTC (${formatElapsed(nowMs - startedAtMs)})`;
}

/** "Circled 2× near Cairo (CAI), 14:05–14:22 UTC; …" or the no-hold line. */
export function formatHoldingSummary(episodes) {
  if (!episodes.length) return 'None detected on this flight';
  return episodes
    .map((episode) => {
      const place = episode.nearestAirport
        ? ` near ${episode.nearestAirport.name || episode.nearestAirport.code} (${episode.nearestAirport.code})`
        : '';
      return `Circled ${episode.turns}×${place}, ${formatUtcClock(episode.startT)}–${formatUtcClock(episode.endT)} UTC`;
    })
    .join('; ');
}

/**
 * @param {object} input
 * @param {Array<{t: number, lat: number, lon: number}>} input.points Current-flight fixes.
 * @param {number|null} input.startedAt Epoch ms of the first fix.
 * @param {Array<object>} [input.airports] Route airports with lat/lon.
 * @param {number} input.nowMs Clock for the elapsed time.
 * @returns {{airborneSince: string, holding: string}} '' where nothing is known.
 */
export function tripSummary({ points, startedAt, airports = [], nowMs }) {
  const airborneSince = formatAirborneSince(startedAt, nowMs);
  if (!Array.isArray(points) || points.length < 2)
    return { airborneSince, holding: '' };
  return {
    airborneSince,
    holding: formatHoldingSummary(detectHolding(points, { airports })),
  };
}
