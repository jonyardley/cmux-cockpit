#!/bin/sh
# Run by the start-cockpit rule in automations.json when cmux opens a
# window. cmux's socket answers only programs it started (socket mode
# "cmux processes only") or ones holding the pass cmux gives each of its
# terminals (CMUX_SOCKET_CAPABILITY). A Cockpit macOS opened at login has
# neither, so it reads no workspaces and the native sidebar shows every
# lane at 0. Opened straight from this rule it has neither for long
# either: cmux ends the rule after its timeout and Cockpit's tie to cmux
# goes with it. So this opens Cockpit from a background cmux terminal tab,
# which hands it the pass and closes itself once `open` returns. The pass
# stays good across cmux restarts, so a running Cockpit whose publisher
# holds one is left alone, and any other is quit and opened again.
# A Cockpit running without its publisher (--no-publish, for a fixture)
# is left alone. One copy works at a time, so a restore that opens
# several windows restarts Cockpit once. If cmux will not open the tab,
# it opens nothing: a Cockpit without the pass reads no workspaces, and
# the next new window would only quit it and try again.
# Never fails: with no Cockpit build, no cmux, or on any error, it stops.
# COCKPIT_APP and COCKPIT_STATE are for the tests.

APP=${COCKPIT_APP:-$HOME/.config/cmux/native/mac/build/Build/Products/Debug/Cockpit.app}
STATE=${COCKPIT_STATE:-$HOME/.local/state/cockpit}
[ -d "$APP" ] || exit 0

# The CLI sits beside the running app, wherever it is installed; the
# automation runner has the app's PATH, not a shell's.
app=$(ps -axo comm= | grep '/cmux\.app/Contents/MacOS/cmux$' | head -n 1)
[ -n "$app" ] || exit 0
CMUX=$(command -v cmux || echo "${app%/MacOS/cmux}/Resources/bin/cmux")
[ -x "$CMUX" ] || exit 0
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
  publisher=$(pgrep -x cockpit-publish | head -n 1)
  [ -n "$publisher" ] || exit 0
  ps -E -p "$publisher" -o command= | grep -q ' CMUX_SOCKET_CAPABILITY=' && exit 0
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

window=$(printf '%s' "${CMUX_AUTOMATION_EVENT_JSON:-}" |
  sed -n 's/.*"window_id" *: *"\([^"]*\)".*/\1/p' | head -n 1)
if [ -n "$window" ]; then
  set -- --window "$window"
else
  set --
fi
# The tab's shell reads the path inside single quotes.
quoted=$(printf '%s' "$APP" | sed "s/'/'\\\\''/g")
"$CMUX" new-surface --type terminal "$@" --focus false \
  --command "open '$quoted'; exit" >/dev/null 2>&1 || exit 0
# Hold the lock until Cockpit is up, so another window's run in the
# meantime does not open a second tab. A slow shell start can take a while.
i=0
while [ -z "$(cockpit)" ] && [ "$i" -lt 30 ]; do
  sleep 1
  i=$((i + 1))
done
exit 0
