#!/bin/sh
# Runs guard-ready.ts only for a Bash call whose command mentions `pr ready`,
# so the rest of the shell calls in a session do not each start node. The
# match is loose on purpose: guard-ready.ts decides; this only skips calls
# that cannot be one.
input=$(cat)
case "$input" in
  # A pipeline's status is its last command's, so node's exit 2 comes back.
  *ready*)
    printf '%s' "$input" | node "$(dirname "$0")/guard-ready.ts"
    exit $?
    ;;
esac
exit 0
