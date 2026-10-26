import * as Cesium from 'cesium';
import {
  GPS_JAM_DEFAULT_WINDOW_HOURS,
  GPS_JAM_SOURCE_LABEL,
  GPS_JAM_WINDOW_HOURS,
} from '../../sources/gpsJam.js';
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
import { createGpsJamRendering } from './rendering.js';
import {
  GPS_JAM_STYLE,
  cellCentre,
  cellId,
  cellLabel,
  cellProperties,
  drawnCells,
  nearestPlaceName,
  percentText,
  summarizeCells,
  topCells,
} from './geometry.js';

export const GPS_JAM_LAYER_ID = 'gps-interference';
const LAYER_NAME = 'GPS Interference';
/** Poll cadence while enabled; the server keeps polling only while requests arrive. */
const REFRESH_MS = 120_000;
/** Camera settle time before a viewport-centred refresh. */
const MOVE_SETTLE_MS = 3_000;
const FOCUS_RADIUS_M = 90_000;
const FOCUS_RANGE_M = 420_000;
const FOCUS_PITCH_DEG = -50;
const FOCUS_DURATION_SEC = 1.6;

/**
 * Inferred GPS-interference cells from aircraft GPS-quality broadcasts. Only
 * medium and high cells are drawn; low cells are counted in the row. The
 * server samples the viewed area when the camera centre is supplied.
 */
