import * as Cesium from 'cesium';

/**
 * Camera presets for notable locations.
 * Startup opens on START_VIEW (Egypt), see flyToStartView.
 */
export const CAMERA_PRESETS = {
  austin: {
    destination: Cesium.Cartesian3.fromDegrees(-97.7431, 30.2672, 800),
    orientation: {
      heading: Cesium.Math.toRadians(0),
      pitch: Cesium.Math.toRadians(-35),
      roll: 0.0,
    },
  },
  sf: {
    destination: Cesium.Cartesian3.fromDegrees(-122.4194, 37.7749, 1000),
    orientation: {
      heading: Cesium.Math.toRadians(30),
      pitch: Cesium.Math.toRadians(-30),
      roll: 0.0,
    },
  },
  nyc: {
    destination: Cesium.Cartesian3.fromDegrees(-73.9857, 40.7484, 1200),
    orientation: {
      heading: Cesium.Math.toRadians(-20),
      pitch: Cesium.Math.toRadians(-30),
      roll: 0.0,
    },
  },
};

/**
 * Fly the camera to a preset location with a smooth animation.
 */
export function flyToPreset(viewer, presetName, duration = 3.0) {
  const preset = CAMERA_PRESETS[presetName];
  if (!preset) return;

  viewer.camera.flyTo({
    destination: preset.destination,
    orientation: preset.orientation,
    duration,
    easingFunction: Cesium.EasingFunction.CUBIC_IN_OUT,
  });
}

/**
 * Where the app opens when no share link is present. Straight-down framing
 * over the country at a flat-map scale; reuse this rather than restating it.
 */
export const START_VIEW = Object.freeze({
  name: 'Egypt',
  lat: 26.8,
  lon: 30.8,
  heightM: 2200000,
});

/**
 * Set the startup camera to START_VIEW: north-up and straight down, in one
 * step. There is no fly-in, so the first frame is already the flat map.
 * @returns {Function} Teardown; cancels any flight that may still be running.
 */
export function flyToStartView(viewer) {
  viewer.camera.setView({
    destination: Cesium.Cartesian3.fromDegrees(
      START_VIEW.lon,
      START_VIEW.lat,
      START_VIEW.heightM,
    ),
    orientation: {
      heading: Cesium.Math.toRadians(0),
      pitch: Cesium.Math.toRadians(-90),
      roll: 0.0,
    },
  });
  return () => {
    if (!viewer.isDestroyed()) viewer.camera.cancelFlight();
  };
}

/**
 * Animated return to START_VIEW (Egypt, straight down). This is the home reset:
 * the full-earth pull-out is `flyToGlobeView` in locations.js, kept for the
 * zoom_to_globe tool and the Environmental mission.
 * @param {Cesium.Viewer} viewer
 * @param {{duration?: number, onComplete?: Function, onCancel?: Function}} [options]
 * @returns {{latitude: number, longitude: number, heightM: number}}
 */
export function flyToHomeView(viewer, options = {}) {
  viewer.camera.cancelFlight();
  viewer.camera.flyTo({
    destination: Cesium.Cartesian3.fromDegrees(
      START_VIEW.lon,
      START_VIEW.lat,
      START_VIEW.heightM,
    ),
    orientation: {
      heading: Cesium.Math.toRadians(0),
      pitch: Cesium.Math.toRadians(-90),
      roll: 0.0,
    },
    duration: options.duration > 0 ? options.duration : 2.8,
    easingFunction: Cesium.EasingFunction.CUBIC_IN_OUT,
    complete: options.onComplete,
    cancel: options.onCancel,
  });
  return {
    latitude: START_VIEW.lat,
    longitude: START_VIEW.lon,
    heightM: START_VIEW.heightM,
  };
}
