# Herdr-Subagent: Pi extension for visible, isolated sub-agents

Plan for a pi extension that spawns sub-agents as herdr-managed panes/tabs, each
running its own `pi` process with its own context window, persona, and tool
surface — with cross-agent communication routed exclusively through the
project's issue management process.

---

## 1. Research summary: what other tools do

### Claude Code (`code.claude.com/docs/en/sub-agents`)
- Subagents are markdown files with YAML frontmatter: `name`, `description`
  (required), `tools` allowlist / `disallowedTools` denylist, `model`
  (or `inherit`), `maxTurns`, `permissionMode`, `skills`, `mcpServers`.
- Locations: `.claude/agents/` (project) and `~/.claude/agents/` (user);
  project scope requires trust.
- Each subagent gets its own context window + system prompt; it does not see
  the parent's history. Only the **final result** returns to the parent.
- Initial context: system prompt + a delegation message the parent **writes**
  (not the raw user request), plus optional CLAUDE.md / git snapshot.
- Hardened against prompt-injection from subagent reports (reports are marked
  as carrying no authority; instruction-shaped output is escaped).
- Built-in read-only agents (Explore, Plan) skip CLAUDE.md to stay fast/cheap.
- Nested delegation is depth-capped; the `Agent` tool itself is blocked inside
  subagents, preventing subagent↔subagent spawning.

### Codex (developers.openai.com/codex/subagents)
- Custom agents are **TOML files** in `~/.codex/agents/` or `.codex/agents/`:
  `name`, `description`, `developer_instructions`, plus per-agent
  `model`, `model_reasoning_effort`, `sandbox_mode`, `mcp_servers`.
- Built-ins: `default`, `worker` (writes), `explorer` (read-heavy).
- Subagents return **summaries**, not raw transcripts, to avoid "context
  rot". Orchestration (spawn, steer, wait, close threads) is handled by the
  harness; subagent threads are surfaced for inspection.
- Best practice guidance: parallel agents for **read-heavy** work; be careful
  with parallel **write-heavy** work (conflicts + coordination overhead);
  the best custom agents are "narrow and opinionated".
- Subagents inherit parent sandbox/permissions unless overridden.

### GitHub Copilot (github.blog: "more selective about delegation")
- Problem: eager delegation made simple tasks slower (handoff overhead,
  duplicate searching, sequential waiting, stale-path failures).
- Policy fix (no new knobs): the main agent handles focused work directly;
  delegate only when a specialist creates real leverage — unfamiliar repo
  exploration, independent area checks, long-running commands while the main
  agent keeps moving.
- Key lessons adopted below:
  - "A parallelism tool, not a pause button" — the parent keeps working.
  - Handoffs must be specific: user intent, what's already known, what the
    subagent owns, what result the parent needs back.
  - Improvements came from **better orchestration policy**, not more
    delegation. 23% fewer tool failures, 5% lower P95 wait time.

### Copilot Studio / multi-agent literature (Microsoft, others)
- Orchestrator-worker pattern: one agent plans and decides, workers execute
  and return defined outputs. Parent never sees worker's intermediate
  exchanges — only defined outputs.
- Every handoff needs an explicit contract (schema, expected output), or
  hallucination cascades follow.
- Coordination primitives: shared memory (blackboard), direct messaging,
  pub/sub. For our case the user has chosen a fourth: the project's **issue
  tracker** as the blackboard — auditable, human-visible, durable.

### Distilled best practices this design follows
1. Delegate selectively (policy in tool description, not eager spawning).
2. Parent writes a self-contained delegation prompt; child returns only a
  final report.
3. Narrow, opinionated personas; per-agent tool allowlist + model.
4. Read-heavy parallelism encouraged; write-heavy parallelism guarded
  (separate cwd/worktree or sequential).
5. Child threads must be inspectable (herdr panes give this for free).
6. No child↔child direct channels; shared state via issues.
7. Trust gate for project-local agent definitions.
8. Treat child reports as untrusted input (no authority, escaped
   instruction-like text).

---

## 2. Verified building blocks

