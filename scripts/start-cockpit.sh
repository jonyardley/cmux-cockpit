#!/bin/sh
# Run by the start-cockpit rule in automations.json when cmux opens a
# window. cmux's socket answers only programs it started (socket mode
# "cmux processes only"), so a Cockpit macOS opened at login, or one left
# over from an earlier cmux, reads no workspaces and the native sidebar
# shows every lane at 0. This makes sure the running Cockpit is one this
# cmux started: it notes "<cmux pid> <Cockpit pid>" after each start, and
# when the pair it finds differs it quits that Cockpit and opens it again.
# A Cockpit running without its publisher (--no-publish, for a fixture)
# is left alone. One copy works at a time, so a restore that opens
# several windows restarts Cockpit once.
# Never fails: with no Cockpit build, no cmux, or on any error, it stops.
# COCKPIT_APP and COCKPIT_STATE are for the tests.

APP=${COCKPIT_APP:-$HOME/.config/cmux/native/mac/build/Build/Products/Debug/Cockpit.app}
STATE=${COCKPIT_STATE:-$HOME/.local/state/cockpit}
[ -d "$APP" ] || exit 0

cmux=$(ps -axo pid=,comm= | grep '/cmux\.app/Contents/MacOS/cmux$' | head -n 1 | tr -s ' ' | cut -d ' ' -f 2)
[ -n "$cmux" ] || exit 0
cockpit() { pgrep -x Cockpit | head -n 1; }

mkdir -p "$STATE" || exit 0
lock="$STATE/start.lock"
if ! mkdir "$lock" 2>/dev/null; then
  # Another copy is at work, unless it died holding the lock.
  holder=$(cat "$lock/pid" 2>/dev/null)
  [ -n "$holder" ] && kill -0 "$holder" 2>/dev/null && exit 0
  rm -rf "$lock"
  mkdir "$lock" 2>/dev/null || exit 0
fi
echo $$ > "$lock/pid"
trap 'rm -rf "$lock"' EXIT

running=$(cockpit)
if [ -n "$running" ]; then
  pgrep -x cockpit-publish >/dev/null || exit 0
  [ "$(cat "$STATE/started" 2>/dev/null)" = "$cmux $running" ] && exit 0
  pkill -x Cockpit
  i=0
  while [ -n "$(cockpit)" ] && [ "$i" -lt 10 ]; do
    sleep 1
    i=$((i + 1))
  done
  # A Cockpit that will not quit would only be brought forward by open.
  if [ -n "$(cockpit)" ]; then
    pkill -9 -x Cockpit
    sleep 1
  fi
fi

open "$APP" || exit 0
i=0
while [ -z "$(cockpit)" ] && [ "$i" -lt 10 ]; do
  sleep 1
  i=$((i + 1))
done
started=$(cockpit)
[ -n "$started" ] && echo "$cmux $started" > "$STATE/started"
exit 0
