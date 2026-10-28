import assert from 'node:assert/strict';
import test from 'node:test';
import * as Cesium from 'cesium';
import {
  FOCUS_RETURN_DURATION_SEC,
  FOCUS_RETURN_FAR_MIN_M,
  FOCUS_RETURN_MIN_HEIGHT_M,
  FOCUS_RETURN_SETTLE_MS,
  classifyNavigationNoun,
  groundDistanceM,
  isFocusAuthorityReason,
  resolveFocusReturnView,
  shouldReturnFromFocus,
  snapshotStraightDownView,
} from './focusReturn.js';
import { NavigationController } from './navigationController.js';

// ---- pure policy ----------------------------------------------------------

test('a straight-down camera is remembered exactly where it is', () => {
  const view = snapshotStraightDownView({
    camera: { lon: 31.2, lat: 30.05, height: 40_000 },
    pitchDeg: -89.9,
    ground: { lon: 31.21, lat: 30.06 },
    rangeM: 39_000,
  });
  assert.deepEqual(view, { lon: 31.2, lat: 30.05, height: 40_000 });
});

test('a tilted camera is remembered as straight down over its screen-centre ground point', () => {
  const view = snapshotStraightDownView({
    camera: { lon: 31.0, lat: 29.5, height: 8_000 },
    pitchDeg: -35,
    ground: { lon: 31.2, lat: 30.05 },
    rangeM: 14_000,
  });
  assert.deepEqual(view, { lon: 31.2, lat: 30.05, height: 14_000 });
});

test('a tilted camera with no ground under the centre falls back to its own position', () => {
  const view = snapshotStraightDownView({
    camera: { lon: 10, lat: 20, height: 300 },
    pitchDeg: -10,
    ground: null,
  });
  assert.deepEqual(view, {
    lon: 10,
    lat: 20,
    height: FOCUS_RETURN_MIN_HEIGHT_M,
  });
  assert.equal(snapshotStraightDownView({ camera: { lon: NaN } }), null);
  assert.equal(snapshotStraightDownView(), null);
});

test('the return lands on the remembered view while the camera stays nearby', () => {
  const snapshot = { lon: 30.8, lat: 26.8, height: 2_200_000 };
  assert.deepEqual(resolveFocusReturnView(snapshot, { lon: 33, lat: 28 }), {
    ...snapshot,
    fallback: false,
  });
  assert.deepEqual(resolveFocusReturnView(snapshot, null), {
    ...snapshot,
    fallback: false,
  });
});

test('a camera that moved far away straightens where it is, at the remembered height', () => {
  const snapshot = { lon: 31.2, lat: 30.05, height: 20_000 };
  const current = { lon: -0.12, lat: 51.5 }; // London, ~3,500 km from Cairo
  assert.ok(groundDistanceM(snapshot, current) > FOCUS_RETURN_FAR_MIN_M);
  assert.deepEqual(resolveFocusReturnView(snapshot, current), {
    lon: -0.12,
    lat: 51.5,
    height: 20_000,
    fallback: true,
  });
  assert.equal(resolveFocusReturnView(null, current), null);
});

test('object nouns start a focus; places, routes and scenes replace it', () => {
  for (const noun of [
    'vessel',
    'fire',
    'satellite',
    'contact',
    'gps',
    'conflict',
    'airport',
    'selection',
  ])
    assert.equal(classifyNavigationNoun(noun), 'focus', noun);
  for (const noun of ['location', 'route', 'scene', 'photo', undefined])
    assert.equal(classifyNavigationNoun(noun), 'location', String(noun));
  assert.equal(isFocusAuthorityReason('context-vessel-focus'), true);
  assert.equal(isFocusAuthorityReason('embed-view'), false);
});

test('Cockpit, tours, a held focus, a newer navigation and a running flight each veto the return', () => {
  const base = { snapshot: { lon: 0, lat: 0, height: 1e6 } };
  assert.equal(shouldReturnFromFocus(base), true);
  for (const veto of [
    { snapshot: null },
    { disposed: true },
    { cockpitActive: true },
    { tourActive: true },
    { focusActive: true },
    { generationChanged: true },
    { cameraFlying: true },
  ])
    assert.equal(
      shouldReturnFromFocus({ ...base, ...veto }),
      false,
      JSON.stringify(veto),
    );
});

// ---- release-hook wiring --------------------------------------------------

const HOME = Object.freeze({ lon: 31.2, lat: 30.05, height: 60_000 });