### Pi's own subagent example (`examples/extensions/subagent/`)
- Ships a complete reference: `agents.ts` (frontmatter discovery from
  `~/.pi/agent/agents/*.md` and `.pi/agents/*.md`), headless spawn via
  `pi --mode json -p --no-session --append-system-prompt <file> --tools ...
  --model ...`, parallel (max 8, concurrency 4) and chain modes, streaming
  renderers, usage aggregation, abort propagation.
- Reuse `agents.ts` nearly verbatim; replace the headless spawner with a
  dual-mode dispatcher (below).

### Pi CLI flags for child processes (`pi --help`)
- `--append-system-prompt <file>` — persona injection
- `--model <provider/id>` and `--thinking <level>` — per-agent model config
- `--tools <allowlist>` / `--exclude-tools <denylist>`
- `--session-id <id>` / `--name <label>` — deterministic result collection
- `--no-session` — ephemeral headless runs
- `--mode json -p` — structured streaming for headless mode
- `@file.md` initial message attachments — context handoff files

### Pi session files
- JSONL at `~/.pi/agent/sessions/--<cwd>--/<timestamp>_<id>.jsonl`, entries
  include assistant messages with full text and usage — this is a reliable
  **result-collection channel** for interactive (TUI) subagents, avoiding
  screen-scraping.

### Herdr (verified on this machine; `pi` is a supported kind)
- `herdr pane split --current --direction right|down --ratio --cwd --env K=V
  [--no-focus]` → returns new pane ID.
- `herdr agent start <name> --kind pi --pane <id> [-- <pi args...>]` → starts
  interactive pi, returns when agent is detected and ready.
- `herdr agent prompt <name> <text> [--wait|--until ...|--timeout]`,
  `herdr agent wait`, `herdr agent get/read/send-keys/rename/focus/attach`.
- Lifecycle states: `idle | working | blocked | done | unknown`.
- `herdr tab create --label`, `herdr worktree create/open`, and
  `herdr notification show` exist for layout + attention management.
- Agent names: `[a-z][a-z0-9_-]{0,31}`, unique among live agents.

---

## 3. Design

### 3.1 Dispatch modes

One registered tool namespace, two execution backends:

| Mode | Spawn | Visible in herdr? | Result channel |
|---|---|---|---|
| `pane` (default when `HERDR_ENV=1` and `ctx.mode === "tui"`) | split pane → `agent start --kind pi` → `agent prompt task` | Yes — full TUI pane | child session JSONL |
| `headless` (fallback: no herdr, or `ctx.mode !== "tui"`) | `spawn(pi --mode json -p --no-session ...)` | No (streamed into tool renderer) | stdout JSON events |

Both use the same agent-definition discovery, the same delegation-prompt
format, and the same report contract, so behavior is identical regardless of
backend.

### 3.2 Fire-and-forget dispatch + explicit collection

Following the Copilot lesson ("parallelism tool, not pause button"):

- `spawn_subagent` returns as soon as the child is running and has received
  its task (agent reaches `working`). It does not block until completion.
- The parent keeps working; `collect_subagents` later waits for
  `idle|done|blocked` and harvests reports.
- Optional: `dispatch_and_wait` convenience (single/chain mode) that blocks —
  for sequential workflows where the parent needs the result now.

Background watcher (optional, phase 3): a poller started from
`session_start` that watches `herdr agent list` and, on completion, calls
`pi.sendUserMessage()` (or `ctx.ui.notify`) with "subagent `scout` finished"
so the parent can be prompted to collect without blocking a turn.

### 3.3 Delegation prompt contract (parent → child)

The parent tool's schema forces the model to produce a self-contained
handoff, per the Copilot/Codex guidance:

```
Task: what the subagent owns (imperative, one job)
Context: what the parent already knows (files, decisions, constraints)
Scope: files/dirs the subagent should work in
Deliverable: the exact report format expected
Report path: absolute path where the report must be written (required)
Deadline/limits: optional max turns / token budget
Cross-agent policy: reminder that other agents cannot be contacted directly;
 findings for other agents go on the issue tracker
```

Reports are written to files (`/tmp/pi-subagent/<name>-<uuid>/report.md`) so
collection never depends on terminal scraping (herdr skill's documented
alternate-screen limitation). The session JSONL is a secondary source of
truth.

### 3.4 Agent definitions (personas)

Reuse the pi example's format (Claude Code-compatible):

