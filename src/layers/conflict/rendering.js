import { resolvePickId } from '../../data/pickRegistry.js';
import {
  CONFLICT_STYLE,
  clusterPixelSize,
  eventId,
  eventPixelSize,
  eventStyle,
} from './geometry.js';

const OUTLINE_COLOR = 'rgba(8,10,14,0.85)';
const OUTLINE_WIDTH_PX = 1;
const CLUSTER_ALPHA = 0.85;

/**
 * Conflict points in one PointPrimitiveCollection, drawn above terrain and
 * buildings at every zoom. Individual events are sized by severity; when the
 * camera is high, clusters (whole-degree cells) replace them. Labels for
 * clusters are the caller's business: this module draws points only.
 */
export function createConflictRendering({ viewer, cesium }) {
  const points = new cesium.PointPrimitiveCollection();
  points.show = false;
  viewer.scene.primitives.add(points);
  /** @type {Map<string, object>} pick id → event or cluster record */
  const recordsById = new Map();
  let mode = 'events';
  let destroyed = false;

  const requestRender = () => {
    if (!viewer.isDestroyed?.()) viewer.scene.requestRender();
  };

  const position = (lat, lon) => cesium.Cartesian3.fromDegrees(lon, lat, 0);

  function clearPoints() {
    points.removeAll();
    recordsById.clear();
  }

  /** Replace the drawn points: `events` in event mode, or `clusters` in cluster mode. */
  function setPoints({ events = [], clusters = [], nextMode = 'events' }) {
    if (destroyed) return;
    clearPoints();
    mode = nextMode;
    if (mode === 'clusters') {
      for (const cluster of clusters) {
        const style = CONFLICT_STYLE[cluster.styleKey];
        recordsById.set(cluster.id, { kind: 'cluster', record: cluster });
        points.add({
          id: cluster.id,
          position: position(cluster.lat, cluster.lon),
          pixelSize: clusterPixelSize(cluster.count),
          color: cesium.Color.fromCssColorString(style.color).withAlpha(
            CLUSTER_ALPHA,
          ),
          outlineColor: cesium.Color.fromCssColorString(OUTLINE_COLOR),
          outlineWidth: OUTLINE_WIDTH_PX,
          disableDepthTestDistance: Number.POSITIVE_INFINITY,
        });
      }
    } else {
      for (const event of events) {
        recordsById.set(eventId(event), { kind: 'event', record: event });
        points.add({
          id: eventId(event),
          position: position(event.lat, event.lon),
          pixelSize: eventPixelSize(event),
          color: cesium.Color.fromCssColorString(eventStyle(event).color),
          outlineColor: cesium.Color.fromCssColorString(OUTLINE_COLOR),
          outlineWidth: OUTLINE_WIDTH_PX,
          disableDepthTestDistance: Number.POSITIVE_INFINITY,
        });
      }
    }
    requestRender();
  }

  /** Event record for an event id, or null (clusters are not selectable). */
  function eventFor(pickId) {
    const entry = recordsById.get(pickId);
    return entry?.kind === 'event' ? entry.record : null;
  }

  /** Event id for a scene pick, or null. Clusters and empty space return null. */
  function pickEvent(picked) {
    const pickId = resolvePickId(picked);
    return pickId && eventFor(pickId) ? pickId : null;
  }

  /** True when a raw pick id belongs to a point this layer drew. */
  function ownsPickId(pickedId) {
    return recordsById.has(String(pickedId));
  }

  function setVisible(visible) {
    if (!destroyed) points.show = visible === true;
    requestRender();
  }

  function clear() {
    if (destroyed) return;
    clearPoints();
    requestRender();
  }

  function destroy() {
    if (destroyed) return;
    destroyed = true;
    recordsById.clear();
    if (!viewer.isDestroyed?.()) viewer.scene.primitives.remove(points);
    else points.removeAll();
  }

  return {
    setPoints,
    eventFor,
    pickEvent,
    ownsPickId,
    setVisible,
    clear,
    destroy,
    get mode() {
      return mode;
    },
    get count() {
      return recordsById.size;
    },
  };
}
