/**
 * Git worktree preparation for write-parallel sub-agents (Plan 3.5 item 3).
 *
 * `layout: "worktree"` isolates each child in its own checkout so parallel
 * writers never touch the same working tree. Inside Herdr the worktree is
 * opened as a dedicated workspace (`herdr worktree create`); elsewhere a plain
 * `git worktree add` is used and the child still runs headless in that checkout.
 *
 * Worktrees are never removed automatically: closing the child's pane is safe,
 * but deleting the checkout could discard the child's uncommitted work.
 */

import { execFile } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import { promisify } from "node:util";
import {
	closeWorkspace,
	createWorkspace,
	createWorktree as herdrCreateWorktree,
	isHerdrAvailable,
	isNotFoundError,
	listPanes,
	listWorkspaces,
} from "./herdr.ts";
import type { SourceWorkspace } from "./state.ts";

const execFileAsync = promisify(execFile);

export interface PreparedWorktree {
	/** Checkout path handed to the child as its working directory. */
	path: string;
	branch: string;
	repoRoot: string;
	mode: "herdr" | "git";
	/** Set when Herdr opened a dedicated workspace for the worktree. */
	paneId?: string;
	tabId?: string;
	workspaceId?: string;
	/** Workspace herdr linked the worktree workspace to (parent, reused, or created). */
	sourceWorkspaceId?: string;
	/** Set only when this run opened the source workspace itself; cleanup closes it. */
	ownedSourceWorkspace?: SourceWorkspace;
}

async function git(
	args: string[],
	cwd: string,
): Promise<{ code: number; stdout: string; stderr: string }> {
	try {
		const { stdout, stderr } = await execFileAsync("git", args, { cwd, maxBuffer: 10 * 1024 * 1024 });
		return { code: 0, stdout, stderr };
	} catch (err: any) {
		return {
			code: typeof err.code === "number" ? err.code : 1,
			stdout: err.stdout ?? "",
			stderr: err.stderr ?? (err instanceof Error ? err.message : String(err)),
		};
	}
}

/** Nearest git repository root for `cwd`, or null when it is not a checkout. */
export async function gitRepoRoot(cwd: string): Promise<string | null> {
	const res = await git(["rev-parse", "--show-toplevel"], cwd);
	if (res.code === 0 && res.stdout.trim()) return res.stdout.trim();
	return null;
}

/** Default checkout location for the plain-git fallback (sibling of the repo). */
export function defaultGitWorktreePath(repoRoot: string, runId: string): string {
	const parent = path.dirname(repoRoot);
	return path.join(parent, `${path.basename(repoRoot)}-subagent-worktrees`, runId);
}

async function branchExists(repoRoot: string, branch: string): Promise<boolean> {
	const res = await git(["show-ref", "--verify", "--quiet", `refs/heads/${branch}`], repoRoot);
	return res.code === 0;
}

async function uniqueBranch(repoRoot: string, base: string): Promise<string> {
	if (!(await branchExists(repoRoot, base))) return base;
	for (let i = 2; i < 50; i++) {
		const candidate = `${base}-${i}`;
		if (!(await branchExists(repoRoot, candidate))) return candidate;
	}
	throw new Error(`Could not find a free branch name for ${base}`);
}

/** Sibling checkout paths must not collide across sessions reusing a run id. */
function uniquePath(base: string): string {
	if (!fs.existsSync(base)) return base;
	for (let i = 2; i < 50; i++) {
		const candidate = `${base}-${i}`;
		if (!fs.existsSync(candidate)) return candidate;
	}
	throw new Error(`Could not find a free worktree path for ${base}`);
}

/** Create a plain git worktree checkout. */
export async function createGitWorktree(options: {
	repoRoot: string;
	dir: string;
	branch: string;
	base?: string;
}): Promise<string> {
	const { repoRoot, dir, branch, base } = options;
	fs.mkdirSync(path.dirname(dir), { recursive: true });

	const args = ["worktree", "add", "-b", branch, dir];
	if (base) args.push(base);
	const res = await git(args, repoRoot);
	if (res.code !== 0) {
		throw new Error(res.stderr.trim() || res.stdout.trim() || "git worktree add failed");
	}
	return dir;
}

/**
 * Main checkout root of the repository that owns `cwd`, when it can be
 * determined. Used so `git worktree remove` never runs with its cwd inside the
 * checkout it is deleting. Returns null for unusual layouts (e.g. bare repos),
 * where callers fall back to the worktree's own root.
 */
async function commonRepoRoot(cwd: string): Promise<string | null> {
	const res = await git(["rev-parse", "--git-common-dir"], cwd);
	if (res.code !== 0 || !res.stdout.trim()) return null;
	const raw = res.stdout.trim();
	const abs = path.isAbsolute(raw) ? raw : path.resolve(cwd, raw);
	return path.basename(abs) === ".git" ? path.dirname(abs) : null;
}

