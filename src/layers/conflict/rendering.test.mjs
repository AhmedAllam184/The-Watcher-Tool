import test from 'node:test';
import assert from 'node:assert/strict';
import { createConflictRendering } from './rendering.js';
import { clusterEvents } from './geometry.js';

class FakePointCollection {
  constructor() {
    this.points = [];
    this.show = true;
  }
  add(options) {
    this.points.push(options);
    return options;
  }
  removeAll() {
    this.points = [];
  }
}

function fakeCesium() {
  return {
    PointPrimitiveCollection: FakePointCollection,
    Cartesian3: { fromDegrees: (lon, lat, height) => ({ lon, lat, height }) },
    Color: {
      fromCssColorString: (css) => ({
        css,
        withAlpha(alpha) {
          return { css, alpha };
        },
      }),
    },
  };
}

function fakeViewer({ destroyed = false } = {}) {
  const primitives = {
    items: [],
    add(item) {
      this.items.push(item);
    },
    remove(item) {
      this.items = this.items.filter((entry) => entry !== item);
    },
  };
  let renders = 0;
  return {
    primitives,
    renders: () => renders,
    isDestroyed: () => destroyed,
    scene: {
      primitives,
      requestRender: () => {
        renders += 1;
      },
    },
  };
}

const EVENTS = [
  { id: 'acled:1', lat: 35.2, lon: 40.1, type: 'Battles', fatalities: 3 },
  {
    id: 'acled:2',
    lat: 35.7,
    lon: 40.9,
    type: 'Violence against civilians',
    fatalities: 0,
  },
];

test('events are drawn as points above terrain, coloured by class and sized by severity', () => {
  const viewer = fakeViewer();
  const rendering = createConflictRendering({ viewer, cesium: fakeCesium() });
  assert.equal(
    viewer.primitives.items.length,
    1,
    'one collection in the scene',
  );
  rendering.setPoints({ events: EVENTS, nextMode: 'events' });
  const [first, second] = viewer.primitives.items[0].points;
  assert.equal(first.id, 'acled:1');
  assert.equal(first.color.css, '#ef4444');
  assert.equal(first.disableDepthTestDistance, Number.POSITIVE_INFINITY);
  assert.ok(first.pixelSize > second.pixelSize);
  assert.equal(second.color.css, '#a855f7');
  assert.equal(rendering.count, 2);
  assert.equal(rendering.mode, 'events');
  assert.ok(viewer.renders() > 0, 'the scene is asked to redraw');
});

test('clusters replace events, carry their count size, and cannot be selected as events', () => {
  const viewer = fakeViewer();
  const rendering = createConflictRendering({ viewer, cesium: fakeCesium() });
  const clusters = clusterEvents(EVENTS);
  rendering.setPoints({ clusters, nextMode: 'clusters' });
  const points = viewer.primitives.items[0].points;
  assert.equal(clusters.length, 1, 'both events share one whole-degree cell');
  assert.equal(points.length, 1);
  assert.ok(points[0].pixelSize >= 10);
  assert.equal(points[0].id, clusters[0].id);
  assert.equal(rendering.mode, 'clusters');
  assert.equal(rendering.eventFor(clusters[0].id), null);
  assert.equal(rendering.ownsPickId(clusters[0].id), true);
});

test('picking resolves events only, and unowned ids belong to nobody here', () => {
  const viewer = fakeViewer();
  const rendering = createConflictRendering({ viewer, cesium: fakeCesium() });
  rendering.setPoints({ events: EVENTS, nextMode: 'events' });
  assert.equal(rendering.pickEvent({ id: 'acled:1' }), 'acled:1');
  assert.equal(
    rendering.pickEvent({ primitive: { id: 'acled:2' } }),
    'acled:2',
  );
  assert.equal(rendering.pickEvent({ id: 'flight-1' }), null);
  assert.equal(rendering.pickEvent(undefined), null);
  assert.equal(rendering.ownsPickId('acled:1'), true);
  assert.equal(rendering.ownsPickId('flight-1'), false);
});

test('visibility, clearing and destruction leave the scene in order', () => {
  const viewer = fakeViewer();
  const rendering = createConflictRendering({ viewer, cesium: fakeCesium() });
  rendering.setPoints({ events: EVENTS, nextMode: 'events' });
  rendering.setVisible(true);
  assert.equal(viewer.primitives.items[0].show, true);
  rendering.clear();
  assert.equal(rendering.count, 0);
  rendering.destroy();
  assert.deepEqual(viewer.primitives.items, []);
  rendering.setPoints({ events: EVENTS, nextMode: 'events' });
  assert.equal(rendering.count, 0, 'a destroyed renderer draws nothing');
});
