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

The id is a workspace id, except for `projects`, where it is the project's
match: an absolute, lowercase directory. Only the first dot splits the key,
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
and when a workspace is selected, each at most once every 30 seconds, with a
five-minute timeout; the poller itself gives up on new lookups after four
minutes, so a slow directory cannot starve the rest. The poll a turn end
fires straight after an agent's `gh pr create` can run before gh lists the
new PR, so the `report-pr` hook (`scripts/hooks/report-pr.ts`) also starts
one detached run with `--delay 10`: it sleeps ten seconds, then waits up to
a minute for the lock instead of skipping, since the run holding it may be
the one that missed the PR.
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

`applySet` refuses `prs`, so no URL can plant a link the sidebar would open,
and `validateState` keeps only `https://github.com/<owner>/<repo>/pull/<n>`
urls.

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
