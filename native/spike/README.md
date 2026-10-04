# R1.0 status spike

Throwaway. It checks the join in section 2 of the
[R1 plan](https://claude.ai/artifact/4szbPZj8SRyHXC1rzhKwaE): can a process
outside cmux tell which agent sits in which workspace, and whether it needs
you? No Crux, nothing in `src/` depends on it, and R1.1 replaces it.

## Run

```sh
cd native/spike
cargo run --release              # live table, reprinted when a row changes
cargo run --release -- --once    # replay, print once caught up, exit
cargo run --release -- --after 500   # replay from a later sequence
```

## What it reads

- `cmux events --after <seq>`: replays what cmux kept since its last start,
  then follows the live stream. The spike reconnects itself rather than with
  `--reconnect`: after a cmux restart the sequence starts at 1 again, so it
  replays the new run from 0. A dead stream shows as a line above the table.
- `claude agents --json` every 2 seconds: busy or idle per interactive pid.
- `cmux --json workspace list` on start, every 30 seconds and when a
  workspace comes or goes: titles.

## How it joins

A Claude process id ties a session to a workspace two ways:

1. `--pid=` and `--tab=` on a `sidebar.metadata.updated` status write. This
   wins when both exist.
2. `_ppid` and `workspace_id` on an `agent.hook.*` event.

JOINED BY says which one placed the row, or `CONFLICT hook <id>` when the
two disagree. A session in a workspace the list does not have shows as
`? workspace <id>`; an Agent View pid with no workspace shows as unjoined.

## Where status comes from

The `claude_code` status writes always say "Running", even straight after
a Stop, so they carry the pid but not the status. Status comes from the
last hook each session sent, following what cmux 0.64.25 does
(`docs/state-loop.md`, "What cmux does"):

| Hook | Status |
| --- | --- |
| Notification (any type, the idle nudge about 60s after Stop included), PermissionRequest, PreToolUse for AskUserQuestion or ExitPlanMode | needs input (NEEDS YOU) |
| UserPromptSubmit, other PreToolUse, PostToolUse, PreCompact | working |
| SessionStart, Stop | idle |
| SessionEnd, or the pid gone from Agent View | ended (row dropped) |

When a workspace holds more than one session, its most urgent one wins.
AGENT VIEW shows Claude's own busy or idle for the same pid as a cross
check; a pid with a status write but no hook yet shows "no hooks yet".

## Known gaps

- Replay covers only what cmux kept since its last start. Sessions that
  went quiet before a cmux restart show as `-` until their next hook.
- Codex sends no hooks, so Codex workspaces show as `-`.
- The last hook wins. A subagent's tool call after a permission prompt
  would flip needs input back to working; whether cmux does the same is unknown.
- A Stop hook that blocks (the cockpit's closing-line check) makes Claude
  carry on after Stop: HOOK STATUS says idle while AGENT VIEW says busy.
  cmux sets idle on Stop too, so this should match the sidebar.
- The cockpit hides some needs input from Needs you on top of cmux (a turn
  that ended on "Nothing for you", a dismissed spell). The spike shows
  cmux's status, so those rows say YES here and not in the strip.

A mismatch with the sidebar's Needs you is the thing this spike exists to
find. Note the SEQ on the row and look it up with
`cmux events --after <seq-1> --limit 1 --no-ack`.
