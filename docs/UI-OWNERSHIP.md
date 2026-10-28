# Application UI ownership

`src/ui/applicationShell.js` constructs controls, connects their explicit inputs
and coordinates shutdown. `shellFacade.js` preserves the methods used by layers,
scene playback and voice. It delegates; new behavior belongs with its owner.

| Owner | Responsibility |
| --- | --- |
| `navigationController.js` | Navigation generation, tracking release and camera authority |
| `focusReturn.js` | Pure policy for the straight-down return when an object focus ends; `navigationController.js` remembers the view and flies the return |
| `locationNavigation.js` | Destination lookup/selection, orbit, world jumps and globe-reset completion |
| `objectSearch.js` | Pure live-object lookup (flights, ships, satellites) behind the place search box |
| `liveObjectFocus.js` | Follows or selects a live object found by the search, through the shell's navigation authority |
| `cockpitCoordinator.js` | Cockpit entry/rollback, readouts and the single Display portal |
| `visualSettings.js` | Effects, detection overrides, visual restoration and render-loop lifetime |
| `panelChrome.js` | Disclosure, docking, layout and Cockpit panel restoration |
| `aircraftDisplay.js` | Shared commercial/military 3D display preferences and controls |
| `layerBindings.js` | Data-manager attachment, selected-tracker adoption and camera-entry listeners |
| `displayBindings.js` | Keyboard/display subscriptions and frame-rate monitor lifetime |
| `shareRestoration.js` | Initial share/layer restoration and cancellation |
| `shellFeedback.js` | Loading feedback, notices and toast lifetime |
| `selectionDetails.js` | Plain-language details panel for the selected object |
| `squawkAlerts.js` | Toasts and recent list for emergency transponder squawks announced by the flight layers |
| `helpPanel.js` | "?" help and map legend dialog, its focus and its larger-text setting |
| `visualPresetLayers.js` | QUICK LAYERS section of the VISUAL PRESETS tray: overlay chips with on/off state and the needs-a-key dot, plus "All layers" |
| `footerReadouts.js` | "Show readouts" switch (Display panel): clock and coordinates in the bottom footer, persisted |
| `textSize.js` | Larger-text preference: the document class and its saved flag |

Owners receive named services, elements, operations and readers. They do not
receive the application shell itself. Readers resolve a replaceable collaborator
at use time; operations cross an ownership boundary without copying its state.
The facade exposes existing properties as delegates rather than duplicate state.

Shutdown has two phases. First revoke input, deferred navigation, camera-entry
listeners, lookups, timers and rendering work. Then await Context restoration,
release sensor overrides while the manager is still attached, detach layer
services and destroy scene resources. Late callbacks cannot acquire the camera.
Manager replacement also releases subscriptions and the previous Directions
module even if the replacement does not provide a Directions layer.

Source-contract tests follow both sides of delegated wiring. Lifecycle tests
exercise pending reset cancellation, stale camera callbacks, replacement and
idempotent teardown. Browser acceptance covers the composed application, including
share restoration, scene commands, navigation, Cockpit, display and voice.
