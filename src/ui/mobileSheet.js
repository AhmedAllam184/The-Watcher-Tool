import { PHONE_QUERY, nextSheetState } from './mobileSheetState.js';

/** Phone placement only. Feature controls, selection and camera remain owned
 * by their existing controllers. Every portal has an exact return anchor. */
export function createMobileSheet({
  documentRef = document,
  windowRef = window,
  hideDetails = () => {},
} = {}) {
  const doc = documentRef;
  const win = windowRef;
  const query = win.matchMedia(PHONE_QUERY);
  const root = doc.createElement('div');
  root.id = 'mobile-shell';
  root.innerHTML = `
    <div class="mobile-search" role="search" aria-label="The Watcher search">
      <button id="mobile-menu" type="button" aria-label="Open The Watcher menu" aria-controls="mobile-sheet"><img src="/logo.svg" alt="" /></button>
      <div id="mobile-search-slot"></div>
      <button id="mobile-settings" type="button" aria-label="Open display settings" aria-controls="mobile-sheet"><svg viewBox="0 0 24 24" aria-hidden="true"><path d="M4 6h16M4 12h16M4 18h16M9 3v6M15 9v6M9 15v6"/></svg></button>
    </div>
    <div id="mobile-chip-slot" aria-label="Quick layers"></div>
    <nav class="mobile-map-actions" aria-label="Map controls">
      <button id="mobile-layers" type="button" aria-label="Open layers" aria-controls="mobile-sheet"><svg viewBox="0 0 24 24" aria-hidden="true"><path d="m12 3 9 5-9 5-9-5 9-5Zm-9 9 9 5 9-5M3 16l9 5 9-5"/></svg></button>
      <button id="mobile-north" type="button" aria-label="Reset map to north up"><svg viewBox="0 0 24 24" aria-hidden="true"><path d="m12 3 7 17-7-4-7 4 7-17Z"/></svg></button>
      <button id="mobile-home" type="button" aria-label="Return to start view"><svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="12" cy="12" r="9"/><path d="M3 12h18M12 3c-6 5-6 13 0 18 6-5 6-13 0-18Z"/></svg></button>
    </nav>
    <section id="mobile-sheet" role="region" aria-labelledby="mobile-sheet-title" hidden>
      <header class="mobile-sheet-header">
        <button id="mobile-sheet-handle" type="button" aria-label="Expand sheet" aria-controls="mobile-sheet-body"><span></span></button>
        <div class="mobile-sheet-heading"><h2 id="mobile-sheet-title">The Watcher</h2><button id="mobile-sheet-close" type="button" aria-label="Close sheet">×</button></div>
      </header>
      <div id="mobile-sheet-body"></div>
    </section>`;
  const find = (id) => root.querySelector('#' + id);
  const sheet = find('mobile-sheet');
  const body = find('mobile-sheet-body');
  const handle = find('mobile-sheet-handle');
  const removers = [];
  const portals = new Map();
  let state = 'closed';
  let active = null;
  let returnFocus = null;
  let dragStart = null;
  let dragged = false;
  let mounted = false;
  let panelPortal = null;
  const listen = (target, type, fn, options) => {
    target.addEventListener(type, fn, options);
    removers.push(() => target.removeEventListener(type, fn, options));
  };
  function move(node, host) {
    if (!node) return;
    if (!portals.has(node)) {
      const anchor = doc.createComment('phone placement return');
      node.before(anchor);
      portals.set(node, anchor);
    }
    host.append(node);
  }
  function restore(node) {
    const anchor = portals.get(node);
    if (!anchor) return;
    anchor.replaceWith(node);
    portals.delete(node);
  }
  function releasePanel() {
    if (panelPortal) {
      panelPortal.removeAttribute('data-mobile-sheet-panel');
      // Give back the desktop fold state that open() lifted for the sheet.
      if (panelPortal.dataset.mobileSheetWasCollapsed === '1')
        panelPortal.classList.add('collapsed');
      delete panelPortal.dataset.mobileSheetWasCollapsed;
      restore(panelPortal);
      panelPortal = null;
    }
    body.replaceChildren();
  }
  function setState(next, dismissDetails = true) {
    state = next;
    sheet.dataset.snap = state;
    sheet.hidden = state === 'closed';
    handle.setAttribute(
      'aria-label',
      `Sheet ${state}. ${state === 'full' ? 'Return to peek' : 'Expand sheet'}`,
    );
    handle.setAttribute(
      'aria-expanded',
      String(state !== 'peek' && state !== 'closed'),
    );
    if (state === 'closed') {
      if (dismissDetails && active === 'selection-details') hideDetails();
      releasePanel();
      active = null;
      if (returnFocus?.isConnected) returnFocus.focus({ preventScroll: true });
    }
  }
  const entries = [
    ['data-panel', 'Layers'],
    ['right-context-rail', 'Tools'],
    ['pp-toggles', 'Display'],
    ['control-panel', 'Visual presets'],
    ['location-bar', 'Places'],
    ['scene-panel', 'Guided tours'],
    ['cctv-panel', 'CCTV'],
    ['street-level-panel', 'Street Level'],
  ];
  function open(id = 'menu', snap = 'half', focus = true) {
    if (!mounted) return;
    if (state === 'closed') returnFocus = doc.activeElement;
    releasePanel();
    active = id;
    find('mobile-sheet-title').textContent =
      id === 'menu'
        ? 'The Watcher'
        : entries.find(([key]) => key === id)?.[1] || 'Object details';
    if (id === 'menu') {
      const menu = doc.createElement('nav');
      menu.className = 'mobile-menu-list';
      menu.setAttribute('aria-label', 'The Watcher tools');
      for (const [key, label] of entries) {
        if (!doc.getElementById(key)) continue;
        const button = doc.createElement('button');
        button.type = 'button';
        button.textContent = label + ' →';
        button.onclick = () => open(key);
        menu.append(button);
      }
      body.append(menu);
    } else {
      const node = doc.getElementById(id);
      if (!node) return setState('closed');
      panelPortal = node;
      node.setAttribute('data-mobile-sheet-panel', '');
      // The sheet hides panel headers, so a panel folded on desktop (Places,
      // Guided tours, CCTV, Street Level) would open as an empty sheet.
      if (node.classList.contains('collapsed')) {
        node.dataset.mobileSheetWasCollapsed = '1';
        node.classList.remove('collapsed');
      }
      move(node, body);
    }
    setState(snap);
    if (focus) handle.focus({ preventScroll: true });
  }
  listen(find('mobile-menu'), 'click', () => open());
  listen(find('mobile-settings'), 'click', () => open('pp-toggles'));
  listen(find('mobile-layers'), 'click', () => open('data-panel'));
  listen(find('mobile-north'), 'click', () =>
    doc.getElementById('north-up-view')?.click(),
  );
  listen(find('mobile-home'), 'click', () =>
    doc.getElementById('reset-globe-view')?.click(),
  );
  listen(find('mobile-sheet-close'), 'click', () => setState('closed'));
  listen(handle, 'click', () => {
    if (!dragged) setState(nextSheetState(state, 'tap'));
    dragged = false;
  });
  listen(handle, 'pointerdown', (event) => {
    if (event.isPrimary === false || event.button !== 0) return;
    dragStart = event.clientY;
    dragged = false;
    handle.setPointerCapture(event.pointerId);
  });
  listen(handle, 'pointerup', (event) => {
    if (dragStart === null) return;
    const delta = event.clientY - dragStart;
    dragStart = null;
    dragged = Math.abs(delta) >= 40;
    if (dragged) setState(nextSheetState(state, 'drag', delta));
  });
  listen(handle, 'pointercancel', () => {
    dragStart = null;
    dragged = false;
  });
  listen(
    doc,
    'keydown',
    (event) => {
      if (mounted && state !== 'closed' && event.key === 'Escape') {
        event.stopPropagation();
        setState('closed');
      }
    },
    true,
  );
  // Existing details owner shows/hides in response to selection. Observe its
  // disclosure, never reproduce selection state or alter its refresh lifetime.
  const details = doc.getElementById('selection-details');
  const observer = new win.MutationObserver(() => {
    if (!mounted || !details) return;
    if (!details.hidden && active !== details.id)
      open(details.id, 'half', false);
    else if (details.hidden && active === details.id) setState('closed');
  });
  if (details)
    observer.observe(details, {
      attributes: true,
      attributeFilter: ['hidden'],
    });
  function sync() {
    if (query.matches === mounted) return;
    if (query.matches) {
      mounted = true;
      doc.body.append(root);
      doc.documentElement.classList.add('phone-layout');
      move(
        doc.querySelector('.location-search-wrap'),
        find('mobile-search-slot'),
      );
      move(doc.getElementById('quick-layer-chips'), find('mobile-chip-slot'));
      if (details && !details.hidden) open(details.id, 'half', false);
    } else {
      setState('closed', false);
      for (const node of [...portals.keys()]) restore(node);
      root.remove();
      doc.documentElement.classList.remove('phone-layout');
      mounted = false;
    }
  }
  listen(query, 'change', sync);
  sync();
  return {
    destroy() {
      observer.disconnect();
      for (const remove of removers) remove();
      releasePanel();
      for (const node of [...portals.keys()]) restore(node);
      root.remove();
      doc.documentElement.classList.remove('phone-layout');
    },
  };
}
