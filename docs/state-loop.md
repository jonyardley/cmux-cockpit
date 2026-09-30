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

Every reload redraws the whole panel, which shows as a flicker, so the
build keeps them to real changes: each sidebar is baked with only the maps
it reads (`scripts/bundle.ts`), and a bundle whose bytes did not change is
not rewritten (`scripts/write-if-changed.ts`), so cmux does not reload it.

## The URL

```
cmux-cockpit://set?key=<map>.<id>&value=<url-encoded JSON>&token=<token>
cmux-cockpit://set?key=<map>.<id>&token=<token>   (no value: delete the entry)
```

`token` is this install's `config/url-token` (see Trust below), which the
sidebars send on every set.

| map               | value                          | issue |
| ----------------- | ------------------------------ | ----- |
| `dismissed`       | `{"<agentId>": <epoch>, ...}`  | #5    |
| `projectOverride` | `"<project key>"`, its first match path, e.g. `"/dev/alpha"` | #8    |
| `projects`        | `{"name", "color": "#rrggbb", "icon": "<SF Symbol>", "root"?}`, or `{"removed": true}` | #9    |
| `ui`              | `ui.mode`: `"all"` or `"projects"`; `ui.collapsed`: `{"lane:<key>" or "project:<key>": 0 or 1}` |       |

The id is a workspace id, except for `projects`, where it is the project's
first match (lowercase, at least two segments deep: a sidebar-made
project's absolute folder, or a `projects.json` project's fragment such as
`/dev/alpha`), and `ui`, whose only ids are `mode`
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
  "projects": { "/users/you/dev/scratch": { "name": "Scratch", "color": "#6A9BCC",
                "icon": "folder.fill", "root": "/Users/you/dev/scratch" } } }
