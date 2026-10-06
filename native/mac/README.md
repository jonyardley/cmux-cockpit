# Cockpit for macOS: the helper app and the cmux sidebar extension

cmux hosts compiled SwiftUI sidebars through ExtensionKit. Cockpit is two
parts, built together from `project.yml` with XcodeGen:

- `Cockpit.app` (`Host/`): the helper app. Unsandboxed, no Dock icon, no
  window. For now it only writes a heartbeat; later it starts the runner
  and publishes the panel model.
- `CockpitSidebar.appex` (`Sidebar/`), embedded in the app: the sandboxed
  extension cmux draws in its left sidebar.
- `Shared/`: the names and the heartbeat rule both targets compile.
  `Tests/main.swift` checks the rule; `native/mac/test.sh` runs it.

The two talk through the App Group `9S5FG4LQAF.dev.jonyardley.cockpit`:
a folder only they can reach, plus a bare distributed notification
(`dev.jonyardley.cockpit.changed`) that says "look again".

## How the extension knows the helper is running

The helper writes the time into `heartbeat` in the group folder every
second, and posts the notification when it starts and when it stops. The
extension reads the file when the notification arrives and every two
seconds besides, and calls the helper running while the latest beat is
under five seconds old. Stopping it with `pkill -x Cockpit` (or Control C
when the binary runs in a terminal) deletes the file and posts the
notification, so the sidebar changes at once; a crash shows within about
seven seconds.

## Build

Needs Xcode 16 or later (the SDK needs Swift tools 6.0) and XcodeGen (`brew install xcodegen`).

```sh
native/mac/build.sh
```

It fetches cmux's sidebar SDK (`fetch-sdk.sh`), generates
`Cockpit.xcodeproj` and builds into `build/`. All three are gitignored.
The SDK is GPL-3.0-or-later, so it is fetched into `.sdk/`, never
committed, pinned to the cmux release tag in `fetch-sdk.sh`; bump that tag
when cmux updates, with the commit it points at (the script refuses a
moved tag). The sparse checkout is no-cone on purpose, so cmux's
root files (its `biome.json` above all) stay out of this repo's tree.

Signing is automatic with team `9S5FG4LQAF`: the App Group needs a real
signature, and the first build may register the app IDs and the group
with Apple. `UNSIGNED=1 native/mac/build.sh` builds without signing, as CI
does. That is a compile check only: cmux will not list an unsigned
extension.

To work in Xcode instead: `./fetch-sdk.sh && xcodegen`, then open
`Cockpit.xcodeproj`.

## Run

```sh
open native/mac/build/Build/Products/Debug/Cockpit.app
```

One launch registers the extension with macOS, at that app's path. Run it
from the main checkout's build: a copy built in a worktree registers from
there, and goes stale when the worktree is removed. To see which copy is
registered:

```sh
pluginkit -mAvvv -i dev.jonyardley.cockpit.sidebar
```

To stop the helper: `pkill -x Cockpit`.

## Switch it on in cmux

Once per machine:

1. Click cmux's puzzle button.
2. In Sidebar Extensions, turn on Cockpit.
3. Open the command palette and run "Sidebar: Extension Sidebar".
4. A "Limited extension access" banner appears once: grant access.

The sidebar then shows one of two states:

- Helper running: "Cockpit", then "Connected. The panel arrives here in a
  later release."
- Helper not running: "Cockpit isn't running", then "Open Cockpit.app to
  start it."
