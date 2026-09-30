# herdr-subagent

A [Pi](https://github.com/earendil-works/pi) extension that provides visible, isolated sub-agents managed via [Herdr](https://github.com/vishen/herdr) or run headlessly.

Each sub-agent runs as an independent `pi` process with its own context window, narrowed tool surface, and defined persona.

---

## Features

- **Visible & Isolated Execution**: When inside Herdr TUI (`HERDR_ENV=1`), sub-agents spawn visibly in dedicated terminal panes or tabs. Ephemeral headless mode is used as an automatic fallback outside Herdr.
- **Topology & Layout Policy**: Automatically splits side-by-side or stacked based on terminal geometry for 1–2 sub-agents, opens dedicated tabs for larger batches, or isolates a writer in its own git worktree (`layout: "worktree"`).
- **Strict Guarding**: Child processes are launched with `--no-extensions --no-skills -e guard.ts -e issues.ts` and a sanitized environment (`HERDR_ENV=0`) to prevent recursive delegation or bypass of the issue tracker.
- **Selective Delegation**: Parent models receive delegation policy via tool descriptions and a `before_agent_start` guidelines section so they delegate only when isolated focus or parallelism provides clear leverage.
- **Shared Issue Channel**: A cross-agent issue board backed by `gh` (GitHub checkouts) or a durable file board (`.pi/issues/`) exposed as `issue_create`, `issue_comment`, `issue_list`, `issue_get`, and `issue_close` — available to the parent and every child, and shared across git worktrees.
- **Live Status & Steering**: A footer status line tracks child states (`⏳scout ⏳worker ✓reviewer`), and `subagent_message` steers a running or blocked pane child with follow-up instructions. Blocked children surface their pending question in status/collect output, and the user can answer them directly from the command line with `/subagents answer` (or by focusing the pane).
- **Resume-Safe**: On session resume the extension rebuilds its child registry from the session branch and reconciles it against live Herdr agents: still-running pane children are re-adopted (with abort/collection wired back up), children whose processes are gone are settled from their persisted reports, and worktree/workspace ownership survives the restart so `/subagents cleanup` still works.
- **Usage Accounting**: Per-child token/cache/cost totals are harvested from child session JSONL, and `subagent_status`, `collect_subagents`, and `/subagents list` append a session-wide totals line (turns, tokens, cache, cost, max context).
- **Bundled Personas**: Includes starter personas (`scout`, `planner`, `worker`, `reviewer`) with model and thinking-level defaults.
- **Fire-and-Forget or Synchronous**: Dispatch tasks in the background and harvest later with `collect_subagents` or `subagent_status`, or block inline with `wait=true`.
- **Interactive Control**: Manage and watch children live using the `/subagents` command (`list`, `focus`, `answer`, `abort`, `collect`, `cleanup`).

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
  - `layout` (optional, default `"auto"`): Herdr topology (`"auto"`, `"pane"`, `"tab"`, `"worktree"`). `"worktree"` gives the child its own git worktree checkout (and a dedicated Herdr workspace inside Herdr) so parallel writers never share a working tree.
  - `model` (optional): Model override (`provider/id` with optional `:thinking` level).
  - `thinking` (optional): Thinking level (`off`, `minimal`, `low`, `medium`, `high`, `xhigh`, `max`).
  - `wait` (optional, default `false`): Whether to block until completion or dispatch in background.

### `collect_subagents`
Waits for running sub-agents to settle (`idle`, `done`, or `blocked`) and harvests reports and usage stats. Blocked children return their pending question plus how to answer it (`subagent_message`), and a session-wide usage totals line is appended.
- **Parameters**:
  - `ids` (optional): Specific run IDs to collect (defaults to all).
  - `timeoutMs` (optional, default `300000`): Maximum time to wait.

### `subagent_status`
Queries the live state of spawned sub-agents and harvests reports from completed runs. Blocked children show the pending question and answer hint; a session-wide usage totals line is appended.
- **Parameters**:
  - `ids` (optional): Specific run IDs to check.
  - `wait` (optional, default `false`): Block until running sub-agents settle.
  - `timeoutMs` (optional): Timeout when blocking.

### `abort_subagent`
Aborts a running sub-agent. For Herdr pane children, sends `ctrl+c` and closes the pane.
- **Parameters**:
  - `id` (required): Run ID or agent name.
  - `force` (optional, default `false`): Force abort even if child is currently working or blocked waiting for input.

### `subagent_message`
Sends a follow-up instruction to a running or blocked pane child. The child receives it as a new user turn in its own context; headless children cannot be steered.
- **Parameters**:
  - `id` (required): Run ID or agent name.
  - `message` (required): Follow-up instruction (clarifications, corrections, answers to a blocked prompt).
  - `wait` (optional, default `true`): Wait until Herdr confirms the child is working on the message.

### `issue_create` / `issue_comment` / `issue_list` / `issue_get` / `issue_close`
The shared cross-agent issue board. Uses `gh issue ...` when the project is a GitHub checkout with `gh` available; otherwise a durable file board at `<project>/.pi/issues/` (markdown + YAML frontmatter). The board always resolves to the main checkout, so worktree-isolated children share it. Titles follow `[<agent>] <summary>` (prefixed automatically), and status transitions (`open → in-progress → blocked → done`) are recorded with `issue_comment`/`issue_close`: on GitHub a closed issue carries no stale `status:*` labels (the closed/open state itself represents done/open, reopening follows the transition), and `issue_create` with `status: "done"` closes the issue. Missing labels are created on demand (if they cannot be applied the issue is still created and the skip is reported), and agent-shaped assignees (e.g. `scout`) are reported as skipped on GitHub since assignees there must be GitHub logins.

---

## User Commands

### `/subagents`
User-facing command to inspect and control sub-agents:
- `/subagents` / `/subagents list`: View all tracked sub-agents, live states, locations, and usage.
- `/subagents focus <id>`: Switch focus to a child's Herdr pane or tab (blocked children include an answer hint).
- `/subagents answer <id> <text>`: Relay an answer to a running or blocked pane child without leaving the parent pane — the same delivery path as `subagent_message`.
- `/subagents abort <id> [--force]`: Abort a sub-agent.
- `/subagents collect [id]`: Harvest reports and usage.
- `/subagents cleanup [--force] [--worktrees]`: Close completed child panes and the Herdr workspaces the extension opened for them — the worktree workspace plus, when herdr had no workspace for the source checkout, the source-checkout workspace it opened. Source-checkout workspaces are opened one per checkout and shared by concurrent runs; a shared one is closed only once no run still needs it — no open pane, and no linked worktree workspace still holding panes (e.g. user-added panes). Workspaces still holding panes are kept. `--worktrees` additionally removes each closed child's git worktree checkout; checkouts with uncommitted changes are skipped and reported unless `--force` is given (which discards them).

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
- **Phase 2 (Complete)**: Interactive Herdr pane integration (`HERDR_ENV=1`), layout topologies (panes, tabs), background watcher, `/subagents` command, `collect_subagents` and `abort_subagent` tools.
- **Phase 3 (Complete)**: Issue tracker communication channel (`gh` / file-backed board), `subagent_message` steering, footer status widget, worktree isolation for parallel writers, and policy-based delegation guidelines injected via `before_agent_start`.
- **Phase 4 (Complete)**: Hardening — blocked-child UX (pending question surfaced in status/collect/list, `/subagents answer` relay, poller resumes tracking a child answered in its pane), resume-time reconciliation (rebuild the registry from the session branch, re-adopt live Herdr agents, settle stale runs, restore worktree/workspace ownership), and cross-child usage accounting (session-JSONL totals plus a session-wide totals line).

---

## License

MIT © [Vishen Gounden](https://github.com/vg2)