function harness({ cockpit = false, tour = false } = {}) {
  const calls = [];
  const timers = [];
  const state = { cockpit, tour, selected: null };
  const camera = {
    pitch: -Cesium.Math.PI_OVER_TWO,
    heading: 0,
    positionCartographic: Cesium.Cartographic.fromDegrees(
      HOME.lon,
      HOME.lat,
      HOME.height,
    ),
    get positionWC() {
      return Cesium.Cartographic.toCartesian(this.positionCartographic);
    },
    cancelFlight: () => calls.push('cancelFlight'),
    lookAtTransform: (matrix) =>
      calls.push(
        Cesium.Matrix4.equals(matrix, Cesium.Matrix4.IDENTITY)
          ? 'lookAtTransform:identity'
          : 'lookAtTransform',
      ),
    flyTo: (options) => calls.push({ flyTo: options }),
    moveTo(lon, lat, height, pitchDeg = -35) {
      this.positionCartographic = Cesium.Cartographic.fromDegrees(
        lon,
        lat,
        height,
      );
      this.pitch = Cesium.Math.toRadians(pitchDeg);
    },
  };
  let tracked;
  const viewer = {
    camera,
    get trackedEntity() {
      return tracked;
    },
    set trackedEntity(value) {
      if (value === undefined && tracked !== undefined)
        calls.push('trackedEntity:released');
      tracked = value;
    },
  };
  const tracker = () => ({
    info: null,
    getTrackedInfo() {
      return this.info;
    },
    stopTracking() {
      if (this.info) calls.push('stopTracking');
      this.info = null;
    },
  });
  const tracking = {
    flightsLayer: tracker(),
    militaryFlightsLayer: tracker(),
    satellitesLayer: tracker(),
    aisLiveVesselsLayer: { clearSelection: () => calls.push('clearVessel') },
    militaryAwarenessLayer: {},
    rocketLaunchesLayer: {},
  };
  // As in the app, the Contact owner releases both aircraft followers.
  tracking.militaryAwarenessLayer.releaseCameraOwnership = () => {
    tracking.flightsLayer.stopTracking();
    tracking.militaryFlightsLayer.stopTracking();
    return false;
  };
  const navigation = new NavigationController({
    viewer,
    tracking,
    searchInput: null,
    interruptCameraMotion() {},
    isCockpitActive: () => state.cockpit,
    isTourActive: () => state.tour,
    clearLocation() {},
    cancelShareSelection: () => false,
    getDataManager: () => null,
    stopOrbit() {},
    showToast: (text) => calls.push({ toast: text }),
    readSelectedContext: () => state.selected,
    // The screen centre sits under the camera in these fixtures.
    readViewTarget: () =>
      Cesium.Cartographic.toCartesian(
        new Cesium.Cartographic(
          camera.positionCartographic.longitude,
          camera.positionCartographic.latitude,
          0,
        ),
      ),
    schedule: (callback, ms) => {
      timers.push({ callback, ms });
      return timers.length;
    },
    cancelSchedule: (handle) => {
      if (timers[handle - 1]) timers[handle - 1].callback = null;
    },
  });
  const flush = () => {
    for (const timer of timers.splice(0)) timer.callback?.();
  };
  const flights = () => calls.filter((call) => call?.flyTo);
  return { navigation, viewer, camera, tracking, calls, state, flush, flights };
}

function assertStraightDownOver(flight, expected) {
  const options = flight.flyTo;
  const carto = Cesium.Cartographic.fromCartesian(options.destination);
  assert.ok(
    Math.abs(Cesium.Math.toDegrees(carto.longitude) - expected.lon) < 1e-6,
  );
  assert.ok(
    Math.abs(Cesium.Math.toDegrees(carto.latitude) - expected.lat) < 1e-6,
  );
  assert.ok(Math.abs(carto.height - expected.height) < 1e-3);
  assert.equal(options.orientation.heading, 0);
  assert.equal(options.orientation.pitch, -Cesium.Math.PI_OVER_TWO);
  assert.equal(options.duration, FOCUS_RETURN_DURATION_SEC);
}

test('following an aircraft and then letting go flies back straight down to where the operator was', () => {
  const h = harness();
  // Map click on an aircraft: the tracker claims the camera.
  h.navigation.noteFocusBegin();
  h.viewer.trackedEntity = { id: 'plane' };
  h.tracking.flightsLayer.info = { icao24: 'abc123' };
  h.camera.moveTo(32, 30.5, 2_000, -20); // chase camera, tilted
  // Escape / empty click: the layer drops the follow.
  h.tracking.flightsLayer.info = null;
  h.viewer.trackedEntity = undefined;
  h.calls.length = 0;
  h.navigation.noteFocusEnded();
  assert.equal(h.flights().length, 0, 'waits out the settle window');
  h.flush();
  assert.equal(h.flights().length, 1);
  assertStraightDownOver(h.flights()[0], HOME);
  // The chase frame is released before the flight starts.
  const lookAt = h.calls.indexOf('lookAtTransform:identity');
  const fly = h.calls.findIndex((call) => call?.flyTo);
  assert.ok(lookAt >= 0 && lookAt < fly);
  // Only once.
  h.navigation.noteFocusEnded();
  h.flush();
  assert.equal(h.flights().length, 1);
});

