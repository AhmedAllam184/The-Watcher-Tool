import * as Cesium from 'cesium';
import {
  CONFLICT_DAYS,
  CONFLICT_DEFAULT_DAYS,
} from '../../sources/conflict.js';
import {
  CONFLICT_LEGEND_KEYS,
  CONFLICT_STYLE,
} from '../../data/conflictLabels.js';
import {
  isOwnedByOtherLayer,
  registerPickOwner,
  resolvePickId,
  unregisterPickOwner,
} from '../../data/pickRegistry.js';
import { isPointerFree } from '../../data/inputOwnership.js';
import {
  clearSelectedEntityContextForLayer,
  registerEntityContext,
  removeEntityContextsForLayer,
  selectEntityContext,
} from '../../data/contextStore.js';
import {
  clearOverlaySource,
  setOverlayEntries,
  setOverlaySourceVisible,
} from '../../overlays/worldOverlay.js';
import { createConflictRendering } from './rendering.js';
import {
  CONFLICT_CLUSTER_ALTITUDE_M,
  CONFLICT_CLUSTER_LABEL_LIMIT,
  clusterEvents,
  eventId,
  eventLabel,
  eventProperties,
  eventSeverity,
  severityText,
  summarizeEvents,
  topEvents,
} from './geometry.js';

export const CONFLICT_LAYER_ID = 'conflict-events';
const LAYER_NAME = 'Conflict Events';
const SOURCE_LABEL = 'ACLED or GDELT news reports';
/** Refresh cadence while enabled. */
const REFRESH_MS = 15 * 60_000;
/** Camera settle time before a refresh for the new view. */
const MOVE_SETTLE_MS = 3_000;
/** Retry after a failed refresh, and the follow-up while the server backfills older reports. */
const RETRY_MS = 5 * 60_000;
const BACKFILL_FOLLOW_UP_MS = 60_000;
const FOCUS_RADIUS_M = 60_000;
const FOCUS_EVENT_RANGE_M = 400_000;
const FOCUS_CLUSTER_RANGE_M = 1_200_000;
const FOCUS_PITCH_DEG = -50;
const FOCUS_DURATION_SEC = 1.6;

const OVERLAY_HOST = Object.freeze({
  setEntries: setOverlayEntries,
  setVisible: setOverlaySourceVisible,
  clearSource: clearOverlaySource,
});

/**
 * Armed-conflict events on the globe. Individual events are points sized by
 * severity; when the camera is high they aggregate into whole-degree cells
 * with a count label on the shared world-overlay host. The server supplies
 * ACLED (verified) or GDELT news locations (unverified), and every surface
 * says which one is shown.
 */
