import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  READOUTS_HIDDEN_CLASS,
  SHOW_READOUTS_STORAGE_KEY,
  applyShowReadouts,
  readShowReadouts,
  writeShowReadouts,
} from './footerReadouts.js';

function memoryStorage(initial = {}) {
  const data = new Map(Object.entries(initial));
  return {
    getItem: (key) => (data.has(key) ? data.get(key) : null),
    setItem: (key, value) => data.set(key, String(value)),
  };
}

test('the readouts default to shown when nothing is stored', () => {
  assert.equal(readShowReadouts({ storage: memoryStorage() }), true);
});

test('a stored choice is restored and written under the watcher key', () => {
  const storage = memoryStorage({ [SHOW_READOUTS_STORAGE_KEY]: '0' });
  assert.equal(readShowReadouts({ storage }), false);
  writeShowReadouts(true, { storage });
  assert.equal(storage.getItem('watcher.showReadouts'), '1');
  assert.equal(SHOW_READOUTS_STORAGE_KEY, 'watcher.showReadouts');
});

test('blocked or full storage keeps the readouts on and never throws', () => {
  const blocked = {
    getItem() {
      throw new Error('blocked');
    },
    setItem() {
      throw new Error('full');
    },
  };
  assert.equal(readShowReadouts({ storage: blocked }), true);
  assert.doesNotThrow(() => writeShowReadouts(false, { storage: blocked }));
  assert.equal(readShowReadouts({ storage: null }), true);
});

test('hiding the readouts marks the body and unticks the Display switch', () => {
  const classes = new Set();
  const toggle = { checked: true };
  const doc = {
    body: {
      classList: {
        toggle: (name, on) => (on ? classes.add(name) : classes.delete(name)),
      },
    },
    getElementById: (id) => (id === 'footer-readouts-toggle' ? toggle : null),
  };
  applyShowReadouts(doc, false);
  assert.ok(classes.has(READOUTS_HIDDEN_CLASS));
  assert.equal(toggle.checked, false);
  applyShowReadouts(doc, true);
  assert.ok(!classes.has(READOUTS_HIDDEN_CLASS));
  assert.equal(toggle.checked, true);
});
