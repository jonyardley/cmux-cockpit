#!/bin/sh
# Run by the native cockpit's runner (native/runner/src/outbox.rs, #429)
# with the agents each workspace shows as JSON: finds node and runs
# agents-save.ts, as quiet-save.sh runs quiet-save.ts. With no node it
# exits 1 (the finder has logged that), so the runner logs the save as failed.

here=$(dirname "$0")
NODE=$(/bin/sh "$here/find-node.sh") || exit 1

exec "$NODE" "$here/agents-save.ts" "$@"
