# CmuxPanel: the docked panel window

A small macOS app whose window sits flush with the left edge of cmux's
main window and follows it: moves, resizes, full screen and Spaces. It
hides when cmux is hidden, minimised, on another Space or quits, and comes
back with it. The content is a placeholder for now.

- `Sources/PanelLayout/`: the pure rules. Given cmux's window frame, the
  screens and cmux's state, it returns the panel's frame or why it hides,
  and when and where to push cmux to make room (`Push.swift`).
  No AppKit, no Accessibility; `swift test` covers it.
- `Sources/CmuxPanel/`: the thin glue. Finds cmux (`com.cmuxterm.app`)
  and its main window by Accessibility, watches it, and moves the panel.
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

- Docks outside cmux's left edge, same top and height, when the screen
  cmux is on has room clear of the Dock.
- When it has no room (cmux at or near the screen's left edge, say
  maximised), it makes room: cmux's main window moves right and narrows
  by the shortfall, keeping its right edge, so the panel fits flush to its
  left. It waits until cmux's frame has been still for half a second with
  no mouse button held, so a drag is never fought, and pushes again
  whenever cmux is dragged back to the edge or maximised. It never pushes
  cmux narrower than 640 points or off the screen, and stops asking for a
  frame cmux refused until cmux moves.
- On quit (Quit, `pkill -x CmuxPanel` or Control C) it gives cmux back the
  frame it had before the latest push, but only if cmux still has the
  frame the push left it at; a move or resize since is left alone.
- Where it cannot push (full screen, too narrow, or cmux refused the
  frame) it overlaps cmux's left strip, as before. When it overlaps, it
  floats above cmux while cmux is the frontmost app, so a click inside
  cmux cannot cover it, and drops back to the normal level when another
  app comes to the front. In full screen it always floats, since nothing
  else shares that Space.
- Hides when cmux quits, is hidden, has no standard window, its main
  window is minimised, or that window is not on the Space being shown
  (checked against the window list, which needs no Screen Recording
  permission).
- Accessibility notifications move it promptly; a 0.25 second poll
  catches what they miss, such as full screen animations and Space
  changes.
