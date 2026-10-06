#!/bin/sh
# Runs the Swift checks. Needs the Swift compiler and cargo, not the SDK or
# XcodeGen.
# 1. The shared heartbeat rule, compiled with its checks.
# 2. The panel types: native/typegen writes Generated/PanelTypes.swift from
#    the Rust panel model, then every fixture in native/fixtures/ must
#    decode with them.
# 3. The sidebar's logic in Sidebar/Model/, with the words on each card
#    checked against the terminal pane's snapshot of the same scene.
set -eu
cd "$(dirname "$0")"
mkdir -p build
swiftc -swift-version 6 -o build/heartbeat-check Shared/Heartbeat.swift Tests/main.swift
build/heartbeat-check
(cd .. && cargo run -q -p cockpit_typegen)
swiftc -swift-version 6 -o build/decode-check Generated/PanelTypes.swift Tests/Decode/main.swift
build/decode-check ../fixtures
swiftc -swift-version 6 -o build/views-check Generated/PanelTypes.swift Sidebar/Model/*.swift Tests/Views/main.swift
build/views-check ../fixtures ../pane/tests/snapshots
