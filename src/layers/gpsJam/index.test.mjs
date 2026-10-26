import test from 'node:test';
import assert from 'node:assert/strict';
import { createGpsJamLayer, GPS_JAM_LAYER_ID } from './index.js';
import { normalizeGpsJamSnapshot } from '../../sources/gpsJam.js';
import {
  registerPickOwner,
  unregisterPickOwner,
} from '../../data/pickRegistry.js';
import { getContextStore } from '../../data/contextStore.js';
import { cellId } from './geometry.js';

const REFERENCE = { lat: 56.5, lon: 20.5 };
const raw = (cells) => ({
  generatedAt: 1_780_000_000_000,
  windowHours: 6,
  cellDeg: 1,
  active: true,
  regions: [{ name: 'Baltic', lat: 57, lon: 21, lastPolledAt: 1, ok: true }],
  cells,
  method: 'Share of airborne aircraft broadcasting degraded GPS quality.',
  note: 'Inferred from aircraft GPS-quality broadcasts.',
  source: 'adsb.lol (ODbL)',
});
const SAMPLE = raw([
  {
    lat: 56,
    lon: 20,
    cellDeg: 1,
    aircraft: 52,
    degraded: 7,
    ratio: 0.14,
    level: 'high',
  },
  {
    lat: 55,
    lon: 19,
    cellDeg: 1,
    aircraft: 20,
    degraded: 1,
    ratio: 0.05,
    level: 'medium',
  },
  {
    lat: 40,
    lon: 0,
    cellDeg: 1,
    aircraft: 30,
    degraded: 0,
    ratio: 0,
    level: 'low',
  },
]);

function fakeCesium() {
  class CustomDataSource {
    constructor(name) {
      this.name = name;
      this.show = true;
      this.entities = {
        values: [],
        add(entity) {
          this.values.push(entity);
          return entity;
        },
        removeAll() {
          this.values = [];
        },
      };
    }
  }
  class ScreenSpaceEventHandler {
    constructor(canvas) {
      this.canvas = canvas;
      this.destroyed = false;
      handlers.push(this);
    }
    setInputAction(callback, type) {
      this.click = callback;
      this.type = type;
    }
    destroy() {
      this.destroyed = true;
    }
    isDestroyed() {
      return this.destroyed;
    }
  }
  const handlers = [];
  return {
    handlers,
    cesium: {
      CustomDataSource,
      ScreenSpaceEventHandler,
      ScreenSpaceEventType: { LEFT_CLICK: 'left' },
      HeightReference: { CLAMP_TO_GROUND: 'clamp' },
      Rectangle: {
        fromDegrees: (west, south, east, north) => ({
          west,
          south,
          east,
          north,
        }),
        center: () => ({
          latitude: (REFERENCE.lat * Math.PI) / 180,
          longitude: (REFERENCE.lon * Math.PI) / 180,
        }),
      },
      Cartesian3: {
        fromDegrees: (lon, lat, height) => ({ lon, lat, height }),
        fromDegreesArray: (values) => values,
      },
      Color: { fromCssColorString: (css) => ({ css }) },
      ColorMaterialProperty: class {
        constructor(color) {
          this.color = color;
        }
      },
      Math: {
        toDegrees: (radians) => (radians * 180) / Math.PI,
        toRadians: (degrees) => (degrees * Math.PI) / 180,
      },
      BoundingSphere: class {
        constructor(center, radius) {
          this.center = center;
          this.radius = radius;
        }
      },
      HeadingPitchRange: class {
        constructor(heading, pitch, range) {
          Object.assign(this, { heading, pitch, range });
        }
      },
    },
  };
}

function fakeEvent() {
  const listeners = new Set();
  return {
    listeners,
    addEventListener(fn) {
      listeners.add(fn);
      return () => listeners.delete(fn);
    },
    raise() {
      for (const fn of [...listeners]) fn();
    },
  };
}

