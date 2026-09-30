import test from "node:test";
import assert from "node:assert";
import { execFileSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import {
	addFileIssueComment,
	clearTrackerCache,
	closeFileIssue,
	createFileIssue,
	detectTracker,
	ensureAuthorPrefix,
	type CommandRunner,
	findProjectRoot,
	ISSUE_TOOL_NAMES,
	listFileIssues,
	normalizeStatus,
	readFileIssue,
	registerIssueTools,
	resolveAuthor,
} from "../issues.ts";

function createMockExtensionAPI() {
	const tools = new Map<string, any>();
	const api: any = {
		registerTool: (tool: any) => {
			tools.set(tool.name, tool);
		},
		tools,
	};
	return api;
}

function tempDir(prefix: string): string {
	return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

test("detectTracker falls back to the file board outside GitHub", async () => {
	clearTrackerCache();
	const fakeRunner: CommandRunner = async (command, args) => {
		if (command === "git" && args.includes("rev-parse")) {
			return { code: 0, stdout: "/repo\n", stderr: "" };
		}
		if (command === "git") {
			return { code: 0, stdout: "https://gitlab.com/org/repo.git\n", stderr: "" };
		}
		return { code: 1, stdout: "", stderr: "not found" };
	};

	const tracker = await detectTracker("/repo/sub", fakeRunner);
	assert.strictEqual(tracker.kind, "file");
	if (tracker.kind === "file") {
		assert.strictEqual(tracker.root, "/repo");
		assert.strictEqual(tracker.boardDir, path.join("/repo", ".pi", "issues"));
	}
});

test("detectTracker uses gh for github.com remotes when gh is available", async () => {
	clearTrackerCache();
	const fakeRunner: CommandRunner = async (command, args) => {
		if (command === "git" && args.includes("rev-parse")) {
			return { code: 0, stdout: "/repo\n", stderr: "" };
		}
		if (command === "git") {
			return { code: 0, stdout: "git@github.com:org/repo.git\n", stderr: "" };
		}
		if (command === "gh") {
			return { code: 0, stdout: "gh version 2.0.0\n", stderr: "" };
		}
		return { code: 1, stdout: "", stderr: "" };
	};

	const tracker = await detectTracker("/repo", fakeRunner);
	assert.strictEqual(tracker.kind, "github");

	// Without gh, even a GitHub remote falls back to the file board.
	const noGh: CommandRunner = async (command, args) =>
		command === "gh" ? { code: 1, stdout: "", stderr: "no gh" } : fakeRunner(command, args);
	const fallback = await detectTracker("/repo", noGh);
	assert.strictEqual(fallback.kind, "file");
});

test("file board create/list/get/comment/close lifecycle", () => {
	const dir = tempDir("pi-test-issues-");
	const boardDir = path.join(dir, ".pi", "issues");

	try {
		const created = createFileIssue(boardDir, {
			title: "[scout] Recon auth module",
			body: "Task: map the auth flow\nFindings: tokens are checked in middleware\nArtifacts: src/auth.ts",
			labels: ["recon"],
			author: "scout",
			status: "in-progress",
		});
		assert.strictEqual(created.id, "1");
		assert.ok(fs.existsSync(created.filePath));

		const list = listFileIssues(boardDir, {});
		assert.strictEqual(list.length, 1);
		assert.strictEqual(list[0].title, "[scout] Recon auth module");
		assert.strictEqual(list[0].status, "in-progress");
		assert.deepStrictEqual(list[0].labels, ["recon"]);

		const detail = readFileIssue(boardDir, "1");
		assert.ok(detail);
		assert.ok(detail.body.includes("src/auth.ts"));
		assert.strictEqual(detail.comments.length, 0);

		addFileIssueComment(boardDir, "1", {
			body: "Blocked on staging credentials.",
			author: "worker",
			status: "blocked",
		});
		const blocked = readFileIssue(boardDir, "1");
		assert.ok(blocked);
		assert.strictEqual(blocked.status, "blocked");
		assert.strictEqual(blocked.comments.length, 1);
		assert.strictEqual(blocked.comments[0].author, "worker");
		assert.ok(blocked.comments[0].body.includes("staging credentials"));

		closeFileIssue(boardDir, "1", { comment: "Done, credentials rotated.", author: "worker" });
		const closed = readFileIssue(boardDir, "1");
		assert.ok(closed);
		assert.strictEqual(closed.status, "done");
		assert.strictEqual(closed.comments.length, 2);

		// Filters
		assert.strictEqual(listFileIssues(boardDir, { status: "open" }).length, 0);
		assert.strictEqual(listFileIssues(boardDir, { status: "done" }).length, 1);
		assert.strictEqual(listFileIssues(boardDir, { label: "recon" }).length, 1);
	} finally {
		fs.rmSync(dir, { recursive: true, force: true });
	}
});

test("file board ids increment and title contract helpers behave", () => {
	const dir = tempDir("pi-test-issues-ids-");
	const boardDir = path.join(dir, ".pi", "issues");
	try {
		const first = createFileIssue(boardDir, { title: "one", body: "a" });
		const second = createFileIssue(boardDir, { title: "two", body: "b" });
		assert.strictEqual(first.id, "1");
		assert.strictEqual(second.id, "2");

		assert.strictEqual(ensureAuthorPrefix("Recon", "scout"), "[scout] Recon");
		assert.strictEqual(ensureAuthorPrefix("[scout] Recon", "worker"), "[scout] Recon");
		assert.strictEqual(normalizeStatus("blocked"), "blocked");
		assert.strictEqual(normalizeStatus("bogus"), "open");

		const prev = process.env.PI_SUBAGENT_AGENT;
		try {
			delete process.env.PI_SUBAGENT_AGENT;
			assert.strictEqual(resolveAuthor(), "parent");
			assert.strictEqual(
				resolveAuthor(undefined, { sessionManager: { getSessionName: () => "sa-worker-1" } }),
				"sa-worker-1",
			);
			assert.strictEqual(
				resolveAuthor(undefined, { sessionManager: { getSessionName: () => "my-session" } }),
				"parent",
			);
			process.env.PI_SUBAGENT_AGENT = "scout";
			assert.strictEqual(resolveAuthor(), "scout");
			assert.strictEqual(resolveAuthor("explicit"), "explicit");
		} finally {
			if (prev === undefined) delete process.env.PI_SUBAGENT_AGENT;
			else process.env.PI_SUBAGENT_AGENT = prev;
		}
	} finally {
		fs.rmSync(dir, { recursive: true, force: true });
	}
});

test("registerIssueTools exposes the five shared tools and executes on a file board", async () => {
	const api = createMockExtensionAPI();
	registerIssueTools(api);
	for (const name of ISSUE_TOOL_NAMES) {
		assert.ok(api.tools.has(name), `missing tool ${name}`);
	}

	const dir = tempDir("pi-test-issues-tools-");
	const ctx = { cwd: dir } as any;
	const prevAuthor = process.env.PI_SUBAGENT_AGENT;
	process.env.PI_SUBAGENT_AGENT = "scout";

	try {
		const create = api.tools.get("issue_create");
		const created = await create.execute(
			"call-1",
			{ title: "Auth recon", body: "Task: recon\nFindings: none yet", labels: ["recon"], status: "in-progress" },
			undefined,
			undefined,
			ctx,
		);
		assert.strictEqual(created.isError, undefined);
		assert.strictEqual(created.details.id, "1");
		assert.ok(created.content[0].text.includes("[scout] Auth recon"));

		const list = api.tools.get("issue_list");
		const listed = await list.execute("call-2", { status: "in-progress" }, undefined, undefined, ctx);
		assert.ok(listed.content[0].text.includes("#1 [in-progress] [scout] Auth recon"));

		const get = api.tools.get("issue_get");
		const fetched = await get.execute("call-3", { id: "1" }, undefined, undefined, ctx);
		assert.ok(fetched.content[0].text.includes("Findings: none yet"));

		const comment = api.tools.get("issue_comment");
		const commented = await comment.execute(
			"call-4",
			{ id: "1", body: "Blocked on credentials", status: "blocked" },
			undefined,
			undefined,
			ctx,
		);
		assert.strictEqual(commented.isError, undefined);

		const blocked = await get.execute("call-5", { id: "1" }, undefined, undefined, ctx);
		assert.ok(blocked.content[0].text.includes("[blocked]"));
		assert.ok(blocked.content[0].text.includes("Blocked on credentials"));

		const close = api.tools.get("issue_close");
		const closed = await close.execute("call-6", { id: "1", comment: "Done" }, undefined, undefined, ctx);
		assert.strictEqual(closed.isError, undefined);

		const after = await list.execute("call-7", { status: "done" }, undefined, undefined, ctx);
		assert.ok(after.content[0].text.includes("#1 [done]"));

		// Missing issues produce an error result, not a throw.
		const missing = await get.execute("call-8", { id: "42" }, undefined, undefined, ctx);
		assert.strictEqual(missing.isError, true);
	} finally {
		if (prevAuthor === undefined) delete process.env.PI_SUBAGENT_AGENT;
		else process.env.PI_SUBAGENT_AGENT = prevAuthor;
		fs.rmSync(dir, { recursive: true, force: true });
	}
});

test("findProjectRoot resolves a linked worktree to the main checkout", async (t) => {
	try {
		execFileSync("git", ["--version"], { stdio: "ignore" });
	} catch {
		return t.skip("git not available");
	}

	const parent = tempDir("pi-test-issues-wt-");
	const repo = path.join(parent, "repo");
	const worktree = path.join(parent, "worktree");
	fs.mkdirSync(repo);

	try {
		execFileSync("git", ["init", "-q", "-b", "main"], { cwd: repo });
		fs.writeFileSync(path.join(repo, "README.md"), "hi\n");
		execFileSync("git", ["add", "."], { cwd: repo });
		execFileSync(
			"git",
			["-c", "user.email=t@t", "-c", "user.name=t", "commit", "-qm", "init"],
			{ cwd: repo },
		);
		execFileSync("git", ["worktree", "add", "-q", "-b", "wt", worktree], { cwd: repo });

		assert.strictEqual(await findProjectRoot(worktree), fs.realpathSync(repo));
	} finally {
		fs.rmSync(parent, { recursive: true, force: true });
	}
});
