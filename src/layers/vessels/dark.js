import * as Cesium from 'cesium';
import { DARK_FIRST_POLL_MS, DARK_POLL_MS, VESSEL_LIFT_M } from './policy.js';

/** World-overlay source for the DARK labels (Cesium text labels are not used). */
export const DARK_OVERLAY_SOURCE_ID = 'ais-dark-vessels';
export const DARK_COLOR = '#f87171';
const DARK_POINT_FILL = 'rgba(248,113,113,0.15)';
const DARK_LAYER_ID = 'ais-live-vessels';
const DARK_ROW_LIMIT = 25;
const DARK_REQUEST_TIMEOUT_MS = 10000;

/** "45m" under an hour, "2h" from an hour on. */
function silenceText(ms) {
  const minutes = Math.round(Number(ms) / 60000);
  if (!Number.isFinite(minutes)) return '?';
  if (minutes < 60) return `${minutes}m`;
  return `${Math.round(minutes / 60)}h`;
}

function ruleText(rule) {
  if (!rule) return '';
  const parts = [];
  if (Number.isFinite(rule.minSilenceMin))
    parts.push(`silent for at least ${rule.minSilenceMin} min`);
  if (Number.isFinite(rule.minSpeedKt))
    parts.push(`under way at ${rule.minSpeedKt} kt or more`);
  if (Number.isFinite(rule.minReports))
    parts.push(`at least ${rule.minReports} earlier reports`);
  if (rule.coverage) parts.push(rule.coverage);
  return parts.join('; ');
}

/**
 * Gone-dark ships: a poll of the server's inference while the layer is on,
 * drawn as rings with DARK labels and listed in the layer's row. Results from a
 * previous enable never reach the state, as in lifecycle.js.
 */
