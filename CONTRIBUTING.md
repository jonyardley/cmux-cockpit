# Contributing

This is a personal cmux setup, so I may turn down changes that do not fit
how I use it. Issues and small pull requests are welcome.

## Setup

```
npm ci
cp config/projects.example.json config/projects.json
npm run hooks   # optional: see SECURITY.md for what the hooks run
npm run build
```

## Before you open a pull request

- `npm run check` passes: Biome, both type checks, knip, a fresh build,
  and the tests with their coverage floor.
- New or changed logic in a `model.ts`, `status.ts`, `drop.ts` or
  `src/shared/` module has a test in `test/`.
- The PR template's "Look at after reload" section says what to check on
  screen after `cmux sidebar reload`. CI cannot run the cmux renderer.
- Never edit `sidebars/*.js` (build output) or commit
  `config/projects.json` (your private project table).

CLAUDE.md holds the full working rules; it is written for coding agents but
reads fine for people.
