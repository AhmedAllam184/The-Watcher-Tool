import test from 'node:test';
import assert from 'node:assert/strict';
import { createAirportStatusOverlay } from './overlay.js';
import { normalizeAirportStatus } from '../../sources/airportStatus.js';

const RUH = {
  icao: 'OERK',
  iata: 'RUH',
  name: 'King Khalid International Airport',
  city: 'Riyadh',
  lat: 24.9576,
  lon: 46.6988,
};
const DXB = {
  icao: 'OMDB',
  iata: 'DXB',
  name: 'Dubai International Airport',
  city: 'Dubai',
  lat: 25.2532,
  lon: 55.3657,
};
const LHR = {
  icao: 'EGLL',
  iata: 'LHR',
  name: 'London Heathrow Airport',
  city: 'London',
  lat: 51.47,
  lon: -0.4543,
};
const JFK = {
  icao: 'KJFK',
  iata: 'JFK',
  name: 'John F Kennedy International Airport',
  city: 'New York',
  lat: 40.6413,
  lon: -73.7781,
};

/** Minimal stand-ins for the Cesium classes the overlay constructs. */
function fakeCesium() {
  class PointPrimitiveCollection {
    constructor() {
      this.points = [];
      this.destroyed = false;
    }
    add(point) {
      this.points.push(point);
      return point;
    }
    removeAll() {
      this.points = [];
    }
    isDestroyed() {
      return this.destroyed;
    }
    destroy() {
      this.destroyed = true;
    }
  }
  return {
    PointPrimitiveCollection,
    Cartesian3: { fromDegrees: (lon, lat, height) => ({ lon, lat, height }) },
    Color: { fromCssColorString: (css) => ({ css }) },
    BoundingSphere: class {
      constructor(centre, radius) {
        Object.assign(this, { centre, radius });
      }
    },
    HeadingPitchRange: class {
      constructor(heading, pitch, range) {
        Object.assign(this, { heading, pitch, range });
      }
    },
    Math: {
      toRadians: (deg) => (deg * Math.PI) / 180,
      toDegrees: (rad) => (rad * 180) / Math.PI,
    },
  };
}

const rad = (deg) => (deg * Math.PI) / 180;

function fakeViewer() {
  const flights = [];
  const moveListeners = [];
  const primitives = {
    list: [],
    add(item) {
      this.list.push(item);
    },
    remove(item) {
      this.list = this.list.filter((other) => other !== item);
    },
  };
  return {
    flights,
    moveListeners,
    scene: { primitives },
    camera: {
      heading: 0,
      computeViewRectangle: () => ({
        west: rad(44),
        south: rad(20),
        east: rad(60),
        north: rad(35),
      }),
      flyToBoundingSphere: (...args) => flights.push(args),
      moveEnd: {
        addEventListener(fn) {
          moveListeners.push(fn);
          return () => moveListeners.splice(moveListeners.indexOf(fn), 1);
        },
      },
    },
  };
}

/** Fake timers recording the interval so the test can fire it. */
function fakeTimers() {
  const intervals = [];
  return {
    intervals,
    setInterval(fn, ms) {
      const id = { fn, ms, cleared: false };
      intervals.push(id);
      return id;
    },
    clearInterval(id) {
      if (id) id.cleared = true;
    },
    setTimeout(fn) {
      return { fn };
    },
    clearTimeout() {},
  };
}

const STATUS = normalizeAirportStatus({
  generatedAt: 1,
  method: 'method',
  note: 'note',
  airports: [
    {
      ...RUH,
      holdingReliable: true,
      lastPolledAt: 1,
      aircraftNearby: 9,
      holding: 4,
      holdingCallsigns: ['SVA1', 'SVA2', 'SVA3', 'SVA4'],
      degradedGps: 0,
      judged: 0,
      degradedShare: null,
      level: 'disrupted',
      reasons: ['4 aircraft holding'],
    },
    {
      ...DXB,
      holdingReliable: true,
      level: 'normal',
      reasons: [],
      holding: 0,
      holdingCallsigns: [],
    },
    {
      ...JFK,
      holdingReliable: true,
      level: 'watch',
      reasons: ['1 aircraft holding'],
      holding: 1,
      holdingCallsigns: ['DAL5'],
    },
  ],
});

function setup({ failSource = null, services = {} } = {}) {
  const cesium = fakeCesium();
  const viewer = fakeViewer();
  const timers = fakeTimers();
  const calls = [];
  const source = {
    async getStatus(args) {
      calls.push(args);
      if (failSource) throw new Error(failSource);
      return STATUS;
    },
  };
  const records = new Map();
  const selected = [];
  const base = {
    registerEntityContext(entity, metadata) {
      entity.__gevContextId = metadata.id;
      records.set(metadata.id, { entity, metadata });
    },
    selectEntityContext(entity) {
      selected.push(entity);
    },
    ...services,
  };
  let renders = 0;
  const overlay = createAirportStatusOverlay({
    source,
    cesium,
    timers,
    loadAirports: async () => [RUH, DXB, LHR, JFK],
    services: { ...base, governorRequestRender: () => (renders += 1) },
  });
  return {
    overlay,
    viewer,
    timers,
    calls,
    records,
    selected,
    cesium,
    get renders() {
      return renders;
    },
  };
}

