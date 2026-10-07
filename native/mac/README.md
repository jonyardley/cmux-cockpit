# Cockpit for macOS: the helper app and the cmux sidebar extension

cmux hosts compiled SwiftUI sidebars through ExtensionKit. Cockpit is two
parts, built together from `project.yml` with XcodeGen:

- `Cockpit.app` (`Host/`): the helper app. Unsandboxed, no Dock icon, no
  window. It writes a heartbeat and keeps `cockpit-publish` (the runner,
  headless, built by cargo and copied into `Contents/MacOS`) running: it
  starts it with a full PATH and its own pid as the parent, starts it
  again after a backoff if it dies (`Host/Restart.swift`), and stops it
  on quit. It runs no core of its own (issue #269): it writes the core's
  inputs as `data.json`, carries out the effects the sidebar's core drops
  into `outbox/` (one per effect in `native/runner/tests/effects.json`)
  and writes their answers, a refused cmux call or a PR, into `inbox/`.
  Its
  log is `~/Library/Logs/Cockpit/cockpit-publish.log`.
- `CockpitSidebar.appex` (`Sidebar/`), embedded in the app: the sandboxed
  extension cmux draws in its left sidebar. It runs the core itself:
  `native/ffi` built as a static library and linked in, so a click
  redraws the panel on the click (`Sidebar/Live/SidebarCore.swift`).
  `Sidebar/Model/` decides what to show (card words, which chips fit, the
  palette) in plain Swift that `test.sh` checks; `Sidebar/Views/` lays it
  out in SwiftUI; `Sidebar/Live/` runs the core and reads and writes the
  App Group folder.
- `Shared/`: the names and the heartbeat rule both targets compile.
  `Tests/main.swift` checks the rule; `native/mac/test.sh` runs it.
- `Generated/PanelTypes.swift`: the panel model's Swift types and the
  core's `Event`, which the extension compiles. `native/typegen` writes
  them from the Rust types in `native/core`, with an `init(from:)` on each
  that reads the JSON the core writes, so a plain `JSONDecoder()` decodes
  the panel the sidebar's core hands back. `Event` and the types it reaches also get an
  `encode(to:)` in the shapes serde reads, so the sidebar's clicks go to
  its core as the core's own events (`Sidebar/Model/SidebarAction.swift`
  names them). The core's own inputs (a frame, the state file, the
  project table, a PR answer) are left out: the sidebar hands them to
  its core as the bytes the helper wrote, never as Swift values. `Tests/Outbox/main.swift` and typegen's `check_events` check
  each action against `native/core/tests/actions.json`. They are
  gitignored and rebuilt every time: by a step in the Xcode build, and by
  `test.sh`, which then decodes every fixture in `native/fixtures/` with
  them (`Tests/Decode/main.swift`).

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

Needs Xcode 16 or later (the SDK needs Swift tools 6.0), XcodeGen
(`brew install xcodegen`) and the Rust toolchain (rustup; the build runs
cargo to write the panel types and build the core library). The
extension builds for arm64 only, the Rust target rustup installs here.

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
`Cockpit.xcodeproj`. The first build writes `Generated/PanelTypes.swift`.

## Test

```sh
native/mac/test.sh
```

Needs only the Swift compiler and cargo. It runs the heartbeat and
restart checks, writes the panel types, decodes each fixture and checks
what it holds, then checks the sidebar's logic: for every fixture, the
words on each card are the words the terminal pane draws for that card in
its snapshot of the same scene (`native/pane/tests/snapshots/*-80.txt`).
Last it links the core library and drives it as the sidebar does: a
golden scene's `data.json` draws, a click redraws, effects land in
`outbox/`, an `inbox/` answer goes in, and a refused move snaps back.
Every line reads `ok:`, and any `FAIL:` line fails the run.

Xcode previews: `Sidebar/Views/Previews.swift` has one per fixture, plus
dark and narrow lanes and the two empty states.

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

To stop the helper: `pkill -x Cockpit`. To run it without the
publisher, so a fixture stays on screen:

```sh
open native/mac/build/Build/Products/Debug/Cockpit.app --args --no-publish
```

## Show a fixture

```sh
native/mac/dev-fixture.sh lanes
```

It writes the golden scene `test/golden/lanes.input.json` as `data.json`
in the group folder and posts the "changed" signal; the sidebar's core
draws it, and clicks work on it. A running publisher replaces it at its
next change, so stop the helper first or start it with `--no-publish`.
The scene's ages read from today, since the sidebar moves the core's
clock on every two seconds.

## Switch it on in cmux

Once per machine:

1. Click cmux's puzzle button.
2. In Sidebar Extensions, turn on Cockpit.
3. Open the command palette and run "Sidebar: Extension Sidebar".
4. A "Limited extension access" banner appears once: grant access.

The sidebar then shows its core's panel once `data.json` has loaded:
the view switch, Next, Needs you while something waits, and the five
lanes in All, or the projects in Projects: each busy project with its
cards, "+ New project" and Quiet. Right-click a project for its menu; "+"
opens a session in it; "+ New project" and "Edit project" open the editor
as a sheet, which saves through `outbox/` (the sandboxed sidebar cannot
write the state file itself). While the helper is
down a line on top says "Cockpit isn't running". With no panel yet it
says "Waiting for the panel" (helper up) or "Cockpit isn't running"
(helper down).
