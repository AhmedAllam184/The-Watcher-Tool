import { cancelCameraArrival } from '../data/cameraArrival.js';
import { createStateChannel } from '../app/stateChannel.js';
import * as Cesium from 'cesium';
import {
  FOCUS_RETURN_DURATION_SEC,
  FOCUS_RETURN_SETTLE_MS,
  classifyNavigationNoun,
  resolveFocusReturnView,
  shouldReturnFromFocus,
  snapshotStraightDownView,
} from './focusReturn.js';
import {
  beginDeferredNavigation,
  reassertNavigationHandoff,
  runExplicitNavigation,
} from '../navigationPolicy.js';

/** Own camera authority generations, pending search UI and tracking handoff. */
export class NavigationController {
  constructor({
    viewer,
    tracking,
    searchInput,
    interruptCameraMotion,
    isCockpitActive,
    clearLocation,
    cancelShareSelection,
    getDataManager,
    stopOrbit,
    showToast,
    cancelOrientation = () => {},
    isTourActive = () =>
      Boolean(
        globalThis.document?.body?.classList?.contains('scene-playback-mode'),
      ),
    schedule = (callback, ms) => globalThis.setTimeout(callback, ms),
    cancelSchedule = (handle) => globalThis.clearTimeout(handle),
    readViewTarget = () => null,
    readSelectedContext = () => null,
  }) {
    Object.assign(this, {
      viewer,
      tracking,
      searchInput,
      interruptCameraMotion,
      isCockpitActive,
      clearLocation,
      cancelShareSelection,
      getDataManager,
      stopOrbit,
      showToast,
      cancelOrientation,
      isTourActive,
      schedule,
      cancelSchedule,
      readViewTarget,
      readSelectedContext,
    });
    this._navigationGeneration = 0;
    // Straight-down view remembered when an object focus began; the camera
    // returns to it when that focus ends. See focusReturn.js.
    this._focusReturnSnapshot = null;
    this._focusReturnTimer = null;
    this._focusReturnExplicit = false;
    this._explicitNavigationDepth = 0;
    this._cameraHandoffs = createStateChannel(() => ({
      generation: this._navigationGeneration,
    }));
    this._activeLocationSearchGeneration = null;
    this._disposed = false;
  }
  _stampNavigation({
    cancelPendingSelection = true,
    clearSearchedLocation = true,
  } = {}) {
    cancelCameraArrival(this.viewer);
    this.cancelOrientation();
    const { flightsLayer, militaryFlightsLayer, satellitesLayer } =
      this.tracking;
    this._navigationGeneration += 1;
    this._cameraHandoffs?.publish();
    // A newer destination owns the camera, so the last free-text search is no
    // longer where we are. DEFERRED navigation opts out here and clears at the
    // reassert seam instead: a geocode that never resolves moves no camera, and
    // a lookup that fails must not blank a readout that is still true.
    if (clearSearchedLocation) this.clearLocation();
    if (cancelPendingSelection) {
      const passivelyClearedShareSelection = this.cancelShareSelection();
      try {
        flightsLayer.cancelPendingTrackingRestore?.();
      } catch {
        /* best effort */
      }
      try {
        militaryFlightsLayer.cancelPendingTrackingRestore?.();
      } catch {
        /* best effort */
      }
      try {
        satellitesLayer.cancelPendingTrackingRestore?.();
      } catch {
        /* best effort */
      }
      // A deliberate destination supersedes share-selected entities that have
      // not arrived yet. Active owners publish their clear when released.
      if (!passivelyClearedShareSelection && !flightsLayer.getTrackedInfo?.()) {
        this.getDataManager()?.setLayerParams(
          'flights',
          {
            selectedFlightsTrackingId: null,
          },
          { origin: 'tool' },
        );
      }
      if (
        !passivelyClearedShareSelection &&
        !militaryFlightsLayer.getTrackedInfo?.()
      ) {
        this.getDataManager()?.setLayerParams(
          'military',
          {
            selectedMilitaryTrackingId: null,
          },
          { origin: 'tool' },
        );
      }
      if (
        !passivelyClearedShareSelection &&
        !satellitesLayer.getTrackedInfo?.()
      ) {
        this.getDataManager()?.setLayerParams(
          'satellites',
          {
            selectedSatTrackingId: null,
          },
          { origin: 'tool' },
        );
      }
    }
    if (this._activeLocationSearchGeneration !== null) {
      this._settleLocationSearchUi(this._activeLocationSearchGeneration);
    }
    return this._navigationGeneration;
  }

