import test from 'node:test';
import assert from 'node:assert/strict';
import { createConflictLayer, CONFLICT_LAYER_ID } from './index.js';
import { normalizeConflictSnapshot } from '../../sources/conflict.js';
import { getContextStore } from '../../data/contextStore.js';

const CLOSE_M = 500_000;
const FAR_M = 3_000_000;

const ACLED_PAYLOAD = {
  generatedAt: 1_780_000_000_000,
  source: 'acled',
  verified: true,
  days: 1,
  note: 'Verified ACLED events.',
  method: 'ACLED battles and explosions.',
  fetchedAt: 1_779_999_000_000,
  events: [
    {
      id: 'acled:1',
      lat: 35.2,
      lon: 40.1,
      date: '2026-10-26',
      type: 'Battles',
      subType: 'Armed clash',
      fatalities: 3,
      actors: ['Militia A'],
      location: 'Deir ez-Zor',
      country: 'Syria',
      url: 'https://example.test/story',
    },
    {
      id: 'acled:2',
      lat: 35.7,
      lon: 40.9,
      date: '2026-10-26',
      type: 'Explosions/Remote violence',
      fatalities: 12,
      actors: [],
      location: 'Idlib',
      country: 'Syria',
    },
    {
      id: 'acled:3',
      lat: -33.9,
      lon: 151.2,
      date: '2026-10-25',
      type: 'Violence against civilians',
      fatalities: 0,
      actors: [],
      location: 'Sydney',
      country: 'Australia',
    },
  ],
};

const GDELT_PAYLOAD = {
  source: 'gdelt',
  days: 1,
  note: 'Locations of news reports about fighting (GDELT), not verified events; one point can bundle many articles.',
  method: 'GDELT points.',
  events: [
    {
      id: 'gdelt:0',
      lat: 31.35,
      lon: 34.31,
      type: 'News report',
      articles: 4,
      location: 'Khan Younis',
      title: 'Strikes',
    },
  ],
};

function fakeCesium() {
  return {
    Cartesian3: {
      fromDegrees: (lon, lat, height) => ({ lon, lat, height }),
    },
    Math: {
      toDegrees: (radians) => (radians * 180) / Math.PI,
      toRadians: (degrees) => (degrees * Math.PI) / 180,
    },
    BoundingSphere: class {
      constructor(center, radius) {
        Object.assign(this, { center, radius });
      }
    },
    HeadingPitchRange: class {
      constructor(heading, pitch, range) {
        Object.assign(this, { heading, pitch, range });
      }
    },
  };
}

function fakeEvent() {
  const listeners = new Set();
  return {
    addEventListener(fn) {
      listeners.add(fn);
      return () => listeners.delete(fn);
    },
    raise() {
      for (const fn of [...listeners]) fn();
    },
  };
}

/** Returns queued snapshots, or throws the queued Error; every call's options are recorded. */
function feedFrom(queue) {
  const calls = [];
  return {
    calls,
    async getSnapshot(options) {
      calls.push(options);
      const next = queue.shift();
      if (next instanceof Error) throw next;
      return normalizeConflictSnapshot(next, options.days);
    },
  };
}

