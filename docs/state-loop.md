# The local state loop

A sidebar has no filesystem, network or timers (upstream
`docs/custom-sidebars.md`), so anything it holds is gone on reload. This loop
gives it durable state until cmux ships a sidebar store (manaflow-ai/cmux#9985,
tracked in #20).

```
sidebar ──openURL──▶ CmuxCockpit.app ──▶ scripts/state-set.ts
                                           │ applySet, atomic write
                                           ▼
                                  config/state.json (gitignored)
                                           │ npm run build
                                           ▼
sidebars/*.js with __STATE__ baked in ──▶ cmux hot-reloads the sidebar
```

## The URL

```
cmux-cockpit://set?key=<map>.<id>&value=<url-encoded JSON>
cmux-cockpit://set?key=<map>.<id>            (no value: delete the entry)
```

| map               | value                          | issue |
| ----------------- | ------------------------------ | ----- |
| `dismissed`       | `{"<agentId>": <epoch>, ...}`  | #5    |
| `projectOverride` | `"<project key>"`, its first match path, e.g. `"/dev/alpha"` | #8    |
| `projects`        | `{"name", "color": "#rrggbb", "icon": "<SF Symbol>", "root"?}` | #9    |

The id is a workspace id, except for `projects`, where it is the project's
match: an absolute, lowercase directory. Only the first dot splits the key,
so a dotted path stays whole.
Any other host, path or map is refused. `scripts/state-config.ts` holds the
rules (`applySet`, `validateState`) and their tests.

## config/state.json

```json
{ "dismissed": { "<wsId>": { "<agentId>": 1790416690 } },
  "projectOverride": { "<wsId>": "/dev/alpha" },
  "projects": { "/users/jon/dev/scratch": { "name": "Scratch", "color": "#6A9BCC",
                "icon": "folder.fill", "root": "/Users/jon/dev/scratch" } } }
```

A missing or malformed file reads as empty state; bad entries are dropped,
never fatal, so a bad write cannot break the build. Each map keeps its newest
256 entries.

The build merges `projects` over `config/projects.json`, and the file wins:
an in-app project whose match or name is already taken is left out, and so
is dropped from the `__STATE__` the sidebar sees, so the menu never offers
to edit it. Projects in the file are never written by the loop.

## Cost of a save

Every save rebuilds both bundles and cmux reloads both sidebars. Anything
held only for the session goes with it: a card just dragged to a lane can
snap back until cmux reports the move, and the agents panel reloads for a
change it does not use. Saves are rare (a dismissal, a project move), so this
is accepted until cmux's own store lands (#20).

## Trust

Any web page can open a `cmux-cockpit://` URL. The worst it can do is write a
bounded, validated entry and trigger a rebuild. The handler never passes URL
content to a shell.
