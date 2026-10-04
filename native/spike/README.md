# R1.0 status spike

Throwaway. It checks the join in section 2 of the
[R1 plan](https://claude.ai/artifact/4szbPZj8SRyHXC1rzhKwaE): can a process
outside cmux tell which agent sits in which workspace, and whether it needs
you? No Crux, nothing in `src/` depends on it, and R1.1 replaces it.

## Run

```sh
cd native/spike
cargo run --release              # live table, reprinted when a row changes
cargo run --release -- --once    # replay, print once after 3 seconds, exit
cargo run --release -- --after 500   # replay from a later sequence
```

## What it reads

- `cmux events --after <seq> --reconnect`: replays what cmux kept since its
  last start, then follows the live stream.
- `claude agents --json` every 2 seconds: busy or idle per interactive pid.
- `cmux --json workspace list` on start, every 30 seconds and when a
  workspace comes or goes: titles.

## How it joins

A Claude process id ties a session to a workspace two ways:

1. `--pid=` and `--tab=` on a `sidebar.metadata.updated` status write.
2. `_ppid` and `workspace_id` on an `agent.hook.*` event, used when no
   status write carried the pid.

The JOINED BY column says which one matched.

## Where status comes from

The `claude_code` status writes always say "Running", even straight after
a Stop, so they carry the pid but not the status. Status comes from the
last hook each session sent:

| Hook | Status |
| --- | --- |
| SessionStart, Stop | idle |
| UserPromptSubmit, PreToolUse, PostToolUse, PreCompact | working |
| Notification | needs input (NEEDS YOU) |
| SessionEnd | ended (row dropped) |

When a workspace holds more than one session, its most urgent one wins.
AGENT VIEW shows Claude's own busy or idle for the same pid as a cross
check; "not listed" means the process has gone.

## Known gaps

- Replay covers only what cmux kept since its last start. Sessions that
  went quiet before a cmux restart show as `-`.
- Codex sends no hooks, so Codex workspaces show as `-`.
- The hook-to-status table is a guess at what cmux does inside; a mismatch
  with the sidebar's Needs you is the thing this spike exists to find. Note
  the SEQ on the row and look it up with `cmux events --after <seq-1> --limit 1 --no-ack`.
