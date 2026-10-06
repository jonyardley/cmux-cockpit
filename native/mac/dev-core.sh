#!/bin/sh
# Spike (#268): has the sidebar draw from the core linked inside it, fed a
# golden scene's input (test/golden/<scene>.input.json), instead of
# panel.json. Clicks then go to that core, not the outbox; its effects are
# logged, not run. `off` goes back to panel.json.
#
#   native/mac/dev-core.sh lanes
#   native/mac/dev-core.sh off
set -eu
here="$(cd "$(dirname "$0")" && pwd)"
golden="$here/../../test/golden"
group="$HOME/Library/Group Containers/9S5FG4LQAF.dev.jonyardley.cockpit"
if [ "${1:-}" = off ]; then
  rm -f "$group/core-input.json"
elif [ $# -eq 1 ] && [ -f "$golden/$1.input.json" ]; then
  mkdir -p "$group"
  cp "$golden/$1.input.json" "$group/.core-input.json.tmp"
  mv "$group/.core-input.json.tmp" "$group/core-input.json"
else
  echo "usage: $0 <scene>|off, a scene one of:" >&2
  ls "$golden" | sed -n 's/\.input\.json$//p' | sed 's/^/  /' >&2
  exit 2
fi
osascript -l JavaScript -e 'ObjC.import("Foundation"); $.NSDistributedNotificationCenter.defaultCenter.postNotificationNameObjectUserInfoDeliverImmediately("dev.jonyardley.cockpit.changed", $(), $(), true)' >/dev/null
echo "Core input: ${1}"
