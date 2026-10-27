import { createApplicationOperations } from './operations.js';
import * as Cesium from 'cesium';
import {
  createApplicationViewer,
  installTrackpadPinchZoom,
} from '../app/viewer.js';
import { registerDataCredits } from '../data/dataCredits.js';
import { configureCreditKeyboardAccess } from '../creditKeyboard.js';
import { MapStackController } from '../mapStackController.js';
import { DEFAULT_MAP_STACK_ID } from '../maps/stackIds.js';
import { readRememberedMapStack } from '../maps/mapStackMemory.js';
import { loadPhotorealisticTileset } from '../mapStartup.js';
import { initLogoGaze } from '../logoGaze.js';
import {
  uninstallRenderGovernor,
  governorRequestRender,
} from '../renderGovernor.js';
import { describeError } from './errors.js';

/** Construct the application globe using the caller's local configuration. */
export async function createApplicationScene({
  requestServices,
  googleApiKey,
  googleTokens = null,
  cesiumToken,
  credits,
  MapController = MapStackController,
  mapOptions = {},
  loaderStatus,
  signal,
  defer,
}) {
  const operations = createApplicationOperations({
    requests: requestServices,
    signal,
  });
  defer(initLogoGaze());
  const previousKey = window.__GOOGLE_MAPS_API_KEY__;
  if (googleApiKey) {
    window.__GOOGLE_MAPS_API_KEY__ = googleApiKey;
    defer(() => {
      if (window.__GOOGLE_MAPS_API_KEY__ !== googleApiKey) return;
      if (previousKey === undefined) delete window.__GOOGLE_MAPS_API_KEY__;
      else window.__GOOGLE_MAPS_API_KEY__ = previousKey;
    });
  }
  loaderStatus.textContent = 'Configuring viewer...';
  // Provider attribution stays visible, including clean-view and recording.
  const creditContainer = document.createElement('div');
  creditContainer.id = 'cesium-credits';
  // Attribution lives in the bottom footer's right-hand slot.
  (document.getElementById('hud-footer-credits') || document.body).appendChild(
    creditContainer,
  );
  defer(() => creditContainer.remove());
  const viewer = createApplicationViewer({
    container: 'cesiumContainer',
    creditContainer,
  });
  defer(() => {
    uninstallRenderGovernor(viewer);
    if (!viewer.isDestroyed()) viewer.destroy();
  });
  defer(installTrackpadPinchZoom(viewer));
  registerDataCredits(viewer, credits);
  configureCreditKeyboardAccess(document);
  // Google 3D is loaded now only when the visitor's remembered stack is 3D.
  // Otherwise it loads on the first selection (see photorealLoader below), so a
  // plain start does not download the photorealistic tiles at all.
  const hasPhotorealCredentials = Boolean(
    googleApiKey || googleTokens || cesiumToken,
  );
  const loadPhotoreal = () =>
    loadPhotorealisticTileset(Cesium, {
      googleApiKey,
      googleTokens,
      cesiumToken,
    });
  const eagerPhotoreal =
    !hasPhotorealCredentials || readRememberedMapStack() === 'photoreal';
  loaderStatus.textContent = eagerPhotoreal
    ? hasPhotorealCredentials
      ? 'Loading Google 3D Tiles...'
      : 'Loading the keyless globe...'
    : 'Loading the map...';
  const photoreal = eagerPhotoreal
    ? await loadPhotoreal()
    : { tileset: null, route: 'osm', errors: [] };
  const tileset = photoreal.tileset;
  // A provider can finish after cancellation; retain ownership of its result.
  defer(() => {
    if (tileset && !tileset.isDestroyed()) {
      if (!viewer.scene.primitives.remove(tileset)) tileset.destroy();
    }
  });
  signal.throwIfAborted();
  if (tileset) {
    viewer.scene.primitives.add(tileset);
    // NOTE: Cesium World Terrain intentionally disabled — conflicts with Google 3D Tiles at high zoom.
    // Google Photorealistic 3D Tiles provide their own terrain/elevation.
    viewer.scene.globe.show = false;
    console.info(`[Init] Google 3D Tiles loaded via ${photoreal.route}.`);
  } else {
    if (photoreal.errors.length) {
      const tileError = photoreal.errors.at(-1);
      console.warn(
        '[Init] Google 3D Tiles unavailable, using the keyless globe:',
        tileError,
      );
      const tileErrorDetail = describeError(tileError);
      loaderStatus.textContent = `Google 3D Tiles unavailable (${tileErrorDetail}). Loading the keyless globe...`;
    }
    viewer.scene.globe.show = true;
  }

  loaderStatus.textContent = 'Initializing systems...';

  const mapStackController = new MapController(viewer, {
    requestRender: governorRequestRender,
    ...mapOptions,
    googleTileset: tileset,
    // Created on the first Google 3D selection, then reused (the controller caches it).
    photorealLoader:
      eagerPhotoreal || !hasPhotorealCredentials
        ? null
        : async () => {
            const loaded = await loadPhotoreal();
            if (!loaded.tileset)
              throw (
                loaded.errors.at(-1) || new Error('Google 3D Tiles unavailable')
              );
            // Cesium's Google helper sets this on the key route; keep it on lazy loads.
            try {
              loaded.tileset.enableCollision = true;
            } catch {
              /* older tileset */
            }
            console.info(
              `[Init] Google 3D Tiles loaded on demand via ${loaded.route}.`,
            );
            return loaded.tileset;
          },
    cesiumToken,
    // Flat OSM streets unless the visitor picked otherwise last time. A
    // shared link's map value is applied later by share restoration and wins.
    initialStack: readRememberedMapStack() || DEFAULT_MAP_STACK_ID,
    // Task 5 (height-datum fix): rebroadcast stack changes as a window
    // CustomEvent so data layers (CCTV per-regime ground resolution) can
    // react without coupling MapStackController to layer modules. Fires on
    // 'switching'/'ready'/'error'; listeners derive the surface regime from
    // live scene state, so intermediate emissions are harmless.
    onChange: (state) => {
      window.dispatchEvent(
        new CustomEvent('gev:map-stack-changed', { detail: state }),
      );
    },
    onError: (message) => console.warn('[MapStack]', message),
  });
  defer(() => mapStackController.destroy());
  // The controller already resolved an unavailable or unknown start (for
  // example Google 3D with no key) to its default, so activate what it chose.
  await mapStackController.setStack(
    mapStackController.getActiveId?.() ?? DEFAULT_MAP_STACK_ID,
    { silent: true },
  );

  signal.throwIfAborted();
  return { viewer, tileset, mapStackController, operations };
}
