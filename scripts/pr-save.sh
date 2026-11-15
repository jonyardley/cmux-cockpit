#!/bin/sh
# Run by the native cockpit's runner (native/runner/src/outbox.rs, #300)
# with the PR poll's answers as JSON: finds node and runs pr-save.ts. The
# runner has the app's PATH, not a shell's, so node is found by
# scripts/find-node.sh, as pr-poll.sh finds it. With no node it exits 1
# (the finder has logged that), so the runner logs the save as failed.

here=$(dirname "$0")
NODE=$(/bin/sh "$here/find-node.sh") || exit 1

exec "$NODE" "$here/pr-save.ts" "$@"