function harness({ queue = [ACLED_PAYLOAD], navigation = false } = {}) {
  const previousWindow = globalThis.window;
  globalThis.window = new EventTarget();
  const feed = feedFrom(queue);
  const moveEnd = fakeEvent();
  const flights = [];
  const timers = [];
  const overlay = { entries: [], visible: null, cleared: 0, calls: [] };
  const rendering = {
    setVisible: (visible) => (rendering.visible = visible),
    setCalls: [],
    setPoints(args) {
      rendering.setCalls.push(args);
      rendering.nextMode = args.nextMode;
    },
    eventFor: (id) =>
      rendering.events?.find((event) => event.id === id) ?? null,
    pickEvent: () => null,
    ownsPickId: () => false,
    clear() {
      rendering.cleared = (rendering.cleared ?? 0) + 1;
    },
    destroy() {
      rendering.destroyed = true;
    },
    visible: false,
  };
  const viewer = {
    isDestroyed: () => false,
    scene: { canvas: null, requestRender() {}, pick: () => undefined },
    camera: {
      heading: 0,
      moveEnd,
      positionCartographic: { height: CLOSE_M },
      computeViewRectangle: () => ({
        west: 0.6,
        south: 0.5,
        east: 0.7,
        north: 0.8,
      }),
      flyToBoundingSphere: (sphere, options) =>
        flights.push({ sphere, options }),
    },
  };
  const layer = createConflictLayer({
    feed,
    cesium: fakeCesium(),
    createRendering: ({ viewer: v }) => {
      rendering.viewer = v;
      return rendering;
    },
    timers: {
      setTimeout(fn, ms) {
        const timer = { fn, ms, cleared: false };
        timers.push(timer);
        return timer;
      },
      clearTimeout(timer) {
        if (timer) timer.cleared = true;
      },
    },
    matchMedia: () => ({ matches: false }),
    overlayHost: {
      setEntries(id, entries, options) {
        overlay.entries = entries;
        overlay.calls.push({ id, options });
      },
      setVisible(id, visible) {
        overlay.visible = visible;
      },
      clearSource() {
        overlay.cleared += 1;
      },
    },
  });
  layer.init(viewer);
  if (navigation)
    layer.attachShellServices({
      runNavigation: (fly) => {
        navigation.calls.push('navigate');
        fly();
      },
    });
  return {
    layer,
    feed,
    rendering,
    overlay,
    viewer,
    flights,
    timers,
    moveEnd,
    restore() {
      globalThis.window = previousWindow;
    },
  };
}

test('a layer needs a snapshot source, and it refreshes on a 15 min cadence', () => {
  assert.throws(() => createConflictLayer({}), /requires a snapshot source/);
  const h = harness();
  try {
    assert.equal(h.layer.id, CONFLICT_LAYER_ID);
    assert.equal(h.layer.name, 'Conflict Events');
    assert.equal(h.layer.updateInterval, 15 * 60_000);
  } finally {
    h.restore();
  }
});

test('enabling and updating fetches the window and the viewed box, then draws the events', async () => {
  const h = harness();
  try {
    h.layer.enable();
    assert.equal(h.rendering.visible, true);
    await h.layer.update(h.viewer);
    const [call] = h.feed.calls;
    assert.equal(call.days, 1);
    assert.deepEqual(call.bbox, {
      west: (0.6 * 180) / Math.PI,
      south: (0.5 * 180) / Math.PI,
      east: (0.7 * 180) / Math.PI,
      north: (0.8 * 180) / Math.PI,
    });
    assert.equal(h.rendering.setCalls.at(-1).nextMode, 'events');
    assert.equal(h.rendering.setCalls.at(-1).events.length, 3);

    const controls = h.layer.getRowControls();
    assert.equal(controls.info, '3 events · ACLED (verified)');
    assert.equal(
      controls.infoTitle,
      'Verified ACLED events. ACLED battles and explosions.',
    );
    assert.deepEqual(
      controls.legend.map(({ count }) => count),
      [1, 1, 1],
      'explosions, battles and civilians',
    );
    assert.deepEqual(
      controls.chips.map(({ id, active }) => [id, active]),
      [
        ['days-1', true],
        ['days-7', false],
      ],
    );
    assert.equal(
      controls.list.items[0].params.focusEvent,
      'acled:2',
      'most severe first',
    );
    assert.equal(h.layer.getStats().source, 'ACLED');
    assert.equal(h.layer.getStats().count, 3);
  } finally {
    h.layer.disable();
    h.restore();
  }
});

