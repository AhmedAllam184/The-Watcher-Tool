import test from 'node:test';
import assert from 'node:assert/strict';
import { MAP_STACKS } from './catalog.js';
import { createDefaultMapSources } from './defaultSources.js';
import { DEFAULT_MAP_STACK_ID, MAP_STACK_IDS } from './stackIds.js';
import {
  MAP_STACK_STORAGE_KEY,
  readRememberedMapStack,
  writeRememberedMapStack,
} from './mapStackMemory.js';

function memory(initial = null) {
  const values = new Map(initial == null ? [] : [[MAP_STACK_STORAGE_KEY, initial]]);
  return {
    getItem: (key) => values.get(key) ?? null,
    setItem: (key, value) => values.set(key, value),
    read: () => values.get(MAP_STACK_STORAGE_KEY) ?? null,
  };
}

test('the start stack is flat OSM streets, and it is a real catalog entry', () => {
  assert.equal(DEFAULT_MAP_STACK_ID, 'osm');
  assert.ok(MAP_STACKS.some((stack) => stack.id === DEFAULT_MAP_STACK_ID));
});

test('the Cesium-free id list matches the catalog exactly, so the two cannot drift', () => {
  assert.deepEqual([...MAP_STACK_IDS].sort(), MAP_STACKS.map((stack) => stack.id).sort());
});

test('Google 3D stays a source but is never the start, with or without its tileset', () => {
  const withGoogle = createDefaultMapSources({ googleTileset: {}, googleApiKey: 'key' });
  assert.equal(withGoogle.defaultId, 'osm');
  const photoreal = withGoogle.sources.find((source) => source.descriptor.id === 'photoreal');
  assert.equal(photoreal.available, true, 'Google 3D is still selectable in MAP SOURCE');
  assert.equal(createDefaultMapSources({}).defaultId, 'osm');
});

test('a remembered pick comes back, and anything unknown or empty is ignored', () => {
  assert.equal(readRememberedMapStack(memory('photoreal')), 'photoreal');
  assert.equal(readRememberedMapStack(memory('esri-imagery')), 'esri-imagery');
  assert.equal(readRememberedMapStack(memory()), null);
  assert.equal(readRememberedMapStack(memory('not-a-stack')), null);
  assert.equal(readRememberedMapStack(memory('')), null);
});

test('only known stack ids are written, and a blocked store never throws', () => {
  const store = memory();
  assert.equal(writeRememberedMapStack('bing-aerial', store), true);
  assert.equal(store.read(), 'bing-aerial');
  assert.equal(writeRememberedMapStack('bogus', store), false);
  assert.equal(store.read(), 'bing-aerial');

  const blocked = {
    getItem: () => {
      throw new Error('denied');
    },
    setItem: () => {
      throw new Error('denied');
    },
  };
  assert.equal(readRememberedMapStack(blocked), null);
  assert.equal(writeRememberedMapStack('osm', blocked), false);
});

test('a missing storage area is no memory, not an error', () => {
  assert.equal(readRememberedMapStack(null), null);
  assert.equal(writeRememberedMapStack('osm', null), false);
});