export function createDarkVessels({
  vesselState,
  services,
  parts: components,
  layer,
}) {
  const { state } = vesselState;
  const { governorRequestRender } = services.render || {};
  const { registerEntityContext, selectEntityContext } = services.context || {};
  const { requestWorldFocus } = services.worldFocus || {};
  const host = () => vesselState._vesselOverlayHost;

  function positionFor(vessel) {
    const heightM = components.queries.vesselDatumHeightM(
      components.tracking.currentGeoidN(vessel.latitude, vessel.longitude),
      VESSEL_LIFT_M,
    );
    return Cesium.Cartesian3.fromDegrees(
      vessel.longitude,
      vessel.latitude,
      heightM,
    );
  }

  function ensureCollections(viewer) {
    if (!viewer?.scene?.primitives || state.dark.collections) return;
    const points = new Cesium.PointPrimitiveCollection();
    viewer.scene.primitives.add(points);
    state.dark.collections = { primitives: viewer.scene.primitives, points };
  }

  function removeCollections() {
    const collections = state.dark.collections;
    state.dark.collections = null;
    if (!collections) return;
    const { primitives, points } = collections;
    primitives.remove(points);
    if (!points.isDestroyed()) points.destroy();
  }

  /** Replace every ring and label with the latest inference. */
  function render() {
    const { collections, vessels } = state.dark;
    if (collections) {
      collections.points.removeAll();
      for (const vessel of vessels) {
        collections.points.add({
          position: positionFor(vessel),
          pixelSize: 10,
          color: Cesium.Color.fromCssColorString(DARK_POINT_FILL),
          outlineColor: Cesium.Color.fromCssColorString(DARK_COLOR),
          outlineWidth: 2,
          disableDepthTestDistance: Number.POSITIVE_INFINITY,
        });
      }
    }
    host().setEntries(
      DARK_OVERLAY_SOURCE_ID,
      vessels.map((vessel) => ({
        id: `dark:${vessel.mmsi}`,
        position: positionFor(vessel),
        variant: 'label',
        title: `DARK ${silenceText(vessel.silentMs)}`,
        accent: DARK_COLOR,
      })),
    );
    governorRequestRender?.('ais-dark-vessels');
  }

  function isCurrent(sessionId) {
    return state.feed.enabled && state.dark.sessionId === sessionId;
  }

  function scheduleNext(sessionId, delayMs) {
    state.dark.timer = vesselState._aisRuntime.setTimeout(() => {
      state.dark.timer = null;
      void poll(sessionId);
    }, delayMs);
  }

  async function poll(sessionId) {
    const source = vesselState._source;
    if (!isCurrent(sessionId) || typeof source?.getDarkVessels !== 'function')
      return;
    const controller = new AbortController();
    state.dark.abort = controller;
    const signal =
      typeof AbortSignal.any === 'function'
        ? AbortSignal.any([
            controller.signal,
            AbortSignal.timeout(DARK_REQUEST_TIMEOUT_MS),
          ])
        : controller.signal;
    let result = null;
    let failure = null;
    try {
      result = await source.getDarkVessels({ signal });
    } catch (error) {
      failure = error;
    } finally {
      if (state.dark.abort === controller) state.dark.abort = null;
    }
    // A teardown or a newer enable owns the state now; drop this answer.
    if (!isCurrent(sessionId)) return;
    if (failure) {
      console.warn('[Data:ais-live-vessels] dark check failed', failure);
      Object.assign(state.dark, {
        vessels: [],
        feedHealthy: false,
        fetchedAt: vesselState._aisRuntime.now(),
        error: failure.message || 'Dark-ship check failed',
      });
    } else {
      Object.assign(state.dark, {
        vessels: result.vessels,
        note: result.note,
        rule: result.rule,
        feedHealthy: result.feedHealthy,
        fetchedAt: vesselState._aisRuntime.now(),
        error: null,
      });
    }
    render();
    scheduleNext(sessionId, DARK_POLL_MS);
    state.dark.listener?.();
  }

  /** Begin polling for an enabled layer; idempotent while a session runs. */
  function start(viewer) {
    ensureCollections(viewer);
    if (state.dark.sessionId !== null) return;
    if (typeof vesselState._source?.getDarkVessels !== 'function') return;
    const sessionId = ++vesselState._aisSessionSequence;
    state.dark.sessionId = sessionId;
    scheduleNext(sessionId, DARK_FIRST_POLL_MS);
  }

  /** Stop polling and remove everything drawn; the data is dropped with it. */
  function stop() {
    const dark = state.dark;
    dark.sessionId = null;
    if (dark.timer !== null) {
      vesselState._aisRuntime.clearTimeout(dark.timer);
      dark.timer = null;
    }
    dark.abort?.abort();
    dark.abort = null;
    removeCollections();
    host().clearSource(DARK_OVERLAY_SOURCE_ID);
    Object.assign(dark, {
      vessels: [],
      note: '',
      rule: null,
      feedHealthy: false,
      fetchedAt: null,
      error: null,
    });
  }

  function destroy() {
    stop();
    state.dark.listener = null;
  }

  /** Select a gone-dark ship in the shared context and fly to it. */
  function selectDark(vessel) {
    components.selection.clearVesselInspection();
    const entity = {
      name: vessel.name,
      mmsi: vessel.mmsi,
      imo: vessel.imo,
      type: vessel.type,
      destination: vessel.destination,
      speed: vessel.lastSpeedKt,
      course: vessel.course,
      heading: vessel.heading,
      lastPositionEpoch: vessel.lastSeenMs,
      missedRefreshes: 1,
      dark: true,
      inference: vessel.inference,
    };
    const record = registerEntityContext(entity, {
      id: `ais-dark-${vessel.mmsi}`,
      layerId: DARK_LAYER_ID,
      layerName: 'Live AIS Vessels',
      source: 'AISStream (inferred)',
      label: vessel.name,
      latitude: vessel.latitude,
      longitude: vessel.longitude,
      properties: {
        mmsi: vessel.mmsi,
        type: vessel.type,
        destination: vessel.destination,
        status: 'gone dark (inferred)',
        silentMin: Math.round(vessel.silentMs / 60000),
        neighbours: vessel.neighbours,
      },
    });
    if (!record) return false;
    selectEntityContext(entity);
    requestWorldFocus?.({
      kind: 'vessel',
      id: vessel.mmsi,
      label: vessel.name,
      position: positionFor(vessel),
    });
    governorRequestRender?.('ais-dark-selection');
    return true;
  }

  function clearSelection() {
    components.selection.clearVesselInspection();
  }

  /** Row descriptor for the layer panel; null while disabled or before any answer. */
  function getRowControls() {
    const dark = state.dark;
    if (!state.feed.enabled || dark.fetchedAt === null) return null;
    const count = dark.vessels.length;
    let info;
    if (dark.error) info = `Dark-ship check unavailable: ${dark.error}.`;
    else if (!dark.feedHealthy)
      info = 'Dark-ship check paused: the AIS feed is not live.';
    else
      info = `${count} ${count === 1 ? 'ship' : 'ships'} stopped transmitting while under way, where nearby ships still report. Inferred, not confirmed.`;
    const rule = ruleText(dark.rule);
    return {
      chips: [],
      legend: [{ label: 'Gone dark (inferred)', color: DARK_COLOR, count }],
      info,
      infoTitle: [dark.note, rule ? `Rule: ${rule}` : '']
        .filter(Boolean)
        .join(' '),
      list: {
        ariaLabel: 'Ships that went dark',
        items: dark.vessels.slice(0, DARK_ROW_LIMIT).map((vessel) => ({
          id: `dark-${vessel.mmsi}`,
          lead: silenceText(vessel.silentMs),
          text: [
            vessel.name,
            vessel.type || 'vessel',
            Number.isFinite(vessel.lastSpeedKt)
              ? `${vessel.lastSpeedKt} kt`
              : '',
          ]
            .filter(Boolean)
            .join(' · '),
          params: { darkMmsi: vessel.mmsi },
        })),
      },
    };
  }

  /** Accepts {darkMmsi} from a row item; {darkMmsi: null} clears the selection. */
  function setParams(params) {
    if (!params || typeof params !== 'object' || !('darkMmsi' in params))
      return false;
    if (params.darkMmsi === null) {
      clearSelection();
      return true;
    }
    const mmsi = String(params.darkMmsi || '').trim();
    const vessel = state.dark.vessels.find((entry) => entry.mmsi === mmsi);
    if (!vessel || !state.feed.enabled) return false;
    return selectDark(vessel);
  }

  function setRowControlsListener(listener) {
    state.dark.listener = typeof listener === 'function' ? listener : null;
  }

  return {
    start,
    stop,
    destroy,
    methods: { getRowControls, setRowControlsListener, setParams },
  };
}
