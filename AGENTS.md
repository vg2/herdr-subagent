# AGENTS.md — herdr-subagent

Guidance for coding agents working in this repository. The user's global `~/.pi/agent/AGENTS.md` also applies;
this file carries the project-specific rules. Pi loads this file only when the project is trusted.

## What this project is

A Pi package that adds visible, isolated sub-agents backed by Herdr, with a headless fallback. Each sub-agent is a
separate `pi` process with its own context window, narrowed tool surface, and persona. Pi loads it via the `pi`
manifest in `package.json`: `./index.ts` as the extension and `./skills` as the bundled skill. Consumers install it
by git ref, normally a pinned version tag.

Changing the host contract (extension lifecycle, tool/command/event APIs, TUI components)? Read the Pi docs first
(`docs/extensions.md`, `docs/packages.md`, `docs/tui.md` in the Pi installation) and check the actual exported API of
the installed release rather than assuming.

## Layout

| Path | Role |
| --- | --- |
| `index.ts` | Extension factory: tool registration, `/subagents` command, lifecycle handlers, delegation guidelines, status line. The integration surface; largest file. |
| `herdr.ts` | Herdr CLI wrapper, layout policy (`auto`/`pane`/`tab`), env hygiene, agent lifecycle (`start`, `prompt`, `wait`, `read`, `list`). `isHerdrAvailable()` is just `HERDR_ENV === "1"`. |
| `spawner.ts` | Builds and launches children (pane and headless): argv, child env sanitization, tool allowlists, persona/model resolution. |
| `agents.ts` | Persona discovery from project `.pi/agents/` and `~/.pi/agent/agents/`; Claude-Code-compatible frontmatter. |
| `state.ts` | Run registry, `toView`/`reconstructRuns`, durable snapshots, `REPORT_CAP_BYTES`. |
| `collect.ts` | Settling runs and harvesting reports; parses child session JSONL for turns/tokens/cost/context. |
| `issues.ts` | The `issue_*` tools: `gh` backend on GitHub checkouts, file board at `<project>/.pi/issues/` otherwise. |
| `guard.ts` | The only enforcement code children run: blocks herdr CLI use via bash, scrubs `HERDR_*` from the process. |
| `worktree.ts` | `git worktree` per child for `layout: "worktree"`; branch `pi-subagent/<runId>`; cleanup semantics. |
| `format.ts` | Shared status/usage formatting for tool output, TUI renderers, and `/subagents`. |
| `agents/*.md` | Bundled personas: `scout`, `planner`, `worker`, `reviewer`. |
| `skills/herdr-subagents/SKILL.md` | Bundled skill that teaches the parent model delegation policy. Ships with the extension. |
| `test/*.test.ts` | One file per module; hermetic. See Tests. |

## Commands

```bash
npm install                  # once — required before typecheck or tests (node_modules is gitignored)
npm run typecheck            # tsc --noEmit, strict, TypeScript 7
npm test                     # node --test test/*.test.ts — ~85 tests, ~7s
HERDR_ENV=0 npm test         # use this when you are inside Herdr (see gotcha 1)
pi -e ./index.ts             # smoke-test the extension in a live session; /reload re-runs the factory
```

No lint or format tooling is configured. Do not add one without being asked.

## Gates before you say a task is done

1. `npm run typecheck` is clean.
2. `HERDR_ENV=0 npm test` is green.
3. Behavior changes are smoke-tested with `pi -e ./index.ts` (or the installed copy) — tests are hermetic and cannot
   prove the live host wiring.
4. `README.md` and `skills/herdr-subagents/SKILL.md` are updated in the same change when the tool surface, defaults,
   or delegation guidance moved.
5. Conventional Commit message (`feat:`, `fix:`, `chore:`, `docs:`, `test:`).
6. You asked the user about the version bump (see Versioning).

## Gotchas

1. **Running the suite inside Herdr has real side effects.** With `HERDR_ENV=1`, the herdr-gated tests in
   `test/extension.test.ts`, `test/spawner.test.ts`, and `test/worktree.test.ts` create and close actual panes and
   workspaces in the caller's live session. Run `HERDR_ENV=0 npm test` unless you are deliberately exercising the
   Herdr paths.
2. **Dev-time host packages are older than the live host.** The committed lockfile pins `@earendil-works/pi-*` at
   `0.99.1` for local typecheck and tests, while the installed Pi host injects `1.0.0` at runtime. A clean typecheck
   does not prove the host API matches. Verify against the installed release's typings and smoke-test.
