# cmux-cockpit: working rules for agents

Two cmux custom sidebars written in strict TypeScript and bundled into the
flat scripts cmux loads. README.md has the layout and commands.

## Never

- Edit `sidebars/*.js`. They are local build output from `src/` by
  `npm run build`, never committed, so there is nothing for CI to check
  freshness against; CI runs `npm run build` itself as part of `npm run check`.
- Run `cmux sidebar reload`, move workspaces, or change groups: the person at
  the screen reloads and checks by eye. Ask before any tap or drag test.
- Use `any`, `as any`, `!` non-null assertions, `@ts-ignore` or
  `@ts-expect-error`, or loosen `tsconfig.json` or `biome.json` to get green.
  Model the type instead; an `as` cast needs a comment saying why it holds.
- Weaken or delete a test to get green.
- Commit `config/projects.json`. It holds the real project table and is
  gitignored; `config/projects.example.json` is the committed sample.

## Definition of done

1. `npm run check` passes: Biome, both type checks, knip (no dead exports
   or files), build is fresh, tests, and the coverage floor on the logic
   modules. The floor is the total across those modules, not per file, so
   one module can sit below it. Raise it when coverage rises; never lower
   it to get green. It ends with `npm run rust`: rustfmt, clippy and the
   Rust tests under `native/`.
2. New or changed logic in a sidebar's model modules (below) or a
   `shared/` module has a test in `test/`.
3. The PR says what the maintainer should look at after reload: validate and the
   renderer only run on main, so behaviour on screen is unverified until then.

## Where code goes

- `src/shared/`: pure helpers both sidebars use. One copy, never mirrored.
- `src/<sidebar>/*.ts` other than `index.ts` and `theme.ts`: data and
  state. Reads `data`, returns plain values, no views. This is what the
  tests cover. In cockpit, `model.ts` holds lanes and placement, and
  `strip.ts` (Needs you), `lane-entries.ts` (All), `by-project.ts`
  (Projects), `next.ts` and `card-chips.ts` build on it. In agents,
  `model.ts` holds the selected workspace itself, and `lists.ts` (caps
  and "+N more"), `team.ts` (agent rows and Helpers), `checks.ts` (checks
  and Fix), `pr-list.ts` (Pull requests) and `made.ts` (Made here) build
  on it. Never the other way round. A new module joins the coverage list
  in `package.json`.
- `src/<sidebar>/views/`: view builders only. Keep logic out; if a view
  needs a decision, put it in the model and test it there.
- `src/<sidebar>/theme.ts`: colour tokens. No hex literals scattered in new
  code; add a token.
- `src/renderer.d.ts`: the renderer contract. When code needs a renderer
  call or data field that is not declared, add it here first. Data fields
  stay optional: there is no published schema (issue #7).
- Biome caps cognitive complexity at 15: split a function rather than
  raising the cap.

## Renderer rules

- Borders use `ring()` (hug for chips and buttons), never `borderWidth`.
  Outer margins go on a wrapper VStack.
- A reactive value is a zero-argument function; a plain value is read once.
  Maps and `let`s are not reactive: read with `tick()`, write with `bump()`.
- A ForEach row's kind is fixed by its key: new kinds need new keys.

## When the maintainer reports a bug on screen

- Their description is the ground truth. Before offering any cause, restate
  the exact trigger in one line (what they did, what appeared instead) and
  ask for the missing step if it is not there. Never call the reported state
  "working as designed" or "not missing" until you have reproduced it.
- Reproduce it off screen from their steps: a test on the fake renderer or a
  `npm run preview` scene. If you cannot reproduce it, say so; do not guess.
- Before writing the fix, trace where the panel really reads that data
  (which field, which sidebar, cmux data or local state), and make the
  reproducing test pass against that path, not an assumed one.
- A fix that looks right, then snaps back after a few seconds on screen, can
  be an optimistic override expiring over data that disagrees: test past the
  expiry by advancing `r.data.epoch`.

## Tests

`node:test` with TypeScript run natively. `test/support/renderer.ts` fakes
the renderer: install it, then `await import()` the module under test.
`test/built.test.ts` runs the built bundles as cmux would. Each test file is
its own process; within a file, advance `r.data.epoch` to expire optimistic
overrides between tests.

The fake renderer also records each view's tree, and
`test/snapshot-*.test.ts` print seven fixture scenes as text (elements,
words, colours by token name, spacing) into `test/__snapshots__/`, one
file per scene. `npm run check` fails on any drift; when the change on
screen is meant, `npm run snapshots` re-records them, and the snapshot
diff, in words, fills the PR's `## What changed on screen` section.

`npm run preview` draws the same scenes as PNGs in the gitignored
`preview/` (test/support/html.ts maps the tree to HTML, headless Chrome
screenshots it), so a design change can be judged by eye without a
reload. It approximates SwiftUI in flexbox: spacing and colour are true,
text width and symbols are close. Every scene must render with nothing
the mapping does not know; add a new modifier or view there.

Every PR that moves a scene also carries pictures: once the PR is open
and HEAD is pushed with a clean tree, run `npm run pr-visuals` and paste
the before and after table it prints into `## What changed on screen`.
Re-run it after later pushes that change a scene again. Never leave a UI
PR with the words alone.

## Rust in native/

`native/` is one Cargo workspace: `core` (the `cockpit_core` Crux app),
`runner` (`cockpit_runner`, the live-data runner, with no terminal types)
and `pane` (`cockpit_pane`, the terminal pane, a thin loop over the
runner). `rust-toolchain.toml` at the root pins the toolchain, and
`npm run rust` (part of `npm run check`) runs rustfmt, clippy with
warnings denied, and the tests, from `native/`.

- No `unwrap`, `expect` or `panic!` in core logic: model the failure
  and return it. Tests may unwrap. Clippy enforces this in every crate
  that opts into the workspace lints, as `core` does.
- No `#[allow(...)]`, `#![allow(...)]` or lint config to get green: fix
  the code. Same spirit as the TypeScript never-list.
- Clippy clean with warnings denied, on every target, tests included.
- New logic in `core` has a test beside it.

## Workflow

Work on a branch and open a PR; main is protected by habit.
`npm run hooks` once per clone installs the git hooks, including the
pre-commit check. Before a PR is ready for review, every CI check is green
on the last commit (`npm run check` locally covers most of them) and its
description's `## Look at after reload` and `## Review` sections hold real
text, not empty or a placeholder: what to check on screen after reload,
and who reviewed, what they found and what happened to each finding. The
`PR description` check enforces both (it skips drafts), and
`npm run pr-body` runs it on the live description. The maintainer reviews
and merges. Agents never merge.

`.claude/settings.json` hooks block edits to the Never-list files, run
Biome after each edit, and refuse `gh pr ready` while either section is
empty or a placeholder; the scripts are in `scripts/hooks/`. That hook
only sees `gh pr ready` in Bash: going ready any other way, run
`npm run pr-body` first. CI also runs `npm audit`, and gitleaks scans each
PR's commits and, weekly, the full history.

A gitignored `CLAUDE.local.md`, where present, holds the maintainer's own
workflow on top of these rules.
