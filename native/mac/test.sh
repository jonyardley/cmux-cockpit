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
# 4. The outbox: every action the sidebar sends encodes to the JSON the
#    runner's own test parses (native/runner/tests/actions.json), and a
#    send lands as a file named as the runner takes it.
# 5. Drag and drop: where a dropped card lands, and how a drop is drawn
#    until panel.json shows it.
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
build/outbox-check ../runner/tests/actions.json
swiftc -swift-version 6 -o build/drag-check Generated/PanelTypes.swift Sidebar/Model/*.swift Sidebar/Live/PendingMove.swift Tests/Drag/main.swift
build/drag-check
