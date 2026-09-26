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
cmux-cockpit://set?key=<map>.<wsId>&value=<url-encoded JSON>
cmux-cockpit://set?key=<map>.<wsId>            (no value: delete the entry)
```

| map               | value                          | issue |
| ----------------- | ------------------------------ | ----- |
| `dismissed`       | `{"<agentId>": <epoch>, ...}`  | #5    |
| `projectOverride` | `"<project key>"`              | #8    |

Any other host, path or map is refused. `scripts/state-config.ts` holds the
rules (`applySet`, `validateState`) and their tests.

## config/state.json

```json
{ "dismissed": { "<wsId>": { "<agentId>": 1790416690 } },
  "projectOverride": { "<wsId>": "alpha" } }
```

A missing or malformed file reads as empty state; bad entries are dropped,
never fatal, so a bad write cannot break the build. Each map keeps its newest
256 entries.

## Trust

Any web page can open a `cmux-cockpit://` URL. The worst it can do is write a
bounded, validated entry and trigger a rebuild. The handler never passes URL
content to a shell.