function harness({ payloads = [SAMPLE], failWith = null } = {}) {
  const { cesium, handlers } = fakeCesium();
  const moveEnd = fakeEvent();
  const flights = [];
  const removed = [];
  let renders = 0;
  let pickResult;
  const viewer = {
    isDestroyed: () => false,
    dataSources: {
      added: [],
      add(ds) {
        this.added.push(ds);
      },
      remove(ds, destroy) {
        removed.push({ ds, destroy });
      },
    },
    scene: {
      canvas: {},
      requestRender: () => {
        renders += 1;
      },
      pick: () => pickResult,
    },
    camera: {
      heading: 0,
      moveEnd,
      positionCartographic: { latitude: 0, longitude: 0 },
      computeViewRectangle: () => ({}),
      flyToBoundingSphere: (sphere, options) =>
        flights.push({ sphere, options }),
    },
  };
  const timers = [];
  const timerApi = {
    setTimeout(fn, ms) {
      const timer = { fn, ms, cleared: false };
      timers.push(timer);
      return timer;
    },
    clearTimeout(timer) {
      if (timer) timer.cleared = true;
    },
  };
  const calls = [];
  const feed = {
    async getSnapshot(options) {
      calls.push(options);
      if (failWith) throw failWith;
      const body = payloads[Math.min(calls.length - 1, payloads.length - 1)];
      return normalizeGpsJamSnapshot(body, options.windowHours);
    },
  };
  const layer = createGpsJamLayer({
    feed,
    cesium,
    timers: timerApi,
    matchMedia: () => ({ matches: false }),
  });
  return {
    layer,
    viewer,
    handlers,
    moveEnd,
    timers,
    calls,
    flights,
    removed,
    renders: () => renders,
    setPick: (value) => {
      pickResult = value;
    },
  };
}

test('the layer identity matches the registered id, name, icon and source', () => {
  const { layer } = harness();
  assert.equal(layer.id, GPS_JAM_LAYER_ID);
  assert.equal(layer.name, 'GPS Interference');
  assert.equal(layer.icon, '⌖');
  assert.equal(layer.source, 'adsb.lol (inferred)');
  assert.equal(layer.updateInterval, 120_000);
});

test('an enabled sample draws only medium and high cells, centred on the camera', async () => {
  const h = harness();
  h.layer.init(h.viewer);
  h.layer.enable();
  await h.layer.update(h.viewer, {});
  assert.ok(Math.abs(h.calls[0].area.lat - 56.5) < 1e-9);
  assert.ok(Math.abs(h.calls[0].area.lon - 20.5) < 1e-9);
  assert.equal(h.calls[0].windowHours, 6);
  const stats = h.layer.getStats();
  assert.equal(stats.count, 2);
  assert.equal(stats.lowCount, 1);
  assert.equal(stats.error, null);
  assert.equal(stats.source, 'adsb.lol (inferred)');
  // Each drawn cell adds a fill and an outline entity; low cells add nothing.
  assert.equal(h.layer.getRowControls().legend[0].count, 1);
  assert.ok(h.renders() > 0, 'the scene is asked to render');
});

test('row controls describe the window, legend, counts, method and the strongest cells', async () => {
  const h = harness();
  h.layer.init(h.viewer);
  h.layer.enable();
  await h.layer.update(h.viewer, {});
  const controls = h.layer.getRowControls();
  assert.deepEqual(
    controls.chips.map(({ id, label, active, params }) => ({
      id,
      label,
      active,
      params,
    })),
    [
      {
        id: 'window-1',
        label: '1 h',
        active: false,
        params: { windowHours: 1 },
      },
      {
        id: 'window-6',
        label: '6 h',
        active: true,
        params: { windowHours: 6 },
      },
      {
        id: 'window-24',
        label: '24 h',
        active: false,
        params: { windowHours: 24 },
      },
    ],
  );
  assert.deepEqual(
    controls.legend.map(({ label, count }) => [label, count]),
    [
      ['Some interference (2–10%)', 1],
      ['Strong interference (>10%)', 1],
    ],
  );
  assert.equal(
    controls.info,
    '2 affected cells from 102 aircraft sampled · inferred',
  );
  assert.equal(
    controls.infoTitle,
    'Share of airborne aircraft broadcasting degraded GPS quality. Inferred from aircraft GPS-quality broadcasts.',
  );
  assert.deepEqual(
    controls.list.items.map(({ id, lead, text, params }) => ({
      id,
      lead,
      text,
      params,
    })),
    [
      {
        id: cellId(SAMPLE.cells[0]),
        lead: '14%',
        text: 'Baltic · 52 aircraft',
        params: { focusCell: cellId(SAMPLE.cells[0]) },
      },
      {
        id: cellId(SAMPLE.cells[1]),
        lead: '5%',
        text: 'Baltic · 20 aircraft',
        params: { focusCell: cellId(SAMPLE.cells[1]) },
      },
    ],
  );
});