  _settleLocationSearchUi(generation) {
    if (this._activeLocationSearchGeneration !== generation) return;
    this._activeLocationSearchGeneration = null;
    this.searchInput?.classList.remove('searching', 'expanded');
    if (this.searchInput) this.searchInput.value = '';
    this.searchInput?.blur();
  }

  _releaseFollowCamera({
    preserveVesselSelection = true,
    preserveCameraFlight = false,
    trackingOrigin = 'tool',
  } = {}) {
    const {
      flightsLayer,
      militaryFlightsLayer,
      satellitesLayer,
      aisLiveVesselsLayer,
      militaryAwarenessLayer,
      rocketLaunchesLayer,
    } = this.tracking;
    let contactSelected = false;
    try {
      contactSelected = Boolean(
        militaryAwarenessLayer.releaseCameraOwnership?.({
          preserveVesselSelection,
          origin: trackingOrigin,
        }),
      );
    } catch {
      try {
        flightsLayer.stopTracking?.({ origin: trackingOrigin });
      } catch {
        /* best-effort release */
      }
      try {
        militaryFlightsLayer.stopTracking?.({ origin: trackingOrigin });
      } catch {
        /* best-effort release */
      }
      if (!preserveVesselSelection) {
        try {
          aisLiveVesselsLayer.clearSelection?.();
        } catch {
          /* best-effort release */
        }
      }
    }
    try {
      satellitesLayer.stopTracking?.({ origin: trackingOrigin });
    } catch {
      /* best-effort release */
    }
    try {
      rocketLaunchesLayer.releaseCameraOwnership?.();
    } catch {
      /* best-effort release */
    }
    this.viewer.trackedEntity = undefined;
    this.interruptCameraMotion('explicit-navigation');
    this.stopOrbit();
    if (!preserveCameraFlight) this.viewer.camera.cancelFlight();
    try {
      this.viewer.camera.lookAtTransform(Cesium.Matrix4.IDENTITY);
    } catch {
      /* teardown race */
    }
    return contactSelected;
  }

  _runExplicitNavigation(noun, navigate, releaseOptions = undefined) {
    if (!this._disposed && !this.isCockpitActive()) {
      if (classifyNavigationNoun(noun) === 'focus') this.noteFocusBegin();
      else this.cancelFocusReturn();
    }
    // The release below ends the previous owner on purpose; its focus-ended
    // signals belong to this navigation, not to an exit.
    this._explicitNavigationDepth += 1;
    try {
      return runExplicitNavigation({
        disposed: this._disposed,
        cockpitActive: this.isCockpitActive(),
        noun,
        showToast: (text) => this.showToast(text),
        stamp: () => this._stampNavigation(),
        release: () => this._releaseFollowCamera(releaseOptions),
        navigate,
      });
    } finally {
      this._explicitNavigationDepth -= 1;
    }
  }

  /** Change the viewing angle without clearing selection or follow ownership. */
  runOrientation(noun, navigate) {
    if (
      !this._disposed &&
      !this.isCockpitActive() &&
      classifyNavigationNoun(noun) === 'focus' &&
      noun !== 'camera'
    )
      this.noteFocusBegin();
    return runExplicitNavigation({
      disposed: this._disposed,
      cockpitActive: this.isCockpitActive(),
      noun,
      showToast: (text) => this.showToast(text),
      stamp: () =>
        this._stampNavigation({
          cancelPendingSelection: false,
          clearSearchedLocation: false,
        }),
      release: () => {
        this.interruptCameraMotion('camera-orientation');
        this.stopOrbit();
        this.viewer.camera.cancelFlight();
      },
      navigate,
    });
  }