/** Let the overlay's async refresh settle. */
async function settle() {
  for (let i = 0; i < 5; i++)
    await new Promise((resolve) => setImmediate(resolve));
}

test('enabling polls with the viewed airports and draws rings only for affected ones', async () => {
  const env = setup();
  env.overlay.enable(env.viewer);
  await settle();

  assert.equal(env.calls.length, 1);
  assert.deepEqual(env.calls[0].codes.sort(), ['OERK', 'OMDB']);
  const rings = env.viewer.scene.primitives.list[0].points;
  assert.equal(rings.length, 2, 'RUH disrupted and JFK watch');
  const outline = rings.map((ring) => ring.outlineColor.css).sort();
  assert.deepEqual(outline, ['#f87171', '#fbbf24'].sort());
  assert.equal(rings[0].pixelSize, 22);
  assert.equal(rings[0].disableDepthTestDistance, Number.POSITIVE_INFINITY);
  assert.equal(env.timers.intervals[0].ms, 60_000, 'polls every 60 s');
});

test('row controls give legend counts, the monitored total and the affected list', async () => {
  const env = setup();
  env.overlay.enable(env.viewer);
  await settle();

  const rows = env.overlay.getRowControls();
  assert.deepEqual(
    rows.legend.map((item) => [item.label, item.count]),
    [
      ['Disrupted', 1],
      ['Watch', 1],
    ],
  );
  assert.equal(rows.info, '3 airports monitored · inferred');
  assert.match(rows.infoTitle, /note/);
  assert.deepEqual(
    rows.list.items.map((item) => [item.lead, item.params.focusAirport]),
    [
      ['DISRUPTED', 'OERK'],
      ['WATCH', 'KJFK'],
    ],
  );
});

test('focusing an airport selects it with its status and flies the camera there', async () => {
  const env = setup();
  env.overlay.enable(env.viewer);
  await settle();

  assert.equal(env.overlay.setParams({ focusAirport: 'NOPE' }), false);
  assert.equal(env.overlay.setParams({ focusAirport: 'OERK' }), true);
  assert.equal(env.selected.length, 1);
  const record = env.records.get('airport-status:OERK').metadata;
  assert.equal(record.layerId, 'local-airports');
  assert.equal(record.properties.status, 'disrupted (inferred)');
  assert.equal(record.properties.holding, 4);
  assert.equal(record.properties.reasons, '4 aircraft holding');
  assert.equal(env.viewer.flights.length, 1);
});

test('selecting an airport from the layer adds its status to the context', async () => {
  const env = setup();
  const sets = [];
  const base = {
    registerEntityContext(entity, metadata) {
      entity.__gevContextId = metadata.id;
      sets.push(metadata);
    },
    selectEntityContext() {},
  };
  const wrapped = env.overlay.wrapServices(base);
  const entity = {};
  wrapped.registerEntityContext(entity, {
    id: 'local-airports:7',
    layerId: 'local-airports',
    properties: { icao: 'OERK', name: 'King Khalid' },
  });
  env.overlay.enable(env.viewer);
  await settle();
  wrapped.selectEntityContext(entity);
  const enriched = sets.at(-1);
  assert.equal(enriched.id, 'local-airports:7');
  assert.equal(enriched.properties.name, 'King Khalid');
  assert.equal(enriched.properties.status, 'disrupted (inferred)');
});

test('disabling stops polling, removes the rings and clears the row', async () => {
  const env = setup();
  env.overlay.enable(env.viewer);
  await settle();
  env.overlay.disable();

  assert.equal(env.timers.intervals[0].cleared, true);
  assert.deepEqual(env.viewer.scene.primitives.list, []);
  assert.equal(env.viewer.camera.moveEnd.addEventListener.length, 1);
  assert.equal(env.overlay.getRowControls().info, 'No airport status yet.');
});

test('a failing request keeps the row honest', async () => {
  const env = setup({ failSource: 'boom' });
  env.overlay.enable(env.viewer);
  await settle();
  assert.equal(
    env.overlay.getRowControls().info,
    'Airport status unavailable: boom.',
  );
});

test('the layer decorator follows enable and disable and exposes the row', async () => {
  const env = setup();
  const layer = {
    enable() {},
    disable() {},
    destroy() {},
  };
  env.overlay.decorate(layer);
  await layer.enable(env.viewer, { signal: undefined });
  await settle();
  assert.ok(layer.getRowControls().legend);
  assert.equal(layer.setParams({ focusAirport: 'OERK' }), true);
  layer.disable(env.viewer);
  assert.equal(env.timers.intervals[0].cleared, true);
});
