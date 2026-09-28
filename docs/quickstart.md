# Quickstart

Get both sidebars running on your own projects in about 15 minutes. The
cockpit (left) sorts your cmux workspaces into lanes and flags the agents
waiting on you. The agents panel (right) details the selected workspace,
your open pull requests and the pages your agents published.

Steps 1 to 6 are all you need. The optional extras after them turn on the
richer signals, and each one says what it adds.

## Before you start

- macOS with [cmux](https://github.com/manaflow-ai/cmux). Tested on cmux
  0.64.25; highlighting a lane while you drag a card needs 0.65.0 or later.
  Custom sidebars are a cmux beta with no published schema, so a cmux
  update can break them. Check yours with `cmux --version`.
- Node 24.2 or later (`node --version`).
- git.
- Optional: [Claude Code](https://claude.com/claude-code) for the hooks, and
  the GitHub CLI (`gh`) signed in (`gh auth login`) for pull request chips.

## 1. Back up your cmux config

cmux reads its config and sidebars only from `~/.config/cmux`, so the repo
has to live there. If you already have that folder, move it aside (the
command does nothing if a backup already exists, so it is safe to rerun):

```sh
[ -e ~/.config/cmux ] && [ ! -e ~/.config/cmux.backup ] && mv ~/.config/cmux ~/.config/cmux.backup
```

## 2. Clone and install

```sh
git clone https://github.com/jonyardley/cmux-cockpit ~/.config/cmux
cd ~/.config/cmux
npm ci
```

## 3. Switch on custom sidebars

```sh
cp cmux.example.json cmux.json
cmux reload-config
```

That file only turns on the custom sidebars beta. If you had your own
`cmux.json`, copy its settings back from `~/.config/cmux.backup/cmux.json`
into this one and keep the `customSidebars` block. `cmux.json` is ignored by
git, so your settings stay yours.

## 4. Add your projects

```sh
cp config/projects.example.json config/projects.json
```

Edit `config/projects.json`. Each entry puts matching workspaces under one
project in the cockpit's Projects view:

- `match`: part of a folder path, in lower case, such as `"/dev/my-app"`,
  or a list of them. The first entry that matches wins.
- `name`: what the header shows.
- `color`: a hex colour such as `"#6A9BCC"`.
- `icon`: an [SF Symbols](https://developer.apple.com/sf-symbols/) name,
  such as `"star.fill"`.
- `root` (optional): a folder, `~` allowed. It adds a "+" to the project's
  header that opens a new workspace there.

This file is ignored by git too. You can also make a project from any
card's menu later ("New project from this folder").

## 5. Build

```sh
npm run build
```

This writes `sidebars/cockpit.js` and `sidebars/agents.js`, the files cmux
loads. Run it again after every change to `config/projects.json`.

## 6. Show the sidebars

```sh
cmux sidebar select cockpit
npm run agents
```

The first puts the cockpit in the left sidebar. The second puts the agents
panel in the right sidebar (it wraps `cmux right-sidebar set custom
agents`).

You should now see your workspaces as cards on the left, and the selected
workspace's agents on the right:

![The cockpit on the left and the agents panel on the right](images/sidebars.png)

## What you are looking at

The cockpit has two views, All and Projects:

- **All** sorts cards into four lanes, one per cmux workspace group:
  "Main activity", "For review", "Background" and "Parked". Anything not in
  one of those groups shows under "Unsorted". Drag a card to a lane, or use
  its menu; the group is created the first time you move a card into it.
- **Projects** groups cards by your `config/projects.json`. Projects with
  nothing open fold into one "Quiet" row of icons at the bottom.
- **Needs you**, at the top, lists agents waiting on you. Clay
  "Your turn" means the agent finished; amber "Asking" means it stopped on
  a question or a permission (that needs the hooks below). Dismiss a row
  to hide it until the agent next needs you.

The agents panel shows the selected workspace: each agent's status and
latest message, an Answer button when one is waiting, ports and checks.
Under it are your open pull requests and "Made here", the pages and docs
your agents published.

## Optional extras

### Remember dismissals and project changes

A sidebar cannot save anything itself. A small helper app does it for
them: it writes `config/state.json` and rebuilds.

```sh
npm run helper
```

This builds `~/Applications/CmuxCockpit.app` and registers the
`cmux-cockpit://` link type. Without it, dismissals and project moves last
only until cmux reloads the sidebar. The app looks for Node each time it
runs, the same way the poller does (below), so a Node upgrade needs no
reinstall.

Any web page could open a `cmux-cockpit://` link; your browser asks
before it hands one over. The helper only accepts links carrying a token
the first build made for your install (`config/url-token`), which a web
page cannot read, and even then the worst a link can do is change what
the sidebars show. See [SECURITY.md](../SECURITY.md). To remove the helper,
delete `~/Applications/CmuxCockpit.app`.

### Pull request chips and keeping the agents panel

cmux leaves the pull request chips empty for PRs opened by an agent, and
can drop the right sidebar out of the agents panel when it opens a window.
Three cmux automation rules fix both. cmux reads rules only from
`~/.cmuxterm/automations.json`, and this replaces that file, so merge any
rules you already have into `~/.config/cmux/automations.json` first:

```sh
mkdir -p ~/.cmuxterm
[ -f ~/.cmuxterm/automations.json ] && [ ! -L ~/.cmuxterm/automations.json ] && mv ~/.cmuxterm/automations.json ~/.cmuxterm/automations.json.backup
ln -sfn ~/.config/cmux/automations.json ~/.cmuxterm/automations.json
cmux automation reload
```

What each rule runs:

- `restore-agents-panel`, when a window opens: puts the right sidebar back
  on the agents panel if it falls out in the next ten seconds.
- `pr-poll-turn` and `pr-poll-select`, when an agent ends a turn or you
  select a workspace (at most every 30 seconds): run `gh pr list` in each
  workspace's repo, using your `gh` sign-in, and fill in the chips. That
  includes any client repos you have open.

The poller runs outside your shell, so it looks for Node on cmux's PATH,
then fnm's default, nvm (its default alias, else the newest installed),
volta, asdf and mise (the newest installed), then Homebrew. If it finds
none it does nothing and logs a line saying so.

### Claude Code hooks

These hooks tell the sidebars what cmux cannot see. Each one runs only
inside a cmux terminal and quietly does nothing elsewhere. Add these to
the `hooks` object of `~/.claude/settings.json`. Where you already have an
array for an event (say `PreToolUse`), add these entries to it rather than
replacing it, or your existing hooks stop running:

```json
{
  "hooks": {
    "PreToolUse": [
      { "matcher": "Agent", "hooks": [{ "type": "command", "command": "node $HOME/.config/cmux/scripts/hooks/report-subagent.ts" }] },
      { "matcher": "AskUserQuestion|ExitPlanMode", "hooks": [{ "type": "command", "command": "node $HOME/.config/cmux/scripts/hooks/report-notification.ts" }] }
    ],
    "PostToolUse": [
      { "matcher": "Bash", "hooks": [{ "type": "command", "command": "node $HOME/.config/cmux/scripts/hooks/report-pr.ts" }] },
      { "matcher": "Artifact|mcp__claude_ai_Claude_Docs__batch", "hooks": [{ "type": "command", "command": "node $HOME/.config/cmux/scripts/hooks/report-published.ts" }] }
    ],
    "SubagentStart": [
      { "hooks": [{ "type": "command", "command": "node $HOME/.config/cmux/scripts/hooks/report-subagent.ts" }] }
    ],
    "SubagentStop": [
      { "hooks": [{ "type": "command", "command": "node $HOME/.config/cmux/scripts/hooks/report-subagent.ts" }] }
    ],
    "PermissionRequest": [
      { "matcher": "", "hooks": [{ "type": "command", "command": "node $HOME/.config/cmux/scripts/hooks/report-notification.ts" }] }
    ],
    "Notification": [
      { "matcher": "permission_prompt|elicitation_dialog|elicitation_url_dialog", "hooks": [{ "type": "command", "command": "node $HOME/.config/cmux/scripts/hooks/report-notification.ts" }] }
    ]
  }
}
```

What each script turns on:

- `report-notification.ts`: amber "Asking" with the question, instead of
  every stop reading as "Your turn".
- `report-subagent.ts`: a row per running subagent under its agent.
- `report-pr.ts`: a chip as soon as an agent runs `gh pr create`, instead
  of at the next poll.
- `report-published.ts`: the "Made here" list of published pages and docs.

### When something does not work

The helper, the poller and the hooks never interrupt you: each problem is a
line in `~/Library/Logs/cmux-cockpit-state.log`. Start there.

### The dock

`dock.example.json` holds one sample dock control, an Inbox that shows
`gh status` every five minutes. Copy it to `dock.json` if you want it.

## Updating

```sh
cd ~/.config/cmux
git pull
[ -e cmux.json ] || { cp cmux.example.json cmux.json && cmux reload-config; }
npm ci
npm run build
cmux sidebar reload
```

Clones from before `cmux.json` became a local file lose it on that pull;
the third line puts the minimum back. Your old settings are in git
history:
`git show "$(git log -1 --format=%h --diff-filter=D -- cmux.json)^:cmux.json"`.

## Removing it

This keeps a copy of your own files (`cmux.json`, your project table and
saved state) in `~/cmux-cockpit-keep` before deleting the clone:

```sh
mkdir -p ~/cmux-cockpit-keep
cp ~/.config/cmux/cmux.json ~/.config/cmux/config/projects.json ~/.config/cmux/config/state.json ~/cmux-cockpit-keep/ 2>/dev/null
rm -rf ~/.config/cmux
[ -e ~/.config/cmux.backup ] && mv ~/.config/cmux.backup ~/.config/cmux
```

Then remove the extras you added:

- the helper: `~/Applications/CmuxCockpit.app`
- the automations link: `~/.cmuxterm/automations.json` (and restore
  `automations.json.backup` if you had one)
- the `report-*.ts` hooks in `~/.claude/settings.json`

## Working on it

[CONTRIBUTING.md](../CONTRIBUTING.md) covers the dev loop, the checks and
the git hooks. [docs/state-loop.md](state-loop.md) explains how the saved
state, pull request data and hooks work.
