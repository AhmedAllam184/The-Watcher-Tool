import * as Cesium from 'cesium';
import {
  AIRPORT_STATUS_SOURCE_LABEL,
  createAirportStatusSource,
} from '../../sources/airportStatus.js';
import {
  INFRASTRUCTURE_DATA_URLS,
  parseGeojsonLines,
} from '../../sources/infrastructureData.js';
import {
  AIRPORT_RING_PIXELS,
  AIRPORT_STATUS_STYLE,
  affectedAirports,
  airportContextProperties,
  airportLabel,
  airportRowList,
  candidateAirportCodes,
  statusCounts,
} from './presentation.js';

export const AIRPORT_STATUS_LAYER_ID = 'local-airports';
const LAYER_NAME = 'Airports';
const POLL_MS = 60_000;
const MOVE_SETTLE_MS = 3_000;
const FOCUS_RADIUS_M = 30_000;
const FOCUS_RANGE_M = 150_000;
const FOCUS_PITCH_DEG = -50;
const FOCUS_DURATION_SEC = 1.6;

/**
 * Large airports from the bundled dataset, as {icao, iata, name, city, lat, lon}.
 * Read once; the layer keeps its own copy of the features inside the core.
 */
export async function loadLargeAirports({
  fetchImpl = (...args) => globalThis.fetch(...args),
  url = INFRASTRUCTURE_DATA_URLS['local-airports'],
} = {}) {
  const response = await fetchImpl(url);
  if (!response.ok) throw new Error(`airports dataset HTTP ${response.status}`);
  return parseGeojsonLines(await response.text())
    .filter((feature) => feature?.properties?.kind === 'Large airport')
    .map((feature) => {
      const [lon, lat] = feature.geometry?.coordinates ?? [];
      return {
        icao: String(feature.properties.icao ?? '').trim(),
        iata: String(feature.properties.iata ?? '').trim(),
        name: String(feature.properties.name ?? '').trim(),
        city: String(feature.properties.city ?? '').trim(),
        lat,
        lon,
      };
    })
    .filter(
      (airport) =>
        airport.icao &&
        Number.isFinite(airport.lat) &&
        Number.isFinite(airport.lon),
    );
}

/** Degrees view rectangle and ground centre of the camera, or nulls. */
function viewOf(viewer, cesium) {
  const camera = viewer?.camera;
  if (!camera) return { rect: null, centre: null };
  let rectangle = null;
  try {
    rectangle = camera.computeViewRectangle?.() ?? null;
  } catch {
    rectangle = null;
  }
  const degrees = (value) => cesium.Math.toDegrees(value);
  if (rectangle) {
    return {
      rect: {
        west: degrees(rectangle.west),
        south: degrees(rectangle.south),
        east: degrees(rectangle.east),
        north: degrees(rectangle.north),
      },
      centre: null,
    };
  }
  const point = camera.positionCartographic;
  if (!point || !Number.isFinite(point.latitude))
    return { rect: null, centre: null };
  return {
    rect: null,
    centre: { lat: degrees(point.latitude), lon: degrees(point.longitude) },
  };
}

/**
 * Inferred airport disruption, drawn as rings on the Airports layer and
 * listed in its row. The controller is created once; `decorate(layer)` attaches
 * it to the airports layer object, so the layer stays one layer. Polling runs
 * only while that layer is enabled.
 */
