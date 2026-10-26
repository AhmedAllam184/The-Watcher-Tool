// src/layers/flights/tripLine.js
/**
 * Trip line for the tracked aircraft: the current flight's trace drawn along
 * its altitude (coloured by band), a dashed line from the aircraft to the
 * destination airport when the route is plausible, and small markers at the
 * origin and destination. The trace arrives through the layer's source
 * (`fetchTrace`); this controller draws and owns the entities it creates, and
 * removes them on stop. Military uses the same controller.
 */
import * as Cesium from 'cesium';
import { tripSegments, TRIP_BAND_COLORS } from '../../data/tripLineGeometry.js';
import { tripSummary } from '../../data/tripSummary.js';
import { registerPickOwner } from '../../data/pickRegistry.js';

// Entities are claimed so a click on the trip line reads as a no-op, not as
// empty space that would deselect the plane being followed.
registerPickOwner('trip-line', (pickedId) =>
  String(pickedId).startsWith('gev-trip:'),
);

const REFRESH_MS = 60_000;
const LINE_WIDTH = 3;
const DASH_COLOR = '#39d0ff';
const AIRPORT_COLOR = '#e2e8f0';
const AIRPORT_OUTLINE = '#0f172a';
let entitySeq = 0;

/**
 * @param {object} host
 * @param {() => object|null} host.getViewer Current Cesium viewer.
 * @param {(hex: string, options: {signal: AbortSignal}) => Promise<{points: object[], startedAt: number|null}>} host.fetchTrace
 * @param {(hex: string) => {position: object|null, route: object|null}} host.getSubject
 *   Live position (Cartesian3) and the plausible route for a tracked hex.
 * @param {(hex: string) => void} [host.onChange] Called when the drawn line or its facts change.
 * @param {() => number} [host.now]
 * @param {number} [host.refreshMs]
 */
export function createTripLine({
  getViewer,
  fetchTrace,
  getSubject,
  onChange = null,
  now = () => Date.now(),
  refreshMs = REFRESH_MS,
}) {
  let hex = null;
  let token = 0;
  let controller = null;
  let timer = null;
  let points = [];
  let startedAt = null;
  let entities = [];

  function liveViewer() {
    const viewer = getViewer?.();
    return viewer && !viewer.isDestroyed?.() ? viewer : null;
  }

  function clearEntities() {
    const viewer = liveViewer();
    for (const entity of entities) {
      try {
        viewer?.entities.remove(entity);
      } catch {
        /* already gone with its viewer */
      }
    }
    entities = [];
  }

  function addEntity(viewer, options) {
    const entity = viewer.entities.add({
      id: `gev-trip:${++entitySeq}`,
      ...options,
    });
    entities.push(entity);
    return entity;
  }

  function airportPosition(airport) {
    if (!Number.isFinite(airport?.lat) || !Number.isFinite(airport?.lon))
      return null;
    return Cesium.Cartesian3.fromDegrees(airport.lon, airport.lat, 0);
  }

  /** Rebuild every entity of the current trip from the stored fixes and route. */
  function draw() {
    clearEntities();
    const viewer = liveViewer();
    if (!viewer || !hex) return;
    for (const segment of tripSegments(points)) {
      if (segment.coords.length < 2) continue;
      addEntity(viewer, {
        polyline: {
          positions: segment.coords.map((c) =>
            Cesium.Cartesian3.fromDegrees(c.lon, c.lat, c.altM),
          ),
          width: LINE_WIDTH,
          arcType: Cesium.ArcType.NONE,
          material: Cesium.Color.fromCssColorString(
            TRIP_BAND_COLORS[segment.band],
          ),
        },
      });
    }
    const route = getSubject?.(hex)?.route ?? null;
    const origin = airportPosition(route?.origin);
    const destination = airportPosition(route?.destination);
    for (const position of [origin, destination]) {
      if (!position) continue;
      addEntity(viewer, {
        position,
        point: {
          pixelSize: 7,
          color: Cesium.Color.fromCssColorString(AIRPORT_COLOR),
          outlineColor: Cesium.Color.fromCssColorString(AIRPORT_OUTLINE),
          outlineWidth: 1.5,
        },
      });
    }
    if (destination) {
      // Live: the dashed leg starts from wherever the aircraft is now.
      const current = () => getSubject?.(hex)?.position ?? null;
      addEntity(viewer, {
        polyline: {
          positions: new Cesium.CallbackProperty(() => {
            const at = current();
            return at ? [at, destination] : [destination, destination];
          }, false),
          width: 2,
          arcType: Cesium.ArcType.NONE,
          material: new Cesium.PolylineDashMaterialProperty({
            color: Cesium.Color.fromCssColorString(DASH_COLOR).withAlpha(0.9),
            gapColor: Cesium.Color.TRANSPARENT,
            dashLength: 14,
          }),
        },
      });
    }
  }

  async function load() {
    const subject = hex;
    if (!subject || !fetchTrace) return;
    const mine = ++token;
    controller?.abort();
    const attempt = new AbortController();
    controller = attempt;
    let payload;
    try {
      payload = await fetchTrace(subject, { signal: attempt.signal });
    } catch {
      return; // keep the last trace; without one the poll trail stays visible
    }
    if (mine !== token || hex !== subject) return;
    controller = null;
    points = Array.isArray(payload?.points) ? payload.points : [];
    startedAt = Number.isFinite(payload?.startedAt)
      ? payload.startedAt
      : (points[0]?.t ?? null);
    draw();
    onChange?.(subject);
  }

  /** Begin the trip line for a tracked hex; it refreshes every minute until stop(). */
  function start(icao24) {
    stop();
    hex = icao24;
    timer = setInterval(() => {
      load();
    }, refreshMs);
    load();
  }

  /** Remove the trip line and cancel its refresh. Silent: no onChange. */
  function stop() {
    hex = null;
    token += 1;
    controller?.abort();
    controller = null;
    if (timer !== null) clearInterval(timer);
    timer = null;
    points = [];
    startedAt = null;
    clearEntities();
  }

  /** Redraw the route markers and dashed leg after the route changed. */
  function overlayChanged(icao24) {
    if (icao24 !== hex) return;
    draw();
    onChange?.(hex);
  }

  /** True while a drawn trace hides the poll trail. */
  function isShown() {
    return hex !== null && points.length > 1;
  }

  /** Airborne-since and holding text for the tracked hex, or blank strings. */
  function summary(icao24) {
    if (icao24 !== hex || !points.length) {
      return { airborneSince: '', holding: '' };
    }
    const route = getSubject?.(hex)?.route ?? null;
    const airports = [route?.origin, route?.destination]
      .filter(Boolean)
      .map((a) => ({ code: a.code, name: a.name, lat: a.lat, lon: a.lon }));
    return tripSummary({ points, startedAt, airports, nowMs: now() });
  }

  return {
    start,
    stop,
    overlayChanged,
    isShown,
    summary,
    destroy: stop,
  };
}
