/**
 * Pure Conflict Events presentation: severity, clusters, the words and
 * properties shown for an event. No Cesium here.
 */

import { CONFLICT_STYLE, conflictStyleKey } from '../../data/conflictLabels.js';

export { CONFLICT_STYLE };

export const CONFLICT_TOP_LIMIT = 10;
/** Cluster cells are whole degrees. */
export const CONFLICT_CELL_DEG = 1;
/** Above this camera height (m) events aggregate into cells with count labels. */
export const CONFLICT_CLUSTER_ALTITUDE_M = 2_000_000;
/** Most cluster count labels published at once. */
export const CONFLICT_CLUSTER_LABEL_LIMIT = 200;

/** Fatalities for ACLED events, article count for GDELT news locations. */
export const eventSeverity = (event) => event.fatalities ?? event.articles ?? 0;

/** Stable id for an event; the same string keys the point and the context record. */
export const eventId = (event) => event.id;

/** Style record for an event's class. */
export function eventStyle(event) {
  return CONFLICT_STYLE[conflictStyleKey(event.type)];
}

/** Point diameter in pixels, growing with severity. */
export function eventPixelSize(event) {
  return Math.min(16, Math.max(5, 5 + Math.sqrt(eventSeverity(event)) * 2));
}

/** Cluster diameter in pixels, growing with the event count. */
export function clusterPixelSize(count) {
  return Math.min(28, Math.max(10, 10 + Math.sqrt(count) * 2));
}

/** Context record label, e.g. "Airstrike · Khan Younis". */
export function eventLabel(event) {
  const kind = event.subType || event.type;
  return event.location ? `${kind} · ${event.location}` : kind;
}

/** Severity words for the row list and the details panel. */
export function severityText(event) {
  if (event.fatalities !== null && event.fatalities !== undefined)
    return `${event.fatalities} ${event.fatalities === 1 ? 'fatality' : 'fatalities'}`;
  const articles = event.articles ?? 1;
  return `${articles} ${articles === 1 ? 'article' : 'articles'}`;
}

/** Strongest events first; ties keep server order. */
export function topEvents(events = [], limit = CONFLICT_TOP_LIMIT) {
  return events
    .map((event, index) => ({ event, index }))
    .sort(
      (a, b) =>
        eventSeverity(b.event) - eventSeverity(a.event) || a.index - b.index,
    )
    .slice(0, limit)
    .map(({ event }) => event);
}

/**
 * Aggregate events into whole-degree cells. Each cluster takes the colour of
 * its most severe event and is anchored at its cell centre.
 */
export function clusterEvents(events = [], cellDeg = CONFLICT_CELL_DEG) {
  const cells = new Map();
  for (const event of events) {
    const row = Math.floor(event.lat / cellDeg);
    const column = Math.floor(event.lon / cellDeg);
    const key = `${row}:${column}`;
    let cell = cells.get(key);
    if (!cell) {
      cell = {
        id: `cluster:${cellDeg}:${key}`,
        lat: row * cellDeg + cellDeg / 2,
        lon: column * cellDeg + cellDeg / 2,
        count: 0,
        severity: 0,
        styleKey: conflictStyleKey(event.type),
      };
      cells.set(key, cell);
    }
    cell.count += 1;
    const severity = eventSeverity(event);
    if (severity > cell.severity) {
      cell.severity = severity;
      cell.styleKey = conflictStyleKey(event.type);
    }
  }
  return [...cells.values()].sort(
    (a, b) => b.count - a.count || a.id.localeCompare(b.id),
  );
}

/** Counts by style key, plus the total. */
export function summarizeEvents(events = []) {
  const byKey = Object.fromEntries(
    Object.keys(CONFLICT_STYLE).map((key) => [key, 0]),
  );
  for (const event of events) byKey[conflictStyleKey(event.type)] += 1;
  return { total: events.length, byKey };
}

/** Properties shown on a selected event in the details panel. */
export function eventProperties(event, { source, verified, method, note }) {
  return {
    date: event.date || 'Not dated',
    type: event.subType ? `${event.type} · ${event.subType}` : event.type,
    fatalities:
      event.fatalities === null || event.fatalities === undefined
        ? 'Not reported'
        : String(event.fatalities),
    ...(event.articles !== undefined && event.articles !== null
      ? { articles: String(event.articles) }
      : {}),
    actors: event.actors.length ? event.actors.join(' vs ') : 'Not reported',
    location: event.location || 'Not reported',
    country: event.country || 'Not reported',
    source,
    verified: verified ? 'Yes (ACLED)' : 'No — news report (GDELT)',
    ...(event.url ? { link: event.url } : {}),
    method,
    note,
  };
}