```

A missing or malformed file reads as empty state; bad entries are dropped,
never fatal, so a bad write cannot break the build. Each map keeps its newest
256 entries. A file that is there but cannot be read or parsed, or is not a
JSON object, is also built as empty state, but the build copies it to
`config/state.json.unreadable.bak` (never over an earlier copy) and bakes in
`__STATE_UNREADABLE__`, and both sidebars then show one line saying so, so
a broken file never passes for nothing saved (#78). The next write (a tap,
a poll or a hook) replaces the broken file, but copies it aside to the same
name first when no build has yet, so a write that beats the build loses
nothing; if an earlier copy is still there and differs, the write keeps a
second one beside it, named `config/state.json.unreadable.<ms>.bak`. The line stays while the copy is there: delete the copy once you
have looked at it.

The build lays `projects` over `config/projects.json`, and the saved entry
wins: one keyed by a file project's first match replaces its name, colour,
icon and root (its matches stay, so a fragment that also catches that
folder's worktrees keeps doing so), and `{"removed": true}` leaves it out.
An edit that would give two projects one name is dropped and the file's
entry kept. Any other key is a sidebar-made project, appended; one whose
folder a remaining file project's match claims, or whose name is taken, is
left out (a removed file project claims neither). What was
left out is also dropped from the `__STATE__` the sidebar sees. The file
itself is never written by the loop: it is the starting table.

## Pull requests: the one map no URL writes

cmux sends custom sidebars no PR data (#7), so `scripts/pr-poll.ts` finds it
instead and keeps it in a fourth map, `prs`: workspace id to
`{"number", "url", "status": "open|merged|closed", "branch", "title"?, "draft"?, "mergeable"?, "conflicts"?, "checks"?}`.
`title` is the PR's own title, cleaned as an own PR's is and left out when
nothing readable is left; `draft`, `mergeable` (gh's `mergeStateStatus`
CLEAN) and `conflicts` (DIRTY) are saved only as `true`, so the chips can
say a PR's worst state. For every
workspace in every window it reads the directory's git branch and asks
`gh pr list --head <branch> --state all` for that branch's PR, preferring an
open one, and ignoring a fork's PR (`isCrossRepository`), since the sidebar
cannot open one of those the way it opens ours. It replaces the whole map
under the same file lock as a URL's write, sorting its keys first so a
reorder of workspaces or windows between polls is never seen as a change,
and rebuilds only when a PR changed, through the same build lock as the
hooks (`buildNow` in `scripts/hook-build.ts`, which waits up to ten
seconds for a build in flight rather than racing it; if that build is
still going, it builds this write before it lets go, so the poll leaves it
there). If the rebuild fails, it writes the
previous map straight back, so the file matches the screen and the next
poll sees a change again and retries.

A workspace whose git or gh lookup failed keeps its last entry: git failing
outright (a timeout, or any error that is not "not a git repository") keeps
it as-is regardless of branch; gh failing keeps it only while the workspace
is still on the branch it was found for. Two polls never overlap: a
`config/pr-poll.lock` file makes a second run exit straight away while one
is already going (a lock older than five minutes is a crashed run's, and is
cleared and retaken). Every run logs a line, whether it changed anything,
found nothing new, was skipped, or hit an error; a run that changed
something names the maps it changed, such as `[poll, prs]`. Every build in
the main checkout logs `build: redrew agents, cockpit`, naming each sidebar
it rewrote (`nothing` when it rewrote none), since each rewrite is a full
redraw in cmux. A poll logs its own line only once its build returns, so
the `build:` line comes first and the poll's time is when the build ended. Set against a report in `~/Library/Logs/cmux/hangs`,
the two lines say which change, if any, redrew a panel just before cmux
stalled.

The `pr-poll-turn` and `pr-poll-select` rules in `automations.json` run it
(through `scripts/pr-poll.sh`, which finds node with `scripts/find-node.sh`,
the same lookup the helper app uses) when an agent's turn ends
(cmux's `agent.hook.Stop` event: `agent.turn.completed` only ever arrives
inside a notification event's payload, so a rule on it never fires) and
when a workspace is selected, each at most once every 30 seconds, with a
five-minute timeout; the poller itself gives up on new lookups after four
minutes, so a slow directory cannot starve the rest. A poll straight after
an agent's `gh pr create` can run before gh lists the new PR, so the `report-pr` hook (`scripts/hooks/report-pr.ts`) also starts
one detached run with `--delay 10` when it runs in a cmux terminal: it
sleeps ten seconds, then waits for the lock instead of skipping, since the
run holding it may be the one that missed the PR, for as long as a live
run can hold it (five minutes). After an agent's `gh pr ready`, `merge`,
`close` or `reopen` in the foreground the hook starts the same run with
`--delay 1` (a backgrounded one fires the hook before gh has run, so it is
left to the turn-end poll), since GitHub
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
latest. The agents panel's This workspace card sums them up in one line
under its PR ("All 3 checks passed", "1 failing · 2 running"), with one
line under it for each check not passing, and hides them when there are
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
The agents panel's Pull requests list ranks every PR by state (open, then
merged, then closed) and, within a state, shows these after the workspaces'
own PRs, skipping any a workspace already shows. A repo whose lookup fails
keeps its previous entries, and only its own; a repo no workspace sits in
any more drops out. The poll writes `prs`, `ownPrs` and the subagent prune
in one locked pass.

`applySet` refuses `prs` and `ownPrs`, so no URL can plant a link the
sidebar would open, and `validateState` keeps only
`https://github.com/<owner>/<repo>/pull/<n>` urls.

### How fresh the PR data is

`poll` records how the poller's runs went (#78): `okEpoch`, when a run's gh
lookups last answered, and `error` (`unavailable`, `signed-out` or
`missing`) while gh cannot be reached.
`validateState` keeps each field only when it is well formed, and
`applySet` refuses `poll` like the PR maps. `src/shared/freshness.ts` reads
it against the clock: an error, or a last success more than 15 minutes old,
puts a faint line under the agents panel's Pull requests heading ("gh
unavailable · last checked 2h ago") and dims the chips of the poller's PRs.
With no `poll` saved it claims nothing.

