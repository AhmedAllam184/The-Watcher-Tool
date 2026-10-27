import assert from 'node:assert/strict';
import test from 'node:test';
import * as Cesium from 'cesium';
import satellitesLayer from './satellites.js';

// The layer registers a keydown listener on the document while enabled.
globalThis.document ??= { addEventListener() {}, removeEventListener() {} };
// Tracking announces its subject on the window; a plain event target is enough.
globalThis.window ??= new EventTarget();

/** A TLE triple under a catalogue number, parseable by the production catalogue path. */
const tleFor = (satnum, name) => [
  name,
  `1 ${satnum}U 98067A   08264.51782528 -.00002182  00000-0 -11606-4 0  2927`,
  `2 ${satnum}  51.6416 247.4627 0006703 130.5360 325.0288 15.72125391563537`,
].join('\n');

const ISS_TLE = tleFor('25544', 'ISS (ZARYA)');
const SAT_TLE = tleFor('33333', 'DRIFTER-1');

/**
 * Viewer stub that records what the layer adds and removes from the scene.
 * Real Cesium primitives are used, so an orbit line is an actual PolylineGeometry.
 */
function recordingViewer() {
  const added = [];
  const removed = [];
  const viewer = {
    entities: new Cesium.EntityCollection(),
    trackedEntity: undefined,
    trackedEntityChanged: { addEventListener: () => () => {} },
    scene: {
      canvas: { addEventListener() {}, removeEventListener() {} },
      frameState: { frameNumber: 1 },
      preRender: { addEventListener: () => () => {} },
      pick: () => undefined,
      primitives: {
        add(primitive) {
          added.push(primitive);
          return primitive;
        },
        remove(primitive) {
          removed.push(primitive);
          return true;
        },
      },
    },
  };
  /** Orbit lines currently in the scene: polylines added and not since removed. */
  const orbitLines = () =>
    added.filter((primitive) => {
      const geometry = Array.isArray(primitive.geometryInstances)
        ? primitive.geometryInstances[0]
        : primitive.geometryInstances;
      return (
        geometry?.geometry instanceof Cesium.PolylineGeometry &&
        !removed.includes(primitive)
      );
    });
  return { viewer, orbitLines };
}

/** Load two satellites through the production catalogue rebuild, with the fetch stubbed. */
async function loadCatalogue(viewer) {
  const realFetch = globalThis.fetch;
  const realLog = console.log;
  const realWarn = console.warn;
  console.log = () => {};
  console.warn = () => {};
  globalThis.fetch = async (url) => ({
    ok: true,
    text: async () =>
      String(url).endsWith('/stations') ? ISS_TLE : String(url).endsWith('/visual') ? SAT_TLE : '',
  });
  try {
    await satellitesLayer.update(viewer);
  } finally {
    globalThis.fetch = realFetch;
    console.log = realLog;
    console.warn = realWarn;
  }
}

test('turning the satellites layer on draws no orbit line at all', async () => {
  const { viewer, orbitLines } = recordingViewer();
  try {
    await satellitesLayer.init(viewer);
    await loadCatalogue(viewer);
    satellitesLayer.enable(viewer);
    assert.equal(orbitLines().length, 0, 'the ISS line is no longer drawn by default');
    assert.equal(satellitesLayer.getParams().showIssOrbit, false);
  } finally {
    satellitesLayer.destroy(viewer);
  }
});

test('selecting a satellite draws one line for it, and deselecting removes it', async () => {
  const { viewer, orbitLines } = recordingViewer();
  try {
    await satellitesLayer.init(viewer);
    await loadCatalogue(viewer);
    satellitesLayer.enable(viewer);
    assert.equal(satellitesLayer.trackById(33333, { origin: 'user' }), true);
    assert.equal(orbitLines().length, 1, 'the selected satellite has its orbit line');
    satellitesLayer.stopTracking({ origin: 'user' });
    assert.equal(orbitLines().length, 0, 'deselecting removes the line');
  } finally {
    satellitesLayer.destroy(viewer);
  }
});

test('switching the layer off removes the selected satellite line', async () => {
  const { viewer, orbitLines } = recordingViewer();
  try {
    await satellitesLayer.init(viewer);
    await loadCatalogue(viewer);
    satellitesLayer.enable(viewer);
    satellitesLayer.trackById(33333, { origin: 'user' });
    assert.equal(orbitLines().length, 1);
    satellitesLayer.disable(viewer);
    assert.equal(orbitLines().length, 0, 'no line survives the layer being turned off');
  } finally {
    satellitesLayer.destroy(viewer);
  }
});

test('the ISS line is opt-in through the Show ISS orbit chip', async () => {
  const { viewer, orbitLines } = recordingViewer();
  try {
    await satellitesLayer.init(viewer);
    await loadCatalogue(viewer);
    satellitesLayer.enable(viewer);
    const chipOf = () =>
      satellitesLayer.getRowControls().chips.find((chip) => chip.id === 'iss-orbit');
    assert.equal(chipOf().active, false);
    assert.equal(chipOf().state, 'idle');
    assert.deepEqual(chipOf().params, { showIssOrbit: true });

    satellitesLayer.setParams(chipOf().params);
    assert.equal(orbitLines().length, 1, 'the chip draws the ISS line');
    assert.equal(chipOf().active, true);
    assert.deepEqual(chipOf().params, { showIssOrbit: false });

    satellitesLayer.setParams({ showIssOrbit: false });
    assert.equal(orbitLines().length, 0, 'the chip removes it again');
  } finally {
    satellitesLayer.destroy(viewer);
  }
});

test('a catalogue refresh keeps the selected satellite line', async () => {
  const { viewer, orbitLines } = recordingViewer();
  try {
    await satellitesLayer.init(viewer);
    await loadCatalogue(viewer);
    satellitesLayer.enable(viewer);
    satellitesLayer.trackById(33333, { origin: 'user' });
    await loadCatalogue(viewer);
    assert.equal(orbitLines().length, 1, 'the rebuild re-draws the line it cleared');
  } finally {
    satellitesLayer.destroy(viewer);
  }
});