```markdown
---
name: reviewer
description: Strict code review; returns actionable findings only
tools: read, grep, find, ls, bash
model: provider/model-id        # optional; see model routing below
thinking: high                   # optional
cwd: path-or-worktree           # optional (see write-parallelism)
---

System prompt body ...
```

- Locations: `~/.pi/agent/agents/*.md` (user, default) and
  `.pi/agents/*.md` (project; requires `agentScope: "both"` + trust
  confirmation — copy the example's confirm dialog).
- Ad-hoc dispatch without a definition file: `prompt:` parameter accepted
  in place of `agent:` (persona inline or path to an .md).

### 3.4b Model selection & routing

Children run task-appropriate models. Three mechanisms, in resolution order
(same shape as Codex: explicit spawn value → agent default → parent
inheritance):

1. **Per-spawn override ("at prompt time") — primary mechanism.** The
   `spawn_subagent` schema has an optional `model` (and `thinking`)
   parameter. Its description is built dynamically at registration from the
   model registry (`Models.getModels()` via `ctx.modelRegistry`) so the
   parent LLM sees the actually-available model IDs. Two ways a model gets
   chosen "at prompt time":
   - The user says it in natural language ("use glm-5.3-flash for this
     sub-agent") — the parent passes it as `model: "glm-5.3-flash"`.
   - The parent decides on its own, guided by selection guidance embedded
     in the tool description (see 3). The parent already understands the
     task, so this is the cheapest "automatic" route: no extra calls, and
     the choice is visible and auditable in the tool-call arguments.
   Invalid/unknown IDs are fuzzy-matched against the catalog; on no match
   the tool errors with the closest available alternatives (never a silent
   bad spawn).

2. **Persona routing defaults.** Each persona .md may set `model:`/
   `thinking:` frontmatter (scout → fast/cheap + low thinking, worker →
   strong + high thinking, reviewer → mid). Because the persona is chosen
   for the task, this is task-based selection for free. Defaults can be
   overridden per-project via extension settings
   (`~/.pi/agent/settings.json` → `extensions.herdr-subagent.routing`:
   `[{agent, model, thinking}]`) so a team can pin "scout always uses
   glm-5.3-flash" without editing personas.

3. **Inherit the parent's active model** when neither is set (`ctx.model` →
   `--model provider/id`, plus `ctx.thinkingLevel` → `--thinking`, as the
   shipped example does).

**Embedded selection guidance** (in the tool description, refreshed with
the catalog): read-only recon/exploration/summarization → fastest cheap
model, low thinking; implementation/complex reasoning → strongest model,
high thinking; review/triage → mid model. The guidance cites capability
tiers from the catalog, not hard-coded IDs, so it survives model changes.

**Persona-based routing only.** No programmatic router/classifier call:
selection is always per-spawn param → persona default → parent
inheritance. This keeps routing free, instant, and auditable in the tool
call arguments.

**Starter personas ship with pinned defaults** (user-level copies under
`~/.pi/agent/extensions/herdr-subagent/agents/`), verified against the
local catalog (`opencode-go` provider):

| Persona | Pinned model | Thinking | Rationale |
|---|---|---|---|
| `scout` | `opencode-go/glm-5.3-flash` | low | read-heavy recon, cheap + fast, image-capable |
| `planner` | `opencode-go/glm-5.3` | high | planning needs reasoning depth |
| `worker` | `opencode-go/glm-5.3` | high | implementation quality |
| `reviewer` | `opencode-go/glm-5.3` | high | review benefits from reasoning depth |

Pins are ordinary frontmatter `model:`/`thinking:` values — editable, and
overridable per-spawn or via the `extensions.herdr-subagent.routing`
settings table without touching the files.

### 3.5 Layout policy (herdr topology)

Recommendation, in order:

1. **1–2 subagents, short-lived → sibling panes in the current tab.**
   `herdr pane layout --current` to pick `right` (wide pane) or `down`
   (narrow/tall). `--no-focus` keeps the user in the parent pane; panes are
   named (`herdr agent rename` / pane label) so the sidebar shows them.
   Watching is one `pane focus`/`agent focus` away.

2. **3+ subagents, or medium-lived → dedicated tab in the current
   workspace** (`herdr tab create --label "subagents" --no-focus`), then
   split panes inside it. Avoids unusably narrow columns from repeated
   same-direction splits; the user can open the tab and watch everything at
   once. Subagent panes get the parent's cwd.

3. **Long-running / many (swarm) or write-parallel tasks → dedicated
   workspace** (`herdr pane move <pane> --new-workspace --label "swarm"` or
   create workspaces directly), optionally per-subagent **git worktrees**
   (`herdr worktree create --branch`) for write-heavy parallelism so
   children never edit the same checkout. This mirrors Claude Code's
   `isolation: worktree` and answers Codex's "careful with write-heavy
   parallel work".

4. Focus is never stolen (`--no-focus` everywhere unless the user asks);
   completion is signaled with `herdr notification show "subagent X done"` +
  the pi `notify` extension, so watching is opt-in.

The layout choice is a parameter (`layout: "auto" | "pane" | "tab" |
"workspace" | "worktree"`), default `auto` = the policy above.

### 3.6 Isolation & the no-direct-communication rule

- Subagents are separate `pi` processes with their own context windows; they
  do not receive the parent transcript. Only the report file returns.
- **Child → child direct messaging is hard-enforced from the start**, in
  three layers (defense in depth, all active from phase 1):
  1. **Guard extension (primary enforcement).** Every child — pane *and*
     headless — is spawned with `pi --no-extensions --no-skills -e
     <ext-dir>/guard.ts`. The guard is a tiny extension that registers a
     `tool_call` handler blocking any `bash` call whose command matches
     `/\bherdr\b/` (plus a `user_bash` handler returning a blocking result
     for the same pattern, closing the local-execution fallback path). The
     block reason tells the child why: "Sub-agents cannot control herdr or
     contact other agents directly; route coordination through the issue
     tracker (`issue_*` tools)." Because children load no other
     extensions, the guard is the only extension code they run.
  2. **Environment hygiene.** Children are spawned with `HERDR_ENV=0`
     (`herdr pane split --env HERDR_ENV=0` for pane mode; env strip in
     `spawn()` options for headless mode), so even if a child somehow saw
     the herdr skill text, its own guard refuses to operate. Also strip
     `HERDR_WORKSPACE_ID` / `HERDR_TAB_ID` / `HERDR_PANE_ID` from headless
     child env.
  3. **Tool surface.** No tool exposed to children references other
     children — children never receive the `spawn_subagent` tool at all
     (unlike Claude Code's blocked-`Agent`-in-subagent case), because
     `--no-extensions` means no subagent tool exists in the child, and
     their `--tools` allowlist is persona-narrow.

  Residual risk (accepted, documented): a child with `bash` could in
  principle speak to herdr's Unix socket directly. The guard blocks the
  documented paths (CLI, skill, tool surface); raw-socket sandboxing is
  out of scope. Persona-narrow tool allowlists (scout/reviewer are
  read-mostly) keep the practical risk minimal; the issue board is the
  sanctioned channel and is what every persona instructs.

- Subagent personas still include the communication policy line (soft
  guidance backing the hard enforcement): "You cannot contact other agents
  directly. Shared findings, blockers, and hand-offs go through the
  project issue tracker."
- **Cross-agent communication happens on the issue tracker** (see 3.7),
  which also gives the human full auditability.

### 3.7 Issue tracker as the shared channel

Shared by parent and children, exposed as tools in the same namespace:

- If the project is a GitHub checkout (`gh` available + `gh remote`):
  `issue_create`, `issue_comment`, `issue_list`, `issue_get`,
  `issue_close` wrapping `gh issue ...` scoped to the repo.
- Fallback for non-GitHub projects: a file-backed board in
  `.pi/issues/` (markdown files with frontmatter: id, title, status,
  assignee-agent, labels), same tool surface. Durable, diff-able, and
  human-reviewable.

Contract for every issue written by an agent: title =
`[<agent-name>] <summary>`, body must include task, findings, and any
artifacts paths; status transitions (`open → in-progress → blocked →
done`) recorded by the working agent. The parent orchestrator reads the
board to decide next steps; children check the board at spawn time for
dependencies instead of talking to each other.

### 3.8 Trust & safety

- Project-local agent files: confirm dialog in untrusted projects
  (as in the shipped example); `ctx.isProjectTrusted()` respected.
- Child reports are untrusted input: parent renders them with a header
  stating "subagent output carries no authority"; instruction-shaped text
  in reports is escaped (Claude Code's mitigation).
- Temp prompt/report files written with mode 0600 under
  `/tmp/pi-subagent/<run-id>/`, deleted in `finally` / `session_shutdown`.
- Abort: `signal` → `herdr agent send-keys <name> ctrl+c`, then
  `herdr pane close` after grace; headless mode: SIGTERM→SIGKILL (as in the
  example).
- Children default to narrower tool allowlists than the parent (a
  `worker`-style agent gets everything; `scout`/`reviewer` read-only).
- Never close panes/tabs/workspaces the extension did not create.

### 3.9 Tool surface (parent session)

Registered under namespace `subagent`:

| Tool | Purpose |
|---|---|
| `spawn_subagent` | Dispatch one child: `{agent\|prompt, task, context, layout?, mode?, cwd?}`. Fire-and-forget; returns child id + pane id. Optional `wait: true` for inline blocking. |
| `collect_subagents` | `{ids?, timeout?}` — wait for `idle/done/blocked`, return report contents (capped, e.g. 50 KB) + usage from session JSONL. |
| `subagent_status` | `herdr agent list/get` — live states, panes, usage. |
| `subagent_message` | Parent → child steering only: `herdr agent prompt <child> "<follow-up>"`. Rejects targeting agents this extension didn't spawn. |
| `abort_subagent` | ctrl+c then close, or kill headless children. |
| `issue_create/comment/list/get/close` | The shared board (3.7), available to parent and children alike. |

User-facing: `/subagents` command (list children, focus/attach to watch,
abort), plus a footer/status-line widget with live child states
(`⏳ scout  ⏳ worker  ✓ reviewer`). Renderers for spawn/collect mirror the
shipped example (collapsed/expanded, per-agent usage stats).

### 3.10 Extension structure

```
~/.pi/agent/extensions/herdr-subagent/
├── PLAN.md            # this file
├── index.ts           # registration, dispatch tool, renderers, command
├── agents.ts          # persona discovery (adapted from shipped example)
├── herdr.ts           # herdr CLI wrapper: exec, JSON parse, layout policy
├── spawner.ts         # dual-mode spawn (pane + headless), env hygiene
├── collect.ts         # wait + report harvest (report file → session JSONL fallback)
├── issues.ts          # gh-backed or .pi/issues file-backed board
├── guard.ts           # loaded into every child: blocks herdr access (tool_call + user_bash)
├── state.ts           # run registry (child id → pane/agent/session ids); appended via pi.appendEntry for branch survival
└── agents/*.md        # starter personas: scout, planner, worker, reviewer
```

State: in-memory registry of spawned children keyed by run id; durable copy
via `pi.appendEntry()` so child links survive compaction and can be
reconstructed on `session_start` from the branch (`ctx.sessionManager.getBranch()`).

---

## 4. Implementation phases

**Phase 1 — core (MVP, ~1 file + agents.ts)**
1. `agents.ts` discovery (copy from shipped example, add optional
   `thinking`, `cwd` frontmatter).
2. `spawn_subagent` headless mode only (adapt shipped `runSingleAgent`),
   with per-spawn `model`/`thinking` params, persona defaults, and
   catalog-backed validation + fuzzy match (`Models.getModels()`).
3. `collect` inline (blocking `wait` param) + `subagent_status`.
4. Persona .md files for scout/planner/worker/reviewer (pinned models).
5. `guard.ts` hard-enforcement extension, loaded by **every** spawn from
   day one (pane and headless): `pi --no-extensions --no-skills -e
   <ext-dir>/guard.ts`, plus child env hygiene (`HERDR_ENV=0`, stripped
   `HERDR_*` ids for headless spawns).

**Phase 2 — herdr pane mode**
5. `herdr.ts` wrapper; layout policy (auto: pane/tab by count and
   `pane layout` geometry); env strip (`HERDR_ENV=0`).
6. `agent start --kind pi` + initial prompt via `agent prompt --wait`;
   child named `sa-<agent>` (unique-ified).
7. Fire-and-forget + `collect_subagents` via `agent wait` +
   report file; session JSONL fallback.
8. Abort/notification handling; `/subagents` command.

**Phase 3 — coordination & polish**
9. Issue channel (gh + file board), shared tools for parent & children.
10. Status widget / footer, `subagent_message` steering.
11. Chain/parallel sugar (optional; the parent can do it with multiple
    spawns), write-parallel worktree layout.
12. Selective-delegation guidance: finalize tool descriptions + a
    guidelines section injected via `before_agent_start` so the model
    delegates by policy, not eagerness (includes the model-selection
    guidance).

**Phase 4 — hardening**
- Blocked-child UX (surface `blocked` state, let the user answer the child
  directly via `agent focus`, or relay answers).
- Reconciliation on `session_start` (children from a previous run:
  adopt/ignore via `herdr agent list`).
- Token/usage accounting across children (session JSONL usage totals).

---

## 5. Risks & open questions

- `agent prompt --wait` waits for a *state change*, not turn completion;
  the report-file contract + `agent wait --until idle|done|blocked` is the
  reliable completion signal (verify pi-in-pane detection timing in
  practice; bump `agent start --timeout` to 60 s for slow models).
- Alternate-screen reads from pi TUI panes are lossy — hence report files,
  never screen scraping, for results.
- (Resolved → hard enforcement) Child herdr access is blocked by the
  `guard.ts` extension (`tool_call` + `user_bash` handlers) in every child
  from day one, plus `HERDR_ENV=0` env hygiene and no child tool surface.
  Residual risk: raw access to herdr's Unix socket from a child's `bash`
  is not sandboxed — accepted; the guard blocks the documented paths and
  personas are tool-narrow.
- (Resolved) File-board fallback (`.pi/issues/`) is included alongside
  `gh` for GitHub checkouts.
- (Resolved) Model selection is persona-based only: per-spawn `model`
  param → pinned persona default → parent inheritance. No programmatic
  router. Starter personas ship pinned (scout → `glm-5.3-flash`, others →
  `glm-5.3`).
- (Resolved) Child sessions persist. Storage detail: sessions are **global
  to pi, grouped by project cwd** — `~/.pi/agent/sessions/--<cwd>--/
  <timestamp>_<session-id>.jsonl` (overridable via `--session-dir` /
  `PI_CODING_AGENT_SESSION_DIR` / `sessionDir`). A pane-mode child spawned
  with cwd = the project therefore lands in the same group dir as the
  parent's sessions, under its own `--session-id`. Sessions are saved
  automatically and incrementally (tree JSONL, written per entry), so the
  child's history survives pane close and process death. Headless children
  run `--no-session` (ephemeral, as in the shipped example) — their results
  come from stdout, so no session is needed. Prune via `/subagents cleanup`
  (deletes `.jsonl` files); the pi session picker offers trash-based delete
  too.
- (Resolved) Child environment leanness: lean by default
  (`--no-extensions --no-skills`), per-persona opt-in frontmatter
  (`extensions:`, `skills:`, `contextFiles: true`); read-only personas skip
  context files.
- (Resolved) Pane cleanup: **closing a completed child pane via herdr is
  safe.** Once the child reaches `idle`/`done`, its session is fully
  persisted on disk and the report file exists, so closing the pane only
  terminates the now-idle process — no data loss. The extension's
  "keep by default" is a UX choice (watchability), not a data-safety
  requirement. Guard rails in the extension: `abort_subagent`/`/subagents
  cleanup` refuse to close panes whose child state is `working` or
  `blocked` (a working child would be killed mid-turn; a blocked child
  would discard its pending approval) without an explicit `--force`, and
  never close panes the extension did not create. Manually closing the
  last pane in a tab closes the tab. After any manual close, the extension
  reconciles its registry against `herdr agent list` on next
  `subagent_status`/`collect` call.
- (Resolved) Completion delivery: notify-only (status widget + `herdr
  notification`); the parent decides when to call `collect_subagents`. No
  auto-injected context.
- (Resolved) Hard enforcement from the start: every child (pane and
  headless) loads `guard.ts` via `-e`, which blocks herdr access at
  `tool_call` and `user_bash`, alongside `HERDR_ENV=0` env hygiene and no
  child tool surface for spawning. See 3.6.
- Naming: extension/tools named `subagent` would collide with the shipped
  example if both are installed — prefix with the namespace and use
  distinct tool names (`spawn_subagent` etc.).
