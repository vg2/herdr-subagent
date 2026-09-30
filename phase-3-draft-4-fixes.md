# Phase 3 — Draft 4 Fixes

Fixes for the five gaps raised by the review of the draft-3 fix set
(documented in `phase-3-draft-3-fixes.md`). Draft-1 through draft-4 changes
remain one uncommitted working tree.

---

## 1. Findings and fixes

### 1.1 Cascade close could destroy user panes in a shared linked worktree workspace

**Severity:** Moderate (violated the fix's own "never close what we don't own" invariant).

Draft 3's owned-source close protected other runs only via `sourceInUse`,
which counted runs with an *open agent pane*. A run B that had reused the
source workspace, whose agent pane was closed, but whose worktree workspace was
deliberately **kept** because the user had added panes to it was not in
`sourceInUse`. The owner's cleanup then closed the source workspace, and the
Herdr cascade destroyed B's kept worktree workspace with the user's panes in
it. The `worktreeWorkspaceGone` guard protected only the owner's own worktree,
never the sharers'.

**Fix:** `sourceInUse` now also counts a run when its agent pane is gone but
its worktree workspace still shows panes (queried via `listPanes`; a
not-found workspace means nothing to protect, any other error conservatively
keeps the source workspace so cleanup can retry later).

**Files:** `index.ts`, `README.md`, `test/extension.test.ts`

### 1.2 Concurrent worktree spawns opened duplicate source workspaces

**Severity:** Moderate (regression vs. the `--cwd` path's own dedup).

Write-parallel spawns are the point of `layout: "worktree"`, and parallel
`spawn_subagent` calls racing through source-workspace resolution each opened
their own `subagent source <id>` workspace for the same checkout. Pre-draft-3,
`herdr worktree create --cwd` reused the existing source workspace.

**Fix:** `worktree.ts` tracks source workspaces this process opened, keyed by
repo root (`sourceWorkspaces`). `openSourceWorkspace()` resolves (or creates)
the workspace for a checkout; concurrent calls await the same in-flight
promise, so N parallel runs share one source workspace, and only the run whose
call created it owns closing it. A failed creation drops its entry so a later
run retries instead of inheriting a rejected promise. Closed workspaces are
forgotten via `forgetSourceWorkspace()` (called by cleanup and the git
fallback), so later runs never reuse a stale id after a manual close.

**Files:** `worktree.ts`, `index.ts`, `test/spawner.test.ts`

### 1.3 `workspaceForRepo` adopted foreign workspaces, enabling cross-session interference

**Severity:** Moderate (narrow window).

The draft-3 `listWorkspaces()` scan returned *any* workspace showing the
checkout — including another pi session's workspace or another run's owned
source workspace. Within one session the `sourceInUse` guard covered reuse; across
sessions, the foreign owner's cleanup could close the shared source workspace
mid-run, cascading to close this run's worktree workspace under a running
child. The old `--cwd` path also reused existing workspaces, but nothing ever
closed them (that was the leak draft 3 fixed); draft 3 made the owner-close
reachable against adopted workspaces.

**Fix:** the scan is gone. `prepareWorktree` links a worktree only to a
workspace it can account for: the parent session's own workspace
(`parentWorkspaceForRepo()`: the pane the parent runs in, or the workspace's
own checkout — never other sessions'), or one this process opened itself
(the 1.2 map). The git fallback path also self-heals a stale shared entry: a
workspace that herdr reports gone is forgotten before falling back.

**Files:** `worktree.ts`

### 1.4 "Displayed status falls back to open" was claimed but not implemented

**Severity:** Minor (doc overclaim / misleading diagnostic).

`issue_comment` reported the *requested* status — `Commented on issue #7
(status: in-progress).` — with the warning appended in parentheses; nothing
displayed `open`. `issue_close` dropped `statusResult.warning` entirely
(latent: unreachable for `"done"` today, since no status label is applied).

**Fix:** `issue_comment` now reports the *applied* status (`open` when the
label could not be applied) alongside the warning note, and `issue_close`
surfaces the warning rather than dropping it if that ever becomes reachable.

**Files:** `issues.ts`

### 1.5 Cleanup summary misreported source workspaces as worktree workspaces

**Severity:** Cosmetic (inaccurate diagnostics).

The draft-3 owned-source branches reused `skippedWorkspaces`/`closedWorkspaces`,
so a kept source workspace was reported as "Kept N worktree workspace(s) still
in use", an already-closed source workspace inflated "Closed N worktree
workspace(s)", and one run closing both its worktree and source workspace
counted as two closed "worktree workspaces".

**Fix:** separate counters (`closedSourceWorkspaces`/`keptSourceWorkspaces`)
with their own summary lines ("source-checkout workspace(s)"); the kept/closed
source workspace close sites (including the not-found path) increment them.

**Files:** `index.ts`, `test/extension.test.ts`

---

## 2. Verification

- `npx tsc --noEmit` — clean.
- `npm test` — **61/61 pass, 0 skipped** (59 before; +1 concurrent-race test,
  +1 shared-source cascade test). New coverage:
  - `concurrent worktree runs share one source workspace instead of opening
    one each` (spawner, live): two racing `prepareWorktree` calls share one
    source workspace; exactly one run owns it.
  - `cleanup keeps a shared source workspace while a linked worktree workspace
    holds panes` (extension, live): a reused run's worktree workspace holding a
    user-added pane survives `cleanup --force`, and the shared source
    workspace is kept (and reported as kept) rather than cascade-closed; the
    existing single-run cleanup test now also asserts the source-workspace
    close is reported.
- Full-suite post-run Herdr check: only the user's own workspaces and agents
  remain; no leaked panes, agents, or workspaces.

---

## 3. Notes

- Cross-session reconstruction of runs (and therefore of source-workspace
  ownership after a parent restart) remains Phase 4 work; until then a second
  session's source workspace is simply not adoptable (1.3), which is the
  conservative side of that trade.
- Sequential spawns find the shared source workspace through the same map, so
  the draft-3 empirical observation ("a second `--cwd` call reuses the
  existing source workspace") is preserved without herdr's implicit dedup.

---

## 4. Files touched (draft-4 only)

`README.md`, `index.ts`, `issues.ts`, `worktree.ts`,
`test/extension.test.ts`, `test/spawner.test.ts`.