test('a GDELT-only snapshot is labelled unverified and names the ACLED key hint', async () => {
  const h = harness({ queue: [GDELT_PAYLOAD] });
  try {
    h.layer.enable();
    await h.layer.update(h.viewer);
    const controls = h.layer.getRowControls();
    assert.equal(
      controls.info,
      '1 event · GDELT news reports (unverified). Add a free ACLED key for verified data',
    );
    assert.equal(h.layer.getStats().source, 'ACLED or GDELT news reports');
  } finally {
    h.layer.disable();
    h.restore();
  }
});

test('changing the window refetches while enabled and rejects unsupported windows', async () => {
  const h = harness({ queue: [ACLED_PAYLOAD, { ...ACLED_PAYLOAD, days: 7 }] });
  try {
    h.layer.enable();
    await h.layer.update(h.viewer);
    assert.equal(h.layer.setParams({ days: 3 }), false);
    assert.equal(h.layer.setParams({ days: 7 }), true);
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(h.feed.calls.at(-1).days, 7);
    assert.equal(h.layer.getRowControls().chips[1].active, true);
  } finally {
    h.layer.disable();
    h.restore();
  }
});

test('a high camera aggregates events into labelled cells, and a descent restores points', async () => {
  const h = harness();
  try {
    h.layer.enable();
    await h.layer.update(h.viewer);
    h.viewer.camera.positionCartographic.height = FAR_M;
    h.moveEnd.raise();
    assert.equal(h.rendering.nextMode, 'clusters');
    const clusterEntries = h.overlay.entries;
    assert.deepEqual(clusterEntries.map((entry) => entry.title).sort(), [
      '1',
      '2',
    ]);
    assert.equal(h.overlay.visible, true);

    h.viewer.camera.positionCartographic.height = CLOSE_M;
    h.moveEnd.raise();
    assert.equal(h.rendering.nextMode, 'events');
    assert.equal(h.overlay.cleared >= 1, true);
    assert.equal(h.overlay.visible, false);
  } finally {
    h.layer.disable();
    h.restore();
  }
});

test('selecting an event registers its context and flies to it through the shell', async () => {
  const navigation = { calls: [] };
  const h = harness({ navigation });
  try {
    h.layer.enable();
    await h.layer.update(h.viewer);
    const accepted = h.layer.setParams({ focusEvent: 'acled:1' });
    assert.equal(accepted, true);
    assert.deepEqual(navigation.calls, ['navigate']);
    assert.equal(h.flights.length, 1);
    assert.equal(h.flights[0].options.offset.range, 400_000);
    const record = getContextStore().entities.get('acled:1');
    assert.equal(record.label, 'Armed clash · Deir ez-Zor');
    assert.equal(record.properties.verified, 'Yes (ACLED)');
    assert.equal(record.properties.link, 'https://example.test/story');
    assert.equal(record.properties.fatalities, '3');
  } finally {
    h.layer.disable();
    h.restore();
  }
});

test('an unknown event is rejected, and clearing removes the selection', async () => {
  const h = harness();
  try {
    h.layer.enable();
    await h.layer.update(h.viewer);
    assert.equal(h.layer.setParams({ focusEvent: 'nope' }), false);
    assert.equal(h.layer.setParams({ focusEvent: 'acled:2' }), true);
    assert.equal(h.layer.setParams({ clear: true }), true);
  } finally {
    h.layer.disable();
    h.restore();
  }
});

test('a failed refresh keeps the last good sample and states the failure', async () => {
  const h = harness({
    queue: [ACLED_PAYLOAD, new Error('Conflict events HTTP 503')],
  });
  try {
    h.layer.enable();
    await h.layer.update(h.viewer);
    await h.layer.update(h.viewer);
    const stats = h.layer.getStats();
    assert.equal(stats.error, 'Conflict events HTTP 503; retrying in 5 min');
    assert.equal(stats.count, 3, 'the last good sample stays on screen');
    assert.equal(h.layer.getRowControls().info, '3 events · ACLED (verified)');
    assert.match(
      h.layer.getRowControls().info,
      /^3 events/,
      'the sample stays readable',
    );
  } finally {
    h.layer.disable();
    h.restore();
  }
});

