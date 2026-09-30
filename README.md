# herdr-subagent

A [Pi](https://github.com/earendil-works/pi) extension that provides visible, isolated sub-agents managed via [Herdr](https://github.com/vishen/herdr) or run headlessly.

Each sub-agent runs as an independent `pi` process with its own context window, narrowed tool surface, and defined persona.

---

## Features

- **Visible & Isolated Execution**: When inside Herdr TUI (`HERDR_ENV=1`), sub-agents spawn visibly in dedicated terminal panes or tabs. Ephemeral headless mode is used as an automatic fallback outside Herdr.
- **Topology & Layout Policy**: Automatically splits side-by-side or stacked based on terminal geometry for 1–2 sub-agents, or opens dedicated tabs for larger batches.
- **Strict Guarding**: Child processes are launched with `--no-extensions --no-skills -e guard.ts` and a sanitized environment (`HERDR_ENV=0`) to prevent recursive delegation or bypass of the issue tracker.
- **Selective Delegation**: Parent models are instructed to delegate only when isolated focus or parallelism provides clear leverage.
- **Bundled Personas**: Includes starter personas (`scout`, `planner`, `worker`, `reviewer`) with model and thinking-level defaults.
- **Fire-and-Forget or Synchronous**: Dispatch tasks in the background and harvest later with `collect_subagents` or `subagent_status`, or block inline with `wait=true`.
- **Interactive Control**: Manage and watch children live using the `/subagents` command (`list`, `focus`, `abort`, `collect`, `cleanup`).

---

## Installation

Install as a Pi package on any machine running Pi:

```bash
pi install git:github.com/vg2/herdr-subagent
```

To update to the latest version:

```bash
pi update herdr-subagent
```

---

## Tools Exposed

### `spawn_subagent`
Delegates a self-contained task to an isolated sub-agent.
- **Parameters**:
  - `task` (required): What the sub-agent owns (imperative, single job).
  - `agent` (optional): Persona name (`scout`, `planner`, `worker`, `reviewer`).
  - `prompt` (optional): Ad-hoc system prompt or path to a custom persona `.md`.
  - `context` (optional): Background facts, decisions, and constraints known to the parent.
  - `scope` (optional): Files or directories the sub-agent should focus on.
  - `deliverable` (optional): Expected format of the final report.
  - `mode` (optional, default `"auto"`): Execution backend (`"auto"`, `"pane"`, `"headless"`).
  - `layout` (optional, default `"auto"`): Herdr topology (`"auto"`, `"pane"`, `"tab"`).
  - `model` (optional): Model override (`provider/id` with optional `:thinking` level).
  - `thinking` (optional): Thinking level (`off`, `minimal`, `low`, `medium`, `high`, `xhigh`, `max`).
  - `wait` (optional, default `false`): Whether to block until completion or dispatch in background.

### `collect_subagents`
Waits for running sub-agents to settle (`idle`, `done`, or `blocked`) and harvests reports and usage stats.
- **Parameters**:
  - `ids` (optional): Specific run IDs to collect (defaults to all).
  - `timeoutMs` (optional, default `300000`): Maximum time to wait.

### `subagent_status`
Queries the live state of spawned sub-agents and harvests reports from completed runs.
- **Parameters**:
  - `ids` (optional): Specific run IDs to check.
  - `wait` (optional, default `false`): Block until running sub-agents settle.
  - `timeoutMs` (optional): Timeout when blocking.

### `abort_subagent`
Aborts a running sub-agent. For Herdr pane children, sends `ctrl+c` and closes the pane.
- **Parameters**:
  - `id` (required): Run ID or agent name.
  - `force` (optional, default `false`): Force abort even if child is currently working or blocked waiting for input.

---

## User Commands

### `/subagents`
User-facing command to inspect and control sub-agents:
- `/subagents` / `/subagents list`: View all tracked sub-agents, live states, locations, and usage.
- `/subagents focus <id>`: Switch focus to a child's Herdr pane or tab.
- `/subagents abort <id> [--force]`: Abort a sub-agent.
- `/subagents collect [id]`: Harvest reports and usage.
- `/subagents cleanup [--force]`: Close completed child panes.

---

## Starter Personas

| Persona | Purpose | Default Model Pin | Default Thinking |
|---|---|---|---|
| `scout` | Fast, read-only codebase exploration & recon | `opencode-go/glm-5.3-flash` | `low` |
| `planner` | Formulates actionable implementation plans | `opencode-go/glm-5.3` | `high` |
| `worker` | General-purpose autonomous coding with full tools | Parent's active model | Parent's thinking |
| `reviewer` | Strict code review for correctness & security | `opencode-go/glm-5.3` | `high` |

Custom user personas can be added in `~/.pi/agent/agents/*.md` or project-local `.pi/agents/*.md`.

---

## Roadmap

- **Phase 1 (Complete)**: Headless MVP, dual-mode execution foundation, starter personas, and hard isolation guard.
- **Phase 2 (Current / Complete)**: Interactive Herdr pane integration (`HERDR_ENV=1`), layout topologies (panes, tabs), background watcher, `/subagents` command, `collect_subagents` and `abort_subagent` tools.
- **Phase 3**: Issue tracker communication channel (`gh` / file-backed board) for cross-agent coordination and auditability.

---

## License

MIT © [Vishen Gounden](https://github.com/vg2)
