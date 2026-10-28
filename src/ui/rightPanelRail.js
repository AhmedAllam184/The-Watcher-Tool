import { shouldHideCollapsedRightPanels } from './panelRailGeometry.js';

import { displayPanelScroller } from './displayPanelScroll.js';

/**
 * Lay out the sub-panels inside the TOOLS card for one synchronous pass.
 *
 * TOOLS is the third card of the left column (`#left-panel-stack`). The left
 * engine places and sizes the card, and the card's own body scrolls, so this
 * engine does not position or allocate anything. It keeps the policy that
 * belongs to the sub-panels: the Cyber accordion (one open panel), the Tactical
 * rule that hides collapsed launchers beside an open one, and the Display
 * scroll restoration.
 * @param {object} options Live DOM and caller policy.
 * @param {HTMLElement} options.stack The TOOLS card; its children are the sub-panels.
 * @param {Window} options.windowRef Viewport and media-query reader.
 * @param {{visible: boolean, variant: string}} options.hud Current HUD presentation.
 * @param {string} options.preferredPanelId Most recently opened panel.
 * @param {Function} options.onCollapse Update a panel's disclosure chrome.
 * @param {HTMLElement} options.displayPanel Display panel whose scroll is restored.
 * @param {Function} options.readDisplayScrollTop Read the caller's scroll restoration value.
 * @param {Document} [options.documentRef] Document supplying current keyboard focus.
 */
export function layoutRightPanelRail({
  stack,
  windowRef,
  hud,
  preferredPanelId,
  onCollapse,
  displayPanel,
  readDisplayScrollTop,
  documentRef = stack?.ownerDocument,
}) {
  if (!stack) return;

  const panels = [...stack.children].filter(
    (panel) =>
      panel.matches('[data-panel-id]:not(.panel-floating)') && !panel.hidden,
  );
  // Normalize restored state and theme entry without overwriting saved panel
  // preferences: Cyber keeps one sub-panel open at a time.
  if (hud.variant === 'cyber') {
    const expanded = panels.filter(
      (panel) => !panel.classList.contains('collapsed'),
    );
    const owner =
      expanded.find((panel) => panel.id === preferredPanelId) ||
      expanded.find((panel) => panel.contains(documentRef?.activeElement)) ||
      expanded[0];
    for (const panel of expanded) {
      if (panel === owner) continue;
      panel.classList.add('collapsed', 'cyber-accordion-collapsed');
      onCollapse(panel);
    }
  } else {
    for (const panel of panels) {
      if (!panel.classList.contains('cyber-accordion-collapsed')) continue;
      panel.classList.remove('collapsed', 'cyber-accordion-collapsed');
      onCollapse(panel);
    }
  }
  const isMobile = windowRef.matchMedia('(max-width: 720px)').matches;
  const hasExpandedPanel = panels.some(
    (panel) =>
      !panel.classList.contains('collapsed') &&
      (!isMobile || panel.id !== 'pp-toggles'),
  );
  const exclusive = shouldHideCollapsedRightPanels({
    hudVariant: hud.variant,
    hasExpandedPanel,
  });
  stack.classList.toggle('layout-exclusive', exclusive);
  for (const panel of panels) {
    if (exclusive && panel.classList.contains('collapsed'))
      panel.setAttribute('aria-hidden', 'true');
    else panel.removeAttribute('aria-hidden');
  }

  // The card's body scrolls; sub-panels keep their natural height inside it.
  stack.dataset.layoutMode = 'column';
  if (displayPanel && !displayPanel.classList.contains('collapsed')) {
    const scroller = displayPanelScroller(displayPanel);
    const maxScrollTop = Math.max(
      0,
      scroller.scrollHeight - scroller.clientHeight,
    );
    scroller.scrollTop = Math.min(readDisplayScrollTop(), maxScrollTop);
  }
}