test('disabling clears the points, the labels and the context, and the row reports no sample', async () => {
  const h = harness();
  try {
    h.layer.enable();
    await h.layer.update(h.viewer);
    h.layer.disable();
    assert.equal(h.rendering.visible, false);
    assert.equal(h.overlay.visible, false);
    assert.equal(h.layer.getStats().count, 0);
    assert.equal(
      h.layer.getRowControls().info,
      'No conflict event sample yet.',
    );
    assert.equal(h.layer.getStats().empty, false);
  } finally {
    h.restore();
  }
});

test('a destroyed layer ignores later refreshes', async () => {
  const h = harness();
  try {
    h.layer.enable();
    h.layer.destroy();
    assert.equal(h.layer.getRowControls(), null);
    assert.equal(h.layer.setParams({ days: 7 }), false);
    await h.layer.update(h.viewer);
    assert.equal(h.feed.calls.length, 0);
  } finally {
    h.restore();
  }
});

const pendingTimers = (h) => h.timers.filter((timer) => !timer.cleared);

/** Let a timer's async refresh settle. */
const settle = () => new Promise((resolve) => setImmediate(resolve));

test('the legend lists the three classes, in order, with their labels', async () => {
  const h = harness();
  try {
    h.layer.enable();
    await h.layer.update(h.viewer);
    assert.deepEqual(
      h.layer.getRowControls().legend.map(({ label }) => label),
      [
        'Airstrikes / bombings',
        'Fighting / clashes',
        'Violence against people',
      ],
    );
  } finally {
    h.layer.disable();
    h.restore();
  }
});

test('a failed refresh shows its reason, retries after 5 min, and clears the failure when the retry works', async () => {
  const h = harness({
    queue: [
      ACLED_PAYLOAD,
      new Error('GDELT HTTP 429 (rate limited)'),
      ACLED_PAYLOAD,
    ],
  });
  try {
    h.layer.enable();
    await h.layer.update(h.viewer);
    await h.layer.update(h.viewer);
    assert.equal(
      h.layer.getStats().error,
      'GDELT HTTP 429 (rate limited); retrying in 5 min',
    );
    assert.equal(
      h.layer.getRowControls().info,
      '3 events · ACLED (verified)',
      'the last good sample stays',
    );
    const [retry] = pendingTimers(h);
    assert.equal(retry.ms, 5 * 60_000);
    retry.fn();
    await settle();
    assert.equal(h.feed.calls.length, 3);
    assert.equal(h.layer.getStats().error, null);
  } finally {
    h.layer.disable();
    h.restore();
  }
});

test('disabling the layer cancels a pending retry', async () => {
  const h = harness({
    queue: [ACLED_PAYLOAD, new Error('ACLED HTTP 500')],
  });
  try {
    h.layer.enable();
    await h.layer.update(h.viewer);
    await h.layer.update(h.viewer);
    assert.equal(pendingTimers(h).length, 1);
    h.layer.disable();
    assert.equal(pendingTimers(h).length, 0);
  } finally {
    h.restore();
  }
});

test('a snapshot that is still backfilling follows up after a minute and says so in the row', async () => {
  const h = harness({
    queue: [{ ...GDELT_PAYLOAD, coverageHours: 2, backfilling: true }],
  });
  try {
    h.layer.enable();
    await h.layer.update(h.viewer);
    const [follow] = pendingTimers(h);
    assert.equal(follow.ms, 60_000);
    assert.equal(
      h.layer.getRowControls().info,
      '1 event · GDELT news reports (unverified) · 2 h loaded, loading older reports. Add a free ACLED key for verified data',
    );
  } finally {
    h.layer.disable();
    h.restore();
  }
});
