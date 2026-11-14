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
# scene's ages must read from today, not from the scene's own clock. Every
# scene therefore has data.epoch and every session time in data (an
# agent's last activity and since time, a workspace's latest time, a
# child's started and ended time, all in epoch seconds) moved by the gap
# between now and the scene's clock, so a card reads the age the scene
# intends. A scene with Ostinato records (ostinato) has every record
# line's time moved by the same step, so a run in progress still reads as
# one:
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
# records and data, the scene's times all moved from the scene's clock to
# now.
python3 -c '
import datetime, json, sys, time
scene = json.load(open(sys.argv[1]))
now = time.time()
out = {"seq": 0, "written_at_ms": int(now * 1000), "home": sys.argv[2]}
out.update({k: scene.get(k) for k in ("projects", "state", "ostinato", "data")})
step = now - (scene.get("data") or {}).get("epoch", now)
TIMES = ("lastActivityAt", "sinceEpoch", "latestAt", "startedEpoch", "endedEpoch")
def shift(node):
    if isinstance(node, dict):
        for key, value in node.items():
            if key in TIMES and isinstance(value, (int, float)) and not isinstance(value, bool):
                node[key] = value + step
            else:
                shift(value)
    elif isinstance(node, list):
        for item in node:
            shift(item)
data = out.get("data")
if isinstance(data, dict):
    shift(data.get("workspaces"))
    if isinstance(data.get("epoch"), (int, float)):
        data["epoch"] = now
def moved(line):
    try:
        row = json.loads(line)
        at = datetime.datetime.strptime(row["at"], "%Y-%m-%dT%H:%M:%SZ").replace(tzinfo=datetime.timezone.utc)
    except (ValueError, KeyError, TypeError):
        return line
    when = datetime.datetime.fromtimestamp(at.timestamp() + step, datetime.timezone.utc)
    row["at"] = when.strftime("%Y-%m-%dT%H:%M:%SZ")
    return json.dumps(row, separators=(",", ":"))
for record in ((out.get("ostinato") or {}).get("records") or {}).values():
    record["text"] = "".join(moved(l) + "\n" for l in record["text"].splitlines())
json.dump(out, open(sys.argv[3], "w"))
' "$golden/$1.input.json" "$HOME" "$tmp"
mv "$tmp" "$group/data.json"
osascript -l JavaScript -e 'ObjC.import("Foundation"); $.NSDistributedNotificationCenter.defaultCenter.postNotificationNameObjectUserInfoDeliverImmediately("dev.jonyardley.cockpit.changed", $(), $(), true)' >/dev/null
echo "Showing $1 from $group/data.json"