export function createGpsJamLayer({
  feed,
  cesium = Cesium,
  createRendering = createGpsJamRendering,
  timers = globalThis,
  matchMedia = globalThis.matchMedia?.bind(globalThis),
} = {}) {
  if (typeof feed?.getSnapshot !== 'function')
    throw new TypeError('GPS interference requires a snapshot source');
  let viewer = null,
    rendering = null,
    snapshot = null,
    drawn = [],
    request = null,
    listener = null,
    selectedId = null,
    clickHandler = null,
    moveEndRemove = null,
    settleTimer = null,
    runNavigation = null,
    windowHours = GPS_JAM_DEFAULT_WINDOW_HOURS,
    error = null,
    loading = false,
    enabled = false,
    destroyed = false;
  const notify = () => listener?.();

  /** Camera centre in degrees: the view rectangle centre, else the camera's ground point. */
  function viewCentre() {
    const camera = viewer?.camera;
    if (!camera) return null;
    let rectangle = null;
    try {
      rectangle = camera.computeViewRectangle?.();
    } catch {
      rectangle = null;
    }
    const point = rectangle
      ? cesium.Rectangle.center(rectangle)
      : camera.positionCartographic;
    if (!point || !Number.isFinite(point.latitude)) return null;
    return {
      lat: cesium.Math.toDegrees(point.latitude),
      lon: cesium.Math.toDegrees(point.longitude),
    };
  }

  /** Context record for one cell; its entity carries the voice-targeting point. */
  function registerCell(cell) {
    const centre = cellCentre(cell);
    const entity = {
      show: true,
      __localBaseCartesian: cesium.Cartesian3.fromDegrees(
        centre.longitude,
        centre.latitude,
        0,
      ),
    };
    registerEntityContext(entity, {
      id: cellId(cell),
      layerId: GPS_JAM_LAYER_ID,
      layerName: LAYER_NAME,
      source: GPS_JAM_SOURCE_LABEL,
      dataSource: rendering?.dataSource ?? null,
      label: cellLabel(cell),
      latitude: centre.latitude,
      longitude: centre.longitude,
      properties: cellProperties(cell, {
        windowHours: snapshot?.windowHours ?? windowHours,
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
      clearSelectedEntityContextForLayer(GPS_JAM_LAYER_ID);
    } catch {
      /* context store unavailable: nothing to clear */
    }
  }

  /** Select one drawn cell and publish it to the shared context store. */
  function selectCell(key) {
    const cell = rendering?.cellFor(key);
    if (!cell) return false;
    selectedId = key;
    try {
      selectEntityContext(registerCell(cell));
    } catch {
      /* the selection still shows in the row */
    }
    notify();
    return true;
  }

  function applySnapshot(next) {
    snapshot = next;
    drawn = drawnCells(next.cells);
    rendering?.setCells(next.cells);
    if (selectedId !== null) {
      const cell = drawn.find((item) => cellId(item) === selectedId);
      if (cell) {
        try {
          registerCell(cell);
        } catch {
          /* context store unavailable */
        }
      } else {
        // The selected cell left the sample. Eviction-aware readouts keep
        // their last-known values rather than tearing down.
        selectedId = null;
        try {
          clearSelectedEntityContextForLayer(GPS_JAM_LAYER_ID, {
            evicted: true,
          });
        } catch {
          /* context store unavailable */
        }
      }
    }
  }

  /** Fetch the current window around the camera; a newer request supersedes this one. */
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
      const centre = viewCentre();
      const next = await feed.getSnapshot({
        windowHours,
        ...(centre ? { area: centre } : {}),
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
    } catch (cause) {
      if (controller.signal.aborted || request !== controller) return true;
      // Keep the last good sample on screen; the row states the failure.
      error = cause?.message || 'GPS interference unavailable';
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

  function onMoveEnd() {
    if (!enabled || destroyed) return;
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
      const key = rendering?.pickCell(picked);
      if (key) {
        selectCell(key);
        return;
      }
      // A pick owned by a sibling layer is not empty space.
      const pickedId = resolvePickId(picked);
      if (pickedId && isOwnedByOtherLayer(GPS_JAM_LAYER_ID, pickedId)) return;
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

  /** Fly to a cell, through the shell's navigation policy when it is attached. */
  function focusCell(cell) {
    const centre = cellCentre(cell);
    const fly = () => {
      if (!enabled || destroyed || !viewer) return;
      const heading = Number.isFinite(viewer.camera.heading)
        ? viewer.camera.heading
        : 0;
      const reduced = matchMedia?.('(prefers-reduced-motion: reduce)')?.matches;
      viewer.camera.flyToBoundingSphere(
        new cesium.BoundingSphere(
          cesium.Cartesian3.fromDegrees(centre.longitude, centre.latitude, 0),
          FOCUS_RADIUS_M,
        ),
        {
          offset: new cesium.HeadingPitchRange(
            heading,
            cesium.Math.toRadians(FOCUS_PITCH_DEG),
            FOCUS_RANGE_M,
          ),
          duration: reduced ? 0 : FOCUS_DURATION_SEC,
        },
      );
    };
    if (runNavigation) runNavigation(fly);
    else fly();
  }

  /** Summary, chips, legend and the strongest cells, for the layer row. */
  function rowList(cells) {
    return topCells(cells).map((cell) => {
      const key = cellId(cell);
      return {
        id: key,
        lead: percentText(cell.ratio),
        text: `${nearestPlaceName(cell, snapshot?.regions ?? [])} · ${cell.aircraft} aircraft`,
        params: { focusCell: key },
      };
    });
  }

  const layer = {
    id: GPS_JAM_LAYER_ID,
    name: LAYER_NAME,
    icon: '⌖',
    source: GPS_JAM_SOURCE_LABEL,
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
        GPS_JAM_LAYER_ID,
        (pickedId) => enabled && rendering?.ownsPickId(pickedId) === true,
      );
      moveEndRemove =
        viewer?.camera?.moveEnd?.addEventListener(onMoveEnd) ?? null;
      installSelection();
    },
    disable() {
      enabled = false;
      cancelSettle();
      request?.abort();
      request = null;
      loading = false;
      error = null;
      moveEndRemove?.();
      moveEndRemove = null;
      removeSelection();
      unregisterPickOwner(GPS_JAM_LAYER_ID);
      clearSelection();
      snapshot = null;
      drawn = [];
      rendering?.clear();
      rendering?.setVisible(false);
      try {
        removeEntityContextsForLayer(GPS_JAM_LAYER_ID);
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
      if (params.windowHours !== undefined) {
        const next = Number(params.windowHours);
        if (!GPS_JAM_WINDOW_HOURS.includes(next)) return false;
        if (next !== windowHours) {
          windowHours = next;
          if (enabled) void refresh();
          notify();
        }
      }
      if (params.clear === true || params.focusCell === null) {
        clearSelection();
        notify();
        return true;
      }
      if (params.focusCell !== undefined) {
        const key = String(params.focusCell);
        const cell = drawn.find((item) => cellId(item) === key);
        if (!cell || !enabled || !selectCell(key)) return false;
        focusCell(cell);
      }
      return true;
    },
    getRowControls() {
      if (destroyed) return null;
      const cells = snapshot?.cells ?? [];
      const summary = summarizeCells(cells);
      let info;
      if (snapshot)
        info = `${summary.affected} affected ${summary.affected === 1 ? 'cell' : 'cells'} from ${summary.aircraft} aircraft sampled · inferred`;
      else if (error) info = `GPS interference unavailable: ${error}.`;
      else
        info = loading
          ? 'Loading GPS interference…'
          : 'No GPS interference sample yet.';
      return {
        chips: GPS_JAM_WINDOW_HOURS.map((hours) => ({
          id: `window-${hours}`,
          label: `${hours} h`,
          active: hours === windowHours,
          params: { windowHours: hours },
          title: `Sample the last ${hours} h of aircraft broadcasts`,
        })),
        legend: [
          {
            label: GPS_JAM_STYLE.medium.label,
            color: GPS_JAM_STYLE.medium.swatch,
            count: summary.medium,
          },
          {
            label: GPS_JAM_STYLE.high.label,
            color: GPS_JAM_STYLE.high.swatch,
            count: summary.high,
          },
        ],
        info,
        infoTitle: [snapshot?.method, snapshot?.note].filter(Boolean).join(' '),
        list: {
          ariaLabel: 'Cells with the strongest GPS interference',
          items: rowList(cells),
        },
      };
    },
    setRowControlsListener(value) {
      listener = typeof value === 'function' ? value : null;
    },
    getStats() {
      const summary = summarizeCells(snapshot?.cells ?? []);
      return {
        count: summary.affected,
        lowCount: summary.low,
        lastUpdate: snapshot?.generatedAt ?? null,
        loading,
        error,
        stale: false,
        source: GPS_JAM_SOURCE_LABEL,
        windowHours,
        empty: Boolean(snapshot && summary.affected === 0),
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
      drawn = [];
    },
  };
  return layer;
}
