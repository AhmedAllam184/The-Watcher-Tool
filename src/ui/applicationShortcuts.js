const STYLE_KEYS = Object.freeze({
  1: 'normal',
  2: 'retro',
  3: 'surveillance',
  4: 'thermal',
  5: 'anime',
  6: 'noir',
  7: 'snow',
});

const isEditableTarget = (target) =>
  !!target?.isContentEditable || !!target?.matches?.('select, input, textarea');

const hasOpenDialog = (documentRef) =>
  !!documentRef.querySelector?.('dialog[open], [role="dialog"]:not([hidden])');

/** Any open dialog except the help panel, so "?" can also close the help. */
const hasOtherOpenDialog = (documentRef) =>
  [
    ...(documentRef.querySelectorAll?.(
      'dialog[open], [role="dialog"]:not([hidden])',
    ) ?? []),
  ].some((node) => node.id !== 'help-panel');

/**
 * Bind the application's existing bubbling keyboard shortcuts.
 * Capture-phase surfaces keep first refusal. The caller owns each action and
 * persistence; form controls keep native typing except for Escape.
 * @param {object} options
 * @param {Document} options.documentRef Keyboard event target.
 * @param {HTMLElement} options.searchInput Additional editing target.
 * @param {object} options.actions Existing application operations.
 * @returns {{destroy: Function}} Synchronous, idempotent listener cleanup.
 */
export function bindApplicationShortcuts({
  documentRef,
  searchInput,
  actions,
}) {
  const onKeyDown = (event) => {
    const isFormControl =
      event.target?.matches?.('select, input, textarea') ||
      event.target === searchInput;
    if (isFormControl && event.key !== 'Escape') return;

    if (
      event.key === '/' &&
      !event.ctrlKey &&
      !event.metaKey &&
      !event.altKey
    ) {
      if (isEditableTarget(event.target) || hasOpenDialog(documentRef)) return;
      event.preventDefault();
      actions.openSearch();
      return;
    }

    if (
      event.key === '?' &&
      !event.ctrlKey &&
      !event.metaKey &&
      !event.altKey
    ) {
      if (isEditableTarget(event.target) || hasOtherOpenDialog(documentRef))
        return;
      event.preventDefault();
      actions.toggleHelp();
      return;
    }

    if (STYLE_KEYS[event.key]) actions.setStyle(STYLE_KEYS[event.key]);
    if (event.key === 'Escape') actions.dismissSearch();
    const key = event.key.toLowerCase();
    if (key === 'h') actions.toggleHud();
    if (key === 'o') actions.toggleOrbit();
    if (key === 'v') actions.toggleCleanView();
    if (key === 'f') actions.toggleLayers();
    if (key === 'd') actions.cycleDetection();
    if (key === 'c') actions.toggleCctv();
  };
  documentRef.addEventListener('keydown', onKeyDown);
  return {
    destroy() {
      documentRef.removeEventListener('keydown', onKeyDown);
    },
  };
}
