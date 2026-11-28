import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

// createApplicationScene builds a live Cesium viewer, so the startup branch is
// pinned here at source level. The controller behaviour itself is tested in
// src/maps/controller.test.mjs.
const scene = fs.readFileSync(new URL('./scene.js', import.meta.url), 'utf8');

test('Google 3D loads at startup when it is the start stack or nothing else is possible', () => {
  assert.match(scene, /const startStack =\s*readRememberedMapStack\(\) \|\|\s*\(hasPhotorealCredentials \? 'photoreal' : DEFAULT_MAP_STACK_ID\);/);
  assert.match(scene, /const eagerPhotoreal =\s*!hasPhotorealCredentials \|\| startStack === 'photoreal';/);
  assert.match(scene, /initialStack: startStack,/);
  // The eager call is the only place the startup path awaits the loader.
  assert.match(scene, /const photoreal = eagerPhotoreal\s*\? await loadPhotoreal\(\)\s*: \{ tileset: null, route: 'osm', errors: \[\] \};/);
});

test('a plain start hands the controller a loader instead of a tileset', () => {
  assert.match(scene, /photorealLoader:\s*eagerPhotoreal \|\| !hasPhotorealCredentials/);
  assert.match(scene, /const loaded = await loadPhotoreal\(\);/);
  assert.match(scene, /loaded\.errors\.at\(-1\)\s*\|\|\s*new Error\('Google 3D Tiles unavailable'\)/);
});
