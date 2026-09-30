import test from "node:test";
import assert from "node:assert";
import { execFileSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import {
	createGitWorktree,
	defaultGitWorktreePath,
	gitRepoRoot,
	prepareWorktree,
	removeGitWorktree,
} from "../worktree.ts";

function gitAvailable(): boolean {
	try {
		execFileSync("git", ["--version"], { stdio: "ignore" });
		return true;
	} catch {
		return false;
	}
}

function initRepo(dir: string): void {
	execFileSync("git", ["init", "-q", "-b", "main"], { cwd: dir });
	fs.writeFileSync(path.join(dir, "README.md"), "hello\n");
	execFileSync("git", ["add", "."], { cwd: dir });
	execFileSync(
		"git",
		["-c", "user.email=test@test", "-c", "user.name=test", "commit", "-qm", "init"],
		{ cwd: dir },
	);
}

test("gitRepoRoot returns null outside a checkout and the root inside one", async (t) => {
	if (!gitAvailable()) return t.skip("git not available");

	const parent = fs.mkdtempSync(path.join(os.tmpdir(), "pi-test-wt-"));
	const repo = path.join(parent, "repo");
	const plain = path.join(parent, "plain");
	fs.mkdirSync(repo);
	fs.mkdirSync(plain);

	try {
		assert.strictEqual(await gitRepoRoot(plain), null);
		initRepo(repo);
		assert.strictEqual(await gitRepoRoot(path.join(repo, "sub")), null); // sub does not exist yet
		fs.mkdirSync(path.join(repo, "sub"));
		assert.strictEqual(await gitRepoRoot(path.join(repo, "sub")), fs.realpathSync(repo));
	} finally {
		fs.rmSync(parent, { recursive: true, force: true });
	}
});

test("prepareWorktree without herdr creates and removes a plain git worktree", async (t) => {
	if (!gitAvailable()) return t.skip("git not available");

	const parent = fs.mkdtempSync(path.join(os.tmpdir(), "pi-test-wt-prep-"));
	const repo = path.join(parent, "repo");
	fs.mkdirSync(repo);
	initRepo(repo);

	try {
		const prepared = await prepareWorktree({
			cwd: repo,
			runId: "sa-worker-1",
			preferHerdr: false,
		});

		assert.strictEqual(prepared.mode, "git");
		assert.strictEqual(prepared.branch, "pi-subagent/sa-worker-1");
		assert.strictEqual(prepared.path, defaultGitWorktreePath(fs.realpathSync(repo), "sa-worker-1"));
		assert.ok(fs.existsSync(prepared.path), "worktree checkout should exist");
		assert.ok(fs.existsSync(path.join(prepared.path, "README.md")), "worktree should contain the repo");

		// The branch is registered and the checkout is a linked worktree.
		const worktrees = execFileSync("git", ["worktree", "list", "--porcelain"], { cwd: repo, encoding: "utf-8" });
		assert.ok(worktrees.includes(prepared.path));

		await removeGitWorktree(prepared.path);
		assert.ok(!fs.existsSync(prepared.path), "worktree should be removed");
	} finally {
		fs.rmSync(parent, { recursive: true, force: true });
	}
});

test("createGitWorktree refuses to reuse an existing branch untouched and uniqueBranch suffixes", async (t) => {
	if (!gitAvailable()) return t.skip("git not available");

	const parent = fs.mkdtempSync(path.join(os.tmpdir(), "pi-test-wt-branch-"));
	const repo = path.join(parent, "repo");
	fs.mkdirSync(repo);
	initRepo(repo);

	try {
		const first = await prepareWorktree({ cwd: repo, runId: "sa-worker-1", preferHerdr: false });
		// A second run with the same id must not collide on the branch.
		const second = await prepareWorktree({ cwd: repo, runId: "sa-worker-1", preferHerdr: false });
		assert.strictEqual(second.branch, "pi-subagent/sa-worker-1-2");
		assert.notStrictEqual(first.path, second.path);

		await removeGitWorktree(first.path);
		await removeGitWorktree(second.path);
	} finally {
		fs.rmSync(parent, { recursive: true, force: true });
	}
});

test("createGitWorktree surfaces a clear error for a missing repository", async (t) => {
	if (!gitAvailable()) return t.skip("git not available");

	const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-test-wt-bad-"));
	try {
		await assert.rejects(
			createGitWorktree({ repoRoot: dir, dir: path.join(dir, "wt"), branch: "x" }),
			/not a git repository|git worktree add failed/i,
		);
	} finally {
		fs.rmSync(dir, { recursive: true, force: true });
	}
});
