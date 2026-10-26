import { createFlightSnapshotRenderer } from './snapshotRenderer.js';
import { createFlightState } from './state.js';
import { createRendering } from './rendering.js';
import { createMotion } from './motion.js';
import { createTracking } from './tracking.js';
import { createTripLine } from './tripLine.js';
import { createController } from './controller.js';
import { createEnrichment } from './enrichment.js';
import { createIngestion } from './ingestion.js';
import { createLifecycle } from './lifecycle.js';
import { createEvidence } from './evidence.js';
import { createTesting } from './testing.js';
import { createQueries } from './queries.js';
import { emitSquawkEmergencies } from '../../data/squawk.js';
/** Compose one civil-flight layer with application-owned scene services. */
export function createCivilFlightLayer({
  source,
  services,
  resolveAsset = (url) => url,
} = {}) {
  const flightState = createFlightState({ source, services });
  const parts = {};
  const layer = {};
  const context = { flightState, services, parts, layer, resolveAsset };
  parts.rendering = createRendering(context);
  parts.motion = createMotion(context);
  parts.tracking = createTracking(context);
  // Current-flight trace for the tracked plane. The source fetches; this draws.
  parts.tripLine = createTripLine({
    getViewer: () => flightState._viewer,
    fetchTrace: (icao24, options) =>
      flightState.feed?._source?.getTrace?.(icao24, options),
    getSubject: (icao24) => {
      const info = flightState.records.data.get(icao24);
      const route =
        info?.route && parts.tracking._routeIsPlausible(icao24, info.route)
          ? info.route
          : null;
      return {
        position: flightState._billboards.get(icao24)?.position ?? null,
        route,
      };
    },
    onChange: (icao24) => parts.tracking._onTripLineChange(icao24),
  });
  parts.controller = createController(context);
  parts.enrichment = createEnrichment(context);
  parts.lifecycle = createLifecycle(context);
  parts.evidence = createEvidence(context);
  parts.testing = createTesting(context);
  parts.queries = createQueries(context);
  const applySnapshot = createFlightSnapshotRenderer({
    flightState,
    records: flightState.records,
    militaryRegistry: services.militaryRegistry,
    groundFloor: services.groundFloor,
    meshFloor: services.meshFloor,
    rendering: parts.rendering,
    tracking: parts.tracking,
    motion: parts.motion,
    enrichment: parts.enrichment,
    queries: parts.queries,
  });
  parts.ingestion = createIngestion({
    feed: flightState.feed,
    getQuery: (viewer) =>
      parts.controller._flightQuery(viewer || flightState._viewer),
    applySnapshot,
    setSourceLabel: (source) => {
      layer.source = source;
    },
    applyPendingTrackingRestore: () =>
      parts.tracking._applyPendingTrackingRestore(),
    onSquawkAlerts: (alerts) =>
      emitSquawkEmergencies(
        typeof window === 'undefined' ? null : window,
        'flights',
        alerts,
      ),
  });

  Object.assign(
    layer,
    parts.queries.methods,
    parts.lifecycle.methods,
    parts.ingestion.methods,
  );
  Object.defineProperty(layer, 'testing', { value: parts.testing });
  return layer;
}
export { TRACKED_MODEL_MAX_PX } from './policy.js';
