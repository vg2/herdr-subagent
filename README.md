# herdr-subagent

A [Pi](https://github.com/earendil-works/pi) extension that provides visible, isolated sub-agents managed via [Herdr](https://github.com/vishen/herdr) or run headlessly.

Each sub-agent runs as an independent `pi` process with its own context window, narrowed tool surface, and defined persona.

---

## Features

- **Isolated Execution**: Sub-agents run in separate `pi` processes with dedicated context windows. Only final reports return to the parent.
- **Strict Guarding**: Child processes are launched with `--no-extensions --no-skills -e guard.ts` and a sanitized environment (`HERDR_ENV=0`) to prevent recursive delegation or bypass of the issue tracker.
- **Selective Delegation**: Parent models are instructed to delegate only when isolated focus or parallelism provides clear leverage.
- **Bundled Personas**: Includes starter personas (`scout`, `planner`, `worker`, `reviewer`) with model and thinking-level defaults.
- **Fire-and-Forget or Synchronous**: Dispatch tasks in the background and poll with `subagent_status`, or block inline with `wait=true`.

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
  - `model` (optional): Model override (`provider/id` with optional `:thinking` level).
  - `thinking` (optional): Thinking level (`off`, `minimal`, `low`, `medium`, `high`, `xhigh`, `max`).
  - `wait` (optional, default `true`): Whether to block until completion or dispatch in background.

### `subagent_status`
Queries the live state of spawned sub-agents and harvests reports from completed runs.
- **Parameters**:
  - `ids` (optional): Specific run IDs to check.
  - `wait` (optional, default `false`): Block until running sub-agents settle.
  - `timeoutMs` (optional): Timeout when blocking.

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

- **Phase 1 (Current)**: Headless MVP, dual-mode execution foundation, starter personas, and hard isolation guard.
- **Phase 2**: Interactive Herdr pane integration (`HERDR_ENV=1`), layout topologies (panes, tabs, workspaces, worktrees), and live visual monitoring.
- **Phase 3**: Issue tracker communication channel (`gh` / file-backed board) for cross-agent coordination and auditability.

---

## License

MIT © [Vishen Gounden](https://github.com/vg2)
