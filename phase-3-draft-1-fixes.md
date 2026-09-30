# Phase 3 — Draft 1 Review & Fixes

Review of commit `cb103a0` ("phase 3 first pass implementation") against
PLAN.md §4, Phase 3, items 9–12, followed by the fixes applied to close the
gaps found.

---

## 1. Review summary

All four Phase 3 items were implemented and the PLAN.md "(Done: …)"
annotations accurately described the code. `tsc --noEmit` was clean and the
45 existing tests passed.

| Plan item | Status before fixes |
|---|---|
| 9 — Issue channel (gh + file board), shared by parent & children | Implemented: `issues.ts`, `-e issues.ts` in both spawn modes, issue tools appended to persona allowlists, board resolves to the main checkout via `git rev-parse --git-common-dir` |
| 10 — Status widget + `subagent_message` steering | Implemented: `ctx.ui.setStatus` footer, registry-scoped steering tool, notification on done/failed/blocked |
| 11 — Worktree layout (chain/parallel sugar skipped) | Implemented: `layout: "worktree"`, herdr workspace + plain `git worktree add` fallback |
| 12 — Selective-delegation guidance | Implemented: `DELEGATION_GUIDELINES` injected via `before_agent_start`, gated on `spawn_subagent` |

Five issues were found (two worth fixing before Phase 4).

---

## 2. Issues and fixes

### 2.1 Env hygiene missing on the herdr-worktree pane path — **fixed**

**Severity:** High (Plan 3.6 layer-2 violation)

`spawner.ts` `startPane()` reused the root pane created by
`herdr worktree create` when `layout: "worktree"` was used inside Herdr.
That command has **no `--env` flag**, so the pane inherited Herdr's own
environment (`HERDR_ENV=1`, live `HERDR_PANE_ID` / `HERDR_TAB_ID` /
`HERDR_WORKSPACE_ID`) and the child never received
`PI_SUBAGENT_AGENT`. The normal pane path and the plain-git worktree
fallback both applied `CLEAN_CHILD_ENV`, so only this path was affected.

**Fix:**
- `startPane()` now splits the worktree root pane into a fresh pane with
  `CLEAN_CHILD_ENV` + `PI_SUBAGENT_AGENT` (`paneChildEnv()` helper), runs the
  agent there, and closes the shell root pane.
- If the root-pane close fails, the id is kept as
  `run.worktreeShellPaneId`; `run.abort()` and `/subagents cleanup` retry
  the close, and cleanup will not remove a worktree while such a shell pane
  still exists.
- `guard.ts` additionally scrubs all `HERDR_*` variables from `process.env`
  at load, so tool subprocesses in any child never inherit them (defense in
  depth for spawn paths that cannot set env directly).
- Added `listWorkspaces()` / `closeWorkspace()` wrappers in `herdr.ts`.

**Files:** `spawner.ts`, `guard.ts`, `state.ts`, `herdr.ts`, `index.ts`

### 2.2 GitHub status transitions accumulated labels — **fixed**

**Severity:** High (correctness)

`issue_comment` on the gh backend only ran `gh issue edit --add-label
status:X`; previous `status:*` labels were never removed. After
`in-progress → blocked`, both labels existed and `ghStatusOf()`'s
`.find(name => name.startsWith("status:"))` could report a stale status.
The file board was unaffected (single `status:` field).

**Fix:** new `applyGhStatus()`:
- reads current labels via `gh issue view --json state,labels`;
- removes every stale `status:*` label and adds the target;
- for `done`: strips stale labels first (since `gh issue close` has no
  `--remove-label`) and closes the issue;
- reopens an issue when it is moved from a closed state back to an active
  one.

Documented in README. Covered by two fake-runner tests.

**Files:** `issues.ts`, `test/issues.test.ts`

### 2.3 gh backend failed on agent-shaped assignees/labels — **fixed**

**Severity:** Minor (cross-backend divergence)

