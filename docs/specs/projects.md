# Projects: assignment and creation

> **Superseded.** This is the design note written before projects shipped,
> kept for history. Much of what it calls impossible now works: the agents
> panel reads projects, "Move to project" persists, and a card can make its
> folder a project. For how it works today, see
> [state-loop.md](../state-loop.md) and the [README](../../README.md).

Answers issues [#8](https://github.com/jonyardley/cmux-cockpit/issues/8)
(assign sessions to projects) and
[#9](https://github.com/jonyardley/cmux-cockpit/issues/9) (create and
customise a project). Grounded in `src/shared/projects.ts`,
`src/cockpit/model.ts`, `src/cockpit/lanes.ts`, `src/cockpit/drop.ts`,
`scripts/build.ts`, `scripts/projects-config.ts`, and the renderer's
published capabilities (`docs/custom-sidebars.md` in manaflow-ai/cmux).

## What already works

Automatic, path-based assignment (#8 Q1) is done. `projectOf()` in
`src/shared/projects.ts` lowercases a workspace's `directory` and matches it
against each `Project.match` (a string or list of path fragments); the first
hit wins, otherwise a workspace falls into a synthetic "Other" project.
`src/cockpit/model.ts`'s `projectKey()`/`projectEntries()` groups cards by
this for the Projects view. `PROJECTS` comes from `config/projects.json`
(gitignored, real table) or `config/projects.example.json` (fallback),
injected at build time as the `__PROJECTS__` define by `scripts/build.ts`
and shape-checked by `scripts/projects-config.ts` (unique first-match,
unique name, lowercase match strings). This covers the common case
zero-touch: open a session under a matched path and it lands in the right
project without any UI action.

The #8 mirroring worry (cockpit.js and agents.js must agree, since sidebars
cannot import) is currently moot: `__PROJECTS__` is injected into both
bundles, but `src/agents/*.ts` does not read `PROJECTS` at all today. It
becomes live the day the agents panel groups by project too.

## Why override and creation are hard

#8 Q2/Q3 and #9 all hit the same wall: **project is not a cmux concept**,
only a sidebar-computed grouping over `directory`. Compare with lanes,
which *are* real: `moveToLane()` in `src/cockpit/lanes.ts` calls
`cmux("workspace.group.add"/"remove")` against actual cmux workspace groups
(`data.groups()`, `w.group`), and a local override map only bridges the few
seconds until cmux's own data reflects the move — it persists because cmux
persists group membership itself. A workspace has exactly one `group`
field, already spent on lanes, so project assignment cannot reuse that
channel without colliding with lanes, and cmux exposes no second slot (no
tags, no custom metadata) on `Workspace`.

`src/cockpit/state.ts` says outright that `signal()` state is "local to
this sidebar, forgotten on reload", confirmed generally by the renderer
docs: sidebars are sandboxed (no filesystem, network or storage), and there
is no settings/config API or text-input control (`TextField`, `Toggle` and
friends are "still missing"). So a manual override can only be a
same-session optimistic UI patch, and nothing lets someone type a new
project's name, colour or icon into the sidebar itself.

## Answering #8

1. **Automatic from path?** Yes, already shipped (`projectOf`).
2. **Override mechanism?** No persistence route exists via cmux, so the
   honest option is a session-only override: a context-menu "Move to
   project" action (mirroring `moveToLane`), an in-memory map from
   workspace id to project key, consulted the way `laneOf()` consults
   `laneOverride`. Drag and drop is possible in principle (`Reorderable`'s
   `onMove` is the renderer's only drop primitive) but the Projects list
   is not currently a `Reorderable` surface (`flatEntries` returns `[]`
   outside "all" mode) — that is a second, separate piece of work for the
   same result.
3. **Where it persists, sync?** It does not survive reload with today's
   renderer; it would need re-deriving from `directory` again after
   reload, same as before the override. This is the one question the
   renderer, not the code, blocks: it needs a per-workspace custom field
   from cmux, or a documented way to write local files. Neither exists.
4. **Wrong project by mistake?** Given (3), "move it" via the context menu
   is strictly better than close-and-reopen: no lost agent, no extra cost.
   Reopening in the right directory is the only way to make the automatic
   rule pick it up permanently, since the override resets on reload.

## Answering #9

1. **Made of:** already fully specified by `Project` in
   `src/shared/projects.ts`: `match` (string or list), `name`, `color`,
   `icon` (SF Symbol), and an optional `root` (absolute path, `~` allowed)
   that shows a "+" on the project's header to open a new workspace there.
   Ordering is array order in `config/projects.json`.
2. **Where it lives:** stays `config/projects.json` (gitignored) plus
   `config/projects.example.json` (committed sample), validated by
   `scripts/projects-config.ts`, injected by `scripts/build.ts`. This is
   already one source both sidebars read (only whether `agents.ts` uses it
   is open, per #8). A cmux-settings store was considered and rejected: no
   settings API exists, and it would drop the table out of git history and
   build-time validation for no gain.
3. **Creation in-UI, or config?** By editing config. No text-input
   controls exist in the renderer, so the minimum viable version is what
   already exists: copy an entry in `config/projects.json`, edit it,
   `npm run build`/`dev` picks it up, with `scripts/projects-config.ts`
   catching a duplicate name or match at build time.
4. **Interaction with automatic assignment:** unchanged; a new entry
   immediately catches any workspace whose `directory` matches, including
   ones opened before the edit, once the sidebar rebuilds and reloads.

## Minimum viable next step

Add a "Move to project" context menu (`.contextMenu([...])`) to each card
in Projects mode, backed by a session-only override map shaped like
`laneOverride`: recompute `projectKey()` through the override first, fall
back to `projectOf()`.

Trade-off: fixes the exceptions (wrong directory, a repo spanning two
projects) for as long as the session stays open, but a reload silently
reverts to the path rule with no warning the override was lost. That is a
real rough edge, not a bug to hide — worth a one-line UI note, or just
accepted, since automatic-by-path is already right most of the time.

## Impossible with today's renderer

- A manual override that survives reload: no per-workspace custom field,
  no filesystem or storage access from a sidebar script.
- In-app project creation or editing: no `TextField` or other input
  control exists in the renderer yet.
- True drag-and-drop reassignment without first turning the Projects view
  into a second `Reorderable` list, since `flatEntries` (the only current
  feed) is lane-only.
- Reusing cmux's own persistence (`workspace.group`) for project
  membership without conflicting with lanes, since a workspace carries
  only one `group` field and lanes already use it.
