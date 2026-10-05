# Golden JSON: the cockpit model's answers

What the TypeScript cockpit model computes for each fixture scene, written
as plain JSON so the native core can load the same inputs and compare its
outputs. This file is the contract the Rust side reads: a field renamed or
dropped here is a breaking change there.

- Recorded by `npm run golden` (test/support/golden.ts, one
  `test/golden-<scene>.test.ts` per scene). `npm run check` fails when a file
  here is stale, missing, or has no scene behind it, and when a scene in
  test/support/scenes.ts has no golden test.
- The JSON is laid out by the repo's Biome, as every JSON file here is, so
  compare parsed values, never the text.
- Scenes come from test/support/scenes.ts, the same fixtures the text
  snapshots in test/__snapshots__/ print.
- Keys are sorted at every level; arrays keep their order, which is
  meaningful (display order, longest waiting first, and so on).
- The clock is fixed: `data.epoch` is 1000000 in every scene, and every
  time in the input is a whole number of seconds before it.
- Workspaces are named by their `id` in the outputs, never copied.

## Scenes

| Scene | What it covers |
| --- | --- |
| `lanes` | A card in every state across the four lane groups and Unsorted, a folded Parked lane, a selected card, merged PRs, a background shell keeping an idle card Waiting. |
| `needs-and-next` | Five sessions waiting (the strip's cap of four plus "+N more"), saved asks and moves, a Ready card, and the Next queue. No lane groups, so every card is Unsorted. |
| `projects` | The Projects view: cards under two projects and Other, a waiting session's placeholder, a quiet project. |
| `review-verdicts` | The For review lane with a PR in every merge state, and the header's "N ready to merge". |

The `agents` scene is the other sidebar, and `editor` and `new-project` add
only draft state the editor holds after load (a typed name or folder), not
cmux data or saved state, so none of the three has golden files.

## `<scene>.input.json`

What the scene starts from: the three things the sidebar reads.

| Field | Type | Meaning |
| --- | --- | --- |
| `data` | object | The cmux data the renderer hands the sidebar. |
| `data.epoch` | number | The clock, in epoch seconds. |
| `data.groups` | array | cmux workspace groups. A lane is the group whose `name` matches the lane's. |
| `data.groups[].id` | string | The group's id; a workspace's `group` points at it. |
| `data.groups[].name` | string | The group's name: "Main activity", "For review", "Background" or "Parked". |
| `data.groups[].anchorId` | string | The workspace that anchors the group. |
| `data.selectedId` | string or null | The selected workspace. |
| `data.workspaces` | array | Every workspace, in tab order. |
| `data.workspaces[].id` | string | The workspace's id. |
| `data.workspaces[].title` | string | Its title. |
| `data.workspaces[].group` | string | The group it is in; absent when in none (Unsorted). |
| `data.workspaces[].directory` | string | Its folder, matched against the project table. |
| `data.workspaces[].branch` | string | Its git branch. |
| `data.workspaces[].dirty` | boolean | Uncommitted changes. |
| `data.workspaces[].pinned` | boolean | Pinned in cmux. |
| `data.workspaces[].selected` | boolean | cmux's own selected flag. |
| `data.workspaces[].unread` | number | Unread message count. |
| `data.workspaces[].latestAt` | number | Epoch seconds of the latest prompt. |
| `data.workspaces[].latestPrompt` | string | The latest prompt's text. |
| `data.workspaces[].latestMessage` | string | The latest agent message's text. |
| `data.workspaces[].progress` | object | `{ value, label }`: a progress bar, `value` from 0 to 1. |
| `data.workspaces[].pr` | object | cmux's own PR for the branch: `number`, `status` ("open", "merged", "closed"), `url`, and optionally `draft`, `additions`, `deletions`. |
| `data.workspaces[].agents` | array | The agents in the workspace. |
| `data.workspaces[].agents[].id` | string | The agent's id; for a Claude session, its session id. |
| `data.workspaces[].agents[].kind` | string | The agent's kind, "claude" when set. |
| `data.workspaces[].agents[].status` | string | "working", "needs_input", "idle" or "ended". |
| `data.workspaces[].agents[].sinceEpoch` | number | When the current status began. |
| `data.workspaces[].agents[].lastActivityAt` | number | Its last activity. |
| `data.workspaces[].agents[].children` | array | Subagent runs: `id`, `label`, `running`, `startedEpoch`. |
| `projects` | array | The project table the build bakes in (config/projects.example.json here). |
| `projects[].match` | string or string[] | Folder fragments a workspace's `directory` is matched against; the first is the project's key. |
| `projects[].name` | string | Its display name. |
| `projects[].color` | string | Its colour, hex. |
| `projects[].icon` | string | Its SF Symbol name. |
| `projects[].root` | string | The folder a new session opens in; absent when it has none. |
| `state` | object | The saved state the build bakes in (scripts/state-config.ts `State`). Every required field is present, as an empty object when nothing is saved. The optional ones (`shells`, `poll`, and `ui.mode` and `ui.collapsed` inside `ui`) are left out when unset: read a missing one as empty, and a missing `ui.mode` as "all". |
| `state.asking` | object | wsId to `{ reason, epoch }`: why its agent last stopped to ask. |
| `state.moves` | object | wsId to the "Your move" line its chat last ended on: `text`, `epoch`, `session`, optionally `decisions`, `leans`. |
| `state.prs` | object | wsId to the poller's PR for its branch: `url`, `number`, `status`, `branch`, `title`, `checks` (`{ name, state }`, state "pass", "fail" or "pending"), optionally `mergeable`, `conflicts`, `draft`, `additions`, `deletions`. |
| `state.shells` | object, optional | wsId to its running background shells: `id`, `session` (the agent id that started it), `startedEpoch`. |
| `state.ui` | object | `mode` ("all" or "projects", optional) and `collapsed` (optional: "lane:<key>" or "project:<key>" to 1 folded, 0 unfolded). |
| `state.poll` | object, optional | How the PR poller's last runs went: `okEpoch` (its last success) and `error` ("unavailable", "signed-out" or "missing"). Unset in every scene here. |
| `state.dismissed` | object | wsId to agent id to the start of a dismissed ask. |
| `state.projectOverride` | object | wsId to the project key chosen by "Move to project". |
| `state.projects` | object | Project key to a project made or edited in the sidebar. |
| `state.mergeKept` | object | wsId to the merged PR number Keep was tapped on. |
| `state.ownPrs`, `state.subagents`, `state.names`, `state.published`, `state.prOrigins` | object | Saved for the agents sidebar; empty in every scene here. |

## `<scene>.json`

What the model computes, at the scene's clock.

| Field | Type | Meaning |
| --- | --- | --- |
| `mode` | string | The view mode: "all" or "projects". |
| `placement` | object | Workspace id to where it sits, for every workspace in the data. |
| `placement.<id>.lane` | string | Its lane: "main", "review", "bg", "parked" or "unsorted". |
| `placement.<id>.actualLane` | string | Its lane by cmux's data alone, without a pending move. Equal to `lane` here. |
| `placement.<id>.density` | string | How big its card draws: "full", "compact" or "row". |
| `placement.<id>.card` | boolean | Whether it is a card; false for a lane's generated anchor. |
| `placement.<id>.status` | string | Its agent status: "working", "needs_input", "idle", "ended" or "none". |
| `placement.<id>.project` | string | Its project key, "other" when none matches. |
| `laneHeaders` | object | Lane key to its header. |
| `laneHeaders.<lane>.collapsed` | boolean | Folded or not. |
| `laneHeaders.<lane>.workspaces` | string[] | The cards the header counts, placeholders included, in tab order. |
| `laneHeaders.<lane>.mergeReady` | string | Its merge line, "2 ready to merge", or "". |
| `laneEntries` | array | All mode's rows, top to bottom. |
| `laneEntries[].kind` | string | "header", "zone" (an empty lane), "ws" (a card) or "ghost" (the placeholder of a card in the Needs you strip). |
| `laneEntries[].id` | string | The row's key: `h:<lane>` or `h:<lane>:<anchorId>`, `z:<lane>`, `w:<wsId>`, `g:<wsId>`. |
| `laneEntries[].lane` | string | The lane the row is in. |
| `laneEntries[].anchorId` | string or null | On a header: the generated anchor whose status it shows. |
| `laneEntries[].wsId` | string | On a card or placeholder: its workspace. |
| `projectEntries` | array | Projects mode's rows, top to bottom. |
| `projectEntries[].kind` | string | "header", "ws", "ghost", "newRow", "quietHeader", "quietRow" or "editor". |
| `projectEntries[].id` | string | The row's key: `p:<project>`, `<wsId>@p`, `<wsId>@g`, `new`, `quiet`, `q:<project>`, `e:<project>`. |
| `projectEntries[].project` | string | On a header, quiet row or editor: its project key. |
| `projectEntries[].wsId` | string | On a card or placeholder: its workspace. |
| `quietProjects` | string[] | Project keys with no sessions, in table order. |
| `projectHeaders` | object | Project key to what its header or quiet row shows, for every `header` and `quietRow` in `projectEntries`. |
| `projectHeaders.<key>.name` | string | The project's name; "Other" for `other`. |
| `projectHeaders.<key>.workspaces` | string[] | The cards it counts, placeholders included, in tab order. |
| `projectHeaders.<key>.canOpen` | boolean | Whether it has a folder, so its "+" opens a new session there. |
| `chips` | object | Card id to its chips row, for every card (not a lane's generated anchor). |
| `chips.<id>.chips` | array | `chipsFor` with the branch, as the full and project cards ask for it, in order: `size`, `pr`, `br`, `port`, each only when it has something to show. |
| `chips.<id>.chips[].id` | string | "size" (what answering the chat takes), "pr", "br" (the branch) or "port". |
| `chips.<id>.chips[].text` | string | On size, br and port: the chip's words ("Decide · 2", "feat", ":5173 +1 ↗"). |
| `chips.<id>.chips[].size` | string | On size: "quick", "review" or "decide". |
| `chips.<id>.chips[].dirty` | boolean | On br: uncommitted changes. |
| `chips.<id>.chips[].url` | string | On pr (absent with no link) and port: what a tap opens. |
| `chips.<id>.chips[].tag` | string | On pr: the number, "#12". |
| `chips.<id>.chips[].state` | string | On pr: the words after the number ("draft · running", "1 failing", "open", "merged"). |
| `chips.<id>.chips[].health` | string | On pr: "failing", "conflicts", "running", "ready" or "quiet". |
| `chips.<id>.chips[].diff` | string | On pr: an open PR's diff size, "+120 −8", or "". |
| `chips.<id>.canFileForReview` | boolean | Whether the card offers "To review". |
| `chips.<id>.reviewIsGreen` | boolean | Whether its PR is ready to merge, so "To review" shows green. |
| `chips.<id>.cardChips` | array | `cardChips` with the branch, what the card draws: `chips`, less a merged card's clean branch while Park or Close shows. Each chip as in `chips`. |
| `chips.<id>.showsChipsRow` | boolean | Whether the card has a chips row: a drawn chip, To review, or Park or Close. |
| `chips.<id>.offersPark` | boolean | Whether a merged card offers Park. |
| `chips.<id>.offersClose` | boolean | Whether a merged card offers Close. |
| `chips.<id>.offersMergedActions` | boolean | Whether a merged card offers Keep: not kept for this PR, not an anchor, not pinned. |
| `chips.<id>.keepLabel` | string | The card menu's Keep item, named by what tapping it would do. |
| `chips.<id>.cardOpacity` | number | How faint the card sits when not selected or dragged: 0.6 for a merged card nothing in which wants Jon, else 1. |
| `chips.<id>.fullLine` | object | How `cardChips` fit a full card's line (`FULL_LINE_CHARS`): `fitsOneLine`, `splits` (over two lines) and `secondLineFits` (Park and Close stay on the split's second line). |
| `chips.<id>.projectLine` | object | The same on a project card's line (`PROJECT_LINE_CHARS`). |
| `needs` | object | The Needs you strip. |
| `needs.list` | string[] | Every workspace waiting on you, longest waiting first. |
| `needs.shown` | string[] | The ones the strip lists (at most four). |
| `needs.inStrip` | string[] | The ones whose card leaves a placeholder: `shown`, less a card being dragged. |
| `needs.more` | number | How many the strip leaves out, its "+N more". |
| `needs.waitText` | string | The header's clock for the oldest ask, "12m", or "" with nothing timed. |
| `needs.late` | boolean | Whether the oldest ask has waited 30 minutes or more. |
| `next` | object | The Next button. |
| `next.queue` | string[] | What Next walks through: needs you, then Ready, each longest waiting first. |
| `next.step` | object or null | Where the next press goes: `target` (a workspace id), `position` (1-based) and `total`; null when there is nowhere to go. |