`issue_create` passed `--assignee scout` and arbitrary `--label` values to
`gh`. GitHub rejects non-login assignees and missing labels, failing the
whole create, while the file board accepted agent-shaped values.

**Fix:**
- `ensureGhLabels()` creates missing labels on demand. It checks first and
  does **not** use `--force`, so existing repository label colors are
  preserved; a search recheck tolerates races and labels beyond the list
  limit.
- `ghCreateIssue()` retries without the assignee when the first attempt
  fails and reports the skip to the caller
  ("assignee … was not applied: GitHub assignees must be GitHub logins").
- `assignee` parameter description and README updated.

**Files:** `issues.ts`, `test/issues.test.ts`, `README.md`

### 2.4 Worktree removal always used `--force` — **fixed**

**Severity:** Minor (data-safety UX)

`removeGitWorktree()` ran `git worktree remove --force` unconditionally, so
`/subagents cleanup --worktrees` could silently discard a child's
uncommitted work even though the README/plan claimed caution.

**Fix:**
- `removeGitWorktree(path, { force })` tries a plain `git worktree remove`
  first; `--force` is only used when explicitly requested.
- `/subagents cleanup --worktrees` passes the flag through and reports dirty
  checkouts separately: *"Skipped N worktree(s) with uncommitted changes
  (rerun with --force to discard)."*
- New test covers both the refusal and the forced removal.

**Files:** `worktree.ts`, `index.ts`, `test/worktree.test.ts`, `README.md`

### 2.5 Nits — **fixed**

- `IssueToolDetails.tracker` is now optional and `fail()` defaults to `{}`,
  so a gh-path exception is no longer mislabeled `tracker: "file"`.
- Removed the unused `PI_SUBAGENT_ID` env var (dead surface); identity
  attribution uses `PI_SUBAGENT_AGENT` on every child path now.
- Corrected stale docstrings (`guard.ts` "only extension code" →
  guard + issues; `spawner.ts` child invocation list now includes
  `-e issues.ts`).
- Guarded against a duplicate `status:*` label when the caller also passes
  it via `labels`.

**Files:** `issues.ts`, `spawner.ts`, `guard.ts`, `test/spawner.test.ts`

---

## 3. Verification

- `npx tsc --noEmit` — clean.
- `npm test` — **51/51 pass** (45 before; +6 new tests for labels,
  assignee retry, status transitions, dirty worktrees, and env helpers).
- New live Herdr test `startPane worktree layout runs in a sanitized split
  pane and closes the shell root pane` ran 3× against real Herdr: child in a
  fresh split pane, root shell gone, no leaked panes/workspaces/agents after
  the suite.
- Full-suite post-run check: only the user's own workspace/agent remain.

---

## 4. Notes discovered during the fix

- `herdr worktree create --cwd <repo>` also opens a workspace for the
  *source* repo when it is not already open. In production
  `parentWorkspaceForRepo()` avoids this by passing `--workspace` when the
  parent is in the same repo; for foreign `cwd` values the extra workspace
  is Herdr's own UI decision and is left alone (plan 3.8: never close
  resources the extension did not create). The live test closes any such
  workspace it causes so test runs leave no litter.
- Out of scope / unchanged from the plan: raw Unix-socket access to Herdr
  from a child's `bash` remains an accepted residual risk (guard + env
  hygiene close the documented paths only).

---

## 5. Files touched

```
 PLAN.md               |   2 +-
 README.md             |   4 +-
 guard.ts              |  22 +++--
 herdr.ts              |  13 +++
 index.ts              |  35 +++++--
 issues.ts             | 235 +++++++++++++++++++++++++++++++++++++++++++-------
 spawner.ts            |  49 +++++++++--
 state.ts              |   4 +
 test/issues.test.ts   |  97 +++++++++++++++++++++
 test/spawner.test.ts  | 154 ++++++++++++++++++++++++++++++++++++++++-
 test/worktree.test.ts |  24 ++++++
 worktree.ts           |  17 +++-
 12 files changed, 595 insertions(+), 61 deletions(-)
```
