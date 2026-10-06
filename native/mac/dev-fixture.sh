#!/bin/sh
# Shows a fixture in the Cockpit sidebar: wraps native/fixtures/<name>.json
# in panel.json's envelope, as cockpit-publish writes it, into the shared
# App Group folder (or COCKPIT_GROUP_DIR), then posts the "changed" signal.
#
#   native/mac/dev-fixture.sh lanes
#
# A running cockpit-publish overwrites it at its next change, so stop the
# helper first (pkill -x Cockpit), or start it with no publisher:
#   open native/mac/build/Build/Products/Debug/Cockpit.app --args --no-publish
set -eu
here="$(cd "$(dirname "$0")" && pwd)"
fixtures="$here/../fixtures"
if [ $# -ne 1 ] || [ ! -f "$fixtures/$1.json" ]; then
  echo "usage: $0 <fixture>, one of:" >&2
  ls "$fixtures" | sed -n 's/\.json$//p' | sed 's/^/  /' >&2
  exit 2
fi
if [ -n "${COCKPIT_GROUP_DIR:-}" ]; then
  echo "note: COCKPIT_GROUP_DIR is set; the sidebar reads only the App Group folder, so it will not show this" >&2
fi
group="${COCKPIT_GROUP_DIR:-$HOME/Library/Group Containers/9S5FG4LQAF.dev.jonyardley.cockpit}"
mkdir -p "$group"
tmp="$group/.panel.json.dev.tmp"
now_ms="$(($(date +%s) * 1000))"
{
  printf '{"seq": 0, "written_at_ms": %s, "panel": ' "$now_ms"
  cat "$fixtures/$1.json"
  printf '}\n'
} > "$tmp"
mv "$tmp" "$group/panel.json"
osascript -l JavaScript -e 'ObjC.import("Foundation"); $.NSDistributedNotificationCenter.defaultCenter.postNotificationNameObjectUserInfoDeliverImmediately("dev.jonyardley.cockpit.changed", $(), $(), true)' >/dev/null
echo "Showing $1 from $group/panel.json"
