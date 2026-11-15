#!/bin/sh
# Run by the restore-agents-panel rule in automations.json (#27). When cmux
# creates a window before the custom sidebar is available, it falls back to
# Files and saves that over the remembered mode. For ten seconds this checks
# the new window once a second and puts agents back whenever it has fallen
# out of custom mode; it does not stop at the first custom reading, since
# cmux can fall back after it. It targets the window named in the event, so
# a restore of several windows fixes each one. The automation runner has the
# app's PATH, not a shell's, so cmux is found by its install path if need be.
# Never fails: with no cmux, or on any cmux error, it does nothing.

CMUX=$(command -v cmux || echo /Applications/cmux.app/Contents/Resources/bin/cmux)
[ -x "$CMUX" ] || exit 0

window=$(printf '%s' "${CMUX_AUTOMATION_EVENT_JSON:-}" |
  sed -n 's/.*"window_id":"\([^"]*\)".*/\1/p' | head -n 1)
[ -n "$window" ] || exit 0

i=0
while [ "$i" -lt 10 ]; do
  sleep 1
  case $("$CMUX" right-sidebar mode --window "$window" 2>/dev/null) in
    *'"mode":"custom'*) ;;
    *) "$CMUX" right-sidebar set custom agents --no-focus --window "$window" >/dev/null 2>&1 ;;
  esac
  i=$((i + 1))
done
exit 0
