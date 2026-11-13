# Background work hook payloads

Real Claude Code 2.1.322 hook payloads, captured on 12 November 2026 from a
background chat that started a background shell, a background agent (which
started its own background shell), a monitor and a `claude --bg` session, then
ended its turn while they ran. Trimmed and scrubbed: home paths are `/Users/me`,
session, prompt and agent ids are stable fakes (the chat is `...a001`, its
prompts are `...b001` to `...b006` in time order, its agent is
`a1b2c3d4e5f607182`, the `claude --bg` session is `5e5e5e5e`), tool use ids are
`toolu_FAKE_*`, and prompt and message text is removed. Task ids, commands,
descriptions and every other field are as captured; no field was dropped.

Each file is `{ capture_event, payload }`; `payload` is what the hook read on
stdin. Read in this order, they follow one run. Left out: a ToolSearch call,
a second Stop with the same list as
`stop-agent-ended-its-shell-in-parent-list.json`, the agent's SubagentStart
when it was woken again, and two tool calls the agent made that started no
background work.

These are frozen captures. `test/report-background.test.ts` replays them
in the order below, so any change to a file goes in the same PR as the
test change it needs.

| File | What it shows |
| --- | --- |
| `post-tool-use-bash-background.json` | A background shell starting: no `background_tasks`, the new task id is `tool_response.backgroundTaskId` |
| `pre-tool-use-agent.json` | An agent about to launch |
| `post-tool-use-agent-async.json` | A background agent launched: `tool_response.agentId`, `status: async_launched` |
| `subagent-start.json` | SubagentStart: `agent_id` and `agent_type`, no `background_tasks` |
| `post-tool-use-monitor.json` | A monitor starting: the id is `tool_response.taskId` |
| `post-tool-use-claude-bg.json` | `claude --bg` run in Bash: the only place its session id appears, in `tool_response.stdout` |
| `post-tool-use-agents-own-shell.json` | The agent starting its own shell: same hook, with `agent_id` set |
| `stop-turn-end-tasks-running.json` | Stop at the turn end with work running: the list holds the chat's shell, the agent, the monitor and the agent's own shell |
| `subagent-stop-tasks-running.json` | SubagentStop for the agent's first pause: carries the same list, scoped to the parent chat (`session_id`), with `agent_id` set |
| `stop-agent-ended-its-shell-in-parent-list.json` | Next Stop: the agent has gone from the list, its shell is still there as an ordinary shell |
| `subagent-stop-agent-woken-again.json` | The agent woken when its shell ended, stopping again: it is back in the list, its shell is gone |
| `stop-shell-and-monitor-left.json` | A Stop after the agent's shell finished: finished tasks drop out of the list |
| `stop-one-shell-left.json` | A Stop with one shell left |
| `stop-all-done.json` | The last Stop: `background_tasks` is `[]` |

What the captures say, in short:

- `background_tasks` is on Stop and SubagentStop only, never on PostToolUse or SubagentStart.
- Only `status: "running"` appeared; a finished task is removed, not marked.
- An agent drops out of the list when it pauses with work of its own running, and comes back when that work wakes it (a second SubagentStart, then SubagentStop). Absent from the list is not the same as finished.
- A monitor is listed as `type: "shell"` with its watch command, not as `monitor` (Claude Code 2.1.322; later payloads carry `monitor`, #371).
- The list never held the `claude --bg` session.
- `session_crons` is present and was `[]`.
