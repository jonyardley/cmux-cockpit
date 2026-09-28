# Contributing

This is a personal cmux setup, so I may turn down changes that do not fit
how I use it. Issues and small pull requests are welcome.

## Setup

Follow the [quickstart](docs/quickstart.md) to install, then:

```
npm run hooks   # optional: installs the git hooks below
```

The git hooks, once installed:

- pre-commit runs `npm run check`. Skip it once with `--no-verify`.
- After a branch switch, a pull or a rebase they rebuild `sidebars/*.js`,
  and after a pull that changed `package-lock.json` they run `npm ci`
  first. In the main checkout they also put the right sidebar back on the
  agents panel.
- pre-push only checks pushes to this repo on GitHub, where it refuses
  history from before the repo went public. It does nothing for a fork.

## Before you open a pull request

- `npm run check` passes: Biome, both type checks, knip, a fresh build,
  the tests with their coverage floor, and `cmux sidebar validate` (main
  checkout only).
- New or changed logic in a `model.ts`, `status.ts`, `drop.ts` or
  `src/shared/` module has a test in `test/`.
- The PR template's "Look at after reload" section says what to check on
  screen after `cmux sidebar reload`. cmux loads sidebars only from
  `~/.config/cmux`, so CI and worktrees cannot show them.
- Never edit `sidebars/*.js` (build output) or commit
  `config/projects.json` (your private project table).

## npm scripts

| Script | What it does |
| --- | --- |
| `build` | Bundles `src/` into `sidebars/*.js` |
| `dev` | Rebuilds on every save |
| `check` | Everything CI runs |
| `lint`, `fix` | Biome check, or apply its fixes |
| `typecheck`, `knip`, `test`, `coverage` | The parts of `check` one at a time |
| `validate` | `cmux sidebar validate`, main checkout only |
| `pr-body` | Checks an open PR's description (needs `gh`) |
| `hooks` | Installs the git hooks |
| `helper` | Installs the URL handler app that saves state |
| `agents` | Puts the agents panel in the right sidebar |

## Working with Claude Code

CLAUDE.md holds the full working rules; it is written for coding agents but
reads fine for people. Its Workflow section is the maintainer's own setup
(worktrunk worktrees, a self-review before hand-off); skip it if you work
differently.

`.claude/settings.json` adds three project hooks that run in Claude Code
sessions in this repo:

- `guard-edit`: refuses edits to `sidebars/*.js` and `config/projects.json`.
- `lint-edit`: runs Biome on each file after an edit.
- `guard-ready`: refuses `gh pr ready` while the PR description's Review
  or "Look at after reload" section is empty.