/**
 * Remove a worktree checkout. Without `force`, git refuses when the checkout
 * contains modified or untracked files, so a child's uncommitted work is never
 * discarded silently; callers surface that as "skipped" and require an explicit
 * force to delete it. The command runs from the main checkout, not from inside
 * the checkout being removed.
 */
export async function removeGitWorktree(
	worktreePath: string,
	options: { force?: boolean } = {},
): Promise<void> {
	const root = (await commonRepoRoot(worktreePath)) ?? (await gitRepoRoot(worktreePath));
	if (!root) throw new Error(`Not a git worktree: ${worktreePath}`);
	let res = await git(["worktree", "remove", worktreePath], root);
	if (res.code !== 0 && options.force) {
		res = await git(["worktree", "remove", "--force", worktreePath], root);
	}
	if (res.code !== 0) {
		throw new Error(res.stderr.trim() || "git worktree remove failed");
	}
}

export interface PrepareWorktreeOptions {
	cwd: string;
	runId: string;
	label?: string;
	base?: string;
	/** Try the Herdr-backed workspace first (pane mode inside Herdr). */
	preferHerdr: boolean;
}

/**
 * The parent session's own workspace when it shows `repoRoot`: the pane the
 * parent runs in, or else the workspace's own checkout. Never scans for or
 * adopts other sessions' workspaces — a foreign owner's cleanup could close a
 * shared source workspace (cascading to this run's worktree workspace)
 * without knowing about this run's panes. This extension only links worktrees
 * to workspaces it can account for: the parent's own, or one it opened itself.
 */
async function parentWorkspaceForRepo(repoRoot: string): Promise<string | undefined> {
	const workspaceId = process.env.HERDR_WORKSPACE_ID;
	if (!workspaceId) return undefined;
	const paneId = process.env.HERDR_PANE_ID;
	if (paneId) {
		try {
			const panes = await listPanes(workspaceId);
			const pane = panes.find((p) => p.pane_id === paneId);
			const parentCwd = pane?.foreground_cwd || pane?.cwd;
			if (parentCwd) {
				const parentRoot = await gitRepoRoot(parentCwd);
				if (parentRoot && parentRoot === repoRoot) return workspaceId;
			}
		} catch {
			/* fall through to the workspace's own checkout */
		}
	}

	try {
		const target = path.resolve(repoRoot);
		const ws = (await listWorkspaces()).find((w) => w.workspace_id === workspaceId);
		const checkout = ws?.worktree?.checkout_path ?? ws?.worktree?.path;
		if (checkout && path.resolve(checkout) === target) return workspaceId;
	} catch {
		/* fall back to opening a workspace explicitly */
	}
	return undefined;
}

/** A source-checkout workspace this process opened, keyed by repo root. */
interface TrackedSourceWorkspace {
	/** Creation in flight (or settled): concurrent runs await the same promise. */
	promise: Promise<SourceWorkspace>;
	/** Set once creation settles, so a closed workspace can be forgotten by id. */
	workspaceId?: string;
}

const sourceWorkspaces = new Map<string, TrackedSourceWorkspace>();

/**
 * The source-checkout workspace for `repoRoot`, opening one when needed.
 * Concurrent worktree runs (the point of `layout: "worktree"`) share a single
 * workspace — one `workspace create`, one visible source workspace per
 * checkout — instead of racing to open one each; only the run whose call
 * created it owns closing it.
 */
async function openSourceWorkspace(
	repoRoot: string,
	runId: string,
): Promise<{ workspaceId: string; owned?: SourceWorkspace }> {
	const key = path.resolve(repoRoot);
	const existing = sourceWorkspaces.get(key);
	if (existing) {
		// Shared: the creating run owns it; cleanup keeps it while this run's panes are open.
		const shared = await existing.promise;
		return { workspaceId: shared.workspaceId };
	}
	const entry: TrackedSourceWorkspace = { promise: null as unknown as Promise<SourceWorkspace> };
	const promise = createWorkspace({
		cwd: repoRoot,
		label: `subagent source ${runId}`,
		focus: false,
	}).then((created) => {
		const owned: SourceWorkspace = {
			workspaceId: created.workspace.workspace_id,
			paneIds: [created.rootPane.pane_id],
		};
		entry.workspaceId = owned.workspaceId;
		return owned;
	});
	entry.promise = promise;
	sourceWorkspaces.set(key, entry);
	// Drop a failed creation so a later run retries instead of inheriting a rejected promise.
	promise.catch(() => {
		if (sourceWorkspaces.get(key) === entry) sourceWorkspaces.delete(key);
	});
	const owned = await promise;
	return { workspaceId: owned.workspaceId, owned };
}

