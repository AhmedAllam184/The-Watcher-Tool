import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

// The sheet hides panel headers, so a desktop-folded panel must open unfolded
// in the sheet and get its fold back when it leaves.
const sheet = fs.readFileSync(new URL('./mobileSheet.js', import.meta.url), 'utf8');

test('a folded panel opens unfolded in the phone sheet', () => {
  assert.match(sheet, /node\.dataset\.mobileSheetWasCollapsed = '1';\s*node\.classList\.remove\('collapsed'\);/);
});

test('releasing the panel restores its desktop fold', () => {
  assert.match(sheet, /if \(panelPortal\.dataset\.mobileSheetWasCollapsed === '1'\)\s*panelPortal\.classList\.add\('collapsed'\);/);
  assert.match(sheet, /delete panelPortal\.dataset\.mobileSheetWasCollapsed;/);
});
