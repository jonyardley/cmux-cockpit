## What changed

<!-- The outcome, in a sentence or two. -->

## What changed on screen

<!-- From the diff of test/__snapshots__/ after `npm run snapshots`: which
scenes moved and what a reader would see differently, in words. Write
"no snapshot changes" when none moved. Paste the before and after table
`npm run pr-visuals` prints once the PR is open. -->

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
