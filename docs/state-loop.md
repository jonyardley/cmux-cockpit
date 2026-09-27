# The local state loop

A sidebar has no filesystem, network or timers (upstream
`docs/custom-sidebars.md`), so anything it holds is gone on reload. This loop
gives it durable state until cmux ships a sidebar store (manaflow-ai/cmux#9985,
tracked in #20).

```
sidebar ──openURL──▶ CmuxCockpit.app ──▶ scripts/state-set.ts
                                           │ applySet, atomic write
                                           ▼
                                  config/state.json (gitignored)
                                           │ npm run build
                                           ▼
sidebars/*.js with __STATE__ baked in ──▶ cmux hot-reloads the sidebar
```

## The URL

```
cmux-cockpit://set?key=<map>.<id>&value=<url-encoded JSON>
cmux-cockpit://set?key=<map>.<id>            (no value: delete the entry)
```

| map               | value                          | issue |
| ----------------- | ------------------------------ | ----- |
| `dismissed`       | `{"<agentId>": <epoch>, ...}`  | #5    |
| `projectOverride` | `"<project key>"`, its first match path, e.g. `"/dev/alpha"` | #8    |
| `projects`        | `{"name", "color": "#rrggbb", "icon": "<SF Symbol>", "root"?}` | #9    |
| `ui`              | `ui.mode`: `"all"` or `"projects"`; `ui.collapsed`: `{"lane:<key>" or "project:<key>": 0 or 1}` |       |

The id is a workspace id, except for `projects`, where it is the project's
match: an absolute, lowercase directory, and `ui`, whose only ids are `mode`
and `collapsed`. `ui` exists because every rebuild hot-reloads the sidebar:
without it, a PR poll or a dismissal would drop the cockpit back on All with
its folds reset. A lane group's fold lives in cmux; its `lane:` flag only
records that it was toggled, so Parked stops starting folded. Only the first dot splits the key,
so a dotted path stays whole.
Any other host, path or map is refused. `scripts/state-config.ts` holds the
rules (`applySet`, `validateState`) and their tests.

## config/state.json

```json
{ "dismissed": { "<wsId>": { "<agentId>": 1790416690 } },
  "projectOverride": { "<wsId>": "/dev/alpha" },
  "projects": { "/users/jon/dev/scratch": { "name": "Scratch", "color": "#6A9BCC",
                "icon": "folder.fill", "root": "/Users/jon/dev/scratch" } } }
```

A missing or malformed file reads as empty state; bad entries are dropped,
never fatal, so a bad write cannot break the build. Each map keeps its newest
256 entries.

The build merges `projects` over `config/projects.json`, and the file wins:
an in-app project whose match or name is already taken is left out, and so
is dropped from the `__STATE__` the sidebar sees, so the menu never offers
to edit it. Projects in the file are never written by the loop.

## Pull requests: the one map no URL writes

cmux sends custom sidebars no PR data (#7), so `scripts/pr-poll.ts` finds it
instead and keeps it in a fourth map, `prs`: workspace id to
`{"number", "url", "status": "open|merged|closed", "branch", "checks"?}`. For every
workspace in every window it reads the directory's git branch and asks
`gh pr list --head <branch> --state all` for that branch's PR, preferring an
open one, and ignoring a fork's PR (`isCrossRepository`), since the sidebar
cannot open one of those the way it opens ours. It replaces the whole map
under the same file lock as a URL's write, sorting its keys first so a
reorder of workspaces or windows between polls is never seen as a change,
and rebuilds only when a PR changed. If the rebuild fails, it writes the
previous map straight back, so the file matches the screen and the next
poll sees a change again and retries.

A workspace whose git or gh lookup failed keeps its last entry: git failing
outright (a timeout, or any error that is not "not a git repository") keeps
it as-is regardless of branch; gh failing keeps it only while the workspace
is still on the branch it was found for. Two polls never overlap: a
`config/pr-poll.lock` file makes a second run exit straight away while one
is already going (a lock older than five minutes is a crashed run's, and is
cleared and retaken). Every run logs a line, whether it changed anything,
found nothing new, was skipped, or hit an error.

The `pr-poll-turn` and `pr-poll-select` rules in `automations.json` run it
(through `scripts/pr-poll.sh`, which finds node) when an agent's turn ends
(cmux's `agent.hook.Stop` event: `agent.turn.completed` only ever arrives
inside a notification event's payload, so a rule on it never fires) and
when a workspace is selected, each at most once every 30 seconds, with a
five-minute timeout; the poller itself gives up on new lookups after four
minutes, so a slow directory cannot starve the rest. The poll a turn end
fires straight after an agent's `gh pr create` can run before gh lists the
new PR, so the `report-pr` hook (`scripts/hooks/report-pr.ts`) also starts
one detached run with `--delay 10` when it runs in a cmux terminal: it
sleeps ten seconds, then waits for the lock instead of skipping, since the
run holding it may be the one that missed the PR, for as long as a live
run can hold it (five minutes). After an agent's `gh pr ready` or
`gh pr merge` the hook starts the same run with `--delay 1`, since GitHub
already has the new state and waiting for the lock is the part that matters.
Its stderr goes to the state log, and the
rebuild after a change is limited to a minute, since this run has no outer
timeout.
`src/shared/prs.ts` reads it back: cmux's own `pr`/`prs` win when present. A
saved PR shows while the workspace's branch is not yet known, or still
matches the branch it was found for, and hides once the workspace has moved
to a different branch.

### Checks

The same `gh pr list` call asks for `statusCheckRollup`, and the PR's
entry keeps `checks`: up to 20 `{"name", "state": "pass|fail|pending"}`,
failing first, then running, then passed, by name within each, so the cap
never drops a red check; left out when there are none. A finished run
passes on success, neutral or skipped and fails on anything else; a commit
status passes on success and is pending while pending or expected. A rerun
check appears once per run, so only the latest started run of each
workflow and name is kept, and a queued run with no start yet counts as the
latest. The agents panel's This workspace card shows them as
"CHECKS 3 / 5" with one line per check, and hides the block when there are
none; `src/shared/prs.ts`'s `checksOf` gives them only while no PR from
cmux itself is showing.

Only the three states are saved, never a time or a run id, so a rebuild
(and so a reload of both sidebars) happens only when a check changes state.
A run of n checks makes at most 2n changes (each appearing, then each
settling), and polls coalesce them: at most one rebuild per poll, and each
of the two poll rules fires at most once every 30 seconds, so at worst
about four reloads a minute while CI runs, agents finish turns and
workspaces change. Polls are event-driven, so while nothing ends a turn or
changes selection the card keeps its last states: the usual case is an
agent pushing, its turn ending, and the checks showing "running" until the
next turn or workspace switch.

### Your own open PRs

A PR is found through a workspace's branch, so closing the workspace hid a
PR still waiting on review. Each poll therefore also asks, once per repo any
workspace sits in (git's common dir, so every worktree of a repo counts
once), for `gh pr list --author @me --state open`, and saves the result in
`ownPrs`: PR url to its number, url, branch, draft flag, `title` (control
characters become spaces, cut to 120 characters, the branch when there is
none) and `repo`, the common dir it was found in. Checks and the merge
verdict are left out, so CI on a PR no workspace holds never rewrites the
file or rebuilds. A fork's PR counts here, unlike for a workspace's branch.
The agents panel's Pull requests list shows these after the workspaces'
own PRs, skipping any a workspace already shows. A repo whose lookup fails
keeps its previous entries, and only its own; a repo no workspace sits in
any more drops out. The poll writes `prs`, `ownPrs` and the subagent prune
in one locked pass.

`applySet` refuses `prs` and `ownPrs`, so no URL can plant a link the
sidebar would open, and `validateState` keeps only
`https://github.com/<owner>/<repo>/pull/<n>` urls.

## Cost of a save

Every save rebuilds both bundles and cmux reloads both sidebars. Anything
held only for the session goes with it: a card just dragged to a lane can
snap back until cmux reports the move, and the agents panel reloads for a
change it does not use. Saves are rare (a dismissal, a project move, a PR
opened or merged), so this is accepted until cmux's own store lands (#20).

## Trust

Any web page can open a `cmux-cockpit://` URL. The worst it can do is write a
bounded, validated entry and trigger a rebuild. The handler never passes URL
content to a shell.

## Subagent runs: the map no URL writes either

cmux sends custom sidebars no subagent data at all (#6), so
`scripts/hooks/report-subagent.ts` records them itself, from three Claude
Code hooks, in a fifth map, `subagents`: workspace id to a list of runs,
oldest first, each `{"id", "session", "agentId"?, "type"?, "label",
"startedEpoch", "endedEpoch"?}`. `src/shared/subagents.ts` reads it back for
the agents model while cmux carries no agent's own subagent runs
(`children`) of its own.

A run is keyed by the Agent tool call rather than the agent, since Claude
Code names the call before it can name the run: `PreToolUse` (matcher
`"Agent"`) appends a run keyed by `tool_use_id` (a duplicate delivery of the
same call, from the hook being registered twice or a redelivered event, is
a no-op), labelled from the call's `description` (cleaned up and cut to
`MAX_LABEL` code points, so a surrogate pair is never split, then trimmed),
falling back to `subagent_type`, then `"subagent"`; it also saves the call's
`subagent_type` as the run's `type`, unshown but used for pairing.
`SubagentStart` fires moments later with an `agent_id`, an `agent_type` and
no description, so it gives the oldest run in that session with no
`agentId` yet whose `type` matches this `agent_type` that id, falling back
to the oldest unpaired run in the session when none matches (there is
nothing better in `SubagentStart` to go on); when there is no unpaired run
at all (the `PreToolUse` was missed), it appends one instead, labelled from
`agent_type`. `SubagentStop` finds the run by `agentId` and sets
`endedEpoch`, unless it already has one (a duplicate delivery of the same
Stop).

**Residual case:** a denied or failed Agent call never gets a
`SubagentStart`, so its row sits unpaired. If a second call of the same
`subagent_type` in the same session is approved within the unpaired
pruning window below, `SubagentStart` still pairs to the denied call's
older row first, mislabelling which run actually started; nothing recorded
here can tell the two calls apart beyond session and type.

A crashed agent never sends `SubagentStop`, so every write also prunes
(`scripts/subagent-runs.ts`, shared with `scripts/pr-poll.ts` below): a run
with no `agentId` yet (a denied or failed call that never starts) is
dropped after ten minutes, a still-running, paired run is dropped after two
hours, and a finished one is dropped ten minutes after it ended, so the
sidebar has had a good while to show it settling. `MAX_SUBAGENTS`
(`scripts/state-config.ts`) then caps each workspace's list at its most
recent runs, the same as every other map's cap.

Pruning also runs inside `pr-poll.ts`'s own state write, on every poll, not
only when a subagent event rebuilds: the `pr-poll-turn` and
`pr-poll-select` rules already fire on every agent turn end and workspace
select, so a done row or a crashed run clears on the next poll even when
nothing reports a new subagent event in between.

Add these three hooks to `~/.claude/settings.json` to feed it (matching how
`report-pr.ts` is registered there):

```json
{
  "hooks": {
    "PreToolUse": [
      { "matcher": "Agent", "hooks": [{ "type": "command", "command": "node $HOME/.config/cmux/scripts/hooks/report-subagent.ts" }] }
    ],
    "SubagentStart": [
      { "hooks": [{ "type": "command", "command": "node $HOME/.config/cmux/scripts/hooks/report-subagent.ts" }] }
    ],
    "SubagentStop": [
      { "hooks": [{ "type": "command", "command": "node $HOME/.config/cmux/scripts/hooks/report-subagent.ts" }] }
    ]
  }
}
```

Each run gets the event as JSON on stdin and reads the workspace from
`CMUX_WORKSPACE_ID`; a missing workspace id, unparseable JSON, or an event
it does not recognise is a quiet exit 0, never a failure. The write itself
goes through `state-url.ts`'s `writeSubagents`, the same locked
read-modify-write as a URL's `set` or `writePrs`'s whole-map replace, so it
cannot race either.

Pairing a `SubagentStart` to its call only sets `agentId`, which the
sidebar never shows, so that alone does not trigger a rebuild; a new run
appearing, one ending, or one being pruned does. Since `SubagentStart`
fires moments after the `PreToolUse` that starts the same run, and
independent subagents can start together, a rebuild is coalesced rather
than fired per event: the first event to find no build already in flight
takes a lockfile (`config/hook-build.lock`) and spawns a detached,
short-sleeping build of its own; every other event in that window finds
the lock held and does nothing, trusting the build already running to pick
up its write once it runs. A lock older than two minutes is a crashed
build's and is retaken. The coalescing lives in `scripts/hook-build.ts`,
shared with the published-links hook below, so the two never build at once.

## Published pages and docs

cmux knows nothing about the pages and docs agents publish on claude.ai
(issue #52), so `scripts/hooks/report-published.ts` records them in a sixth
map, `published`: link to `{"url", "title", "kind", "workspace", "epoch"}`,
oldest first, where `kind` is `page` (the Artifact tool) or `doc` (Claude
Docs). Keyed by the link, a republish replaces its entry and moves it last.
Every write drops entries older than seven days, and `MAX_ENTRIES` caps
the map. Only a `https://claude.ai/artifact/<id>` or
`https://claude.ai/code/artifact/<id>` link is kept, since the sidebar will
open it on a tap, and no URL can set the map. `src/shared/published.ts`
reads it back, newest first, for the agents panel's Made here section
(`madeHere` in `src/agents/model.ts`), and applies the same
seven days itself (`src/shared/published-age.ts`), since the hook prunes
only when it writes.

It runs as a PostToolUse hook:

```json
{
  "hooks": {
    "PostToolUse": [
      {
        "matcher": "Artifact|mcp__claude_ai_Claude_Docs__batch",
        "hooks": [{ "type": "command", "command": "node $HOME/.config/cmux/scripts/hooks/report-published.ts" }]
      }
    ]
  }
}
```

An Artifact call counts only as a page publish (no `action`, or
`publish`, and not an `asset` upload); a Claude Docs `batch` counts only
when its `tool_input.container.create` is set, so edits to an existing doc
are not recorded again. Docs' `create` tool is not hooked: it adds a tab,
comment or upload to a doc that already exists. The link is
`tool_input.url` when an Artifact update names one, else the first
claude.ai artifact link in any string anywhere in `tool_response` (whose
shape is not documented) that the call's own input does not name, so a
type or source artifact echoed back is skipped. The title is the published
HTML file's `<title>` (only its first 256 KB is read), then
`tool_input.title`, then the file's name for a page, or
`tool_input.container.create.name` for a doc. It never fails the hook: a
problem is a line on stderr and exit 0.

Two gaps are known. One artifact has two link forms,
`claude.ai/artifact/<id>` and `claude.ai/code/artifact/<uuid>`, with
different ids and no local way to map one to the other, so republishing
under the other form adds a second entry. And an update that names its
`url` is recorded without reading the result, so a refused republish
(which returns the live version rather than failing) still counts.
