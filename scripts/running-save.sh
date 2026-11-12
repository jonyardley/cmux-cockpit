#!/bin/sh
# Run by the native cockpit's runner (native/runner/src/outbox.rs, #360)
# with the core's background verdicts as JSON: finds node and runs
# running-save.ts, as pr-save.sh runs pr-save.ts. With no node it exits 1
# (the finder has logged that), so the runner logs the save as failed.

here=$(dirname "$0")
NODE=$(/bin/sh "$here/find-node.sh") || exit 1

exec "$NODE" "$here/running-save.ts" "$@"
