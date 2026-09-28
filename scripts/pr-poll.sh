#!/bin/sh
# Run by the pr-poll rules in automations.json (#7): finds node and runs
# pr-poll.ts. The automation runner has the app's PATH, not a shell's, so
# node is found by scripts/find-node.sh, the one list of version managers
# and install paths the helper app uses too. Never fails: with no node it
# does nothing (the finder has logged that).

here=$(dirname "$0")
NODE=$(/bin/sh "$here/find-node.sh") || exit 0

exec "$NODE" "$here/pr-poll.ts"
