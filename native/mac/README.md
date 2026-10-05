# CmuxPanel: the docked panel window

A small macOS app whose window sits inside cmux's main window, over
cmux's left sidebar, so cmux's own shadow and rounded corners frame it and
it reads as cmux's sidebar. It follows cmux: moves, resizes, the sidebar
divider, full screen and Spaces. It hides when cmux is hidden, minimised,
on another Space or quits, and comes back with it. The content is a
placeholder for now.

- `Sources/PanelLayout/`: the pure rules. Given cmux's window frame, the
  sidebar and cmux's state, it returns the panel's frame or why it hides,
  and whether the panel needs ordering above cmux's window. No AppKit, no
  Accessibility; `swift test` covers it.
- `Sources/CmuxPanel/`: the thin glue. Finds cmux (`com.cmuxterm.app`)
  its main window and that window's sidebar by Accessibility, watches it,
  and moves the panel. It never moves or resizes cmux.
- `Support/Info.plist` and `bundle.sh`: the app bundle and its signing.

## Build and test

Needs Xcode or the Command Line Tools (Swift 5.9 or later).

```sh
cd native/mac
swift build
swift test
```

## Bundle and sign

```sh
cd native/mac
./bundle.sh
```

This builds a release binary, wraps it in `build/CmuxPanel.app` (no Dock
icon) and signs it ad hoc, the same as the URL helper
(`codesign -f -s - build/CmuxPanel.app`). An ad hoc signature changes
with every build, so macOS treats each rebuild as a new app and the
Accessibility permission stops applying. To keep it across rebuilds, sign
with a certificate from your keychain instead:

```sh
SIGN_IDENTITY="Apple Development: Your Name (TEAMID)" ./bundle.sh
```

## Run

```sh
open native/mac/build/CmuxPanel.app
```

To stop it: `pkill -x CmuxPanel`.

## Grant the Accessibility permission

The first launch asks once, with the system prompt. Until it is on, the
panel shows a strip at the left of the main screen saying so, with a
button to the setting; later launches show that strip rather than
prompting again.

1. Open System Settings, Privacy & Security, Accessibility.
2. Turn on CmuxPanel (add it with the plus button from
   `native/mac/build/` if it is not listed).
3. Within a second the panel docks to cmux; no relaunch needed.

After an ad hoc rebuild, remove CmuxPanel from that list and add it
again, or the switch shows on while the permission does nothing.

## How it decides

- Covers cmux's sidebar inside cmux's window: cmux's left edge, from the
  bottom of the title bar row (so the traffic lights and title bar
  buttons stay clear) down to cmux's bottom edge.
- Width: the right edge of cmux's sidebar list, found by Accessibility as
  the scroll area cmux tags `Sidebar`, so it follows when the divider is
  dragged. If that is missing, where cmux's split view of panes starts.
  If neither is found (a cmux update changed its layout), a fixed 280
  points. Never wider than cmux's window.
- Top: where cmux's split view of panes starts, 28 points below the
  window's top today; 28 points when it is not found.
- Hides when cmux's sidebar is closed (its list gone and the panes
  starting within 40 points of the window's edge), so it never covers a
  terminal.
- Looks like part of cmux: borderless, no shadow, clear and non opaque so
  the bottom left corner can round to match cmux's window corner (16
  points, judged by eye; square in full screen). The background is the
  stock sidebar material for now, not cmux's exact sidebar colour.
- Stacking: at the normal window level, ordered directly above cmux's main
  window by its window number. Floating above everything would cover
  other apps; the normal level, just above cmux, lets any app that comes
  in front of cmux cover the panel too. When cmux comes forward (it is
  activated, or a click in it brings its windows up) its window lands
  over the panel, so the panel checks the window list's on-screen order on
  every refresh and, if anything sits between it and cmux's window or
  cmux is above it, orders itself back directly above. It refreshes at
  once when cmux is activated; otherwise the poll catches it within a
  quarter of a second.
- Full screen: the panel joins every Space, full screen ones included as
  an auxiliary window. It floats there, since only cmux shares that
  Space, and is ordered to the front whenever it is not yet on screen.
  The panel used to go missing in full screen because it was only ordered
  front when it first appeared; one already showing was moved but never
  ordered onto cmux's new full screen Space. It is now ordered on every
  refresh that finds it out of place. This cause is read from the code,
  not reproduced.
- Hides when cmux quits, is hidden, has no standard window, its main
  window is minimised, or that window is not on the Space being shown
  (no on-screen window in the window list covers nine tenths of it, which
  needs no Screen Recording permission).
- Accessibility notifications move it promptly; a 0.25 second poll
  catches what they miss, such as full screen animations, Space changes
  and the divider being dragged.