/**
 * Forget a tracked source workspace once it is closed (by cleanup or the git
 * fallback), so later runs do not reuse a stale workspace id after a manual
 * close, and concurrent reuse stops once the workspace is really gone.
 */
export function forgetSourceWorkspace(workspaceId: string): void {
	for (const [key, entry] of sourceWorkspaces) {
		if (entry.workspaceId === workspaceId) {
			sourceWorkspaces.delete(key);
			return;
		}
	}
}

/**
 * Re-register a source workspace recorded in the session, so a resumed parent
 * session reuses it for later worktree runs instead of opening a duplicate.
 * Live entries win: adoption never replaces an in-flight creation.
 */
export function adoptSourceWorkspace(repoRoot: string, owned: SourceWorkspace): void {
	if (!owned?.workspaceId) return;
	const key = path.resolve(repoRoot);
	if (sourceWorkspaces.has(key)) return;
	sourceWorkspaces.set(key, { promise: Promise.resolve(owned), workspaceId: owned.workspaceId });
}

/** Whether a workspace still exists per herdr (unknown errors conservatively say yes). */
async function sourceWorkspaceAlive(workspaceId: string): Promise<boolean> {
	try {
		await listPanes(workspaceId);
		return true;
	} catch (err) {
		return !isNotFoundError(err);
	}
}

/**
 * Prepare an isolated checkout for a run. Prefers a Herdr worktree workspace
 * when available; falls back to `git worktree add` so headless children (and
 * non-Herdr sessions) still get isolation.
 */
export async function prepareWorktree(options: PrepareWorktreeOptions): Promise<PreparedWorktree> {
	const { cwd, runId, label, base, preferHerdr } = options;

	const repoRoot = await gitRepoRoot(cwd);
	if (!repoRoot) {
		throw new Error(`layout "worktree" requires a git repository (cwd: ${cwd} is not a checkout)`);
	}

	const branch = await uniqueBranch(repoRoot, `pi-subagent/${runId}`);

	if (preferHerdr && isHerdrAvailable()) {
		let sourceWorkspaceId: string | undefined;
		let ownedSourceWorkspace: SourceWorkspace | undefined;
		try {
			// `herdr worktree create --cwd` opens a source-checkout workspace as a
			// side effect and links the worktree to it; that workspace is invisible to
			// cleanup and leaks. Link to the parent's own workspace when it shows the
			// checkout, or to one this process opened (sharing it with concurrent
			// runs), or open one explicitly so this run owns it — never to a foreign
			// workspace nobody here can account for.
			sourceWorkspaceId = await parentWorkspaceForRepo(repoRoot);
			if (!sourceWorkspaceId) {
				const source = await openSourceWorkspace(repoRoot, runId);
				sourceWorkspaceId = source.workspaceId;
				ownedSourceWorkspace = source.owned;
			}
			const res = await herdrCreateWorktree({
				workspaceId: sourceWorkspaceId,
				branch,
				base,
				label: label ?? runId,
				focus: false,
			});
			const worktreePath = res.rootPane.cwd || res.worktree.path;
			return {
				path: worktreePath,
				branch,
				repoRoot,
				mode: "herdr",
				paneId: res.rootPane.pane_id,
				tabId: res.tab.tab_id,
				workspaceId: res.workspace.workspace_id,
				sourceWorkspaceId,
				ownedSourceWorkspace,
			};
		} catch (herdrErr: any) {
			// A source workspace we opened for a worktree that then failed would be
			// stranded, so close it (and forget it) before falling back to git. A
			// shared one is kept — other runs still use it — but is forgotten when
			// herdr says it is already gone, so later runs do not reuse a stale id.
			if (ownedSourceWorkspace) {
				try {
					await closeWorkspace(ownedSourceWorkspace.workspaceId);
					forgetSourceWorkspace(ownedSourceWorkspace.workspaceId);
				} catch (err) {
					if (isNotFoundError(err)) forgetSourceWorkspace(ownedSourceWorkspace.workspaceId);
				}
			} else if (sourceWorkspaceId && !(await sourceWorkspaceAlive(sourceWorkspaceId))) {
				forgetSourceWorkspace(sourceWorkspaceId);
			}
			const dir = uniquePath(defaultGitWorktreePath(repoRoot, runId));
			try {
				await createGitWorktree({ repoRoot, dir, branch, base });
			} catch (gitErr: any) {
				throw new Error(
					`Failed to create a worktree. herdr: ${herdrErr?.message ?? herdrErr}; ` +
						`git: ${gitErr?.message ?? gitErr}`,
				);
			}
			return { path: dir, branch, repoRoot, mode: "git" };
		}
	}

	const dir = uniquePath(defaultGitWorktreePath(repoRoot, runId));
	await createGitWorktree({ repoRoot, dir, branch, base });
	return { path: dir, branch, repoRoot, mode: "git" };
}
