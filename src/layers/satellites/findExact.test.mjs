import test from 'node:test';
import assert from 'node:assert/strict';
import { createControls } from './controls.js';

/** Controls over a fake catalog; propagation returns a fixed sub-satellite point. */
function controlsWith(entries) {
  const catalog = new Map(
    entries.map(([noradId, name]) => [noradId, { name, satrec: {} }]),
  );
  const controls = createControls({
    state: { _catalog: catalog },
    services: { layerState: { isExplicitLayerStateOrigin: () => false } },
    parts: {
      orbits: {
        propagatePosition: () => ({
          latitude: 10,
          longitude: 20,
          altitude: 400_000,
        }),
      },
    },
    source: {},
  });
  return controls.methods;
}

test('satellite findExact takes the exact name even when a longer name is listed first', () => {
  const controls = controlsWith([
    [40001, 'EVER GIVEN II'],
    [40002, 'EVER GIVEN'],
  ]);
  assert.equal(
    controls.findByQuery('ever given').noradId,
    40001,
    'partial search unchanged',
  );
  assert.equal(controls.findExact('ever  given').noradId, 40002);
  assert.equal(controls.findExact('40001').name, 'EVER GIVEN II');
  assert.equal(controls.findExact('EVER'), null, 'a partial name is not exact');
  assert.equal(controls.findExact(''), null);
});

test('satellite findExact returns nothing for an empty catalog', () => {
  assert.equal(controlsWith([]).findExact('ISS'), null);
});
