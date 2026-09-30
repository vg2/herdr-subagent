# Phase 3 — Draft 2 Review & Fixes

Second-pass review of the Phase 3 draft-1 fix set (the uncommitted working-tree
diff documented in `phase-3-draft-1-fixes.md`), followed by the fixes applied
to close the gaps it surfaced.

---

## 1. Review summary

The draft-1 fixes did close their five target issues: `tsc --noEmit` was clean
and all 51 tests passed. The second review looked specifically at the newly
introduced code paths for regressions and interactions and found five residual
gaps — two worth fixing before Phase 4, three minor.

| # | Finding | Severity | Status before fixes |
|---|---|---|---|
| G1 | `issue_close` on GitHub bypassed `applyGhStatus`, and `done` semantics diverged between create/comment/close | Moderate | stale `status:*` labels survived on closed issues; `issue_create` with `status: "done"` left the issue open |
| G2 | Extension-created worktree workspaces were never closed | Moderate | one empty Herdr workspace leaked per `layout: "worktree"` run; the draft-1 `listWorkspaces()`/`closeWorkspace()` helpers were only used by tests |
| G3 | `guard.ts` scrubbed the environment at import time | Minor | any future importer (e.g. a test) would silently strip `HERDR_*` from its own process, making live Herdr tests skip |
| G4 | The guard regex matched `herdr-subagent` paths | Minor | child `bash` commands were blocked in this repository's own paths (`\b` treats the hyphen as a boundary) |
| G5 | Four nits: assignee-retry diagnostics, `status:open` label divergence, no label fallback, worktree-remove cwd | Minor | see 2.5 |

---

## 2. Issues and fixes

### 2.1 G1 — `issue_close` bypassed the GitHub status transition; `done` diverged

**Severity:** Moderate (correctness / doc overclaim)

Fix 2.2 of draft 1 added `applyGhStatus()` (strip stale `status:*`, close on
done, reopen on reactivation) and routed `issue_comment` through it, but:

- `issue_close` (gh) still ran a bare `gh issue close`, so a closed issue kept
  its `status:in-progress` label. Displayed status was still correct
  (`ghStatusOf` treats closed as done), but the README claimed stale labels
  are removed.
- `issue_create` with `status: "done"` applied a `status:done` label and left
  the GitHub issue **open**, while `applyGhStatus("done")` closed it — two
  meanings for the same state.
- Closing was not idempotent: an already-closed issue was closed again.

**Fix:**
- gh `issue_close` now posts its optional comment and then calls
  `applyGhStatus(..., "done")`; failures distinguish "comment posted, but
  closing failed".
- `issue_create` with `status: "done"` creates the issue (no transient
  `status:done` label), then closes it through the same `applyGhStatus` path
  and reports "(closed as done)"; if the issue number cannot be parsed from
  `gh` output, the result says so instead of silently leaving it open.
- One shared representation, encoded by the new exported `wantStatusLabel()`:
  `done` = closed with no `status:*` label, `open` = no `status:*` label
  (matching `issue_create`), active states = `status:<state>` with all stale
  labels removed. `applyGhStatus` allocates labels for active states only and
  skips `gh issue close` when the issue is already closed (after still
  clearing stale labels).

**Files:** `issues.ts`, `README.md`, `test/issues.test.ts`

### 2.2 G2 — extension-created worktree workspaces leaked

**Severity:** Moderate (resource leak)

`herdr worktree create` opens a dedicated workspace for each worktree-layout
run. Draft-1 added `listWorkspaces()`/`closeWorkspace()` wrappers, but the
extension never called them: `/subagents cleanup --worktrees` closed the
panes, the shell root pane, and (optionally) removed the checkout, yet the
empty workspace stayed open — one per run. Only the live test cleaned up its
own.

**Fix:**
- `SubagentRun`/`RunView` record `worktreeMode` (`"herdr"` | `"git"`) so the
  cleanup knows which workspace was created by this extension.
- `/subagents cleanup` now closes the Herdr worktree workspace for such a run
  once none of its panes remain; it calls `listPanes(workspaceId)` first and
  keeps any workspace still holding panes (e.g. ones the user opened), in
  line with plan 3.8 "never close what you didn't create".
- `workspace_not_found` is treated as already closed (`isNotFoundError`), and
  cleanup reports both closed and kept workspaces.
