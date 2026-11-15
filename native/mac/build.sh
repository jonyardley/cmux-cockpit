#!/bin/sh
# Fetches the SDK, generates the Xcode project and builds Cockpit.app with
# the sidebar extension inside, into build/. Signs automatically with team
# 9S5FG4LQAF; UNSIGNED=1 builds without signing, as CI does, which compiles
# both targets but cannot use the App Group, so it shows only the empty state.
set -eu
cd "$(dirname "$0")"
./fetch-sdk.sh
xcodegen generate --quiet
if [ "${UNSIGNED:-}" = 1 ]; then
  signing="CODE_SIGNING_ALLOWED=NO"
else
  signing="-allowProvisioningUpdates"
fi
xcodebuild -project Cockpit.xcodeproj -scheme Cockpit -configuration Debug \
  -destination generic/platform=macOS -derivedDataPath build -quiet "$signing" build
echo "Built build/Build/Products/Debug/Cockpit.app"
