## What changed

<!-- The outcome, in a sentence or two. -->

## Look at after reload

<!-- Required. Validate and the renderer only run on main, so name what to
check by eye after `cmux sidebar reload`, or write "nothing on screen". -->

## Review

<!-- Required. Who reviewed and how (for example `/code-review high`), what
it found, and what happened to each finding: fixed, or why not. Write
"no findings" if it was clean. -->

## Checklist

- [ ] `npm run check` passes locally
- [ ] New or changed logic in `model.ts`, `status.ts`, `drop.ts` or `shared/` has a test
- [ ] No edits to `sidebars/*.js`, and `config/projects.json` is not committed