  _beginDeferredNavigation(
    noun = 'location',
    { cancelPendingSelection = true } = {},
  ) {
    if (!this._disposed && !this.isCockpitActive()) this.cancelFocusReturn();
    return beginDeferredNavigation({
      disposed: this._disposed,
      cockpitActive: this.isCockpitActive(),
      noun,
      showToast: (text) => this.showToast(text),
      // The searched-location readout survives the STAMP; only a flight that
      // actually starts invalidates it (see the release hook below).
      stamp: () =>
        this._stampNavigation({
          cancelPendingSelection,
          clearSearchedLocation: false,
        }),
    });
  }

  _reassertNavigationHandoff(generation) {
    return reassertNavigationHandoff({
      generation,
      currentGeneration: this._navigationGeneration,
      cockpitActive: this.isCockpitActive(),
      disposed: this._disposed,
      showToast: (text) => this.showToast(text),
      // Reached only once the handoff is granted, immediately before the
      // deferred flight starts — so a lookup that failed, was superseded, or
      // was refused by the cockpit leaves the old readout standing.
      release: () => {
        this.clearLocation();
        return this._releaseFollowCamera();
      },
    });
  }
  /** Subscribe to ownership changes without claiming the camera or exposing mutable state. */
  subscribeCameraHandoff(listener) {
    return this._cameraHandoffs.subscribe(listener, { emitCurrent: false });
  }
  /** Read the camera as the straight-down view it stands for. */
  _readStraightDownView() {
    const camera = this.viewer?.camera;
    const position = camera?.positionCartographic;
    if (!position) return null;
    const toDegrees = Cesium.Math.toDegrees;
    let ground = null;
    let rangeM;
    try {
      const target = this.readViewTarget(this.viewer);
      if (target) {
        const carto = Cesium.Cartographic.fromCartesian(target);
        if (carto) {
          ground = {
            lon: toDegrees(carto.longitude),
            lat: toDegrees(carto.latitude),
          };
          rangeM = Cesium.Cartesian3.distance(camera.positionWC, target);
        }
      }
    } catch {
      /* no ground under the screen centre */
    }
    return {
      camera: {
        lon: toDegrees(position.longitude),
        lat: toDegrees(position.latitude),
        height: position.height,
      },
      pitchDeg: Number.isFinite(camera.pitch)
        ? toDegrees(camera.pitch)
        : undefined,
      ground,
      rangeM,
    };
  }

  /**
   * An object focus (follow, chase or fly-to-object) is starting. Remember the
   * straight-down view the operator is leaving, unless an earlier focus in the
   * same chain already did: switching objects keeps the first view.
   */
  noteFocusBegin() {
    this._cancelPendingFocusReturn();
    if (this._disposed || this._focusReturnSnapshot) return;
    if (this.isCockpitActive() || this.isTourActive()) return;
    const view = this._readStraightDownView();
    this._focusReturnSnapshot = view ? snapshotStraightDownView(view) : null;
  }

  /** A newer place was chosen: forget the remembered view and stay put. */
  cancelFocusReturn() {
    this._cancelPendingFocusReturn();
    this._focusReturnSnapshot = null;
  }

  _cancelPendingFocusReturn() {
    if (this._focusReturnTimer === null) return;
    this.cancelSchedule(this._focusReturnTimer);
    this._focusReturnTimer = null;
  }

  /** Whether an object still holds the camera or the selection. */
  _focusStillHeld({ includeSelection = true } = {}) {
    if (this.viewer?.trackedEntity) return true;
    const { flightsLayer, militaryFlightsLayer, satellitesLayer } =
      this.tracking || {};
    for (const layer of [flightsLayer, militaryFlightsLayer, satellitesLayer]) {
      try {
        if (layer?.getTrackedInfo?.()) return true;
      } catch {
        /* a layer mid-teardown holds nothing */
      }
    }
    if (!includeSelection) return false;
    try {
      return Boolean(this.readSelectedContext());
    } catch {
      return false;
    }
  }

