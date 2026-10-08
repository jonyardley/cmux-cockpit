#!/bin/sh
# Runs the Swift checks. Needs the Swift compiler and cargo, not the SDK or
# XcodeGen.
# 1. The shared heartbeat rule and the helper's restart rule, compiled
#    with their checks.
# 2. The panel types: native/typegen writes Generated/PanelTypes.swift from
#    the Rust panel model, then every fixture in native/fixtures/ must
#    decode with them.
# 3. The sidebar's logic in Sidebar/Model/, with the words on each card
#    checked against the terminal pane's snapshot of the same scene.
# 4. The clicks and the outbox: every action the sidebar sends its core,
#    as the generated Event, encodes to the JSON the core's own test
#    checks (native/core/tests/actions.json) and decodes in Rust as the
#    core's Event, alone and inside At; an effect file lands named as the
#    runner takes it.
# 5. The effect files: native/runner/tests/effects.json, which the
#    runner's own test matches against the bridge, has one entry per
#    effect the runner takes from outbox/.
# 6. Drag and drop: where a dropped card lands, and that a drag carries
#    only our own type, declared in Sidebar/Info.plist as data, not text.
# 7. The panel's clicks and menus: what each action chip and menu pick
#    sends, over every fixture.
# 8. The sidebar's own core, linked to native/ffi as the extension links
#    it: a golden scene's data.json draws, a click redraws on the click,
#    its effects land in outbox/, an inbox/ answer goes in, and a move
#    cmux refuses snaps back.
set -eu
cd "$(dirname "$0")"
mkdir -p build
swiftc -swift-version 6 -o build/heartbeat-check Shared/Heartbeat.swift Host/Restart.swift Tests/main.swift
build/heartbeat-check
(cd .. && cargo run -q -p cockpit_typegen)
swiftc -swift-version 6 -o build/decode-check Generated/PanelTypes.swift Tests/Decode/main.swift
build/decode-check ../fixtures
swiftc -swift-version 6 -o build/views-check Generated/PanelTypes.swift Sidebar/Model/*.swift Tests/Views/main.swift
build/views-check ../fixtures ../pane/tests/snapshots
swiftc -swift-version 6 -o build/outbox-check Generated/PanelTypes.swift Shared/Heartbeat.swift Sidebar/Model/SidebarAction.swift Sidebar/Live/Outbox.swift Tests/Outbox/main.swift
build/outbox-check ../core/tests/actions.json build/swift-events.json
(cd .. && cargo run -q -p cockpit_typegen --bin check_events -- core/tests/actions.json mac/build/swift-events.json)
swiftc -swift-version 6 -o build/effects-check Tests/Effects/main.swift
build/effects-check ../runner/tests/effects.json
swiftc -swift-version 6 -o build/drag-check Generated/PanelTypes.swift Sidebar/Model/*.swift Sidebar/Views/DragItem.swift Tests/Drag/main.swift
build/drag-check Sidebar/Info.plist
swiftc -swift-version 6 -o build/actions-check Generated/PanelTypes.swift Sidebar/Model/*.swift Tests/Actions/main.swift
build/actions-check ../fixtures
(cd .. && cargo build -q -p cockpit_ffi)
swiftc -swift-version 6 -o build/core-check -import-objc-header ../ffi/include/cockpit_ffi.h -L ../target/debug -lcockpit_ffi \
  Generated/PanelTypes.swift Shared/Heartbeat.swift Sidebar/Model/SidebarAction.swift Sidebar/Live/Outbox.swift Sidebar/Live/Inbox.swift Sidebar/Live/SidebarCore.swift Tests/Core/main.swift
build/core-check ../../test/golden/lanes.input.json
