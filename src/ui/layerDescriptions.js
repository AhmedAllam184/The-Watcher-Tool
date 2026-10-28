/**
 * Plain-English one-liners for the Data Layers panel.
 *
 * Each entry says what the layer shows and, where it applies, what it needs
 * (an API key or local hardware). Keep every sentence at or below 90
 * characters and free of unexplained jargon. Pure data: no DOM or app imports.
 * @module ui/layerDescriptions
 */

/** @type {Readonly<Record<string, string>>} */
export const LAYER_DESCRIPTIONS = Object.freeze({
  satellites: 'Satellites in orbit, placed from public orbit data (CelesTrak).',
  flights: 'Commercial and private aircraft tracked live from OpenSky Network.',
  military:
    'Military aircraft located live from public aircraft broadcasts (adsb.lol).',
  'local-adsb':
    'Planes picked up by your own USB radio receiver (RTL-SDR dongle). Needs the hardware.',
  'ais-live-vessels':
    'Live ship positions from AIS transponders. Needs an AISStream key.',
  traffic:
    'Road congestion on the street map. Live flow needs an optional TomTom key.',
  transit:
    'Live buses and trains in supported cities, such as Boston, Austin and Helsinki.',
  bikeshare:
    'Live bike availability at public bike-share stations (Lyft and BCycle).',
  cctv: 'Public road and street cameras run by city and state transport agencies.',
  'recent-imagery':
    'Recent satellite photos of the ground from NASA, as map tiles.',
  'street-level':
    'Street-level photos from Mapillary, a crowd-sourced image service. Needs a key.',
  'alpr-cameras':
    'License-plate reader cameras mapped in OpenStreetMap (US and Canada). Locations only.',
  'military-installations':
    'Military bases, airfields, naval bases and ranges mapped in OpenStreetMap.',
  'military-satellites':
    'Military and intelligence satellites (CelesTrak list + programme names). Inferred.',
  'local-datacenters':
    'Data center sites from a bundled OpenStreetMap dataset.',
  'telegeography-submarine-cables':
    'Undersea internet cables and their landing points, from TeleGeography.',
  'local-dams': 'Dams from a bundled OpenStreetMap dataset.',
  'rocket-launches':
    'Rocket launches and space missions from the last 30 days, via Launch Library 2.',
  earthquakes: 'Recent earthquakes worldwide from the USGS real-time feed.',
  'local-firms':
    'Fires detected by NASA satellites in the last day. Needs a free FIRMS key.',
  'fire-perimeters':
    'Outlines of current US wildfire incidents from the National Interagency Fire Center.',
  wind: 'Animated surface wind from NOAA GFS or ECMWF weather model forecasts.',
  'weather-radar':
    'Rain radar over the contiguous US, refreshed about every 4 minutes.',
  'weather-satellite':
    'Infrared cloud images from NOAA GOES weather satellites, refreshed often.',
  'weather-lightning':
    'Lightning strike density over the Americas and Pacific, from the last 15 minutes.',
  'weather-cyclones':
    'Hurricane and tropical storm positions and forecast cones from NOAA centers.',
  directions:
    'Route between two points along real streets, using OpenStreetMap routing.',
  radio:
    'Internet radio stations worldwide, placed on the map from Radio Browser.',
  'local-airports':
    'Large and scheduled-service airports worldwide, with names and codes (OurAirports).',
  'gps-interference':
    'Aircraft reporting degraded GPS: a sign of jamming or spoofing. Inferred, not confirmed.',
  'conflict-events':
    'Armed-conflict events reported in the news (GDELT) or verified by ACLED with a key.',
});

/**
 * Return the plain-English description for a layer, or an empty string when
 * the layer has none.
 * @param {string} id Layer id, as used in the Data Layers panel.
 * @returns {string}
 */
export function describeLayer(id) {
  return Object.hasOwn(LAYER_DESCRIPTIONS, id) ? LAYER_DESCRIPTIONS[id] : '';
}
