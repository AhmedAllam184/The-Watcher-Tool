/**
 * Ring and row colours for the inferred airport disruption overlay. Shared by
 * the Airports layer, its row and the help legend, so the three never drift.
 */

/** Fill and outline per affected level. Fill is translucent; outline is solid. */
export const AIRPORT_STATUS_STYLE = Object.freeze({
  disrupted: Object.freeze({
    label: 'Disrupted',
    swatch: '#f87171',
    fill: 'rgba(248,113,113,0.12)',
  }),
  watch: Object.freeze({
    label: 'Watch',
    swatch: '#fbbf24',
    fill: 'rgba(251,191,36,0.12)',
  }),
});
