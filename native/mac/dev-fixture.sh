#!/bin/sh
# Shows a golden scene in the Cockpit sidebar: writes
# test/golden/<scene>.input.json as data.json, as cockpit-publish writes
# it, into the shared App Group folder (or COCKPIT_GROUP_DIR), then posts
# the "changed" signal. The sidebar's own core draws it (#270).
#
#   native/mac/dev-fixture.sh lanes
#
# A running cockpit-publish overwrites it at its next change, so stop the
# helper first (pkill -x Cockpit), or start it with no publisher:
#   open native/mac/build/Build/Products/Debug/Cockpit.app --args --no-publish
# The sidebar moves the core's clock to now every two seconds, so the
# scene's ages read from today, not from the scene's own clock.
set -eu
here="$(cd "$(dirname "$0")" && pwd)"
golden="$here/../../test/golden"
if [ $# -ne 1 ] || [ ! -f "$golden/$1.input.json" ]; then
  echo "usage: $0 <scene>, one of:" >&2
  ls "$golden" | sed -n 's/\.input\.json$//p' | sed 's/^/  /' >&2
  exit 2
fi
if [ -n "${COCKPIT_GROUP_DIR:-}" ]; then
  echo "note: COCKPIT_GROUP_DIR is set; the sidebar reads only the App Group folder, so it will not show this" >&2
fi
group="${COCKPIT_GROUP_DIR:-$HOME/Library/Group Containers/9S5FG4LQAF.dev.jonyardley.cockpit}"
mkdir -p "$group"
tmp="$group/.data.json.dev.tmp"
# data.json's envelope around the scene's projects, state and data.
python3 -c '
import json, sys, time
scene = json.load(open(sys.argv[1]))
out = {"seq": 0, "written_at_ms": int(time.time() * 1000), "home": sys.argv[2]}
out.update({k: scene.get(k) for k in ("projects", "state", "data")})
json.dump(out, open(sys.argv[3], "w"))
' "$golden/$1.input.json" "$HOME" "$tmp"
mv "$tmp" "$group/data.json"
osascript -l JavaScript -e 'ObjC.import("Foundation"); $.NSDistributedNotificationCenter.defaultCenter.postNotificationNameObjectUserInfoDeliverImmediately("dev.jonyardley.cockpit.changed", $(), $(), true)' >/dev/null
echo "Showing $1 from $group/data.json"
