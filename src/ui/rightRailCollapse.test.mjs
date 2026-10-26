import test from 'node:test';
import assert from 'node:assert/strict';
import {
  RIGHT_RAIL_COLLAPSED_STORAGE_KEY,
  applyRightRailCollapsed,
  readRightRailCollapsed,
  writeRightRailCollapsed,
} from './rightRailCollapse.js';
import { PanelChrome } from './panelChrome.js';

function memoryStorage(initial = {}) {
  const values = new Map(Object.entries(initial));
  return {
    values,
    getItem: (key) => (values.has(key) ? values.get(key) : null),
    setItem: (key, value) => values.set(key, String(value)),
  };
}

const brokenStorage = {
  getItem() {
    throw new Error('blocked');
  },
  setItem() {
    throw new Error('full');
  },
};

test('the pane collapse flag reads only the stored 1 and defaults to expanded', () => {
  assert.equal(RIGHT_RAIL_COLLAPSED_STORAGE_KEY, 'watcher.rightRailCollapsed');
  assert.equal(readRightRailCollapsed({ storage: memoryStorage() }), false);
  assert.equal(
    readRightRailCollapsed({ storage: memoryStorage({ [RIGHT_RAIL_COLLAPSED_STORAGE_KEY]: '1' }) }),
    true,
  );
  assert.equal(
    readRightRailCollapsed({ storage: memoryStorage({ [RIGHT_RAIL_COLLAPSED_STORAGE_KEY]: '0' }) }),
    false,
  );
  assert.equal(readRightRailCollapsed({ storage: null }), false);
});

test('the pane collapse flag is written as 1 and 0 and survives blocked storage', () => {
  const storage = memoryStorage();
  writeRightRailCollapsed(true, { storage });
  assert.equal(storage.values.get(RIGHT_RAIL_COLLAPSED_STORAGE_KEY), '1');
  writeRightRailCollapsed(false, { storage });
  assert.equal(storage.values.get(RIGHT_RAIL_COLLAPSED_STORAGE_KEY), '0');
  assert.equal(readRightRailCollapsed({ storage: brokenStorage }), false);
  assert.doesNotThrow(() => writeRightRailCollapsed(true, { storage: brokenStorage }));
});

test('applying the pane state sets the class, the toggle name and its glyph', () => {
  const classes = new Set();
  const rail = {
    classList: {
      toggle: (name, on) => (on ? classes.add(name) : classes.delete(name)),
    },
  };
  const glyph = { textContent: 'right_panel_close' };
  const attributes = new Map();
  const button = {
    title: '',
    setAttribute: (name, value) => attributes.set(name, value),
    querySelector: () => glyph,
  };
  assert.equal(applyRightRailCollapsed({ rail, button, collapsed: true }), true);
  assert.ok(classes.has('right-rail-collapsed'));
  assert.equal(attributes.get('aria-expanded'), 'false');
  assert.equal(attributes.get('aria-label'), 'Expand tools pane');
  assert.equal(glyph.textContent, 'right_panel_open');

  applyRightRailCollapsed({ rail, button, collapsed: false });
  assert.ok(!classes.has('right-rail-collapsed'));
  assert.equal(attributes.get('aria-expanded'), 'true');
  assert.equal(attributes.get('aria-label'), 'Collapse tools pane');
  assert.equal(glyph.textContent, 'right_panel_close');
});

function chromeFixture({ stored = null } = {}) {
  const classes = new Set();
  const rail = {
    classList: {
      contains: (name) => classes.has(name),
      toggle: (name, on) => (on ? classes.add(name) : classes.delete(name)),
    },
  };
  const attributes = new Map();
  const button = {
    title: '',
    setAttribute: (name, value) => attributes.set(name, value),
    querySelector: () => ({ textContent: '' }),
  };
  const listeners = [];
  const scheduled = [];
  const storage = memoryStorage(
    stored === null ? {} : { [RIGHT_RAIL_COLLAPSED_STORAGE_KEY]: stored },
  );
  const owner = {
    _rightPanelStack: rail,
    _lifetime: {
      listen: (target, type, handler) => listeners.push([target, type, handler]),
    },
    _scheduleRightPanelLayout: () => scheduled.push(true),
    _setRightRailCollapsed: PanelChrome.prototype._setRightRailCollapsed,
  };
  owner._initRightRailToggle = PanelChrome.prototype._initRightRailToggle;
  return { owner, rail, button, listeners, scheduled, storage, classes, attributes };
}

test('the TOOLS toggle restores the stored choice without rewriting it', () => {
  const prior = globalThis.document;
  const f = chromeFixture({ stored: '1' });
  const priorStorage = globalThis.localStorage;
  globalThis.localStorage = f.storage;
  globalThis.document = { getElementById: (id) => (id === 'right-rail-toggle' ? f.button : null) };
  try {
    f.owner._initRightRailToggle();
    assert.ok(f.classes.has('right-rail-collapsed'));
    assert.equal(f.attributes.get('aria-expanded'), 'false');
    assert.equal(f.storage.values.get(RIGHT_RAIL_COLLAPSED_STORAGE_KEY), '1');
    assert.ok(f.scheduled.length > 0, 'the rail layout is rescheduled');
    assert.equal(f.listeners.length, 1);
  } finally {
    globalThis.document = prior;
    globalThis.localStorage = priorStorage;
  }
});

test('the TOOLS toggle collapses and expands the pane and remembers the choice', () => {
  const prior = globalThis.document;
  const f = chromeFixture();
  const priorStorage = globalThis.localStorage;
  globalThis.localStorage = f.storage;
  globalThis.document = { getElementById: (id) => (id === 'right-rail-toggle' ? f.button : null) };
  try {
    f.owner._initRightRailToggle();
    assert.equal(f.classes.has('right-rail-collapsed'), false);
    const [, , onClick] = f.listeners[0];
    onClick();
    assert.ok(f.classes.has('right-rail-collapsed'));
    assert.equal(f.storage.values.get(RIGHT_RAIL_COLLAPSED_STORAGE_KEY), '1');
    onClick();
    assert.equal(f.classes.has('right-rail-collapsed'), false);
    assert.equal(f.storage.values.get(RIGHT_RAIL_COLLAPSED_STORAGE_KEY), '0');
  } finally {
    globalThis.document = prior;
    globalThis.localStorage = priorStorage;
  }
});

test('a page without the TOOLS toggle leaves the rail untouched', () => {
  const prior = globalThis.document;
  const f = chromeFixture({ stored: '1' });
  globalThis.document = { getElementById: () => null };
  try {
    f.owner._initRightRailToggle();
    assert.equal(f.classes.has('right-rail-collapsed'), false);
    assert.equal(f.listeners.length, 0);
  } finally {
    globalThis.document = prior;
  }
});
