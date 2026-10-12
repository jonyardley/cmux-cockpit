#!/bin/sh
# Run by the start-cockpit rule in automations.json when cmux opens a
# window. cmux's socket answers only programs it started (socket mode
# "cmux processes only"), so a Cockpit macOS started at login, before cmux,
# reads no workspaces and the native sidebar shows every lane at 0. This
# starts Cockpit from cmux instead: with none running it opens one; with
# one running it waits for a data.json written after this script began,
# and when none holding a workspace list comes in time, it quits that
# Cockpit and opens it again. A healthy Cockpit is left alone.
# Never fails: with no Cockpit build, or on any error, it does nothing.
# COCKPIT_APP, COCKPIT_DATA and COCKPIT_WAIT are for the tests.

APP=${COCKPIT_APP:-$HOME/.config/cmux/native/mac/build/Build/Products/Debug/Cockpit.app}
DATA=${COCKPIT_DATA:-$HOME/Library/Group Containers/9S5FG4LQAF.dev.jonyardley.cockpit/data.json}
WAIT=${COCKPIT_WAIT:-45}
[ -d "$APP" ] || exit 0

if ! pgrep -x Cockpit >/dev/null 2>&1; then
  open "$APP" >/dev/null 2>&1
  exit 0
fi

# The publisher writes at least every 30 seconds, so a healthy one has
# written a list since the mark well inside the wait.
mark=$(mktemp "${TMPDIR:-/tmp}/start-cockpit.XXXXXX") || exit 0
trap 'rm -f "$mark"' EXIT
i=0
while [ "$i" -lt "$WAIT" ]; do
  if [ "$DATA" -nt "$mark" ] && grep -q '"workspaces":\[' "$DATA" 2>/dev/null; then
    exit 0
  fi
  sleep 1
  i=$((i + 1))
done

pkill -x Cockpit >/dev/null 2>&1
i=0
while pgrep -x Cockpit >/dev/null 2>&1 && [ "$i" -lt 10 ]; do
  sleep 1
  i=$((i + 1))
done
open "$APP" >/dev/null 2>&1
exit 0