export function createConflictLayer({
  feed,
  cesium = Cesium,
  createRendering = createConflictRendering,
  timers = globalThis,
  matchMedia = globalThis.matchMedia?.bind(globalThis),
  overlayHost = OVERLAY_HOST,
} = {}) {
  if (typeof feed?.getSnapshot !== 'function')
    throw new TypeError('Conflict events requires a snapshot source');
  let viewer = null,
    rendering = null,
    snapshot = null,
    eventsById = new Map(),
    clusters = [],
    clustersById = new Map(),
    renderedClustered = false,
    request = null,
    listener = null,
    selectedId = null,
    clickHandler = null,
    moveEndRemove = null,
    settleTimer = null,
    followUpTimer = null,
    runNavigation = null,
    days = CONFLICT_DEFAULT_DAYS,
    error = null,
    loading = false,
    enabled = false,
    destroyed = false;
  const notify = () => listener?.();

  /** Camera height in metres, or 0 before a camera exists. */
  function altitudeM() {
    const height = viewer?.camera?.positionCartographic?.height;
    return Number.isFinite(height) ? height : 0;
  }

  /** The viewed rectangle in degrees, or null for a view that wraps the antimeridian. */
  function viewBox() {
    const camera = viewer?.camera;
    if (!camera) return null;
    let rectangle = null;
    try {
      rectangle = camera.computeViewRectangle?.();
    } catch {
      rectangle = null;
    }
    if (!rectangle) return null;
    const box = {
      west: cesium.Math.toDegrees(rectangle.west),
      south: cesium.Math.toDegrees(rectangle.south),
      east: cesium.Math.toDegrees(rectangle.east),
      north: cesium.Math.toDegrees(rectangle.north),
    };
    if (!(box.west < box.east && box.south < box.north)) return null;
    return box;
  }

  /** Context record for one event; its entity carries the voice-targeting point. */
  function registerEvent(event) {
    const entity = {
      show: true,
      __localBaseCartesian: cesium.Cartesian3.fromDegrees(
        event.lon,
        event.lat,
        0,
      ),
    };
    registerEntityContext(entity, {
      id: eventId(event),
      layerId: CONFLICT_LAYER_ID,
      layerName: LAYER_NAME,
      source: snapshot?.verified ? 'ACLED' : 'GDELT',
      dataSource: null,
      label: eventLabel(event),
      latitude: event.lat,
      longitude: event.lon,
      properties: eventProperties(event, {
        source: snapshot?.verified ? 'ACLED' : 'GDELT',
        verified: snapshot?.verified === true,
        method: snapshot?.method ?? '',
        note: snapshot?.note ?? '',
      }),
    });
    return entity;
  }

  function clearSelection() {
    if (selectedId === null) return;
    selectedId = null;
    try {
      clearSelectedEntityContextForLayer(CONFLICT_LAYER_ID);
    } catch {
      /* context store unavailable: nothing to clear */
    }
  }

  /** Select one event and publish it to the shared context store. */
  function selectEvent(key) {
    const event = eventsById.get(key);
    if (!event) return false;
    selectedId = key;
    try {
      selectEntityContext(registerEvent(event));
    } catch {
      /* the selection still shows in the row */
    }
    notify();
    return true;
  }

  /** Publish the cluster labels in cluster mode, and hide them otherwise. */
  function publishLabels(clustered) {
    if (!clustered || !enabled || clusters.length === 0) {
      overlayHost.clearSource(CONFLICT_LAYER_ID);
      overlayHost.setVisible(CONFLICT_LAYER_ID, false);
      return;
    }
    const entries = clusters
      .slice(0, CONFLICT_CLUSTER_LABEL_LIMIT)
      .map((cluster) => ({
        id: cluster.id,
        position: cesium.Cartesian3.fromDegrees(cluster.lon, cluster.lat, 0),
        variant: 'label',
        title: String(cluster.count),
        details: [],
        accent: CONFLICT_STYLE[cluster.styleKey].color,
        priority: cluster.count,
        interactive: true,
        maxDistance: Number.POSITIVE_INFINITY,
      }));
    overlayHost.setVisible(CONFLICT_LAYER_ID, true);
    overlayHost.setEntries(CONFLICT_LAYER_ID, entries, {
      cohortLimit: CONFLICT_CLUSTER_LABEL_LIMIT,
      moving: false,
    });
  }

  /** Draw the snapshot at the current zoom: individual events, or cells when high. */
  function present() {
    if (destroyed) return;
    renderedClustered = altitudeM() > CONFLICT_CLUSTER_ALTITUDE_M;
    rendering?.setPoints({
      events: snapshot ? snapshot.events : [],
      clusters,
      nextMode: renderedClustered ? 'clusters' : 'events',
    });
    publishLabels(renderedClustered);
  }

  /** Switch between events and clusters only when the zoom crosses the threshold. */
  function syncMode() {
    if (!snapshot) return;
    if (altitudeM() > CONFLICT_CLUSTER_ALTITUDE_M !== renderedClustered)
      present();
  }

  function applySnapshot(next) {
    snapshot = next;
    eventsById = new Map(next.events.map((event) => [eventId(event), event]));
    clusters = clusterEvents(next.events);
    clustersById = new Map(clusters.map((cluster) => [cluster.id, cluster]));
    present();
    if (selectedId !== null) {
      const event = eventsById.get(selectedId);
      if (event) {
        try {
          registerEvent(event);
        } catch {
          /* context store unavailable */
        }
      } else {
        // The selected event left the sample; keep its last-known readout.
        selectedId = null;
        try {
          clearSelectedEntityContextForLayer(CONFLICT_LAYER_ID, {
            evicted: true,
          });
        } catch {
          /* context store unavailable */
        }
      }
    }
  }

  /** Fetch the window around the camera; a newer request supersedes this one. */
  async function refresh({ signal } = {}) {
    if (destroyed || !enabled) return true;
    request?.abort();
    const controller = new AbortController();
    const abort = () => controller.abort(signal?.reason);
    if (signal?.aborted) abort();
    else signal?.addEventListener('abort', abort, { once: true });
    request = controller;
    loading = true;
    notify();
    try {
      const next = await feed.getSnapshot({
        days,
        bbox: viewBox(),
        signal: controller.signal,
      });
      if (
        !enabled ||
        destroyed ||
        controller.signal.aborted ||
        request !== controller
      )
        return true;
      applySnapshot(next);
      error = null;
      scheduleRefresh(next.backfilling ? BACKFILL_FOLLOW_UP_MS : null);
    } catch (cause) {
      if (controller.signal.aborted || request !== controller) return true;
      // Keep the last good sample on screen; the row states the failure and when it retries.
      error = `${cause?.message || 'conflict events unavailable'}; retrying in 5 min`;
      scheduleRefresh(RETRY_MS);
    } finally {
      signal?.removeEventListener('abort', abort);
      if (request === controller) {
        request = null;
        loading = false;
        notify();
      }
    }
    return true;
  }

  function cancelSettle() {
    if (settleTimer !== null) timers.clearTimeout(settleTimer);
    settleTimer = null;
  }

  /** One refresh after `ms`, replacing any pending one; null cancels it. */
  function scheduleRefresh(ms) {
    if (followUpTimer !== null) timers.clearTimeout(followUpTimer);
    followUpTimer = null;
    if (ms === null || !enabled || destroyed) return;
    followUpTimer = timers.setTimeout(() => {
      followUpTimer = null;
      if (enabled && !destroyed) void refresh();
    }, ms);
  }

  function onMoveEnd() {
    if (!enabled || destroyed) return;
    syncMode();
    cancelSettle();
    settleTimer = timers.setTimeout(() => {
      settleTimer = null;
      if (enabled && !destroyed) void refresh();
    }, MOVE_SETTLE_MS);
  }

  function installSelection() {
    if (
      clickHandler ||
      !viewer?.scene?.canvas ||
      typeof cesium.ScreenSpaceEventHandler !== 'function'
    )
      return;
    const owner = new cesium.ScreenSpaceEventHandler(viewer.scene.canvas);
    clickHandler = owner;
    owner.setInputAction((click) => {
      if (!enabled || destroyed || clickHandler !== owner) return;
      // A tool owns the pointer: yield the click.
      if (!isPointerFree() || !click?.position) return;
      const picked = viewer.scene.pick(click.position);
      const key = rendering?.pickEvent(picked);
      if (key) {
        selectEvent(key);
        return;
      }
      const pickedId = resolvePickId(picked);
      // A cluster click flies into that cell.
      if (pickedId && rendering?.ownsPickId(pickedId)) {
        const cluster = clustersById.get(pickedId);
        if (cluster) flyTo(cluster.lat, cluster.lon, FOCUS_CLUSTER_RANGE_M);
        return;
      }
      // A pick owned by a sibling layer is not empty space.
      if (pickedId && isOwnedByOtherLayer(CONFLICT_LAYER_ID, pickedId)) return;
      if (selectedId !== null) {
        clearSelection();
        notify();
      }
    }, cesium.ScreenSpaceEventType.LEFT_CLICK);
  }

  function removeSelection() {
    const owner = clickHandler;
    clickHandler = null;
    if (owner && !owner.isDestroyed?.()) owner.destroy();
  }

  /** Fly to a point, through the shell's navigation policy when it is attached. */
  function flyTo(lat, lon, range) {
    const fly = () => {
      if (!enabled || destroyed || !viewer) return;
      const heading = Number.isFinite(viewer.camera.heading)
        ? viewer.camera.heading
        : 0;
      const reduced = matchMedia?.('(prefers-reduced-motion: reduce)')?.matches;
      viewer.camera.flyToBoundingSphere(
        new cesium.BoundingSphere(
          cesium.Cartesian3.fromDegrees(lon, lat, 0),
          FOCUS_RADIUS_M,
        ),
        {
          offset: new cesium.HeadingPitchRange(
            heading,
            cesium.Math.toRadians(FOCUS_PITCH_DEG),
            range,
          ),
          duration: reduced ? 0 : FOCUS_DURATION_SEC,
        },
      );
    };
    if (runNavigation) runNavigation(fly);
    else fly();
  }

  /** The most severe events, for the row list. */
  function rowList() {
    return topEvents(snapshot?.events ?? []).map((event) => ({
      id: eventId(event),
      lead: String(eventSeverity(event)),
      text: `${eventLabel(event)} · ${event.date || 'undated'} · ${severityText(event)}`,
      params: { focusEvent: eventId(event) },
    }));
  }

  const layer = {
    id: CONFLICT_LAYER_ID,
    name: LAYER_NAME,
    icon: '⚔',
    source: SOURCE_LABEL,
    updateInterval: REFRESH_MS,
    init(nextViewer) {
      if (destroyed) return;
      viewer = nextViewer;
      rendering = createRendering({ viewer, cesium });
    },
    attachShellServices(services) {
      runNavigation =
        typeof services?.runNavigation === 'function'
          ? services.runNavigation
          : null;
      notify();
    },
    enable() {
      if (destroyed || enabled) return;
      enabled = true;
      rendering?.setVisible(true);
      registerPickOwner(
        CONFLICT_LAYER_ID,
        (pickedId) => enabled && rendering?.ownsPickId(pickedId) === true,
      );
      moveEndRemove =
        viewer?.camera?.moveEnd?.addEventListener(onMoveEnd) ?? null;
      installSelection();
      if (snapshot) present();
    },
    disable() {
      enabled = false;
      cancelSettle();
      scheduleRefresh(null);
      request?.abort();
      request = null;
      loading = false;
      error = null;
      moveEndRemove?.();
      moveEndRemove = null;
      removeSelection();
      unregisterPickOwner(CONFLICT_LAYER_ID);
      clearSelection();
      snapshot = null;
      eventsById = new Map();
      clusters = [];
      clustersById = new Map();
      renderedClustered = false;
      publishLabels(false);
      rendering?.clear();
      rendering?.setVisible(false);
      try {
        removeEntityContextsForLayer(CONFLICT_LAYER_ID);
      } catch {
        /* context store unavailable */
      }
      notify();
    },
    update(_viewer, { signal } = {}) {
      return refresh({ signal });
    },
    setParams(params = {}) {
      if (destroyed) return false;
      if (params.days !== undefined) {
        const next = Number(params.days);
        if (!CONFLICT_DAYS.includes(next)) return false;
        if (next !== days) {
          days = next;
          if (enabled) void refresh();
          notify();
        }
      }
      if (params.clear === true || params.focusEvent === null) {
        clearSelection();
        notify();
        return true;
      }
      if (params.focusEvent !== undefined) {
        const key = String(params.focusEvent);
        const event = eventsById.get(key);
        if (!event || !enabled || !selectEvent(key)) return false;
        flyTo(event.lat, event.lon, FOCUS_EVENT_RANGE_M);
      }
      return true;
    },
    getRowControls() {
      if (destroyed) return null;
      const events = snapshot?.events ?? [];
      const summary = summarizeEvents(events);
      let info;
      if (snapshot) {
        info = `${summary.total} ${summary.total === 1 ? 'event' : 'events'} · ${snapshot.verified ? 'ACLED (verified)' : 'GDELT news reports (unverified)'}`;
        if (!snapshot.verified) {
          if (snapshot.coverageHours !== null)
            info += ` · ${snapshot.coverageHours} h loaded${snapshot.backfilling ? ', loading older reports' : ''}`;
          info += '. Add a free ACLED key for verified data';
        }
      } else if (error) info = `Conflict events unavailable: ${error}.`;
      else
        info = loading
          ? 'Loading conflict events…'
          : 'No conflict event sample yet.';
      return {
        chips: CONFLICT_DAYS.map((count) => ({
          id: `days-${count}`,
          label: count === 1 ? '24 h' : '7 days',
          active: count === days,
          params: { days: count },
          title:
            count === 1
              ? 'Show events from the last 24 hours'
              : 'Show events from the last 7 days',
        })),
        legend: CONFLICT_LEGEND_KEYS.map((key) => ({
          label: CONFLICT_STYLE[key].label,
          color: CONFLICT_STYLE[key].swatch,
          count: summary.byKey[key],
        })),
        info,
        infoTitle: [snapshot?.note, snapshot?.method].filter(Boolean).join(' '),
        list: {
          ariaLabel: 'Conflict events with the most severe outcomes',
          items: rowList(),
        },
      };
    },
    setRowControlsListener(value) {
      listener = typeof value === 'function' ? value : null;
    },
    getStats() {
      const total = snapshot?.events.length ?? 0;
      return {
        count: total,
        lastUpdate: snapshot?.generatedAt ?? null,
        loading,
        error,
        stale: false,
        source: snapshot?.verified ? 'ACLED' : SOURCE_LABEL,
        windowDays: days,
        empty: Boolean(snapshot && total === 0),
      };
    },
    destroy() {
      if (destroyed) return;
      layer.disable();
      destroyed = true;
      rendering?.destroy();
      rendering = null;
      viewer = null;
      listener = null;
      runNavigation = null;
      snapshot = null;
      eventsById = new Map();
      clusters = [];
      clustersById = new Map();
    },
  };
  return layer;
}