export function createAirportStatusOverlay({
  source = createAirportStatusSource(),
  loadAirports = () => loadLargeAirports(),
  cesium = Cesium,
  timers = globalThis,
  matchMedia = globalThis.matchMedia?.bind(globalThis),
  services = {},
  pollMs = POLL_MS,
  moveSettleMs = MOVE_SETTLE_MS,
} = {}) {
  let viewer = null;
  let collection = null;
  let enabled = false;
  let destroyed = false;
  let status = null;
  let byIcao = new Map();
  let error = null;
  let loading = false;
  let airportsPromise = null;
  let request = null;
  let pollTimer = null;
  let settleTimer = null;
  let moveEndRemove = null;
  let listener = null;
  let runNavigation = null;
  /** Context id → registration metadata for airports, so selection can re-register with status. */
  const contextMeta = new Map();
  const notify = () => listener?.();

  function ensureCollection() {
    if (collection || !viewer?.scene?.primitives) return;
    collection = new cesium.PointPrimitiveCollection();
    viewer.scene.primitives.add(collection);
  }

  function removeCollection() {
    const owned = collection;
    collection = null;
    if (!owned) return;
    try {
      viewer?.scene?.primitives?.remove(owned);
    } catch {
      /* the scene is already gone */
    }
    if (!owned.isDestroyed?.()) owned.destroy();
  }

  function requestRender() {
    services.governorRequestRender?.('airport-status');
  }

  /** Rings around every disrupted and watch airport in the latest status. */
  function redraw() {
    if (!collection) return;
    collection.removeAll();
    for (const airport of affectedAirports(status?.airports ?? [])) {
      const style = AIRPORT_STATUS_STYLE[airport.level];
      collection.add({
        position: cesium.Cartesian3.fromDegrees(airport.lon, airport.lat, 0),
        pixelSize: AIRPORT_RING_PIXELS,
        color: cesium.Color.fromCssColorString(style.fill),
        outlineColor: cesium.Color.fromCssColorString(style.swatch),
        outlineWidth: 2,
        disableDepthTestDistance: Number.POSITIVE_INFINITY,
      });
    }
    requestRender();
  }

  function ensureAirports() {
    if (!airportsPromise) {
      airportsPromise = Promise.resolve()
        .then(() => loadAirports())
        .catch((cause) => {
          airportsPromise = null;
          console.warn('[airport-status] airports dataset unavailable', cause);
          return [];
        });
    }
    return airportsPromise;
  }

  function applyStatus(next) {
    status = next;
    byIcao = new Map(next.airports.map((airport) => [airport.icao, airport]));
    redraw();
  }

  /** Ask for the viewed large airports too; the server always returns its watchlist. */
  async function refresh() {
    if (!enabled || destroyed) return;
    request?.abort();
    const controller = new AbortController();
    request = controller;
    loading = true;
    notify();
    try {
      const airports = await ensureAirports();
      if (!enabled || controller.signal.aborted) return;
      const codes = candidateAirportCodes(airports, viewOf(viewer, cesium));
      const next = await source.getStatus({
        codes,
        signal: controller.signal,
      });
      if (!enabled || controller.signal.aborted) return;
      applyStatus(next);
      error = null;
    } catch (cause) {
      if (controller.signal.aborted || !enabled) return;
      // Keep the last good status on screen; the row states the failure.
      error = cause?.message || 'airport status unavailable';
    } finally {
      if (request === controller) {
        request = null;
        loading = false;
        notify();
      }
    }
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
      void refresh();
    }, moveSettleMs);
  }

  /** Context record for a focused airport, carrying its status. */
  function selectAirport(airport) {
    const entity = {
      show: true,
      __localBaseCartesian: cesium.Cartesian3.fromDegrees(
        airport.lon,
        airport.lat,
        0,
      ),
    };
    services.registerEntityContext?.(entity, {
      id: `airport-status:${airport.icao}`,
      layerId: AIRPORT_STATUS_LAYER_ID,
      layerName: LAYER_NAME,
      source: AIRPORT_STATUS_SOURCE_LABEL,
      dataSource: null,
      label: airportLabel(airport),
      latitude: airport.lat,
      longitude: airport.lon,
      properties: {
        name: airport.name,
        iata: airport.iata,
        icao: airport.icao,
        city: airport.city,
        ...airportContextProperties(airport),
      },
    });
    services.selectEntityContext?.(entity);
  }

  function flyTo(airport) {
    const fly = () => {
      if (!enabled || destroyed || !viewer) return;
      const heading = Number.isFinite(viewer.camera.heading)
        ? viewer.camera.heading
        : 0;
      const reduced = matchMedia?.('(prefers-reduced-motion: reduce)')?.matches;
      viewer.camera.flyToBoundingSphere(
        new cesium.BoundingSphere(
          cesium.Cartesian3.fromDegrees(airport.lon, airport.lat, 0),
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

  const controller = {
    enable(nextViewer) {
      if (destroyed || enabled || !nextViewer) return;
      viewer = nextViewer;
      enabled = true;
      ensureCollection();
      moveEndRemove =
        viewer.camera?.moveEnd?.addEventListener(onMoveEnd) ?? null;
      pollTimer = timers.setInterval(() => void refresh(), pollMs);
      void refresh();
    },
    disable() {
      enabled = false;
      cancelSettle();
      if (pollTimer !== null) timers.clearInterval(pollTimer);
      pollTimer = null;
      request?.abort();
      request = null;
      loading = false;
      moveEndRemove?.();
      moveEndRemove = null;
      removeCollection();
      status = null;
      byIcao = new Map();
      error = null;
      notify();
    },
    destroy() {
      controller.disable();
      destroyed = true;
      listener = null;
      runNavigation = null;
      contextMeta.clear();
    },
    attachShellServices(services) {
      runNavigation =
        typeof services?.runNavigation === 'function'
          ? services.runNavigation
          : null;
    },
    setListener(value) {
      listener = typeof value === 'function' ? value : null;
    },
    getRowControls() {
      if (destroyed) return null;
      const airports = status?.airports ?? [];
      const counts = statusCounts(airports);
      let info;
      if (status) info = `${airports.length} airports monitored · inferred`;
      else if (error) info = `Airport status unavailable: ${error}.`;
      else
        info = loading ? 'Checking airport status…' : 'No airport status yet.';
      return {
        legend: [
          {
            label: AIRPORT_STATUS_STYLE.disrupted.label,
            color: AIRPORT_STATUS_STYLE.disrupted.swatch,
            count: counts.disrupted,
          },
          {
            label: AIRPORT_STATUS_STYLE.watch.label,
            color: AIRPORT_STATUS_STYLE.watch.swatch,
            count: counts.watch,
          },
        ],
        info,
        infoTitle: [status?.note, status?.method].filter(Boolean).join(' '),
        list: {
          ariaLabel: 'Airports disrupted or under watch',
          items: airportRowList(airports),
        },
      };
    },
    setParams(params = {}) {
      if (destroyed || params.focusAirport === undefined) return false;
      const airport = byIcao.get(String(params.focusAirport));
      if (!airport || !enabled) return false;
      selectAirport(airport);
      flyTo(airport);
      return true;
    },
    /**
     * Services for the airports layer. Its own airport registrations are
     * remembered, so selecting an airport re-registers it with the latest status.
     */
    wrapServices(base) {
      return {
        ...base,
        registerEntityContext(entity, metadata) {
          if (metadata?.layerId === AIRPORT_STATUS_LAYER_ID && metadata.id)
            contextMeta.set(metadata.id, metadata);
          return base.registerEntityContext(entity, metadata);
        },
        selectEntityContext(entity) {
          const metadata = entity?.__gevContextId
            ? contextMeta.get(entity.__gevContextId)
            : undefined;
          const airport = metadata
            ? byIcao.get(metadata.properties?.icao)
            : undefined;
          if (metadata && airport) {
            base.registerEntityContext(entity, {
              ...metadata,
              properties: {
                ...metadata.properties,
                ...airportContextProperties(airport),
              },
            });
          }
          return base.selectEntityContext(entity);
        },
      };
    },
    /**
     * Attach row controls, focus and polling to the airports layer object.
     * The layer's own enable/disable/destroy still run; the overlay follows them.
     */
    decorate(layer) {
      const { enable, disable, destroy } = layer;
      layer.enable = (nextViewer, options) => {
        controller.enable(nextViewer);
        return enable(nextViewer, options);
      };
      layer.disable = (nextViewer, options) => {
        controller.disable();
        return disable(nextViewer, options);
      };
      layer.destroy = (nextViewer) => {
        controller.destroy();
        return destroy(nextViewer);
      };
      layer.attachShellServices = (shell) =>
        controller.attachShellServices(shell);
      layer.getRowControls = () => controller.getRowControls();
      layer.setRowControlsListener = (value) => controller.setListener(value);
      layer.setParams = (params) => controller.setParams(params);
      return layer;
    },
  };
  return controller;
}
