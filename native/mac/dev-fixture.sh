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
# scene's ages must read from today, not from the scene's own clock.
# dev-fixture.py therefore moves every time the core reads, in data (an
# agent's last activity and since time, a workspace's latest time, a
# child's started and ended time, data.epoch itself) and in the saved
# state (asks, moves, dismissals, background tasks, check times), by the
# gap between now and the scene's clock, so a card reads the age and wait
# the scene intends. A scene with Ostinato records (ostinato) has every
# record line's time moved by the same step, so a run in progress still
# reads as one:
#   native/mac/dev-fixture.sh ostinato
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
# data.json's envelope around the scene's projects, state, Ostinato
# records and data, the scene's times all moved from its clock to now.
python3 "$here/dev-fixture.py" "$golden/$1.input.json" "$HOME" "$tmp"
mv "$tmp" "$group/data.json"
osascript -l JavaScript -e 'ObjC.import("Foundation"); $.NSDistributedNotificationCenter.defaultCenter.postNotificationNameObjectUserInfoDeliverImmediately("dev.jonyardley.cockpit.changed", $(), $(), true)' >/dev/null
echo "Showing $1 from $group/data.json"
