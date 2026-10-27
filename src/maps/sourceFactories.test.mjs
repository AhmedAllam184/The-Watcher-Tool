import test from 'node:test';
import assert from 'node:assert/strict';
import * as Cesium from 'cesium';
import {
  createEsriReferenceImagery,
  createEsriStreetImagery,
  createIonImagery,
  createOsmImagery,
} from './imagery.js';
import { MAP_STACKS } from './catalog.js';
import { createWorldTerrain, createKeylessTerrain } from './terrain.js';
import { createDefaultMapSources } from './defaultSources.js';

test('Esri uses Re:Earth without keys and preserves ion terrain when configured', async () => {
  const originalTerrain = Cesium.CesiumTerrainProvider.fromUrl;
  const originalResource = Cesium.IonResource.fromAssetId;
  const calls = [];
  try {
    Cesium.CesiumTerrainProvider.fromUrl = async (resource) => {
      calls.push(resource);
      return { resource };
    };
    Cesium.IonResource.fromAssetId = async () =>
      assert.fail('keyless mode must not acquire ion terrain');
    const keyless = createDefaultMapSources();
    const esri = keyless.sources.find(
      ({ descriptor }) => descriptor.id === 'esri-imagery',
    );
    assert.equal(esri.available, true);
    assert.equal(esri.terrain.id, 'keyless');
    assert.equal(esri.terrain.create, createKeylessTerrain);
    await esri.terrain.create();
    // A Resource, not a bare URL: the retry policy rides on it (terrainRetry.js).
    assert.equal(calls.length, 1);
    assert.ok(calls[0] instanceof Cesium.Resource);
    assert.equal(
      calls[0].url,
      'https://terrain.reearth.land/cesium-mesh/ellipsoid',
    );
    assert.equal(calls[0].retryAttempts, 3);
    assert.equal(typeof calls[0].retryCallback, 'function');
    assert.equal(
      keyless.sources.find(({ descriptor }) => descriptor.id === 'photoreal')
        .available,
      false,
    );
    for (const credentials of [
      { googleApiKey: 'test-key' },
      { cesiumToken: 'test-token' },
    ]) {
      const keyed = createDefaultMapSources({
        ...credentials,
        googleTileset: { show: true },
      });
      assert.equal(
        keyed.sources.find(({ descriptor }) => descriptor.id === 'photoreal')
          .available,
        true,
      );
      assert.equal(
        keyed.sources.find(({ descriptor }) => descriptor.id === 'esri-imagery')
          .terrain.id,
        credentials.cesiumToken ? 'world' : 'keyless',
      );
      const failedTileset = createDefaultMapSources(credentials);
      assert.equal(
        failedTileset.sources.find(
          ({ descriptor }) => descriptor.id === 'photoreal',
        ).available,
        false,
      );
    }
  } finally {
    Cesium.CesiumTerrainProvider.fromUrl = originalTerrain;
    Cesium.IonResource.fromAssetId = originalResource;
  }
});

test('imagery and terrain pass their own ion token without relying on SDK defaults', async () => {
  const originalImagery = Cesium.IonImageryProvider.fromAssetId;
  const originalResource = Cesium.IonResource.fromAssetId;
  const originalTerrain = Cesium.CesiumTerrainProvider.fromUrl;
  const calls = [];
  const defaultToken = Cesium.Ion.defaultAccessToken;
  try {
    Cesium.IonImageryProvider.fromAssetId = async (id, options) => {
      calls.push({ kind: 'imagery', id, options });
      return { id };
    };
    Cesium.IonResource.fromAssetId = async (id, options) => {
      calls.push({ kind: 'resource', id, options });
      return { id };
    };
    Cesium.CesiumTerrainProvider.fromUrl = async (resource, options) => {
      calls.push({ kind: 'terrain', resource, options });
      return { id: 'terrain' };
    };
    await createIonImagery(Cesium.IonWorldImageryStyle.AERIAL, 'imagery-token');
    const result = await createWorldTerrain('terrain-token');
    assert.equal(calls[0].options.accessToken, 'imagery-token');
    assert.equal(calls[1].options.accessToken, 'terrain-token');
    assert.equal(calls[1].id, 1);
    assert.equal(calls[2].options.requestVertexNormals, true);
    assert.equal(result.provider.id, 'terrain');
    assert.equal(Cesium.Ion.defaultAccessToken, defaultToken);
  } finally {
    Cesium.IonImageryProvider.fromAssetId = originalImagery;
    Cesium.IonResource.fromAssetId = originalResource;
    Cesium.CesiumTerrainProvider.fromUrl = originalTerrain;
  }
});