  /**
   * An object focus may have ended (deselected, lost, Escape). Decide after a
   * short settle, so a switch to another object is not mistaken for an exit.
   * @param {{explicit?: boolean}} [options] An explicit exit ignores a static
   * selection that remains; only a follow camera keeps the focus alive.
   */
  noteFocusEnded({ explicit = false } = {}) {
    if (this._disposed || !this._focusReturnSnapshot) return;
    if (this._explicitNavigationDepth > 0) return;
    // An explicit exit stays explicit when a passive signal from the same
    // exit (the layer dropping its follow) lands in the settle window.
    const pendingExplicit =
      this._focusReturnTimer !== null && this._focusReturnExplicit;
    explicit = explicit || pendingExplicit;
    this._cancelPendingFocusReturn();
    this._focusReturnExplicit = explicit;
    const generation = this._navigationGeneration;
    this._focusReturnTimer = this.schedule(() => {
      this._focusReturnTimer = null;
      const camera = this.viewer?.camera;
      const ready = shouldReturnFromFocus({
        disposed: this._disposed,
        snapshot: this._focusReturnSnapshot,
        cockpitActive: this.isCockpitActive(),
        tourActive: this.isTourActive(),
        focusActive: this._focusStillHeld({ includeSelection: !explicit }),
        generationChanged: generation !== this._navigationGeneration,
        // Cesium keeps the running flyTo here; someone else is moving the camera.
        cameraFlying: Boolean(camera?._currentFlight),
      });
      if (!ready) {
        // Cockpit and tours keep the view for their own exit; a newer owner
        // keeps it for the end of its focus.
        return;
      }
      this._flyFocusReturn();
    }, FOCUS_RETURN_SETTLE_MS);
  }

  /**
   * Leave any object focus now and return straight down: to the remembered
   * view when there is one, else over the current ground point. Used by the
   * N shortcut and the details panel's close button.
   * @param {{release?: boolean}} [options] Whether to drop the follow owner.
   * @returns {boolean} Whether the return flight started.
   */
  returnToStraightDownView({ release = true } = {}) {
    if (this._disposed) return false;
    if (this.isCockpitActive()) {
      this.showToast?.('Exit cockpit to return to the map view');
      return false;
    }
    if (!this._focusReturnSnapshot) {
      const view = this._readStraightDownView();
      // Straight down where the operator is looking, at their current zoom.
      this._focusReturnSnapshot = view ? snapshotStraightDownView(view) : null;
    }
    if (!this._focusReturnSnapshot) return false;
    return this._flyFocusReturn({ release });
  }

  /**
   * The operator closed the focus (details panel close). Return only when a
   * focus moved the camera; closing a plain selection leaves the map alone.
   * @returns {boolean} Whether the return flight started.
   */
  exitFocus() {
    if (this._disposed || !this._focusReturnSnapshot) return false;
    return this.returnToStraightDownView({ release: true });
  }

  _flyFocusReturn({ release = false } = {}) {
    const snapshot = this._focusReturnSnapshot;
    this.cancelFocusReturn();
    const current = this._readStraightDownView();
    const view = resolveFocusReturnView(snapshot, current?.ground);
    if (!view) return false;
    this._stampNavigation({
      cancelPendingSelection: false,
      clearSearchedLocation: false,
    });
    // A chase camera stays bolted to its entity's frame until both the
    // tracked entity and the lookAt transform are released; flying first
    // leaves the camera "locked in 3D".
    this._explicitNavigationDepth += 1;
    try {
      this._releaseFollowCamera({ preserveVesselSelection: !release });
    } finally {
      this._explicitNavigationDepth -= 1;
    }
    const camera = this.viewer.camera;
    camera.flyTo({
      destination: Cesium.Cartesian3.fromDegrees(
        view.lon,
        view.lat,
        view.height,
      ),
      orientation: {
        heading: 0,
        pitch: -Cesium.Math.PI_OVER_TWO,
        roll: 0,
      },
      duration: FOCUS_RETURN_DURATION_SEC,
      easingFunction: Cesium.EasingFunction.CUBIC_IN_OUT,
    });
    return true;
  }

  stop() {
    this.cancelFocusReturn();
    cancelCameraArrival(this.viewer);
    this._disposed = true;
    this._cameraHandoffs?.publish();
    this._cameraHandoffs?.destroy();
  }
  destroy() {
    this.stop();
    this._stampNavigation();
  }
}
