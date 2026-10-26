import test from 'node:test';
import assert from 'node:assert/strict';
import { createDarkVessels, DARK_OVERLAY_SOURCE_ID } from './dark.js';
import { createVesselState } from './state.js';

const NOW = 1800000000000;
const settle = () => new Promise((resolve) => setTimeout(resolve, 0));

function dark(overrides = {}) {
  return {
    mmsi: '232000001',
    name: 'LOST SHIP',
    type: 'Cargo',
    imo: '9811000',
    destination: 'ROTTERDAM',
    latitude: 51.9,
    longitude: 4.1,
    lastSpeedKt: 9,
    course: 88,
    heading: 90,
    lastSeenMs: NOW - 45 * 60000,
    silentMs: 45 * 60000,
    neighbours: 4,
    inference: 'Silent 45 min while nearby ships still report',
    ...overrides,
  };
}

function payload(vessels = [dark()], extra = {}) {
  return {
    feedHealthy: true,
    note: 'Inferred from silence.',
    rule: {
      minSilenceMin: 20,
      minSpeedKt: 3,
      minReports: 5,
      coverage: 'at least 3 neighbours',
    },
    count: vessels.length,
    vessels,
    ...extra,
  };
}

/** Fake runtime clock: timers are queued and run by hand. */
function fakeRuntime() {
  const timers = new Set();
  return {
    timers,
    now: () => NOW,
    setTimeout(fn, delay) {
      const timer = { fn, delay };
      timers.add(timer);
      return timer;
    },
    clearTimeout(timer) {
      timers.delete(timer);
    },
    runNext() {
      const [timer] = timers;
      timers.delete(timer);
      timer.fn();
      return timer.delay;
    },
  };
}

function setup({ source, feedEnabled = true } = {}) {
  const requests = [];
  const selected = [];
  const contextCalls = [];
  const renders = [];
  const pendingCleared = [];
  const hostCalls = { setEntries: [], clearSource: [] };
  const primitives = new Set();
  const viewer = {
    scene: {
      primitives: {
        add: (p) => primitives.add(p),
        remove: (p) => primitives.delete(p),
      },
    },
  };
  const services = {
    overlay: {},
    render: { governorRequestRender: (reason) => renders.push(reason) },
    context: {
      registerEntityContext(entity, metadata) {
        contextCalls.push({ entity, metadata });
        return { ...metadata, entity };
      },
      selectEntityContext(entity) {
        selected.push(entity);
        return entity;
      },
    },
    worldFocus: {
      requestWorldFocus(detail) {
        requests.push(detail);
        return true;
      },
    },
  };
  const vesselState = createVesselState({
    source: source || { getDarkVessels: async () => payload() },
    services,
  });
  const runtime = fakeRuntime();
  vesselState._aisRuntime = runtime;
  vesselState._vesselOverlayHost = {
    setEntries: (id, entries) => hostCalls.setEntries.push({ id, entries }),
    setVisible: () => {},
    clearSource: (id) => hostCalls.clearSource.push(id),
    hitTest: () => null,
  };
  vesselState.state.feed.enabled = feedEnabled;
  const parts = {
    queries: { vesselDatumHeightM: (geoidN, liftM) => liftM + geoidN },
    tracking: { currentGeoidN: () => 0 },
    selection: {
      clearVesselInspection: () => pendingCleared.push(true),
    },
  };
  const module = createDarkVessels({
    vesselState,
    services,
    parts,
    layer: {},
  });
  const { state } = vesselState;
  const enable = () => {
    state.feed.enabled = true;
    module.start(viewer);
  };
  const disable = () => {
    state.feed.enabled = false;
    module.stop();
  };
  return {
    vesselState,
    state,
    module,
    runtime,
    viewer,
    primitives,
    requests,
    selected,
    contextCalls,
    renders,
    pendingCleared,
    hostCalls,
    enable,
    disable,
    methods: module.methods,
  };
}

test('polling stores the inference, draws rings and labels, then repeats every minute', async () => {
  const fixture = setup();
  fixture.enable();
  assert.equal(fixture.runtime.timers.size, 1);
  assert.equal(fixture.runtime.runNext(), 5000);
  await settle();
  const { state } = fixture;
  assert.equal(state.dark.vessels.length, 1);
  assert.equal(state.dark.feedHealthy, true);
  assert.equal(state.dark.note, 'Inferred from silence.');
  assert.equal(state.dark.fetchedAt, NOW);
  assert.equal(state.dark.error, null);
  assert.equal(fixture.state.dark.collections.points.length, 1);
  const label = fixture.hostCalls.setEntries.at(-1);
  assert.equal(label.id, DARK_OVERLAY_SOURCE_ID);
  assert.equal(label.entries[0].title, 'DARK 45m');
  assert.equal(label.entries[0].variant, 'label');
  assert.equal(fixture.runtime.timers.size, 1);
  assert.equal(fixture.runtime.runNext(), 60000);
  assert.ok(fixture.renders.includes('ais-dark-vessels'));
});

test('a result that arrives after disable or re-enable is ignored', async () => {
  let resolveFirst;
  let calls = 0;
  const source = {
    getDarkVessels: () =>
      calls++ === 0
        ? new Promise((resolve) => {
            resolveFirst = resolve;
          })
        : Promise.resolve(payload([dark({ mmsi: '232000002' })])),
  };
  const fixture = setup({ source });
  fixture.enable();
  fixture.runtime.runNext();
  await settle();
  fixture.disable();
  fixture.enable();
  resolveFirst(payload([dark()]));
  await settle();
  assert.deepEqual(
    fixture.state.dark.vessels.map((vessel) => vessel.mmsi),
    [],
    'the stale answer must not reach the state',
  );
  fixture.runtime.runNext();
  await settle();
  assert.deepEqual(
    fixture.state.dark.vessels.map((vessel) => vessel.mmsi),
    ['232000002'],
  );
});

