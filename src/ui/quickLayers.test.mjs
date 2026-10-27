import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import {
  QUICK_LAYER_OVERLAYS,
  createQuickLayers,
  quickLayerSwitchTarget,
} from './quickLayers.js';

// Minimal element stand-in: just the surface quickLayers.js touches.
function fakeElement(tag = 'div') {
  const attributes = new Map();
  const listeners = new Map();
  const classes = new Set();
  const node = {
    tagName: tag.toUpperCase(),
    children: [],
    dataset: {},
    get className() {
      return [...classes].join(' ');
    },
    set className(value) {
      classes.clear();
      for (const name of String(value).split(/\s+/).filter(Boolean))
        classes.add(name);
    },
    style: {
      props: new Map(),
      setProperty(name, value) {
        this.props.set(name, value);
      },
      removeProperty(name) {
        this.props.delete(name);
      },
    },
    hidden: false,
    title: '',
    textContent: '',
    classList: {
      add: (...names) => names.forEach((name) => classes.add(name)),
      remove: (...names) => names.forEach((name) => classes.delete(name)),
      toggle: (name, force) => {
        if (force) classes.add(name);
        else classes.delete(name);
      },
      contains: (name) => classes.has(name),
    },
    setAttribute(name, value) {
      attributes.set(name, String(value));
      if (name === 'hidden') this.hidden = true;
    },
    getAttribute: (name) =>
      attributes.has(name) ? attributes.get(name) : null,
    removeAttribute(name) {
      attributes.delete(name);
      if (name === 'hidden') this.hidden = false;
    },
    append(...nodes) {
      this.children.push(...nodes);
      for (const child of nodes) child.parent = this;
    },
    replaceChildren(...nodes) {
      this.children = [...nodes];
    },
    contains(target) {
      return target === this || this.children.some((c) => c.contains?.(target));
    },
    addEventListener(type, listener) {
      if (!listeners.has(type)) listeners.set(type, new Set());
      listeners.get(type).add(listener);
    },
    removeEventListener(type, listener) {
      listeners.get(type)?.delete(listener);
    },
    dispatch(type, event = {}) {
      for (const listener of listeners.get(type) ?? []) listener(event);
    },
    listenerCount: (type) => listeners.get(type)?.size ?? 0,
    getBoundingClientRect: () => ({
      left: 16,
      right: 88,
      top: 660,
      bottom: 732,
      width: 72,
      height: 72,
    }),
    focus() {
      this.focused = true;
    },
    attributes,
    classes,
  };
  return node;
}

function fakeDocument() {
  return {
    createElement: (tag) => fakeElement(tag),
    addEventListener() {},
    removeEventListener() {},
    querySelectorAll: () => [],
  };
}

function fakeWindow() {
  const listeners = new Set();
  return {
    innerHeight: 900,
    getComputedStyle: () => ({
      display: 'block',
      visibility: 'visible',
      opacity: '1',
    }),
    requestAnimationFrame: () => 1,
    cancelAnimationFrame() {},
    addEventListener() {},
    removeEventListener() {},
  };
}

function fakeManager(rows) {
  const manager = {
    layers: new Map(rows.map((row) => [row.id, row])),
    calls: [],
    rows,
    getAll: () =>
      rows.map((row) => ({
        id: row.id,
        name: row.name,
        icon: '',
        enabled: row.enabled,
        lifecycleState: 'settled',
        stats: row.stats ?? {},
        requiresKeyId: row.requiresKeyId ?? null,
      })),
    isEnabled: (id) => manager.layers.get(id)?.enabled === true,
    async setEnabled(id, enabled, options) {
      manager.calls.push({ id, enabled, options });
      manager.layers.get(id).enabled = enabled;
    },
    subscribeActivity: () => () => {},
  };
  return manager;
}

function harness({
  activeId = 'osm',
  manager = fakeManager(defaultRows()),
} = {}) {
  const root = fakeElement('div');
  const stacks = [
    { id: 'osm', label: 'OSM', available: true },
    { id: 'esri-imagery', label: 'Esri Satellite', available: true },
    {
      id: 'photoreal',
      label: 'Google 3D',
      available: false,
      unavailableReason: 'Google 3D is unavailable',
    },
  ];
  const state = { activeId };
  const selected = [];
  const opened = [];
  const toasts = [];
  const quick = createQuickLayers({
    root,
    readDataManager: () => manager,
    mapStackController: {
      getStacks: () => stacks,
      getActiveId: () => state.activeId,
    },
    selectMapStack: async (id) => {
      selected.push(id);
      state.activeId = id;
      return null;
    },
    openDataPanel: () => opened.push(true),
    showToast: (message) => toasts.push(message),
    loadKeyStatus: async () => null,
    documentRef: fakeDocument(),
    windowRef: fakeWindow(),
  });
  const find = (selector) => {
    const walk = (node) => {
      if (
        node.classes?.has(selector.slice(1)) ||
        node.attributes?.get('data-x') === selector
      )
        return node;
      for (const child of node.children) {
        const hit = walk(child);
        if (hit) return hit;
      }
      return null;
    };
    return walk(root);
  };
  const tile = (layerId) => {
    const walk = (node) => {
      if (node.dataset?.layerId === layerId) return node;
      for (const child of node.children ?? []) {
        const hit = walk(child);
        if (hit) return hit;
      }
      return null;
    };
    return walk(root);
  };
  const byClass = (name) => {
    const walk = (node) => {
      if (node.classes?.has(name)) return node;
      for (const child of node.children ?? []) {
        const hit = walk(child);
        if (hit) return hit;
      }
      return null;
    };
    return walk(root);
  };
  return {
    root,
    quick,
    manager,
    state,
    selected,
    opened,
    toasts,
    find,
    tile,
    byClass,
  };
}

