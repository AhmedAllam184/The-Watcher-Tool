/**
 * Presentation constants for the GPS-interference layer, kept pure so the
 * help legend can read them without loading the layer or Cesium.
 */

/** Fill and outline per drawn level. Low cells are counted, never drawn. */
export const GPS_JAM_STYLE = Object.freeze({
  medium: Object.freeze({
    label: 'Some interference (2–10%)',
    swatch: '#fbbf24',
    fill: 'rgba(251,191,36,0.35)',
    outline: 'rgba(251,191,36,0.8)',
  }),
  high: Object.freeze({
    label: 'Strong interference (>10%)',
    swatch: '#f87171',
    fill: 'rgba(248,113,113,0.45)',
    outline: 'rgba(248,113,113,0.8)',
  }),
});
