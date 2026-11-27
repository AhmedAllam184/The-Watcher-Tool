import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import {
  PHONE_QUERY,
  SHEET_STATES,
  nextSheetState,
} from './mobileSheetState.js';

test('phone handle cycles all three snap heights without dismissing', () => {
  assert.equal(nextSheetState('closed', 'tap'), 'peek');
  assert.equal(nextSheetState('peek', 'tap'), 'half');
  assert.equal(nextSheetState('half', 'tap'), 'full');
  assert.equal(nextSheetState('full', 'tap'), 'peek');
});
test('downward drags step down and dismiss from peek; upward drags stop at full', () => {
  assert.equal(nextSheetState('full', 'drag', 60), 'half');
  assert.equal(nextSheetState('half', 'drag', 60), 'peek');
  assert.equal(nextSheetState('peek', 'drag', 60), 'closed');
  assert.equal(nextSheetState('peek', 'drag', -60), 'half');
  assert.equal(nextSheetState('full', 'drag', -60), 'full');
});
test('small gestures do not snap and dismiss works from every height', () => {
  for (const state of SHEET_STATES) {
    assert.equal(nextSheetState(state, 'drag', 39), state);
    assert.equal(nextSheetState(state, 'dismiss'), 'closed');
  }
});
test('CSS and placement use the same phone-only width rule', () => {
  assert.equal(PHONE_QUERY, '(max-width: 768px)');
  const css = readFileSync(
    new URL('./styles/mobile.css', import.meta.url),
    'utf8',
  );
  assert.match(css, /@media \(max-width: 768px\)/);
  assert.doesNotMatch(css, /min-width: 768px|pointer: coarse/);
  assert.match(css, /100dvh/);
  assert.match(css, /safe-area-inset-bottom/);
});
