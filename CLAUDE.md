# cmux-cockpit: working rules for agents

Two cmux custom sidebars written in strict TypeScript and bundled into the
flat scripts cmux loads. README.md has the layout and commands.

## Never

- Edit `sidebars/*.js`. They are local build output from `src/` by
  `npm run build`, never committed, so there is nothing for CI to check
  freshness against; CI runs `npm run build` itself as part of `npm run check`.
- Run `cmux sidebar reload`, move workspaces, or change groups: Jon reloads
  and checks by eye. Ask before any tap or drag test.
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
   it to get green.
2. New or changed logic in a `model.ts`, `status.ts`, `drop.ts` or
   `shared/` module has a test in `test/`.
3. The PR says what Jon should look at after reload: validate and the
   renderer only run on main, so behaviour on screen is unverified until then.

## Where code goes

- `src/shared/`: pure helpers both sidebars use. One copy, never mirrored.
- `src/<sidebar>/model.ts` (plus `status.ts`, `drop.ts`, `state.ts` in
  cockpit): data and state. Reads `data`, returns plain values, no views.
  This is what the tests cover.
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

## Tests

`node:test` with TypeScript run natively. `test/support/renderer.ts` fakes
the renderer: install it, then `await import()` the module under test.
`test/built.test.ts` runs the built bundles as cmux would. Each test file is
its own process; within a file, advance `r.data.epoch` to expire optimistic
overrides between tests.

## Workflow

Work on a branch in a worktree and open a PR; main is protected by habit.
Create it with `wt switch -c <branch>` (worktrunk): it lands in
`~/.config/cmux-worktrees/<branch>` and opens its own cmux workspace.
Never `git worktree add`, `.claude/worktrees/` or `just worktree-new`; those
are the old setup and the guard blocks them.

Review before hand-off, in this order:

1. Open the PR and let CI run. The `PR description` check stays red
   until step 3; that is the gate, not a failure to chase.
2. Run `/code-review high` on the PR diff. Fix each finding, or say in the
   PR why not.
3. Fill the PR's `## Review` section with the level, the findings and what
   happened to each. The check needs it and `## Look at after reload` to
   hold real text.
4. Every check green on the last commit, after the fixes. Then Jon reviews
   and merges. Agents never merge.
5. After Jon merges, close out in one hand-off: a single command in its
   own fenced block, starting with `!` so it runs when pasted here. It
   pulls, rebuilds, reloads, and removes every merged worktree this
   session made. Never a bare `cmux sidebar reload` (on stale main it
   loads the old build), and never leave a worktree for Jon to find:
   `! git -C ~/.config/cmux pull --ff-only && npm --prefix ~/.config/cmux run build && cmux automation reload && cmux sidebar reload && wt remove <branch>`
   `wt remove` deletes the branch once merged and closes its cmux
   workspace. The main-checkout guard blocks it for agents, so it goes in
   the hand-off, not a retry. On "prune" or "cleanup for exit", check
   `wt list`: chain every merged worktree, and name any unmerged one for
   Jon instead of removing it.

`npm run hooks` once per clone installs the pre-commit check.
`.claude/settings.json` hooks block edits to the Never-list files and run
Biome after each edit; the scripts are in `scripts/hooks/`. CI also runs
`npm audit`, and gitleaks scans each PR's commits and, weekly, the full
history.
