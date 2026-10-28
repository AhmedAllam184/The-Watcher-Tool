/**
 * Focus-return policy: where the camera goes when a follow or fly-to-object
 * focus ends. Pure values in, pure values out; the navigation owner reads the
 * camera and performs the flight.
 *
 * The operator works on a north-up, straight-down map. Selecting an aircraft,
 * ship, satellite or any listed object tilts the camera into a 3D chase or
 * oblique framing; when that focus ends the camera returns, straight down, to
 * where the operator was just before it began.
 */

/** A camera at or below this pitch already reads as the straight-down map. */
export const STRAIGHT_DOWN_SNAPSHOT_PITCH_DEG = -80;
/** Length of the return flight. */
export const FOCUS_RETURN_DURATION_SEC = 1.5;
/**
 * Delay between a focus-ended signal and the return decision. Switching from
 * one object to another clears the old owner a moment before the new one
 * claims the camera; the settle lets that handoff finish first.
 */
export const FOCUS_RETURN_SETTLE_MS = 150;
/** Return heights stay between street scale and a whole-globe view. */
export const FOCUS_RETURN_MIN_HEIGHT_M = 1_500;
export const FOCUS_RETURN_MAX_HEIGHT_M = 25_000_000;
/**
 * "Far away" from the remembered view, measured on the ground. The radius
 * grows with the remembered height so a continent-scale view stays put while
 * a city-scale view gives way once the camera has clearly moved on.
 */
export const FOCUS_RETURN_FAR_MIN_M = 1_500_000;
export const FOCUS_RETURN_FAR_HEIGHT_FACTOR = 4;

const EARTH_RADIUS_M = 6_371_008.8;

/**
 * Navigation nouns that move the camera onto one object. Every other explicit
 * destination (a place search, city pill, Home, route, scene, photo…) is a new
 * place the operator chose, and supersedes the remembered view.
 */
const FOCUS_NOUNS = new Set([
  'vessel',
  'fire',
  'target',
  'satellite',
  'contact',
  'gps',
  'conflict',
  'airport',
  'weather',
  'camera',
  'selection',
]);

/**
 * @param {string} noun Navigation noun passed to the camera authority.
 * @returns {'focus'|'location'} Whether it starts a focus or replaces it.
 */
export function classifyNavigationNoun(noun) {
  return FOCUS_NOUNS.has(String(noun || '')) ? 'focus' : 'location';
}

/** Layer focus announcements whose reason names an object focus. */
export function isFocusAuthorityReason(reason) {
  return /^context-/.test(String(reason || ''));
}

const finite = (value) => typeof value === 'number' && Number.isFinite(value);

function clampHeight(height) {
  return Math.min(
    FOCUS_RETURN_MAX_HEIGHT_M,
    Math.max(FOCUS_RETURN_MIN_HEIGHT_M, height),
  );
}

function validPoint(point) {
  return (
    finite(point?.lon) &&
    finite(point?.lat) &&
    Math.abs(point.lat) <= 90 &&
    Math.abs(point.lon) <= 360
  );
}

/**
 * Great-circle ground distance between two lon/lat points, in metres.
 * @param {{lon: number, lat: number}} a Degrees.
 * @param {{lon: number, lat: number}} b Degrees.
 * @returns {number}
 */
export function groundDistanceM(a, b) {
  const rad = Math.PI / 180;
  const dLat = (b.lat - a.lat) * rad;
  const dLon = (b.lon - a.lon) * rad;
  const h =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(a.lat * rad) * Math.cos(b.lat * rad) * Math.sin(dLon / 2) ** 2;
  return 2 * EARTH_RADIUS_M * Math.asin(Math.min(1, Math.sqrt(h)));
}

/**
 * The straight-down view equivalent to the camera right now.
 *
 * A camera already looking (nearly) straight down is remembered exactly where
 * it is. A tilted camera is remembered as straight down over the ground point
 * in the middle of the screen, at its distance from that point, so the return
 * keeps the operator's zoom rather than their tilt.
 *
 * @param {object} view
 * @param {{lon: number, lat: number, height: number}} view.camera Camera position (degrees, metres).
 * @param {number} view.pitchDeg Camera pitch in degrees.
 * @param {{lon: number, lat: number}|null} [view.ground] Ground point under the screen centre.
 * @param {number} [view.rangeM] Camera distance to that ground point.
 * @returns {{lon: number, lat: number, height: number}|null}
 */
export function snapshotStraightDownView({
  camera,
  pitchDeg,
  ground = null,
  rangeM,
} = {}) {
  if (!validPoint(camera) || !finite(camera.height)) return null;
  const straightDown =
    !finite(pitchDeg) || pitchDeg <= STRAIGHT_DOWN_SNAPSHOT_PITCH_DEG;
  if (straightDown || !validPoint(ground)) {
    return {
      lon: camera.lon,
      lat: camera.lat,
      height: clampHeight(camera.height),
    };
  }
  const height = finite(rangeM) && rangeM > 0 ? rangeM : camera.height;
  return { lon: ground.lon, lat: ground.lat, height: clampHeight(height) };
}

/**
 * Where the return flight lands.
 *
 * Normally that is the remembered view. When the camera's ground point has
 * moved far from it, the operator has moved on, so the return straightens the
 * view where they are now, at the remembered height.
 *
 * @param {{lon: number, lat: number, height: number}|null} snapshot Remembered view.
 * @param {{lon: number, lat: number}|null} [current] Current ground point.
 * @returns {{lon: number, lat: number, height: number, fallback: boolean}|null}
 */
export function resolveFocusReturnView(snapshot, current = null) {
  if (!validPoint(snapshot) || !finite(snapshot.height)) return null;
  const height = clampHeight(snapshot.height);
  if (validPoint(current)) {
    const farM = Math.max(
      FOCUS_RETURN_FAR_MIN_M,
      height * FOCUS_RETURN_FAR_HEIGHT_FACTOR,
    );
    if (groundDistanceM(snapshot, current) > farM) {
      return { lon: current.lon, lat: current.lat, height, fallback: true };
    }
  }
  return { lon: snapshot.lon, lat: snapshot.lat, height, fallback: false };
}

/**
 * Whether a pending return may fly now. Cockpit, a Guided Tour, a newer
 * navigation and a focus that is still held all win over the return.
 * @param {object} state
 * @returns {boolean}
 */
export function shouldReturnFromFocus({
  disposed = false,
  snapshot = null,
  cockpitActive = false,
  tourActive = false,
  focusActive = false,
  generationChanged = false,
  cameraFlying = false,
} = {}) {
  return Boolean(
    !disposed &&
    snapshot &&
    !cockpitActive &&
    !tourActive &&
    !focusActive &&
    !generationChanged &&
    !cameraFlying,
  );
}
