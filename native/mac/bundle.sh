#!/bin/sh
# Builds CmuxPanel.app in build/ and signs it. Ad hoc by default; set
# SIGN_IDENTITY to a certificate's name in your keychain to sign with it,
# which keeps the Accessibility permission across rebuilds.
set -eu
cd "$(dirname "$0")"
identity="${SIGN_IDENTITY:-}"
[ -n "$identity" ] || identity="-"

swift build -c release
bin=".build/release/CmuxPanel"
app="build/CmuxPanel.app"
rm -rf "$app"
mkdir -p "$app/Contents/MacOS"
cp Support/Info.plist "$app/Contents/Info.plist"
cp "$bin" "$app/Contents/MacOS/CmuxPanel"
codesign -f -s "$identity" "$app"
codesign -v "$app"
echo "Built and signed $app (identity: $identity)"