function defaultRows() {
  return [
    { id: 'flights', name: 'Live Flights', enabled: false },
    {
      id: 'ais-live-vessels',
      name: 'Live Vessels',
      enabled: false,
      stats: { keyRequired: true },
      requiresKeyId: 'aisstream',
    },
    { id: 'local-airports', name: 'Airports', enabled: false },
    { id: 'traffic', name: 'Traffic', enabled: false },
    { id: 'weather-radar', name: 'Weather radar', enabled: false },
    { id: 'local-firms', name: 'Active Fires', enabled: false },
    { id: 'gps-interference', name: 'GPS Interference', enabled: false },
  ];
}

test('the switch target is Satellite from the street map and the street map from anywhere else', () => {
  assert.equal(quickLayerSwitchTarget('osm'), 'esri-imagery');
  assert.equal(quickLayerSwitchTarget('esri-imagery'), 'osm');
  assert.equal(quickLayerSwitchTarget('photoreal'), 'osm');
  assert.equal(quickLayerSwitchTarget(null), 'osm');
});

test('the overlay tiles are the seven Data Layers the brief names, with icons', () => {
  assert.deepEqual(
    QUICK_LAYER_OVERLAYS.map((overlay) => overlay.id),
    [
      'flights',
      'ais-live-vessels',
      'local-airports',
      'traffic',
      'weather-radar',
      'local-firms',
      'gps-interference',
    ],
  );
  for (const overlay of QUICK_LAYER_OVERLAYS)
    assert.ok(overlay.icon && overlay.label);
});

test('the thumbnail names the map a click switches to and toggles it through the shared select path', async () => {
  const h = harness({ activeId: 'osm' });
  const switchButton = h.byClass('ql-switch');
  assert.equal(h.byClass('ql-switch-label').textContent, 'Satellite');
  assert.equal(switchButton.getAttribute('aria-label'), 'Show Satellite map');
  switchButton.dispatch('click');
  await Promise.resolve();
  assert.deepEqual(h.selected, ['esri-imagery']);
  h.quick.refresh();
  assert.equal(h.byClass('ql-switch-label').textContent, 'Map');
  h.byClass('ql-switch').dispatch('click');
  await Promise.resolve();
  assert.deepEqual(h.selected, ['esri-imagery', 'osm']);
});

test('Google 3D is disabled with its reason while unavailable, and never selected', async () => {
  const h = harness();
  const threeD = h.byClass('ql-tile');
  assert.equal(threeD.getAttribute('aria-disabled'), 'true');
  assert.equal(threeD.title, 'Google 3D is unavailable');
  threeD.dispatch('click');
  await Promise.resolve();
  assert.deepEqual(h.selected, []);
});

test('an overlay tile toggles its layer through the manager as a user action and shows the active state', async () => {
  const h = harness();
  const flights = h.tile('flights');
  assert.equal(flights.getAttribute('aria-pressed'), 'false');
  flights.dispatch('click');
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(h.manager.calls, [
    { id: 'flights', enabled: true, options: { origin: 'user' } },
  ]);
  assert.equal(flights.getAttribute('aria-pressed'), 'true');
});

test('a layer that needs a missing key shows the purple key dot and says so in its tooltip', () => {
  const h = harness();
  const ships = h.tile('ais-live-vessels');
  const dot = ships.children[0].children[1];
  assert.equal(dot.hidden, false);
  assert.match(ships.title, /needs a key/);
  assert.equal(h.tile('flights').children[0].children[1].hidden, true);
});

test('More opens the DATA LAYERS panel and closes the tray', () => {
  const h = harness();
  const moreTile = h.root.children[2].children.at(-1).children[0];
  moreTile.dispatch('click');
  assert.deepEqual(h.opened, [true]);
});

test('hover opens the tray for a mouse, Escape closes it and returns focus to the launcher', () => {
  const h = harness();
  const panel = h.root.children[2];
  assert.equal(panel.hidden, true);
  h.root.dispatch('pointerenter', { pointerType: 'mouse' });
  assert.equal(panel.hidden, false);
  let prevented = false;
  h.root.dispatch('keydown', {
    key: 'Escape',
    preventDefault() {
      prevented = true;
    },
    stopPropagation() {},
  });
  assert.equal(prevented, true);
  assert.equal(panel.hidden, true);
  assert.equal(h.root.children[1].focused, true);
});

test('destroy removes its listeners and leaves the root empty', () => {
  const h = harness();
  h.quick.destroy();
  assert.equal(h.root.children.length, 0);
  assert.equal(h.root.listenerCount('pointerenter'), 0);
});

test('the switcher stylesheet keeps the 52px phone square and the 72px desktop square', () => {
  const css = readFileSync(
    new URL('./styles/quickLayers.css', import.meta.url),
    'utf8',
  );
  assert.match(css, /--ql-size: 72px;/);
  assert.match(
    css,
    /@media \(max-width: 639px\)\s*\{\s*\.quick-layers\s*\{\s*--ql-size: 52px;/,
  );
  assert.match(css, /\.ql-panel\s*\{[^}]*overflow-x: auto;/);
});
