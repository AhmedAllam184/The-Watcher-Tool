import { createSatellitesLayer } from '../../layers/satellites/index.js';
import * as picking from '../../data/pickRegistry.js';
import * as focus from '../../data/focusDeemphasis.js';
import * as readout from '../../data/trackedReadout.js';
import * as overlays from '../../overlays/worldOverlay.js';
import * as context from '../../data/contextStore.js';
import * as render from '../../renderGovernor.js';
import * as layerState from '../../data/layerState.js';
import { isCivil, isMilitary } from '../../data/militarySatellites.js';

function applicationServices() {
  return {
    picking,
    focus,
    readout,
    overlays,
    context,
    render,
    layerState,
  };
}

/** Construct the civil Satellites layer (everything that is not military). */
export function createApplicationSatellites({ source }) {
  return createSatellitesLayer({
    source,
    services: applicationServices(),
    id: 'satellites',
    name: 'Satellites',
    filter: isCivil,
  });
}

/**
 * Construct the Military Satellites layer: the same catalogue, filtered to
 * military members, drawn in the military class colour. It has no DENSE mode
 * and does not own the ISS label, which belongs to the civil layer.
 */
export function createApplicationMilitarySatellites({ source }) {
  return createSatellitesLayer({
    source,
    services: applicationServices(),
    id: 'military-satellites',
    name: 'Military Satellites',
    filter: isMilitary,
    groupTag: 'military',
    allowDense: false,
    ownsIssOverlay: false,
  });
}
