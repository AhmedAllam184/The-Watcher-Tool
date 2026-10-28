import test from 'node:test';
import assert from 'node:assert/strict';
import {
  RIGHT_RAIL_COLLAPSED_STORAGE_KEY,
  takeLegacyRightRailCollapsed,
} from './rightRailCollapse.js';
import { PanelChrome } from './panelChrome.js';

function memoryStorage(initial = {}) {
  const values = new Map(Object.entries(initial));
  return {
    values,
    getItem: (key) => (values.has(key) ? values.get(key) : null),
    setItem: (key, value) => values.set(key, String(value)),
    removeItem: (key) => values.delete(key),
  };
}

const brokenStorage = {
  getItem() {
    throw new Error('blocked');
  },
  removeItem() {
    throw new Error('blocked');
  },
};

test('the legacy TOOLS tab flag is read once and then retired', () => {
  assert.equal(RIGHT_RAIL_COLLAPSED_STORAGE_KEY, 'watcher.rightRailCollapsed');
  const storage = memoryStorage({ [RIGHT_RAIL_COLLAPSED_STORAGE_KEY]: '1' });
  assert.equal(takeLegacyRightRailCollapsed({ storage }), true);
  assert.equal(storage.values.has(RIGHT_RAIL_COLLAPSED_STORAGE_KEY), false);
  assert.equal(takeLegacyRightRailCollapsed({ storage }), null);

  const expanded = memoryStorage({ [RIGHT_RAIL_COLLAPSED_STORAGE_KEY]: '0' });
  assert.equal(takeLegacyRightRailCollapsed({ storage: expanded }), false);
  assert.equal(expanded.values.has(RIGHT_RAIL_COLLAPSED_STORAGE_KEY), false);
});

test('a missing or blocked legacy flag reads as no saved choice', () => {
  assert.equal(takeLegacyRightRailCollapsed({ storage: memoryStorage() }), null);
  assert.equal(takeLegacyRightRailCollapsed({ storage: null }), null);
  assert.equal(takeLegacyRightRailCollapsed({ storage: brokenStorage }), null);
});

/** Owner with a TOOLS card; `preference` mirrors what restore recorded for the card. */
function migrationOwner({ legacy, preference = 'default' }) {
  const card = { id: 'right-context-rail', dataset: { collapsedPreference: preference } };
  const calls = [];
  const owner = {
    _rightPanelStack: card,
    setPanelCollapsed: (id, collapsed, options) => calls.push([id, collapsed, options]),
  };
  const storage = memoryStorage(
    legacy === null ? {} : { [RIGHT_RAIL_COLLAPSED_STORAGE_KEY]: legacy },
  );
  return { owner, calls, storage, card };
}

test('a legacy collapsed choice moves to the TOOLS card once, without an accordion side effect', () => {
  const prior = globalThis.localStorage;
  const f = migrationOwner({ legacy: '1' });
  globalThis.localStorage = f.storage;
  try {
    PanelChrome.prototype._migrateRightRailCollapsedPreference.call(f.owner);
  } finally {
    globalThis.localStorage = prior;
  }
  assert.deepEqual(f.calls, [
    ['right-context-rail', true, { restore: true, syncShare: false }],
  ]);
  assert.equal(f.storage.values.has(RIGHT_RAIL_COLLAPSED_STORAGE_KEY), false);
});

test('a card with its own saved choice keeps it; the legacy flag is still retired', () => {
  const prior = globalThis.localStorage;
  const f = migrationOwner({ legacy: '1', preference: 'stored' });
  globalThis.localStorage = f.storage;
  try {
    PanelChrome.prototype._migrateRightRailCollapsedPreference.call(f.owner);
  } finally {
    globalThis.localStorage = prior;
  }
  assert.deepEqual(f.calls, []);
  assert.equal(f.storage.values.has(RIGHT_RAIL_COLLAPSED_STORAGE_KEY), false);
});

test('an expanded or absent legacy flag changes nothing', () => {
  for (const legacy of ['0', null]) {
    const prior = globalThis.localStorage;
    const f = migrationOwner({ legacy });
    globalThis.localStorage = f.storage;
    try {
      PanelChrome.prototype._migrateRightRailCollapsedPreference.call(f.owner);
    } finally {
      globalThis.localStorage = prior;
    }
    assert.deepEqual(f.calls, [], String(legacy));
  }
});
