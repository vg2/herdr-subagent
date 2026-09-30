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
import { createWorktree as herdrCreateWorktree, isHerdrAvailable, listPanes } from "./herdr.ts";

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

/** Remove a worktree checkout. Callers must opt in explicitly (destructive). */
export async function removeGitWorktree(worktreePath: string): Promise<void> {
	const root = await gitRepoRoot(worktreePath);
	if (!root) throw new Error(`Not a git worktree: ${worktreePath}`);
	const res = await git(["worktree", "remove", "--force", worktreePath], root);
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
 * The parent session's workspace id when it belongs to the same repository.
 * Passing it to `herdr worktree create` avoids herdr opening a second workspace
 * for the source checkout when `--cwd` is used instead.
 */
async function parentWorkspaceForRepo(repoRoot: string): Promise<string | undefined> {
	const workspaceId = process.env.HERDR_WORKSPACE_ID;
	const paneId = process.env.HERDR_PANE_ID;
	if (!workspaceId || !paneId) return undefined;

	try {
		const panes = await listPanes(workspaceId);
		const pane = panes.find((p) => p.pane_id === paneId);
		const parentCwd = pane?.foreground_cwd || pane?.cwd;
		if (!parentCwd) return undefined;
		const parentRoot = await gitRepoRoot(parentCwd);
		if (parentRoot && parentRoot === repoRoot) return workspaceId;
	} catch {
		/* fall back to --cwd */
	}
	return undefined;
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
		try {
			const workspaceId = await parentWorkspaceForRepo(repoRoot);
			const res = await herdrCreateWorktree({
				workspaceId,
				cwd: workspaceId ? undefined : repoRoot,
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
			};
		} catch (herdrErr: any) {
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
