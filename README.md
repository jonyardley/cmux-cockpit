# cmux-cockpit

Two custom sidebars for [cmux](https://github.com/manaflow-ai/cmux), the
macOS terminal for running coding agents, plus the app config I use with
them. The cockpit sidebar sorts workspaces into lanes and flags the agents
waiting on you; the agents panel lists what every agent is doing.

This is a personal setup shared as is. It follows cmux's custom sidebar
beta, which has no published schema yet, so a cmux update can break it.

## Requirements

- macOS with a cmux build that has custom sidebars enabled
  (`customSidebars.beta.enabled` in `cmux.json`).
- Node 24 or later (see `.nvmrc`).

cmux reads its config from `~/.config/cmux`, so this repo is cloned there
and needs nothing installed or linked. Back up any existing
`~/.config/cmux` first.

## What is here

- `src/cockpit/`: the left sidebar. All | Projects segments, a
  "Needs you" strip (with dismiss), and workspace cards in lanes (cmux groups
  matched by name) or grouped by project.
- `src/agents/`: the agents panel, shown in the right sidebar.
- `src/shared/`: helpers the sidebars share (text clean-up, projects, agent
  ranking, time).
- `src/renderer.d.ts`: types for the renderer's globals and live data.
- `sidebars/*.js`: local build output, built from `src/`. Never committed,
  never edited by hand.
- `sidebars/probe.swift`: a diagnostic sidebar for testing what the renderer
  supports. `*.parked` files are retired experiments.
- `cmux.json`: app settings. `dock.json`: dock controls.
- `config/projects.example.json`: the committed sample project table.
  `config/projects.json` is your real, gitignored table; never commit it.

## Setup

```
npm ci
cp config/projects.example.json config/projects.json   # then edit in your own projects
npm run hooks     # pre-commit runs npm run check; pulls and branch switches rebuild sidebars (and rerun npm ci when the lockfile changed); a branch checkout also restores the right sidebar to agents mode
npm run build
```

## Working on a sidebar

```
npm run dev                         # rebuild sidebars/*.js on every save
npm run check                       # lint, types, dead code (knip), build fresh, tests with a coverage floor, validate
cmux sidebar reload cockpit         # show the change
```

`npm run agents` restores the agents panel in the right sidebar (wraps
`cmux right-sidebar set custom agents`), in case it ever gets swapped out.

A branch checkout's rebuild of `sidebars/*.js` (see below) drops cmux out
of custom right-sidebar mode; in the main checkout the post-checkout hook
restores it to `agents` automatically.

`cmux sidebar validate` only reads `~/.config/cmux/sidebars`, so it runs in
the main checkout only; in a worktree `npm run validate` skips with a note.

## Rules the renderer taught me

- Sidebars cannot import at runtime, so `src/` is bundled into one flat
  script per sidebar.
- Borders use `ring()`, never `borderWidth` (it is clipped by the corner
  radius). Pass `hug` for chips and buttons.
- Outer margins go on a wrapper VStack; on the same node the background is
  drawn under the padding.
- A sidebar cannot switch the right sidebar's mode: only the CLI can.
  `sidebar.custom.open` opens a pane in the middle instead.
- Put taps on a shape, not a framed Image, or only the glyph takes the tap.

## Contributing and licence

See [CONTRIBUTING.md](CONTRIBUTING.md) and [SECURITY.md](SECURITY.md).
Released under the [MIT licence](LICENSE).
