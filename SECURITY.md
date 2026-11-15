# Security

Please report a vulnerability privately through GitHub's
[private vulnerability reporting](../../security/advisories/new) rather than
in a public issue. I aim to reply within a week.

In scope: the sidebar code in `src/`, the scripts and hooks in `scripts/`,
the helper app in `helper/`, the git hooks in `.githooks/`,
`automations.json`, and the CI workflows.

## What runs on your machine

Installing runs `npm ci`, which runs dependency install scripts (esbuild
fetches its binary this way), and then the build. Everything else below is
off until you install it.

- **The sidebars** run inside cmux with the renderer's permissions. They
  make no network requests.
- **The helper app** (`npm run helper`) installs
  `~/Applications/CmuxCockpit.app` and registers the `cmux-cockpit://`
  link type. Opening such a link writes `config/state.json` and rebuilds
  the sidebars. Any web page can try to open one; your browser asks first,
  and the helper refuses any link without the per-install token the build
  keeps in `config/url-token` (readable by you only). A link can only
  change what the sidebars show (dismissals, project choices and projects
  made from a card), never run a command. Delete the app to remove it.
- **The automations** (`automations.json`, once linked into
  `~/.cmuxterm/`) run `scripts/restore-agents.sh` when cmux opens a
  window, and `scripts/pr-poll.sh` when an agent ends a turn or you select
  a workspace. The poller runs `gh pr list` in every
  workspace's repo with your `gh` sign-in, and writes the results to
  `config/state.json`.
- **The Claude Code hooks** setup adds to `~/.claude/settings.json` and
  `$CLAUDE_CONFIG_DIR/settings.json` run `scripts/hooks/dispatch.ts` with
  Node on the events listed in the
  [quickstart](docs/quickstart.md#claude-code-hooks), which runs the
  `scripts/hooks/report-*.ts` scripts `scripts/hooks/routes.ts` names. They write
  `config/state.json` and start a background rebuild of the sidebars;
  `report-pr.ts` instead runs `gh pr view`, sends cmux the result and
  starts a poll. Problems are logged to
  `~/Library/Logs/cmux-cockpit-state.log`.
- **The git hooks** (`npm run hooks`): pre-commit runs `npm run check`.
  After a branch switch, a pull or a rebase they rebuild the sidebars and
  run `cmux right-sidebar set custom agents`; after a pull that changes
  `package-lock.json` they run `npm ci`, which runs dependency install
  scripts. Read a lockfile change before you pull it.
- **The project hooks** in `.claude/settings.json` run
  `scripts/hooks/*.ts` with Node in Claude Code sessions inside this repo.
  Claude Code asks you to trust the project before they run.
