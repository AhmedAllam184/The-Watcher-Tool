import { PANEL_GROUPS } from './layerPanel.js';
import { LAYER_DESCRIPTIONS, describeLayer } from './layerDescriptions.js';
import assert from 'node:assert/strict';
import test from 'node:test';

const panelIds = PANEL_GROUPS.flatMap(({ ids }) => ids);

test('every Data Layers panel id has a plain-language description', () => {
  for (const id of panelIds) {
    assert.ok(describeLayer(id).length > 0, `${id} has no description`);
  }
});

test('descriptions stay within 90 characters', () => {
  for (const [id, text] of Object.entries(LAYER_DESCRIPTIONS)) {
    assert.ok(text.length <= 90, `${id} is ${text.length} characters`);
  }
});

test('describeLayer returns an empty string for an unknown id', () => {
  assert.equal(describeLayer('no-such-layer'), '');
  assert.equal(describeLayer('constructor'), '');
});
