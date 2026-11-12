# Background work hook payloads

Real Claude Code 2.1.322 hook payloads, captured on 12 November 2026 from a
background chat that started a background shell, a monitor, a background agent
(which started its own background shell) and a `claude --bg` session, then ended
its turn while they ran. Trimmed and scrubbed: home paths are `/Users/me`,
session and agent ids are stable fakes (the chat is `...a001`, its agent is
`a1b2c3d4e5f607182`, the `claude --bg` session is `5e5e5e5e`), and prompt and
message text is removed. Task ids, commands and descriptions are as captured.

Each file is `{ capture_event, payload }`; `payload` is what the hook read on
stdin. Read in this order they follow one run.

| File | What it shows |
| --- | --- |
| `post-tool-use-bash-background.json` | A background shell starting: no `background_tasks`, the new task id is `tool_response.backgroundTaskId` |
| `post-tool-use-monitor.json` | A monitor starting: the id is `tool_response.taskId` |
| `pre-tool-use-agent.json` | An agent about to launch |
| `post-tool-use-agent-async.json` | A background agent launched: `tool_response.agentId`, `status: async_launched` |
| `subagent-start.json` | SubagentStart: `agent_id` and `agent_type`, no `background_tasks` |
| `post-tool-use-claude-bg.json` | `claude --bg` run in Bash: the only place its session id appears, in `tool_response.stdout` |
| `post-tool-use-agents-own-shell.json` | The agent starting its own shell: same hook, with `agent_id` set |
| `stop-turn-end-tasks-running.json` | Stop at the turn end with work running: the list holds the chat's shell, the agent, the monitor and the agent's own shell |
| `subagent-stop-tasks-running.json` | SubagentStop for the agent's first pause: carries the same list, scoped to the parent chat (`session_id`), with `agent_id` set |
| `stop-agent-ended-its-shell-in-parent-list.json` | Next Stop: the agent has gone from the list, its shell is still there as an ordinary shell |
| `subagent-stop-agent-woken-again.json` | The agent woken when its shell ended, stopping again |
| `stop-shell-and-monitor-left.json` | A Stop after the agent's shell finished: finished tasks drop out of the list |
| `stop-one-shell-left.json` | A Stop with one shell left |
| `stop-all-done.json` | The last Stop: `background_tasks` is `[]` |

What the captures say, in short:

- `background_tasks` is on Stop and SubagentStop only, never on PostToolUse or SubagentStart.
- Only `status: "running"` appeared; a finished task is removed, not marked.
- A monitor is listed as `type: "shell"` with its watch command, not as `monitor`.
- The list never held the `claude --bg` session.
- `session_crons` is present and was `[]`.
