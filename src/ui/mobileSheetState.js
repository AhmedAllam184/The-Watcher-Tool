/** One phone breakpoint shared by the placement owner and CSS contract tests. */
export const PHONE_QUERY = '(max-width: 768px)';
export const SHEET_STATES = Object.freeze(['closed', 'peek', 'half', 'full']);

/** Handle taps cycle upward; a downward drag steps down, then dismisses. */
export function nextSheetState(state, action, delta = 0) {
  const index = Math.max(0, SHEET_STATES.indexOf(state));
  if (action === 'dismiss') return 'closed';
  if (action === 'tap') return SHEET_STATES[index >= 3 ? 1 : index + 1];
  if (action === 'drag' && Math.abs(delta) >= 40)
    return SHEET_STATES[Math.max(0, Math.min(3, index + (delta < 0 ? 1 : -1)))];
  return SHEET_STATES[index];
}