test('changing the window refetches with that window; invalid windows are refused', async () => {
  const h = harness();
  h.layer.init(h.viewer);
  h.layer.enable();
  await h.layer.update(h.viewer, {});
  assert.equal(h.layer.setParams({ windowHours: 24 }), true);
  await new Promise((done) => setImmediate(done));
  assert.equal(h.calls.at(-1).windowHours, 24);
  assert.equal(
    h.layer.getRowControls().chips.find((chip) => chip.active).id,
    'window-24',
  );
  assert.equal(h.layer.setParams({ windowHours: 3 }), false);
});

test('camera moves settle for three seconds before one viewport-centred refresh', async () => {
  const h = harness();
  h.layer.init(h.viewer);
  h.layer.enable();
  h.moveEnd.raise();
  h.moveEnd.raise();
  h.moveEnd.raise();
  const pending = h.timers.filter((timer) => !timer.cleared);
  assert.equal(pending.length, 1, 'only the last move schedules work');
  assert.equal(pending[0].ms, 3000);
  pending[0].fn();
  await new Promise((done) => setImmediate(done));
  assert.equal(h.calls.length, 1);
  assert.ok(h.calls[0].area);
});

test('selecting a cell publishes its context record; a click on empty space clears it', async () => {
  const previous = globalThis.window;
  globalThis.window = new EventTarget();
  try {
    const h = harness();
    h.layer.init(h.viewer);
    h.layer.enable();
    await h.layer.update(h.viewer, {});
    const [click] = h.handlers;
    const key = cellId(SAMPLE.cells[0]);
    h.setPick({ id: { id: `${key}:outline` } });
    click.click({ position: { x: 1, y: 1 } });
    const record = getContextStore().entities.get(key);
    assert.equal(record.layerId, GPS_JAM_LAYER_ID);
    assert.equal(record.label, 'GPS interference high');
    assert.equal(record.source, 'adsb.lol (inferred)');
    assert.equal(record.properties.degradedShare, '14% of 52 aircraft');
    assert.equal(record.properties.cell, '1° × 1°');
    assert.equal(record.properties.window, '6 h');
    assert.equal(getContextStore().selectedEntityId, key);

    h.setPick(undefined);
    click.click({ position: { x: 1, y: 1 } });
    assert.equal(getContextStore().selectedEntityId, null);
  } finally {
    globalThis.window = previous;
  }
});

test('a pick owned by a sibling layer leaves the selection alone', async () => {
  const previous = globalThis.window;
  globalThis.window = new EventTarget();
  registerPickOwner('flights', (id) => id === 'aircraft-1');
  try {
    const h = harness();
    h.layer.init(h.viewer);
    h.layer.enable();
    await h.layer.update(h.viewer, {});
    const [click] = h.handlers;
    h.setPick({ id: { id: cellId(SAMPLE.cells[1]) } });
    click.click({ position: { x: 1, y: 1 } });
    const selected = getContextStore().selectedEntityId;
    assert.equal(selected, cellId(SAMPLE.cells[1]));
    h.setPick({ id: { id: 'aircraft-1' } });
    click.click({ position: { x: 1, y: 1 } });
    assert.equal(getContextStore().selectedEntityId, selected);
  } finally {
    unregisterPickOwner('flights');
    globalThis.window = previous;
  }
});