test('disable removes and destroys the rings, clears labels and stops the timer', async () => {
  const fixture = setup();
  fixture.enable();
  fixture.runtime.runNext();
  await settle();
  const points = fixture.state.dark.collections.points;
  assert.equal(fixture.primitives.size, 1);
  fixture.disable();
  assert.equal(fixture.primitives.size, 0);
  assert.equal(points.isDestroyed(), true);
  assert.equal(fixture.state.dark.collections, null);
  assert.deepEqual(fixture.hostCalls.clearSource, [DARK_OVERLAY_SOURCE_ID]);
  assert.equal(fixture.runtime.timers.size, 0);
  assert.deepEqual(fixture.state.dark.vessels, []);
  fixture.module.destroy();
  assert.equal(fixture.state.dark.listener, null);
});

test('a source without the dark route never polls', () => {
  const fixture = setup({ source: { getSnapshot: async () => ({}) } });
  fixture.enable();
  assert.equal(fixture.runtime.timers.size, 0);
  assert.equal(fixture.state.dark.sessionId, null);
});

test('failed polls report the error and show no rings', async () => {
  const source = {
    getDarkVessels: async () => {
      throw Object.assign(new Error('Vessels HTTP 503'), { status: 503 });
    },
  };
  const fixture = setup({ source });
  fixture.enable();
  fixture.runtime.runNext();
  await settle();
  assert.equal(fixture.state.dark.error, 'Vessels HTTP 503');
  assert.deepEqual(fixture.state.dark.vessels, []);
  const controls = fixture.methods.getRowControls();
  assert.match(controls.info, /unavailable: Vessels HTTP 503/);
});

test('getRowControls is null while disabled or before any answer, then describes the dark ships', async () => {
  const fixture = setup();
  assert.equal(fixture.methods.getRowControls(), null);
  fixture.enable();
  assert.equal(fixture.methods.getRowControls(), null);
  fixture.runtime.runNext();
  await settle();
  const controls = fixture.methods.getRowControls();
  assert.deepEqual(controls.chips, []);
  assert.deepEqual(controls.legend, [
    { label: 'Gone dark (inferred)', color: '#f87171', count: 1 },
  ]);
  assert.equal(
    controls.info,
    '1 ship stopped transmitting while under way, where nearby ships still report. Inferred, not confirmed.',
  );
  assert.equal(
    controls.infoTitle,
    'Inferred from silence. Rule: silent for at least 20 min; under way at 3 kt or more; at least 5 earlier reports; at least 3 neighbours',
  );
  assert.equal(controls.list.ariaLabel, 'Ships that went dark');
  assert.deepEqual(controls.list.items, [
    {
      id: 'dark-232000001',
      lead: '45m',
      text: 'LOST SHIP · Cargo · 9 kt',
      params: { darkMmsi: '232000001' },
    },
  ]);

  fixture.state.dark.feedHealthy = false;
  assert.equal(
    fixture.methods.getRowControls().info,
    'Dark-ship check paused: the AIS feed is not live.',
  );
  fixture.disable();
  assert.equal(fixture.methods.getRowControls(), null);
});

test('setRowControlsListener is called after each poll and can be cleared', async () => {
  const fixture = setup();
  let notified = 0;
  fixture.methods.setRowControlsListener(() => notified++);
  fixture.enable();
  fixture.runtime.runNext();
  await settle();
  assert.equal(notified, 1);
  fixture.methods.setRowControlsListener(null);
  fixture.runtime.runNext();
  await settle();
  assert.equal(notified, 1);
});

test('setParams selects a dark ship in the shared context and flies to it', async () => {
  const fixture = setup();
  fixture.enable();
  fixture.runtime.runNext();
  await settle();
  assert.equal(fixture.methods.setParams({ darkMmsi: '999' }), false);
  assert.equal(fixture.methods.setParams({ other: 1 }), false);
  assert.equal(fixture.methods.setParams({ darkMmsi: '232000001' }), true);

  const [call] = fixture.contextCalls;
  assert.equal(call.metadata.id, 'ais-dark-232000001');
  assert.equal(call.metadata.layerId, 'ais-live-vessels');
  assert.equal(call.metadata.source, 'AISStream (inferred)');
  assert.equal(call.metadata.label, 'LOST SHIP');
  assert.equal(call.metadata.properties.status, 'gone dark (inferred)');
  assert.equal(call.metadata.properties.silentMin, 45);
  assert.equal(call.entity.dark, true);
  assert.equal(call.entity.missedRefreshes, 1);
  assert.equal(call.entity.lastPositionEpoch, NOW - 45 * 60000);
  assert.equal(call.entity.speed, 9);
  assert.equal(fixture.selected[0], call.entity);
  assert.equal(fixture.pendingCleared.length, 1);
  assert.equal(fixture.requests[0].kind, 'vessel');
  assert.equal(fixture.requests[0].id, '232000001');

  assert.equal(fixture.methods.setParams({ darkMmsi: null }), true);
});

test('setParams is refused while the layer is disabled', async () => {
  const fixture = setup();
  fixture.enable();
  fixture.runtime.runNext();
  await settle();
  fixture.state.feed.enabled = false;
  assert.equal(fixture.methods.setParams({ darkMmsi: '232000001' }), false);
  assert.equal(fixture.contextCalls.length, 0);
});
