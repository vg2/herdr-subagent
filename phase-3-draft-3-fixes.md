# Phase 3 — Draft 3 Fixes

Fixes for the three findings raised by the review of the draft-2 fix set
(documented in `phase-3-draft-2-fixes.md`). Draft-1, draft-2, and draft-3
changes remain one uncommitted working tree.

---

## 1. Findings and fixes

### 1.1 Source-checkout workspace leaked on the `--cwd` worktree path

**Severity:** Moderate (resource leak — the same class G2 set out to close).

`herdr worktree create --cwd <repo>` opens **two** workspaces: one for the
worktree and a second, untracked one for the source checkout. The draft-2 fix
tracked and closed only the worktree workspace, so whenever the extension could
not associate the parent's workspace with the run's repository (e.g. a
`spawn_subagent` whose `cwd` is in a different repo), that source-checkout
workspace leaked. The draft-2 live test worked around it by closing
"any workspace pointing into the temp dir" in its own `finally` — the
mitigation existed only in the test.

**Fix:**
- `prepareWorktree` no longer uses `--cwd`. It resolves an open workspace for
  the checkout (`workspaceForRepo()`: the parent's workspace when the repos
  match, otherwise any workspace already showing that checkout) and passes it
  with `--workspace`. If none exists it opens the source workspace *explicitly*
  via the new `herdr.ts` `createWorkspace()`, so the extension knows the id and
  owns closing it.
- `PreparedWorktree` / `SubagentRun` / `RunView` gain
  `sourceWorkspaceId` (the linked workspace, for reference counting) and
  `ownedSourceWorkspace` (`{ workspaceId, paneIds }`, set only when this run
  opened it).
- If `herdr worktree create` fails after this run opened the source workspace,
  the source workspace is closed before the git fallback so it is not stranded.
- `/subagents cleanup` closes the owned source workspace after the worktree
  workspace is gone, **only** when no other tracked run still has an open pane
  referencing it (closing a source workspace also closes the linked worktree,
  so a shared one must not be closed early) and only when the workspace still
  contains just the panes this run created (user-added panes keep it open).

**Files:** `herdr.ts`, `worktree.ts`, `state.ts`, `index.ts`, `README.md`,
`test/extension.test.ts`, `test/spawner.test.ts`

### 1.2 `issue_create` with `status: "done"` could claim it closed an issue it did not

**Severity:** Minor (contradictory diagnostic).

When the issue number could not be parsed from `gh` output, the result appended
both ` (closed as done)` and `(could not determine the issue number to close
it; close it manually)`.

**Fix:** the `(closed as done)` suffix is emitted only when the issue number was
known and the close actually ran (`status === "done" && id`; a failed close
already returns early).

**Files:** `issues.ts`

### 1.3 Status-transition label handling diverged from issue creation

**Severity:** Minor (inconsistent degradation on the same permission failure).

`issue_create` degraded gracefully when labels could not be created, but
`applyGhStatus` aborted the whole transition and left stale labels in place.
Its create-side fallback was also all-or-nothing: one uncreatable label dropped
every label.

**Fix:**
- `applyGhStatus` now returns `GhStatusResult` (`{ error?, warning? }`). A
  label-creation failure is reported as a `warning`; the transition still
  removes stale labels, and the comment/close the caller already made is not
  reported as failed. Displayed status falls back to `open`, matching what was
  actually applied.
- `ensureGhLabels` is only consulted when the label actually needs adding, so an
  already-present label is never blocked by a transient label-list failure.
- `issue_create` retries labels individually after a bulk failure, keeping every
  label that applies and reporting only the ones that did not — instead of
  dropping them all.

**Files:** `issues.ts`, `test/issues.test.ts`

---

## 2. Verification

- `npx tsc --noEmit` — clean.
- `npm test` — **59/59 pass, 0 skipped** (58 before; +1 `applyGhStatus` warning
  test). The live worktree tests now assert the run owns its source workspace
  and that cleanup closes it.
- Full-suite post-run Herdr check: only the user's own workspace and agent
  remain; no leaked panes, agents, or workspaces.
- Empirically confirmed before the fix: `herdr worktree create --cwd` opens a
  second source-checkout workspace; closing the source workspace cascades to
  close the linked worktree workspace, and a second `--cwd` call for the same
  repo reuses the existing source workspace — hence the reference-counted,
  owner-only close rather than closing on creation.

---

## 3. Notes

- The source workspace is now created explicitly and visible in Herdr, exactly
  as `--cwd` made it visible before; the difference is that cleanup knows about
  it.
- Shared source workspaces are kept while any tracked run still has an open
  pane; once all such runs are closed, the next `/subagents cleanup` closes it.
- Cross-session reconstruction of runs (and therefore of source-workspace
  ownership after a parent restart) remains Phase 4 work.

---

## 4. Files touched (draft-3 only)

`README.md`, `herdr.ts`, `index.ts`, `issues.ts`, `state.ts`, `worktree.ts`,
`test/extension.test.ts`, `test/issues.test.ts`, `test/spawner.test.ts`.
