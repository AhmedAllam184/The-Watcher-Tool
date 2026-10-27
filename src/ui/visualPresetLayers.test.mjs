import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import {
  PRESET_LAYER_OVERLAYS,
  createVisualPresetLayers,
} from './visualPresetLayers.js';

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

function harness({ manager = fakeManager(defaultRows()), loadKeyStatus = async () => null } = {}) {
  const root = fakeElement('div');
  const allButton = fakeElement('button');
  const statusNode = fakeElement('span');
  const opened = [];
  const toasts = [];
  const layers = createVisualPresetLayers({
    root,
    allButton,
    statusNode,
    readDataManager: () => manager,
    openDataPanel: () => opened.push(true),
    showToast: (message) => toasts.push(message),
    loadKeyStatus,
    documentRef: fakeDocument(),
    windowRef: fakeWindow(),
  });
  const chip = (layerId) => {
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
  return { root, allButton, statusNode, layers, manager, opened, toasts, chip };
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

test('the QUICK LAYERS chips are the overlays the owner named, Conflicts included', () => {
  assert.deepEqual(
    PRESET_LAYER_OVERLAYS.map((overlay) => overlay.id),
    ['flights', 'ais-live-vessels', 'local-airports', 'traffic', 'weather-radar', 'local-firms', 'gps-interference', 'conflict-events'],
  );
  const h = harness();
  assert.equal(h.root.children.length, PRESET_LAYER_OVERLAYS.length);
});

test('no map-source chips are duplicated here: the switch and 3D stay in MAP SOURCE', () => {
  const h = harness();
  for (const node of h.root.children) assert.doesNotMatch(node.className, /ql-switch|ql-tile/);
});

test('a chip shows its layer on or off through aria-pressed and the status count', () => {
  const h = harness();
  h.manager.layers.get('flights').enabled = true;
  h.layers.refresh();
  assert.equal(h.chip('flights').getAttribute('aria-pressed'), 'true');
  assert.equal(h.chip('traffic').getAttribute('aria-pressed'), 'false');
  assert.equal(h.statusNode.textContent, '1 on');
});

test('a chip toggles its layer through the manager as a user action', async () => {
  const h = harness();
  h.chip('traffic').dispatch('click');
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.deepEqual(h.manager.calls, [{ id: 'traffic', enabled: true, options: { origin: 'user' } }]);
  assert.equal(h.chip('traffic').getAttribute('aria-pressed'), 'true');
});

test('a layer that needs a missing key shows the purple dot and says so in its tooltip', async () => {
  const h = harness({ loadKeyStatus: async () => ({ aisstream: { configured: false } }) });
  h.layers.refresh();
  await new Promise((resolve) => setTimeout(resolve, 0));
  const dot = h.chip('ais-live-vessels').children[1];
  assert.equal(dot.hidden, false);
  assert.match(h.chip('ais-live-vessels').title, /needs a key/);
  assert.equal(h.chip('flights').children[1].hidden, true);
});

test('a chip for a layer the registry does not have is disabled with its reason', () => {
  const manager = fakeManager(defaultRows().filter((row) => row.id !== 'conflict-events'));
  const h = harness({ manager });
  assert.equal(h.chip('conflict-events').getAttribute('aria-disabled'), 'true');
  assert.match(h.chip('conflict-events').title, /not available/);
});

test('All layers opens DATA LAYERS', () => {
  const h = harness();
  h.allButton.dispatch('click');
  assert.deepEqual(h.opened, [true]);
});

test('destroy removes its listeners and leaves the row empty', () => {
  const h = harness();
  h.layers.destroy();
  assert.equal(h.root.children.length, 0);
  assert.equal(h.allButton.listenerCount('click'), 0);
});

test('the chip row sits in the tray and the bottom-left switcher is gone', () => {
  const tray = readFileSync(new URL('../ui/templates/command-dock.html', import.meta.url), 'utf8');
  assert.match(tray, /id="quick-layer-chips"/);
  assert.match(tray, /id="quick-layers-all"/);
  const template = readFileSync(new URL('../ui/templates/scene-chrome.html', import.meta.url), 'utf8');
  assert.doesNotMatch(template, /id="quick-layers"/);
});
