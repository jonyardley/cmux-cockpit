#!/bin/sh
# Run by the native cockpit's runner (native/runner/src/outbox.rs, #399)
# with the core's Ostinato cycles as JSON: finds node and runs
# cycles-save.ts, as waits-save.sh runs waits-save.ts. With no node it exits 1 (the
# finder has logged that), so the runner logs the save as failed.

here=$(dirname "$0")
NODE=$(/bin/sh "$here/find-node.sh") || exit 1

exec "$NODE" "$here/cycles-save.ts" "$@"