`poll` is baked in at build, and a write that changes nothing is skipped,
so the writer must not stamp `okEpoch` on every run (each run would then
rebuild and reload both sidebars) nor only on a change of PRs (a quiet
15 minutes with gh working would then read as stale). It should refresh
`okEpoch` when the saved one is more than 5 minutes old, and write `error`
only when it starts or ends. Polls run on agent turn ends and workspace
selects, so after 15 minutes with neither the line is true: the data is
that old.

`pr-poll.ts` tallies every gh call in a run (`ghOutcome`, `nextPoll`) and
saves the result through `writePollMaps` in the same locked pass as the
PR maps. A run where gh calls failed and none answered keeps the last
`okEpoch` and records why: `missing` when gh is not installed,
`signed-out` when gh asks for `gh auth login`, else `unavailable`. A
directory that is not a GitHub repo says nothing about gh either way.
A run where nothing answered because lookups were skipped (past the
deadline, or git could not say) refreshed nothing, so it keeps the saved
status. Any other run is a success, including one that needed no gh call.
With several failures the worst is kept (`missing`, then `signed-out`,
then `unavailable`), so workspace order never flips it. If the rebuild
after a write fails, the old status (or none) goes back with the old maps.

## Cost of a save

Every save rebuilds both bundles and cmux reloads both sidebars. Anything
held only for the session goes with it: a card just dragged to a lane can
snap back until cmux reports the move, and the agents panel reloads for a
change it does not use. Saves are rare (a dismissal, a project move, a PR
opened or merged), so this is accepted until cmux's own store lands (#20).
The one routine save is the poller refreshing `okEpoch` (#78): at most
once every 5 minutes, and only while polls run, so while agents are
working or workspaces are being switched.

## Trust

Any web page can open a `cmux-cockpit://` URL, so the first build makes a
per-install token, `config/url-token` (32 random bytes as hex, gitignored,
readable by you only), and bakes it into both sidebars as `__URL_TOKEN__`.
`persistSet` sends it as the `token` param, and `scripts/state-set.ts`
refuses any set whose token is missing or does not match the file (compared
in constant time), logging "refused: bad token" and never the token. A web
page cannot read the file, so it cannot forge a set. Even with the token,
the worst a URL can do is write a bounded, validated entry and trigger a
rebuild. The handler never passes URL content to a shell.

The helper app does not bake in a node path: it runs `scripts/find-node.sh`
at every tap, which tries node on PATH, then fnm, nvm, volta, asdf, mise
and Homebrew, and logs a line when it finds none, so a Node upgrade does not
break taps silently.

## Subagent runs: the map no URL writes either

cmux sends custom sidebars no subagent data at all (#6), so
`scripts/hooks/report-subagent.ts` records them itself, from three Claude
Code hook events, in a fifth map, `subagents`: workspace id to a list of runs,
oldest first, each `{"id", "session", "agentId"?, "type"?, "label",
"startedEpoch", "endedEpoch"?}`. `src/shared/subagents.ts` reads it back for
the agents model while cmux carries no agent's own subagent runs
(`children`) of its own.

A run is keyed by the Agent tool call rather than the agent, since Claude
Code names the call before it can name the run: `PreToolUse` (matcher
`"Agent"`) appends a run keyed by `tool_use_id` (a duplicate delivery of the
same call, from the hook being installed twice or a redelivered event, is
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
`agent_type`. A `SubagentStart` for an `agent_id` already saved is a
resume (a `SendMessage` to a finished background agent starts it again under
the same id): the newest row for that agent reopens from now, keeping its
label, takes the resuming session and moves to the end of the list, unless a
row for it is still open or it ended under `RESUME_MIN_GAP_S` ago (both a
duplicate delivery). `SubagentStop` sets `endedEpoch` on every open row with
that `agentId`, and does nothing when none is open (a duplicate delivery of
the same Stop).

**Residual cases for resumes:** once a finished row is pruned (ten minutes
after its Stop, below), a later resume looks like a first start and pairs
like one, so it can take an unrelated unpaired row's label. A Stop
redelivered after a resume ends the resumed run early. Neither has been
seen: `routes.ts` lists `report-subagent.ts` once per event, and a
second copy of an event's entry point in settings would double every
event.

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

It is fed by three Claude Code events: `PreToolUse` (on `Agent`),
`SubagentStart` and `SubagentStop`. Claude Code's settings hold one entry
point per event, `scripts/hooks/dispatch.ts`, and `scripts/hooks/routes.ts`
lists the scripts each event runs and the matcher that picks them; that
list, not the settings, is where `report-subagent.ts` is wired to those
three events.

The entry points are in the [quickstart's hooks block](quickstart.md#claude-code-hooks),
the one copy of it.

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
shared with the published-links hook below and with a tap
(`scripts/state-set.ts`), and the poller's synchronous `buildNow` takes the
same lock, so no two builds ever run at once and an older bundle can never
land after a newer one. Whoever holds the lock looks at the state file once
more after dropping it and, if a write landed after its last build, takes
the lock back and builds again, so a write that found the lock held is
never left unbuilt. The holder touches the lock before each build pass, so
a long run of passes is never mistaken for a crashed build's.

`npm run build` takes the same lock (`scripts/hook-build.ts --locked`), so
the git hooks' rebuild after a pull or a branch switch, the close-out's and
`npm run check`'s can never race a tap's or a poll's either. It waits for
the lock as long as a live build could hold it (just over two minutes,
retaking a crashed build's on the way, and saying once that it is
waiting), builds with `build.ts`'s output shown, and exits with its
status, so a failed build still fails the check. Once it holds the lock, a
Ctrl-C or a kill no longer ends it before the lock is dropped, so an
interrupted build never leaves every tap for the next two minutes
unbuilt.
Whatever holds the lock spawns `scripts/build.ts` directly, never
`npm run build`, so nothing waits on its own lock. `npm run dev`'s watch
build does not take it: it runs for as long as you leave it, and is only
for working on the sidebars by hand.

"Changed since that build" means the build's inputs, not only the state
file: the holder compares the state file's text plus the size and
modification time of everything else `build.ts` reads: both project
tables, the state file's unreadable copy, every `.ts` file under `src/`
and the top-level scripts in `scripts/` (`buildInputs`). A pull or a branch switch whose files land while a tap's
build is going then gets another pass from that holder, so the last bundle
written is built from the newest source, even in a clone without the git
hooks installed.

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

`scripts/hooks/dispatch.ts` runs it on `PostToolUse` for `Artifact` and
the Claude Docs `batch` and `update` tools, as `scripts/hooks/routes.ts`
lists.

The entry points are in the [quickstart's hooks block](quickstart.md#claude-code-hooks),
the one copy of it.

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

Editing a doc already saved touches it: a Docs `update`, or a `batch`
whose `tool_input.container.id` names an existing doc. The doc's id is the
`<uuid>` of its `claude.ai/code/artifact/<uuid>` link, the form a Docs
create returns. A touch moves the entry to now and to the workspace doing
the work, title kept, so a doc made days ago and edited today reads as
this workspace's. Opening or reading is not work on it and touches
nothing. An edit carries no title, so a link with no saved entry adds
nothing, an entry past seven days stays gone, and a touch within a minute
of the last from the same workspace is not saved, so filling a doc a
section at a time does not rebuild on every call.

These gaps are known. One artifact has two link forms,
`claude.ai/artifact/<id>` and `claude.ai/code/artifact/<uuid>`, with
different ids and no local way to map one to the other, so republishing
under the other form adds a second entry. And an update that names its
`url` is recorded without reading the result, so a refused republish
(which returns the live version rather than failing) still counts.
Touches share the second gap: a refused edit still moves the entry. And
they miss some work: a rename keeps the saved title (the update tool's
rename input is not documented), and Docs' `create` tool, which adds a
tab, comment or upload, is not hooked, so it touches nothing.

## Ready and merged PRs

Nothing moves a card by itself: it stays in the lane Jon left it in. When
a workspace's PR turns ready to merge (the green chip, the ready test in
src/shared/pr-health.ts), the card's "To review →" button turns green,
and a tap files it into For review. Before 2026-09-30 the cockpit moved
the card itself, which lost cards; a state file from then may still hold a
`prSeen` map, which the next read drops.

Once merged, the card dims (full strength again while selected) and
offers Park, which files it into Parked (left out once it is there), Keep,
and Close workspace, which sends the `workspace.close` socket
command. It stays at full strength while an agent there is working or
asking or it has unread output, and Close is left out while an agent is
working or asking. A pinned workspace (cmux will not close one) and a
lane's anchor offer neither. Keep sets `mergeKept.<workspace id>` to the
kept PR's number, so the buttons stay hidden for that PR past every
reload and come back for a later one; the poller drops an entry once the
workspace's saved PR is another or gone. The set never rebuilds, since the sidebar hides them itself. The worktree is never
removed from the sidebar: that stays in the close-out command.
src/cockpit/merged.ts has the rules.

## Where a PR came from

The agents panel's Pull requests rows say which chat opened each PR, and a
tap goes back to that chat; the state pill opens GitHub. Neither cmux nor
GitHub knows which chat opened a PR, so a hook records it in the
`prOrigins` map: PR link to `{"url", "number", "workspace", "surface",
"session", "epoch"}`, oldest first.

- `scripts/hooks/report-pr.ts`, after a `gh pr create`, records the
  Claude Code `session_id`, `CMUX_WORKSPACE_ID` and `CMUX_SURFACE_ID`,
  with the number taken from the link, so it needs no gh call. A second
  create of the same link replaces the first. Every write drops origins
  older than 30 days. A `mention` saved by the old report-mention.ts hook
  is dropped on the next write.

No URL can set the map. A PR opened by hand, or before the hooks were
installed, has no origin: its row has no "from" line and a tap opens
GitHub, as it does once the chat's workspace has closed, or when it is the
workspace already selected with no terminal saved to flash. Going back to the
chat selects the workspace, focuses the terminal and flashes it; cmux has
no call that scrolls a terminal to a line, so it cannot land on the
message itself.

## Agent names

The agents panel lists a workspace's agents by name. cmux's own agent
title is the session's first message, which it cannot read for a session
run from `~/.claude-personal`, and a `/clear` title is filtered to nothing,
so rows fell back to "Claude 1", "Claude 2". A hook records a name per
session in the `names` map: Claude Code session id to `{"name", "from"}`,
oldest first, where `from` is `"title"` or `"prompt"`.

- `scripts/hooks/report-rename.ts`, on each message, at each turn's end
  and at session start,
  reads what the transcript added since its last read (the same read that
  carries a `/rename` to the workspace). The name is the latest `/rename`,
  else the first real prompt: slash commands, shell escapes, system
  reminders and other text Claude Code wraps in a tag are skipped. It
  works the same for `~/.claude` and `~/.claude-personal`, since the
  transcript path comes with the event. It writes only when the name
  changes, and a write rebuilds.

cmux sends the session id as the agent's `id` (checked on a live reload,
for both folders), so a row looks its name up by that. The saved name
wins over cmux's title, which wins over the numbered fallback. No URL can
set the map.

## Asking or your turn

cmux marks an agent needs_input both when it stops to ask (a permission
prompt, a question, an MCP form) and when it simply finished its turn, and
says nothing about which (issue #81). Claude Code's hooks do, so
`scripts/hooks/report-notification.ts` saves the latest ask per workspace
in a seventh map, `asking`: workspace id to `{"reason", "epoch",
"session"?}`, where `reason` is a short line such as `allow git push?`.
It goes through `applySet` and `readApplyWrite` like a URL's set, but
`state-set.ts` refuses the map from a URL (`urlMaySet`), since a planted
entry would read as the agent's own question. A new ask drops any other
older than a day, and `MAX_ENTRIES` caps the map.

The sidebars read it back through `src/shared/needs.ts`'s `askReason`: a
needs_input agent is asking when the workspace's saved ask is at least as
new as the start of its current needs_input spell (`sinceEpoch`), give or
take `HOOK_SLACK` (3 seconds, since this hook and cmux's own fire on the
same event). When one of the workspace's agents carries the asking
session as its id (unconfirmed whether cmux agent ids are session ids, as
for saved subagent runs), only that agent is asking; otherwise the ask
belongs to the workspace. A fresh ask also overrides the idle-nudge rule
(issue #4), so an ask after a long quiet build is not read as idle. The cockpit then shows the card and its Needs you row amber,
"Asking", with the reason under the title; the agents panel heads the
workspace "Asking" in amber and puts the reason over Open chat. Any other
needs_input is "Your turn" in clay, and red stays for failing checks. No
write clears an ask: once the agent works again and stops, its new spell
starts after the ask, so it reads as its turn. Without the hook, or for an
agent cmux sends no `sinceEpoch` for, everything reads as "Your turn".

What each event saves:

- `PermissionRequest` (every tool): fires the moment Claude Code is about
  to ask, alongside cmux's own `PermissionRequest` hook, which is what
  marks the agent needs_input. The reason names the command's first two
  words (past a `cd`, env assignments and `rtk`, a command-rewriting wrapper), the file an edit or
  write touches, the host a fetch reaches, or the tool; `AskUserQuestion`
  uses the first question's words and `ExitPlanMode` reads
  `approve the plan?`.
- `Notification` (`permission_prompt`, `elicitation_dialog`,
  `elicitation_url_dialog`): the asks with no `PermissionRequest` (an MCP
  form, a sandboxed network request). Its `message` is used as the reason
  ("Claude needs your permission to use Bash" reads `allow Bash?`). A
  `permission_prompt` within 30 seconds of the same session's saved ask is
  that prompt still waiting, so it writes nothing: rewriting would restamp
  the ask, and a quick approval and turn end straight after would read as
  asking. `idle_prompt` is the turn-end nudge, not an ask, and
  `agent_needs_input` (background sessions and teammates) is not
  documented as never firing on a turn end, so neither is hooked.
- `PreToolUse` (`AskUserQuestion`, `ExitPlanMode`): under
  bypassPermissions these two fire no `PermissionRequest`, and cmux flags
  them from `PreToolUse` instead.

The entry points are in the [quickstart's hooks block](quickstart.md#claude-code-hooks),
the one copy of it.

The hook prints nothing to stdout, so it can never answer a permission
prompt, and every problem is a line on stderr and exit 0. Each ask costs a
rebuild through `scripts/hook-build.ts`, coalesced with the other hooks',
so a card turns amber a second or two after the prompt appears. A
workspace holds one saved ask, so where cmux agent ids are not session
ids, two agents waiting at once in one workspace both read the latest
ask's reason.

## What the chat wants

A chat that ends its turn says what it needs from Jon on a last line that
starts "Your move:" (his global rules ask for it). cmux keeps only the
first 240 characters of a message, so the sidebar never sees that line.
`scripts/hooks/report-move.ts`, a Stop hook, takes the turn's final reply
(the event's `last_assistant_message`, else the main-chat reply that ends
the transcript's tail, read once more after a pause when a prompt or a tool
result still comes after the last reply, since that reply is not the final
one) and saves the line per workspace in the `moves` map: workspace id to
`{"text", "epoch", "session"?, "decisions"?, "leans"?}`. A "Your move"
line inside a code fence (a handoff opener) is not the reply's. `decisions`
counts the reply's bold numbered headings with at least one lettered
option under them, and `leans` holds the option marked **Lean** or
(recommended) under each, in Jon's shorthand (`1b 2a`); a rule or a
markdown heading ends a decision's options. A turn with no move line
drops the workspace's saved one. Like `asking`, the map goes through
`applySet` and is refused from a URL, but a new move drops any other more
than a week older (`MOVE_MAX_AGE_S`, since a chat can wait over a weekend),
and `MAX_ENTRIES` caps it.

`src/shared/move.ts` shows the move while the agent is at a turn end and
no prompt has come since it was saved: cmux says idle or needs_input (never
working or ended), it is not an ask, and the move's `epoch` is no earlier
than the workspace's `latestAt`, give or take `HOOK_SLACK`. With no
`latestAt` (missing or 0) there is no telling how old the move is, so none
shows. The slack rule is `savedFor` in `src/shared/needs.ts`, shared with
asks.

### What cmux does (v0.64.25)

From the cmux source at that version:

- Claude's Stop sets the agent idle
  (`Sources/Mobile/AgentChat/AgentChatSessionRegistry+Lifecycle.swift:98`).
  The idle_prompt Notification about 60s later moves it to needs_input and
  stamps `sinceEpoch` and `lastActivityAt` at its arrival (the same file,
  lines 89 to 97, and `AgentChatSessionRegistry.swift:501`). Every hook
  event stamps `lastActivityAt`, so neither says when the agent last worked,
  and `isIdleNudge`'s gap check does not fire on this version (issue #4).
- `latestMessage`, `latestPrompt` and `latestAt` belong to the workspace
  (`Workspace.swift:3052-3054`). UserPromptSubmit writes the prompt into
  both `latestPrompt` and `latestMessage` and sets `latestAt`
  (`Workspace.swift:6643-6648`). Stop writes `last_assistant_message` into
  `latestMessage` and `latestAt` only in iMessage mode, which is off by
  default (`WorkspacePromptSubmit.swift:6,75-81,200`). Notifications never
  write them (`TerminalController.swift:6434`).
- Before an agent's first hook its id can be a `pending-claude-` alias
  rather than the session id (`AgentChatSessionRegistry.swift:519-553`).

So `latestAt` is, by default, when Jon last sent a prompt. A new prompt,
a turn he interrupts and an ask in the middle of a turn all follow a
prompt, so each retires the move; in iMessage mode Stop moves `latestAt`
at about the moment the hook saves, which the slack covers. The hook
stamps the move when it starts, before it may wait for the reply to be
flushed, so a prompt sent during that wait is still newer. The nudge
leaves `latestAt` alone, so the move survives it. By default
`latestMessage` is Jon's own prompt, which `cardMessage` hides as an echo,
so the move is often the only reply text a card has. The Needs you row
falls back to the message and then to "Waiting for your reply", the card
to the message and then to the description.

"Your turn" only appears after the nudge, about 60s after the turn ends;
until then the agent is idle and the card reads idle, with the move and
its chip already showing. That is cmux's behaviour, not the sidebar's. A
dismissal reads as idle too, so it no longer hides the move.

Ownership is stricter than for asks: the move shows only on a Claude agent
whose id is the move's session. A move saved with no session, a new
session in the same workspace (`/clear`, a relaunch, `--resume`), an agent
still on its `pending-claude-` alias and a codex agent all show none, since
a hidden move is the safe side and the next Stop saves a fresh one. The
cockpit quotes it in place of the message on every card and on the Needs
you row, adds it under the status on the Projects row, and leads the chips
with a size: Decide (with the count past one) when the reply laid out
decisions, Review when the line points at something to read (a link,
"read", "review", "look at"; a bare `#N` is only a reference), Quick for a
word or a paste. A line that says nothing waits on Jon, or gives no clue,
gets no chip.
