import test from 'node:test';
import assert from 'node:assert/strict';
import { createSatellitesLayer } from './index.js';
import { isCivil, isMilitary } from '../../data/militarySatellites.js';

// Headless stubs: Cesium's click handler wants a DOM event target.
globalThis.document ??= { addEventListener() {}, removeEventListener() {} };

const tle = (noradId, name) => {
  const n = String(noradId).padStart(5, '0');
  return [
    name,
    `1 ${n}U 98067A   08264.51782528 -.00002182  00000-0 -11606-4 0  2927`,
    `2 ${n}  51.6416 247.4627 0006703 130.5360 325.0288 15.72125391563537`,
    '',
  ].join('\n');
};

const CATALOGUE = {
  stations: tle(25544, 'ISS (ZARYA)'),
  visual: [
    tle(50001, 'OPAQUE SAT'), // on the CelesTrak military list (fixture below)
    tle(50002, 'USA 270'), // programme name
    tle(50004, 'COSMOS 1408 DEB'), // debris: civil even by name
    tle(50005, 'NOAA 19'),
  ].join(''),
  military: tle(50001, 'OPAQUE SAT'),
};

function stubServices() {
  const services = Object.fromEntries(
    ['picking', 'focus', 'readout', 'overlays', 'context', 'render', 'layerState'].map(
      (key) => [key, {}],
    ),
  );
  services.overlays = {
    setOverlayEntries() {},
    setOverlaySourceVisible() {},
    clearOverlaySource() {},
  };
  services.picking = {
    registerPickOwner() {},
    unregisterPickOwner() {},
    resolvePickId: () => null,
    isOwnedByOtherLayer: () => false,
  };
  services.focus = { clearFocusTarget() {}, publishFocusTargetFromCachedPosition() {} };
  services.render = { holdContinuousRender() {}, releaseContinuousRender() {} };
  services.layerState.isExplicitLayerStateOrigin = () => false;
  return services;
}

function stubViewer() {
  const canvas = { addEventListener() {}, removeEventListener() {} };
  return {
    scene: {
      primitives: { add() {}, remove() {} },
      preRender: { addEventListener: () => () => {} },
      canvas,
    },
    trackedEntityChanged: { addEventListener: () => () => {} },
    entities: { add() {}, remove() {} },
  };
}

async function loadLayers() {
  const services = stubServices();
  const source = {
    async readGroup(group) {
      return { ok: true, status: 200, text: CATALOGUE[group] ?? '', stale: false };
    },
  };
  const viewer = stubViewer();
  const civil = createSatellitesLayer({ source, services, filter: isCivil });
  const military = createSatellitesLayer({
    source,
    services,
    id: 'military-satellites',
    name: 'Military Satellites',
    filter: isMilitary,
    groupTag: 'military',
    allowDense: false,
    ownsIssOverlay: false,
  });
  for (const layer of [civil, military]) {
    await layer.init(viewer);
    await layer.update(viewer);
  }
  return { civil, military };
}

test('the civil and military layers partition the catalogue with no overlap', async () => {
  const { civil, military } = await loadLayers();
  const civilIds = civil.getAllPositions(100).map((p) => p.id).sort((a, b) => a - b);
  const militaryIds = military.getAllPositions(100).map((p) => p.id).sort((a, b) => a - b);
  assert.deepEqual(civilIds, [25544, 50004, 50005]);
  assert.deepEqual(militaryIds, [50001, 50002]);
  assert.equal(civilIds.some((id) => militaryIds.includes(id)), false);
});

test('the military layer identifies itself and is drawn as a military class', async () => {
  const { civil, military } = await loadLayers();
  assert.equal(civil.id, 'satellites');
  assert.equal(civil.name, 'Satellites');
  assert.equal(military.id, 'military-satellites');
  assert.equal(military.name, 'Military Satellites');
  const legend = military.getRowControls().legend;
  assert.deepEqual(
    legend.map(({ klass, count }) => [klass, count]),
    [['military', 2]],
  );
  // Only the civil layer offers the DENSE and ISS chips; the military layer has neither.
  assert.deepEqual(military.getRowControls().chips, []);
  assert.deepEqual(
    civil.getRowControls().chips.map(({ id }) => id),
    ['catalog', 'iss-orbit'],
  );
});

test('the military layer refuses the DENSE catalogue mode', async () => {
  const { military } = await loadLayers();
  assert.equal(military.setParams({ catalog: 'dense' }), false);
  assert.equal(military.getParams().catalog, 'core');
});