test('cancellation after ion metadata prevents terrain construction', async () => {
  const originalResource = Cesium.IonResource.fromAssetId;
  const originalTerrain = Cesium.CesiumTerrainProvider.fromUrl;
  const controller = new AbortController();
  try {
    Cesium.IonResource.fromAssetId = async () => {
      controller.abort();
      return {};
    };
    Cesium.CesiumTerrainProvider.fromUrl = () =>
      assert.fail('cancelled terrain construction');
    await assert.rejects(
      createWorldTerrain('test-token', { signal: controller.signal }),
      { name: 'AbortError' },
    );
  } finally {
    Cesium.IonResource.fromAssetId = originalResource;
    Cesium.CesiumTerrainProvider.fromUrl = originalTerrain;
  }
});

test('credentialed source factories reject an omitted token instead of consuming an SDK default', async () => {
  assert.throws(
    () => createIonImagery(Cesium.IonWorldImageryStyle.AERIAL, ''),
    /explicit token/,
  );
  await assert.rejects(createWorldTerrain(' '), /explicit ion token/);
});

test('both Google 3D routes keep tiles drawing while draped imagery loads', async () => {
  const { createGoogleDirectTileset, createGoogleIonTileset } =
    await import('./google3d.js');
  const calls = [];
  const sdk = {
    createGooglePhotorealistic3DTileset: async (...args) => {
      calls.push(args);
      return 'direct';
    },
    IonResource: { fromAssetId: async (id, options) => ({ id, ...options }) },
    Cesium3DTileset: {
      fromUrl: async (...args) => {
        calls.push(args);
        return 'ion';
      },
    },
  };
  assert.equal(await createGoogleDirectTileset(sdk, 'key'), 'direct');
  assert.equal(await createGoogleIonTileset(sdk, 'token'), 'ion');
  assert.deepEqual(calls[0], [
    { key: 'key', onlyUsingWithGoogleGeocoder: true },
    { asynchronouslyLoadImagery: true },
  ]);
  assert.equal(calls[1][0].id, 2275207);
  assert.equal(calls[1][0].accessToken, 'token');
  assert.equal(calls[1][1].asynchronouslyLoadImagery, true);
  assert.equal(calls[1][1].enableCollision, true);
});

test('the streets stack draws English Esri streets and falls back to OSM tiles that no list shows', () => {
  const registry = createDefaultMapSources();
  const byId = (id) =>
    registry.sources.find(({ descriptor }) => descriptor.id === id);
  const streets = byId('osm');
  assert.equal(streets.descriptor.label, 'Streets');
  assert.equal(streets.descriptor.shortLabel, 'MAP');
  assert.equal(streets.imagery, createEsriStreetImagery);
  assert.equal(
    streets.labels,
    undefined,
    'the streets stack has its own labels',
  );
  assert.deepEqual(streets.constructionFallback, {
    id: 'osm-tiles',
    message: 'Street map is unavailable; using OpenStreetMap tiles',
  });
  assert.equal(streets.tileFailureFallback.id, 'osm-tiles');
  assert.equal(streets.tileFailureFallback.threshold, 2);
  const tiles = byId('osm-tiles');
  assert.equal(tiles.imagery, createOsmImagery);
  assert.equal(tiles.descriptor.reportAs, 'osm');
  assert.equal(
    MAP_STACKS.some(({ id }) => id === 'osm-tiles'),
    false,
    'the OSM tiles are internal, not a catalog stack',
  );
  const satellite = byId('esri-imagery');
  assert.equal(satellite.tileFailureFallback.id, 'osm-tiles');
  assert.equal(satellite.constructionFallback.id, 'osm-tiles');
});

test('Google 3D is labels-capable with the same reference layer as the globe stacks', () => {
  const googleTileset = { show: false };
  const { sources } = createDefaultMapSources({ googleTileset });
  const photoreal = sources.find(
    ({ descriptor }) => descriptor.id === 'photoreal',
  );
  assert.equal(photoreal.labels, createEsriReferenceImagery);
  assert.equal(photoreal.imagery, undefined);
});
