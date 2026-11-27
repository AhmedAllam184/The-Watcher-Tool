# Phone layout

The only phone rule is `(max-width: 768px)` in both `mobileSheetState.js` and
`mobile.css`. It applies to narrow desktop windows too; coarse-pointer laptops
above 768px keep the desktop UI. Above the rule the phone DOM is detached and
portals restore exact anchors. Existing desktop styles and panel state remain
authoritative. There is no additional bottom navigation: the available tools
do not form 3–5 natural destinations.

The dark map-first shell uses the existing surface/text/accent tokens, a 56px
search pill with the actual place/object search input, the existing quick-layer
controller (Flights, Ships and Weather radar first), and 48px map buttons.
Layer state uses plus/check indicators as well as aria-pressed and color.
Local SVG strokes render the app's layers/navigation/globe/tune actions without
requiring the external icon font. Home means the existing start view, not GPS.

The menu provides Layers, Tools, Display, Visual presets, Places, Guided tours,
CCTV and Street Level. Those live nodes are placed into the single scrolling
sheet. Object selection opens the actual details owner at half height; close,
Escape and swipe-down from peek dismiss. Handle taps cycle peek/half/full;
vertical handle drags step between snaps with a 40px threshold. The rest of
the map receives input normally. Sheet content scrolls independently.

Safe-area insets, 100dvh, UI touch-action: manipulation, and the globe's own
touch-action preserve map gestures without page scrolling. The full snap stops
below the search/chips. Map attribution follows the sheet edge. Snaps are
instant, including with reduced motion. The manifest and PNG home-screen icons support
standalone launch; this is not an offline-data/service-worker implementation.

## Acceptance tooling

No dependencies need installing. `node scripts/build-mobile-qa.mjs` invokes
Vite with the normal HTML/Cesium plugins, `envDir: false`, no provider
middleware and a worktree-local cache, avoiding environment files and writes
through the dependency junction. For preview:

```powershell
node --input-type=module -e "import {preview} from 'vite'; import config from './scripts/mobile-preview.config.mjs'; await preview({...config,configFile:false});"
node scripts/qa-mobile-layout.mjs
```

Set `MOBILE_QA_BROWSER` to an installed browser executable if needed. The
`--offline` option answers local-origin requests with exact built bytes via
CDP when loopback networking is forbidden. External requests are aborted in
both modes. It dismisses the loading/onboarding overlays for chrome inspection;
it does not claim live-map/provider acceptance. Object screenshots use an
explicit fictional selection event. Screenshots and geometry go to the sibling
`mobile-shots` directory, outside Git.

`node scripts/build-mobile-qa.mjs --baseline` builds the committed entry,
stylesheet and index for desktop comparison. Run the screenshot script with
`--baseline` before rebuilding the candidate. Clock text is fixed for captures.

## Next round / limits

Local acceptance on Node 26.13.1: the environment-free Vite build, format,
import/package boundaries, setup doctor and layer-token checks passed. The
37 focused sheet/theme tests passed. Offline Chrome acceptance passed at
390×844 and 360×780, including Escape, handle drag dismissal, details placement
and restoring search on desktop resize. Desktop before/after captures differ
by at most 2/255 per color channel, with no pixels above that tolerance.
The full suite was attempted normally and hung on restricted socket work;
the bounded run completed with 6,826 passed, 44 failed, 2 cancelled and 10
skipped. Network/native/auth/Git integration failures remain unresolved in
this sandbox; these are not a clean full-suite acceptance. Tracking regression
could not reach the local server. Live device/provider acceptance remains due.

- Scene Director's playback/runtime overlay, expanded Street Level viewer,
  cockpit-specific surfaces, voice controls, provider settings and Help remain with their
  specialized owners. Guided tour controls are in the sheet, but Director's
  active playback controls are not migrated. These need a separate phone pass.
- Automatic feature-driven disclosure of a hidden rail tool does not itself
  switch the active phone sheet. Open that tool from the menu; selection
  details are the explicitly integrated automatic disclosure path.
- Tools nested accordion, complex popup placement, large text, real device
  keyboard/safe-area changes, live camera gestures and installed iOS/Android
  launch need device acceptance. No network/provider behavior was changed.