test('a row focus flies the camera to the cell through the shell navigation facade', async () => {
  const previous = globalThis.window;
  globalThis.window = new EventTarget();
  try {
    const h = harness();
    let navigated = 0;
    h.layer.attachShellServices({
      runNavigation: (navigate) => {
        navigated += 1;
        return navigate();
      },
    });
    h.layer.init(h.viewer);
    h.layer.enable();
    await h.layer.update(h.viewer, {});
    const key = cellId(SAMPLE.cells[0]);
    assert.equal(h.layer.setParams({ focusCell: key }), true);
    assert.equal(navigated, 1);
    assert.equal(h.flights.length, 1);
    assert.equal(h.flights[0].sphere.center.lon, 20.5);
    assert.equal(h.flights[0].sphere.center.lat, 56.5);
    assert.equal(getContextStore().selectedEntityId, key);
    assert.equal(
      h.layer.setParams({ focusCell: 'gps-jam:1:0:0' }),
      false,
      'unknown cells are refused',
    );
    assert.equal(h.layer.setParams({ focusCell: null }), true);
    assert.equal(getContextStore().selectedEntityId, null);
  } finally {
    globalThis.window = previous;
  }
});

test('a failed refresh keeps the last sample and says why in the row', async () => {
  let fail = false;
  const { cesium } = fakeCesium();
  const h = harness();
  const feed = {
    async getSnapshot(options) {
      if (fail) throw new Error('GPS interference HTTP 503');
      return normalizeGpsJamSnapshot(SAMPLE, options.windowHours);
    },
  };
  const layer = createGpsJamLayer({
    feed,
    cesium,
    timers: { setTimeout, clearTimeout },
  });
  layer.init(h.viewer);
  layer.enable();
  await layer.update(h.viewer, {});
  fail = true;
  await layer.update(h.viewer, {});
  assert.equal(layer.getStats().error, 'GPS interference HTTP 503');
  assert.equal(layer.getStats().count, 2, 'the last sample stays on screen');
  assert.equal(
    layer.getRowControls().info,
    '2 affected cells from 102 aircraft sampled · inferred',
  );
});

test('disable releases the scene, the click handler, the camera listener and the pick owner', async () => {
  const previous = globalThis.window;
  globalThis.window = new EventTarget();
  try {
    const h = harness();
    h.layer.init(h.viewer);
    h.layer.enable();
    await h.layer.update(h.viewer, {});
    h.layer.setParams({ focusCell: cellId(SAMPLE.cells[0]) });
    assert.equal(h.moveEnd.listeners.size, 1);
    const [handler] = h.handlers;
    const dataSource = h.viewer.dataSources.added[0];
    assert.equal(dataSource.show, true);

    h.layer.disable();
    assert.equal(h.moveEnd.listeners.size, 0, 'camera listener removed');
    assert.equal(handler.destroyed, true, 'click handler destroyed');
    assert.equal(dataSource.show, false);
    assert.equal(dataSource.entities.values.length, 0, 'cells cleared');
    assert.equal(h.layer.getStats().count, 0);
    assert.equal(getContextStore().selectedEntityId, null);
    assert.equal(
      [...getContextStore().entities.values()].some(
        (record) => record.layerId === GPS_JAM_LAYER_ID,
      ),
      false,
      'context records removed',
    );
    assert.equal(
      h.layer.getRowControls().info,
      'No GPS interference sample yet.',
    );
  } finally {
    globalThis.window = previous;
  }
});

test('a pending settle timer does not refresh after disable, and destroy releases the data source', async () => {
  const h = harness();
  h.layer.init(h.viewer);
  h.layer.enable();
  h.moveEnd.raise();
  const [timer] = h.timers;
  h.layer.disable();
  assert.equal(timer.cleared, true);
  h.layer.destroy();
  assert.equal(h.removed.length, 1);
  assert.equal(
    h.removed[0].destroy,
    true,
    'the data source is destroyed with the layer',
  );
  assert.equal(h.layer.getRowControls(), null, 'a destroyed layer has no row');
  assert.equal(h.layer.setParams({ windowHours: 1 }), false);
  h.layer.destroy();
  assert.equal(h.removed.length, 1, 'destroy is idempotent');
  assert.equal(h.calls.length, 0, 'nothing was fetched after disable');
});

test('a layer without a snapshot source cannot be constructed', () => {
  assert.throws(
    () => createGpsJamLayer({ feed: {} }),
    /requires a snapshot source/,
  );
});
