import { createLocalGeoJsonLayer } from './localGeojsonCore.js';
import { INFRASTRUCTURE_DATA_URLS } from '../sources/infrastructureData.js';

/**
 * Create fresh datacenter, dam and airport layers without starting or loading them.
 * @param {object} services Caller-owned context, overlay and render operations.
 * @returns {object[]} Datacenters, dams, then airports, with stable standalone identities.
 */
export function createInfrastructureLayers(services) {
  const datacentersUrl = INFRASTRUCTURE_DATA_URLS['local-datacenters'];
  const damsUrl = INFRASTRUCTURE_DATA_URLS['local-dams'];
  const airportsUrl = INFRASTRUCTURE_DATA_URLS['local-airports'];
  const datacenters = createLocalGeoJsonLayer(
    {
      id: 'local-datacenters',
      url: datacentersUrl,
      name: 'Datacenters',
      color: '#00ffff', // Cyan
      icon: '▣',
      source: 'Local',
      osmDerived: true,
      labels: true,
      labelMax: 700,
      labelGridPx: 138,
    },
    services,
  );

  const dams = createLocalGeoJsonLayer(
    {
      id: 'local-dams',
      url: damsUrl,
      name: 'Dams',
      color: '#0088ff', // Blue
      icon: '▰',
      source: 'USACE',
      osmDerived: true,
      labels: true,
      labelMax: 900,
      labelGridPx: 132,
    },
    services,
  );

  const airports = createLocalGeoJsonLayer(
    {
      id: 'local-airports',
      url: airportsUrl,
      name: 'Airports',
      color: '#7dd3fc', // Sky
      icon: '✈',
      source: 'OurAirports',
      osmDerived: false,
      labels: true,
      labelMax: 600,
      labelGridPx: 150,
    },
    services,
  );

  return [datacenters, dams, airports];
}
