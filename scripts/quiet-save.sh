#!/bin/sh
# Run by the native cockpit's runner (native/runner/src/outbox.rs, #425)
# with the core's quiet verdicts as JSON: finds node and runs
# quiet-save.ts, as running-save.sh runs running-save.ts. With no node it
# exits 1 (the finder has logged that), so the runner logs the save as failed.

here=$(dirname "$0")
NODE=$(/bin/sh "$here/find-node.sh") || exit 1

exec "$NODE" "$here/quiet-save.ts" "$@"
