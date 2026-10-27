import { MAP_STACKS } from './catalog.js';
import { DEFAULT_MAP_STACK_ID } from './stackIds.js';
import { photorealUnavailableReason } from './availability.js';
import { keySetupRequirement } from '../keySetupCore.mjs';
import {
  createOsmImagery,
  createEsriImagery,
  createEsriStreetImagery,
  createEsriReferenceImagery,
  createIonImagery,
  ESRI_ATTRIBUTION_HTML,
} from './imagery.js';
import { createWorldTerrain, createKeylessTerrain } from './terrain.js';

/**
 * Internal source: the OpenStreetMap tiles the streets stack falls back to. It
 * is not a catalog stack, so it never appears in `getStacks()`; `reportAs`
 * makes the controller speak for the stack that fell back ('osm').
 */
const OSM_TILES_SOURCE = {
  id: 'osm-tiles',
  label: 'OpenStreetMap',
  shortLabel: 'OSM',
  kind: 'osm',
  requiresIon: false,
  reportAs: 'osm',
};

/** Select sources and setup guidance without putting provider branches in the controller. */
export function createDefaultMapSources({
  googleTileset = null,
  photorealLoader = null,
  cesiumToken = '',
  googleApiKey = '',
} = {}) {
  const ionToken = String(cesiumToken || '').trim();
  const hasIon = Boolean(ionToken);
  const hasGoogle = Boolean(String(googleApiKey || '').trim());
  const terrain = {
    id: hasIon ? 'world' : 'keyless',
    create: hasIon
      ? (request) => createWorldTerrain(ionToken, request)
      : createKeylessTerrain,
  };
  // Google 3D is either already loaded (`googleTileset`) or loaded on the first
  // selection (`photorealLoader`, which is offered only when credentials exist).
  const photorealReady = Boolean(googleTileset || photorealLoader);
  return {
    defaultId: DEFAULT_MAP_STACK_ID,
    unknownId: 'photoreal',
    recoveryId: photorealReady ? 'photoreal' : null,
    state: { hasCesiumIonToken: hasIon },
    sources: [
      ...MAP_STACKS.map((descriptor) => {
        const common = {
          descriptor,
          available: !descriptor.requiresIon || hasIon,
          unavailableReason: descriptor.requiresIon
            ? keySetupRequirement('cesium-ion')
            : null,
        };
        if (descriptor.kind === 'photoreal')
          return {
            ...common,
            available: photorealReady,
            unavailableReason: photorealUnavailableReason(hasIon || hasGoogle),
            tileset: googleTileset,
            // Google 3D draws the same place names and borders as the globe stacks.
            labels: createEsriReferenceImagery,
            ...(googleTileset || !photorealLoader
              ? {}
              : {
                  createTileset: ({ signal } = {}) =>
                    photorealLoader({ signal }),
                }),
          };
        const imagery =
          descriptor.kind === 'ion'
            ? () => createIonImagery(descriptor.style, ionToken)
            : descriptor.id === 'osm'
              ? createEsriStreetImagery
              : createEsriImagery;
        return {
          ...common,
          imagery,
          terrain,
          ...(descriptor.labelsOverlay
            ? { labels: createEsriReferenceImagery }
            : {}),
          ...(descriptor.id === 'esri-imagery'
            ? {
                credit: ESRI_ATTRIBUTION_HTML,
                constructionFallback: {
                  id: OSM_TILES_SOURCE.id,
                  message: 'Esri Satellite is unavailable; using OSM',
                },
                tileFailureFallback: {
                  id: OSM_TILES_SOURCE.id,
                  threshold: 2,
                  message: 'Esri Satellite tile requests failed; using OSM',
                },
              }
            : {}),
          ...(descriptor.id === 'osm'
            ? {
                credit: ESRI_ATTRIBUTION_HTML,
                constructionFallback: {
                  id: OSM_TILES_SOURCE.id,
                  message:
                    'Street map is unavailable; using OpenStreetMap tiles',
                },
                tileFailureFallback: {
                  id: OSM_TILES_SOURCE.id,
                  threshold: 2,
                  message:
                    'Street map tile requests failed; using OpenStreetMap tiles',
                },
              }
            : {}),
        };
      }),
      {
        descriptor: OSM_TILES_SOURCE,
        available: true,
        unavailableReason: null,
        imagery: createOsmImagery,
        terrain,
      },
    ],
  };
}
