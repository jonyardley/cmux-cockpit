#!/bin/sh
# Compiles the shared heartbeat rule with its checks and runs them. Needs
# only the Swift compiler, not the SDK or XcodeGen.
set -eu
cd "$(dirname "$0")"
mkdir -p build
swiftc -swift-version 6 -o build/heartbeat-check Shared/Heartbeat.swift Tests/main.swift
build/heartbeat-check
