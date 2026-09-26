# Security

Please report a vulnerability privately through GitHub's
[private vulnerability reporting](../../security/advisories/new) rather than
in a public issue. I aim to reply within a week.

In scope: the sidebar code in `src/`, the build and validate scripts in
`scripts/`, the git hooks in `.githooks/`, and the CI workflows.

## What runs on your machine

- `npm run hooks` is opt-in. Once installed, the pre-commit hook runs
  `npm run check`, and after a pull that changes `package-lock.json` the
  post-merge hook runs `npm ci`, which runs dependency install scripts.
  Read a lockfile change before you pull it.
- `.claude/settings.json` defines Claude Code hooks that run
  `scripts/hooks/*.ts` with Node. Claude Code asks you to trust the project
  before they run.
- The built sidebars run inside cmux with the renderer's permissions. They
  make no network requests.
