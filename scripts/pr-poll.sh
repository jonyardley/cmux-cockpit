#!/bin/sh
# Run by the pr-poll rules in automations.json (#7): finds node and runs
# pr-poll.ts. The automation runner has the app's PATH, not a shell's, so node
# is found by its usual install paths if need be, as restore-agents.sh does
# for cmux. Never fails: with no node it does nothing.

NODE=$(command -v node || true)
for candidate in "$HOME/.local/share/fnm/aliases/default/bin/node" /opt/homebrew/bin/node /usr/local/bin/node; do
  [ -n "$NODE" ] && break
  [ -x "$candidate" ] && NODE=$candidate
done
[ -n "$NODE" ] || exit 0

exec "$NODE" "$(dirname "$0")/pr-poll.ts"