test('switching from one object to another keeps the first remembered view', () => {
  const h = harness();
  h.navigation.noteFocusBegin();
  h.viewer.trackedEntity = { id: 'first' };
  h.camera.moveTo(35, 31, 3_000);
  // Handoff: the first owner lets go, the second claims within the settle.
  h.viewer.trackedEntity = undefined;
  h.navigation.noteFocusEnded();
  h.navigation.noteFocusBegin();
  h.viewer.trackedEntity = { id: 'second' };
  h.flush();
  assert.equal(h.flights().length, 0, 'a switch is not an exit');
  h.camera.moveTo(36, 31.5, 2_500);
  h.viewer.trackedEntity = undefined;
  h.navigation.noteFocusEnded();
  h.flush();
  assert.equal(h.flights().length, 1);
  assertStraightDownOver(h.flights()[0], HOME);
});

test('a release inside an explicit object flight is not an exit', () => {
  const h = harness();
  h.navigation.noteFocusBegin();
  h.viewer.trackedEntity = { id: 'plane' };
  h.tracking.flightsLayer.info = { icao24: 'abc123' };
  // A Data Layers row (GPS cell) flies elsewhere; its release drops the plane.
  h.navigation._runExplicitNavigation('gps', () => {
    h.navigation.noteFocusEnded();
    return true;
  });
  h.flush();
  assert.equal(h.flights().length, 0);
  // Escape later returns to the view from before the plane.
  h.navigation.noteFocusEnded({ explicit: true });
  h.flush();
  assert.equal(h.flights().length, 1);
  assertStraightDownOver(h.flights()[0], HOME);
});

test('a place search, city pill or Home wins over the return', () => {
  const h = harness();
  h.navigation.noteFocusBegin();
  h.viewer.trackedEntity = { id: 'plane' };
  h.viewer.trackedEntity = undefined;
  h.navigation.noteFocusEnded();
  h.navigation._runExplicitNavigation('location', () => true);
  h.flush();
  assert.equal(h.flights().length, 0);
  // A deferred geocode supersedes it too.
  h.navigation.noteFocusBegin();
  h.navigation._beginDeferredNavigation('location');
  h.navigation.noteFocusEnded();
  h.flush();
  assert.equal(h.flights().length, 0);
});

test('a newer navigation during the settle cancels the pending return', () => {
  const h = harness();
  h.navigation.noteFocusBegin();
  h.navigation.noteFocusEnded();
  h.navigation._stampNavigation();
  h.flush();
  assert.equal(h.flights().length, 0);
});

test('Cockpit and a Guided Tour keep the camera; the view returns after they end', () => {
  const h = harness();
  h.navigation.noteFocusBegin();
  h.state.cockpit = true;
  h.navigation.noteFocusEnded();
  h.flush();
  assert.equal(h.flights().length, 0);
  h.state.cockpit = false;
  h.state.tour = true;
  h.navigation.noteFocusEnded();
  h.flush();
  assert.equal(h.flights().length, 0);
  h.state.tour = false;
  h.navigation.noteFocusEnded();
  h.flush();
  assert.equal(h.flights().length, 1);
  assertStraightDownOver(h.flights()[0], HOME);
});

test('a passive clear waits while another selection is held; an explicit exit does not', () => {
  const h = harness();
  h.navigation.noteFocusBegin();
  h.state.selected = { id: 'ship' };
  h.navigation.noteFocusEnded();
  h.flush();
  assert.equal(h.flights().length, 0);
  h.navigation.noteFocusEnded({ explicit: true });
  // A passive signal from the same exit keeps the exit explicit.
  h.navigation.noteFocusEnded();
  h.flush();
  assert.equal(h.flights().length, 1);
});

test('N straightens the view: back to the remembered view during a focus, in place otherwise', () => {
  const h = harness();
  h.navigation.noteFocusBegin();
  h.viewer.trackedEntity = { id: 'plane' };
  h.tracking.flightsLayer.info = { icao24: 'abc123' };
  h.camera.moveTo(32, 30.5, 2_000, -20);
  assert.equal(h.navigation.returnToStraightDownView(), true);
  assert.ok(h.calls.includes('stopTracking'), 'the follow is dropped');
  assert.ok(h.calls.includes('trackedEntity:released'));
  assertStraightDownOver(h.flights()[0], HOME);

  // No focus: straight down over the point in the middle of the screen.
  h.calls.length = 0;
  h.camera.moveTo(20, 40, 12_000, -40);
  assert.equal(h.navigation.returnToStraightDownView(), true);
  assertStraightDownOver(h.flights()[0], { lon: 20, lat: 40, height: 12_000 });

  // Closing the details of a plain selection leaves the map alone.
  h.calls.length = 0;
  assert.equal(h.navigation.exitFocus(), false);
  assert.equal(h.flights().length, 0);

  // Cockpit refuses with a toast.
  h.state.cockpit = true;
  assert.equal(h.navigation.returnToStraightDownView(), false);
  assert.deepEqual(h.calls.at(-1), {
    toast: 'Exit cockpit to return to the map view',
  });
});

test('teardown drops the remembered view and any pending return', () => {
  const h = harness();
  h.navigation.noteFocusBegin();
  h.navigation.noteFocusEnded();
  h.navigation.stop();
  h.flush();
  assert.equal(h.flights().length, 0);
  assert.equal(FOCUS_RETURN_SETTLE_MS > 0, true);
});