3. **Tests must stay hermetic.** No network, no real `pi` process, no Herdr, no writes to the user's real
   `~/.pi/agent`. Use `fs.mkdtempSync` and injected seams; gate any Herdr-dependent test behind `isHerdrAvailable()`.
4. **`REPORT_CAP_BYTES` (50 KB, `state.ts`) is a contract.** Tool output truncates reports and prints `reportPath`;
   the skill documents this. Changing the cap or dropping `reportPath` needs a doc update and test coverage.
5. **Report harvest order is fixed**: `report.md` in the run scratch dir → child session JSONL → `herdr agent read`.
6. **Working in this repo can create `.pi/issues/`** if the issue board is exercised from this checkout. That is a
   local artifact, not source; do not commit it.

## Hard invariants

- **Never move host packages into `dependencies`.** `@earendil-works/pi-ai`, `pi-agent-core`, `pi-coding-agent`,
  `pi-tui`, and `typebox` stay in `peerDependencies` with `"*"` and are supplied by Pi. A bundled copy creates
  duplicate registries and initialization work. New runtime dependencies need explicit user sign-off.
- **Import specifiers keep the `.ts` extension** (`module: NodeNext`, `allowImportingTsExtensions`). Type-stripped
  execution depends on it.
- **Children launch as `pi --no-extensions --no-skills -e guard.ts -e issues.ts`** with a sanitized environment
  (`HERDR_ENV=0`, all `HERDR_*` scrubbed, child identity vars added). Anything a child may do has to be enforced in
  `guard.ts`, and `guard.ts` must not mutate `process.env` at import time (`test/guard.test.ts` asserts this).
- **Every child gets the five `issue_*` tools**, even when its persona declares a tool allowlist
  (`childToolAllowlist`).
- **Run state is persisted through `pi.appendEntry("herdr-subagent-run", toView(...))`.** Any change to the run shape
  must keep `reconstructRuns` / `RunRegistry.restore` compatible — resume behavior is covered by tests and is a
  headline feature.
- **Worktrees are never removed automatically.** `/subagents cleanup --worktrees` skips checkouts with uncommitted
  changes unless forced; do not add code that deletes child worktrees implicitly.
- **No work at module scope in `index.ts`.** No processes, sockets, watchers, or timers in the factory — Pi loads
  extensions for invocations that never start a session. Use `session_start` / `session_shutdown`.
- **The bundled skill and personas are part of the package contract.** Renaming a tool or parameter, changing a
  default, or altering delegation policy requires the matching update in `skills/herdr-subagents/SKILL.md`,
  `agents/*.md`, and the README tables.

## Conventions

- Tabs for indentation, double quotes, explicit `.ts` import specifiers. Match the surrounding file.
- Prefer explicit narrow types over `any`; keep exhaustive control flow rather than wildcard fallbacks.
- Tests live next to the module they cover: `test/<module>.test.ts`. Add cases there for behavior you changed.
- Never weaken a test, a type, or a check to make something pass. Fix the cause.
- No secrets, tokens, or machine-specific paths in the repo. Nothing here needs credentials at build or test time.

## Versioning and releases — ask before bumping

**Before you commit changes in this repo, ask the user whether the version should be bumped.** Never bump
`package.json`, create a tag, or move or delete a tag on your own initiative.

- `package.json` `version` and the git tag are one release: version `0.1.0` ships as annotated tag `v0.1.0`.
- Published tags are immutable. Never force-push, move, or delete one.
- Consumers pin a tag in `~/.pi/agent/settings.json` (`git:github.com/vg2/herdr-subagent@v0.1.0`). Pi reconciles the
  checkout to the configured ref but never advances it, so tagging is only half a release: the consumer entry must be
  updated explicitly (`pi install git:github.com/vg2/herdr-subagent@vX.Y.Z`). When you tag, tell the user that
  follow-up exists, and offer to run it.
- Pre-1.0 semver: breaking or user-visible behavior changes get a minor bump, fixes and internal work get a patch,
  docs/tests/refactors usually need none. State which you think applies when you ask.
- Release steps once the user agrees:
  1. `npm run typecheck && HERDR_ENV=0 npm test`
  2. set `version` in `package.json`
  3. commit it (`chore(release): vX.Y.Z`, or fold the bump into the change commit when the user prefers)
  4. `git tag -a vX.Y.Z -m "<summary>"` then `git push origin main vX.Y.Z`
  5. update the local consumer entry (and re-sync config if the user asks)
- A change to this repo does not affect a running Pi session until the extension reloads. Say so rather than implying
  it is live.