- Git-fallback worktrees (which live in the parent's workspace) are never
  touched, and spawn-failure paths leave a tracked run whose workspace the
  next cleanup can close.

**Files:** `index.ts`, `state.ts`, `herdr.ts`, `README.md`,
`test/extension.test.ts`

### 2.3 G3 — guard env scrub was an import-time side effect

**Severity:** Minor (footgun)

`guard.ts` mutated `process.env` at module top level. Nothing imported
`guard.ts` yet, but the first test that did would lose the test runner's
`HERDR_*` variables, making every live Herdr test silently skip
(`isHerdrAvailable()` becomes false).

**Fix:** the scrub moved into exported `scrubHerdrEnv()`, called from the
extension factory. Production behavior is unchanged (pi invokes the factory
during extension load); importing the module no longer has process-wide
effects.

**Files:** `guard.ts`, `test/guard.test.ts`

### 2.4 G4 — guard regex blocked `herdr-subagent` paths

**Severity:** Minor (false positives)

`\bherdr\b` matches `herdr-subagent` (the hyphen is a word boundary), so any
child `bash` command mentioning this repository's path — or any
`<name>-herdr`/`herdr_*` path — was blocked.

**Fix:** `HERDR_PATTERN` is now `/(?<![\w-])herdr(?![\w-])/i`, wrapped by the
exported `isHerdrCommand()`. `herdr agent list`, `/usr/bin/herdr`, and
`HERDR_ENV=1 herdr` are still blocked; `herdr-subagent`, `my-herdr/...`, and
`herdr_helper.ts` are not.

**Files:** `guard.ts`, `test/guard.test.ts`

### 2.5 G5 — nits

**Severity:** Minor

- **Assignee retry diagnostics.** `ghCreateIssue()` now returns the first
  attempt's error (`assigneeError`) and whether the retry happened
  (`retriedWithoutAssignee`). Success reports include the actual first error
  before the login hint, so a transient failure is not misattributed to an
  invalid login; when both attempts fail, the tool reports the no-assignee
  error plus the original.
- **`status:open` divergence.** `applyGhStatus` no longer adds a
  `status:open` label; open is represented by the absence of a status label,
  matching `issue_create` (via `wantStatusLabel`).
- **No label fallback.** If `ensureGhLabels()` cannot create/apply labels
  (e.g. no triage permission), `issue_create` now creates the issue without
  them and reports the skip instead of failing the whole create, mirroring
  the assignee fallback.
- **Worktree removal cwd.** `removeGitWorktree()` resolves the repository's
  main checkout via `git rev-parse --git-common-dir` and runs
  `git worktree remove` from there, rather than with its cwd inside the
  checkout being deleted (which works on Linux but is fragile on platforms
  that cannot delete a live cwd).

**Files:** `issues.ts`, `worktree.ts`, `test/issues.test.ts`

---

## 3. Verification

- `npx tsc --noEmit` — clean.
- `npm test` — **58/58 pass** (51 before; +2 guard tests, +4 issue-board
  tests, +1 live extension worktree-cleanup test).
- The new live test `cleanup closes the herdr worktree workspace and removes
  its checkout` runs against real Herdr: spawns a pane child in a worktree
  layout, runs `cleanup --force --worktrees`, asserts the extension-created
  workspace is gone and the checkout removed.
- New unit coverage: guard import-side-effect check and command-token
  matching; `applyGhStatus` open/idempotent-done behavior; both-attempts-fail
  diagnostics; `wantStatusLabel`.
- Full-suite post-run Herdr check: only the user's own workspace/agent
  remain — no leaked panes, agents, or workspaces.

---

## 4. Notes

- The second review found no regressions in the draft-1 fixes themselves
  (env hygiene on the worktree pane path, gh label replacement, label
  creation, worktree force-guard); all findings were in edges the original
  fixes left behind.
- Raw Unix-socket access to Herdr from a child's `bash` remains the accepted
  residual risk; the guard + env hygiene close the documented paths only.
- G2's workspace policy is deliberately conservative: a worktree workspace is
  closed only when it is empty, and only for runs whose worktree was created
  by this extension through Herdr.
- The follow-up summary briefly added to `phase-3-draft-1-fixes.md` as a
  section 6 has been folded into this document; the draft-1 doc now records
  only the draft-1 review and fixes.

---

## 5. Files touched

`README.md`, `guard.ts`, `herdr.ts`, `index.ts`, `issues.ts`, `state.ts`,
`worktree.ts`, `test/extension.test.ts`, `test/issues.test.ts`, and the new
`test/guard.test.ts`. `phase-3-draft-1-fixes.md` was edited only to drop the
brief follow-up section in favour of this document. Draft-1 and draft-2
changes are still in one uncommitted working tree, so the cumulative diff
against `cb103a0` below includes both sets (the draft-1-only stat is in §5 of
`phase-3-draft-1-fixes.md`):

```
 PLAN.md                |   2 +-
 README.md              |   4 +-
 guard.ts               |  51 ++++++--
 herdr.ts               |  18 ++-
 index.ts               |  71 +++++++++--
 issues.ts              | 312 +++++++++++++++++++++++++++++++++++++++++++------
 spawner.ts             |  49 +++++++-
 state.ts               |   7 ++
 test/extension.test.ts | 100 +++++++++++++++-
 test/issues.test.ts    | 167 ++++++++++++++++++++++++++
 test/spawner.test.ts   | 154 +++++++++++++++++++++++-
 test/worktree.test.ts  |  24 ++++
 worktree.ts            |  34 +++++-
 13 files changed, 921 insertions(+), 72 deletions(-)
```

Plus untracked files: `test/guard.test.ts`, `phase-3-draft-1-fixes.md`, and
this document.
