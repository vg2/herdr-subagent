import test from "node:test";
import assert from "node:assert";
import { execFileSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import extensionFactory from "../index.ts";
import { emptyUsage } from "../state.ts";
import {
	closePane,
	closeWorkspace,
	isHerdrAvailable,
	listWorkspaces,
	splitPane,
} from "../herdr.ts";
import { removeGitWorktree } from "../worktree.ts";

function createMockExtensionAPI() {
	const tools = new Map<string, any>();
	const commands = new Map<string, any>();
	const handlers = new Map<string, Function[]>();
	const entries: Array<{ type: string; data: any }> = [];

	const api: any = {
		registerTool: (tool: any) => {
			tools.set(tool.name, tool);
		},
		registerCommand: (name: string, cmd: any) => {
			commands.set(name, cmd);
		},
		on: (event: string, handler: Function) => {
			const list = handlers.get(event) ?? [];
			list.push(handler);
			handlers.set(event, list);
		},
		appendEntry: (type: string, data: any) => {
			entries.push({ type, data });
		},
		tools,
		commands,
		handlers,
		entries,
	};

	return api;
}

function createMockContext(overrides: Partial<any> = {}) {
	const notifications: Array<{ msg: string; type?: string }> = [];
	return {
		cwd: process.cwd(),
		mode: "tui",
		hasUI: true,
		isProjectTrusted: () => true,
		ui: {
			notify: (msg: string, type?: string) => {
				notifications.push({ msg, type });
			},
			confirm: async () => true,
		},
		sessionManager: {
			getBranch: () => [],
		},
		modelRegistry: {
			getAvailable: () => [
				{ provider: "opencode-go", id: "glm-5.3-flash", name: "GLM 5.3 Flash", reasoning: false },
				{ provider: "opencode-go", id: "glm-5.3", name: "GLM 5.3", reasoning: true },
			],
			getAll: () => [
				{ provider: "opencode-go", id: "glm-5.3-flash", name: "GLM 5.3 Flash", reasoning: false },
			],
		},
		notifications,
		...overrides,
	};
}

test("extension registers all Phase 2 tools and commands", () => {
	const api = createMockExtensionAPI();
	extensionFactory(api);

	// Registered tools
	assert.ok(api.tools.has("spawn_subagent"));
	assert.ok(api.tools.has("collect_subagents"));
	assert.ok(api.tools.has("subagent_status"));
	assert.ok(api.tools.has("abort_subagent"));

	// Registered command
	assert.ok(api.commands.has("subagents"));
});

test("extension registers the Phase 3 coordination tools", () => {
	const api = createMockExtensionAPI();
	extensionFactory(api);

	assert.ok(api.tools.has("subagent_message"));
	for (const name of ["issue_create", "issue_comment", "issue_list", "issue_get", "issue_close"]) {
		assert.ok(api.tools.has(name), `missing ${name}`);
	}
});

test("before_agent_start injects delegation guidelines only when spawn_subagent is active", () => {
	const api = createMockExtensionAPI();
	extensionFactory(api);

	const handler = (api.handlers.get("before_agent_start") ?? [])[0];
	assert.ok(handler, "before_agent_start handler should be registered");

	const active: any = { selectedTools: ["spawn_subagent"], promptGuidelines: [] };
	handler({ systemPromptOptions: active }, createMockContext());
	assert.ok(active.promptGuidelines.length >= 5, "expected delegation guidelines");
	assert.ok(active.promptGuidelines.some((g: string) => g.includes("Delegate selectively")));
	assert.ok(active.promptGuidelines.some((g: string) => g.includes("worktree")));

	const inactive: any = { selectedTools: ["read"], promptGuidelines: [] };
	handler({ systemPromptOptions: inactive }, createMockContext());
	assert.strictEqual(inactive.promptGuidelines.length, 0);
}, 1);

test("session_start installs the sub-agent status widget and updates it on spawn/abort", async () => {
	const api = createMockExtensionAPI();
	extensionFactory(api);

	const statuses: Array<[string, string | undefined]> = [];
	const ctx = createMockContext({
		ui: {
			notify: () => {},
			confirm: async () => true,
			setStatus: (key: string, value: string | undefined) => statuses.push([key, value]),
		},
	});

	for (const handler of api.handlers.get("session_start") ?? []) {
		await handler({}, ctx);
	}
	assert.ok(statuses.some(([key]) => key === "herdr-subagent"), "session_start should clear/initialize the widget");

	const spawnTool = api.tools.get("spawn_subagent");
	const spawnResult = await spawnTool.execute(
		"call-widget-spawn",
		{ agent: "scout", task: "Say hello", mode: "headless", wait: false },
		undefined,
		undefined,
		ctx,
	);
	const run = spawnResult.details.runs[0];

	const running = statuses[statuses.length - 1];
	assert.strictEqual(running[0], "herdr-subagent");
	assert.ok(running[1]?.includes("scout"), `expected scout in widget text, got ${running[1]}`);

	const abortTool = api.tools.get("abort_subagent");
	await abortTool.execute("call-widget-abort", { id: run.id, force: true }, undefined, undefined, ctx);
	assert.strictEqual(statuses[statuses.length - 1][1], undefined, "widget clears when nothing is active");
});

function persistedView(overrides: Record<string, unknown> & { id: string }): Record<string, unknown> {
	return {
		agent: "scout",
		agentSource: "user",
		task: "old task",
		cwd: process.cwd(),
		status: "running",
		startedAt: 1,
		usage: emptyUsage(),
		reportPath: `/tmp/pi-subagent/${overrides.id}/report.md`,
		collected: false,
		mode: "headless",
		...overrides,
	};
}

test("session_start restores children from the session branch, settles stale runs, and reconciles them", async () => {
	const api = createMockExtensionAPI();
	extensionFactory(api);

	const entries = [
		{
			type: "custom",
			customType: "herdr-subagent-run",
			data: persistedView({ id: "sa-scout-987654", status: "done", endedAt: 2, collected: true, report: "Restored report body" }),
		},
		{ type: "custom", customType: "herdr-subagent-run", data: persistedView({ id: "sa-worker-987655", status: "running" }) },
		{
			type: "custom",
			customType: "herdr-subagent-run",
			data: persistedView({
				id: "sa-reviewer-987656",
				agent: "reviewer",
				status: "blocked",
				mode: "pane",
				paneId: "%42",
				agentName: "sa-reviewer-987656",
				blockedQuestion: "Approve this edit?",
				endedAt: undefined,
			}),
		},
	];

	const ctx = createMockContext({ sessionManager: { getBranch: () => entries } });
	for (const handler of api.handlers.get("session_start") ?? []) {
		await handler({ reason: "resume" }, ctx);
	}

	assert.ok(
		ctx.notifications.some((n: any) => n.msg.includes("Restored 3 sub-agents")),
		`expected a restore notification, got ${JSON.stringify(ctx.notifications)}`,
	);

	const statusTool = api.tools.get("subagent_status");
	const statusRes = await statusTool.execute("call-status-restored", {}, undefined, undefined, ctx);
	const runs = statusRes.details.runs;
	assert.strictEqual(runs.length, 3);

	const done = runs.find((r: any) => r.id === "sa-scout-987654");
	assert.strictEqual(done.status, "done");
	assert.strictEqual(done.report, "Restored report body");

	const stale = runs.find((r: any) => r.id === "sa-worker-987655");
	assert.strictEqual(stale.status, "failed", "stale headless runs cannot be adopted");

	const blocked = runs.find((r: any) => r.id === "sa-reviewer-987656");
	assert.strictEqual(blocked.status, "done", "a blocked child with no live agent is settled");
	assert.strictEqual(blocked.paneClosed, true);

	assert.ok(statusRes.content[0].text.includes("Totals:"), statusRes.content[0].text);
});

test("session_start re-adopts a live pane child from a previous session", async () => {
	if (!isHerdrAvailable()) return;

	const api1 = createMockExtensionAPI();
	extensionFactory(api1);
	const ctx1 = createMockContext({ mode: "tui" });

	const spawnTool = api1.tools.get("spawn_subagent");
	const spawnResult = await spawnTool.execute(
		"call-spawn-live-adopt",
		{ agent: "scout", task: "Say hi", mode: "pane", layout: "pane", wait: false },
		undefined,
		undefined,
		ctx1,
	);
	const view = spawnResult.details.runs[0];
	assert.ok(view?.paneId, "expected a pane child");

	try {
		// The mock API records exactly what the extension persisted for the branch.
		// Use the newest snapshot: the dispatch entry predates the pane/agent identity.
		const persisted = api1.entries
			.filter((e: any) => e.type === "herdr-subagent-run" && e.data?.id === view.id)
			.pop();
		assert.ok(persisted, "spawn should persist the live child snapshot");
		assert.strictEqual(persisted.data.agentName, view.id);
		assert.ok(persisted.data.paneId);

		// Simulate a parent restart: a fresh extension instance resumes the session
		// and must find the still-running child via `herdr agent list`.
		const api2 = createMockExtensionAPI();
		extensionFactory(api2);
		const ctx2 = createMockContext({
			mode: "tui",
			sessionManager: {
				getBranch: () => [{ type: "custom", customType: "herdr-subagent-run", data: persisted.data }],
			},
		});
		for (const handler of api2.handlers.get("session_start") ?? []) {
			await handler({ reason: "resume" }, ctx2);
		}
		assert.ok(ctx2.notifications.some((n: any) => n.msg.includes("Restored 1 sub-agent")));

		const statusTool = api2.tools.get("subagent_status");
		const statusRes = await statusTool.execute("call-status-live-adopt", { ids: [view.id] }, undefined, undefined, ctx2);
		const adopted = statusRes.details.runs[0];
		assert.ok(adopted, "restored run should be listed");
		assert.strictEqual(adopted.paneClosed, false, "a live pane must be re-adopted");
		assert.ok(["running", "blocked", "done"].includes(adopted.status), adopted.status);

		// The restored abort handle must also work through the new instance.
		const abortTool = api2.tools.get("abort_subagent");
		await abortTool.execute("call-abort-live-adopt", { id: view.id, force: true }, undefined, undefined, ctx2);
	} finally {
		for (const handler of api1.handlers.get("session_shutdown") ?? []) {
			await handler({}, ctx1);
		}
	}
});

test("session_start does not adopt children in a forked session", async () => {
	const api = createMockExtensionAPI();
	extensionFactory(api);

	const entries = [
		{ type: "custom", customType: "herdr-subagent-run", data: persistedView({ id: "sa-scout-12", status: "done" }) },
	];
	const ctx = createMockContext({ sessionManager: { getBranch: () => entries } });
	for (const handler of api.handlers.get("session_start") ?? []) {
		await handler({ reason: "fork" }, ctx);
	}

	const statusTool = api.tools.get("subagent_status");
	const statusRes = await statusTool.execute("call-status-fork", {}, undefined, undefined, ctx);
	assert.strictEqual(statusRes.details.runs.length, 0);
	assert.strictEqual(ctx.notifications.length, 0, "forked sessions start with a clean registry");
});

test("/subagents answer relays to pane children only", async () => {
	const api = createMockExtensionAPI();
	extensionFactory(api);
	const ctx = createMockContext();

	const spawnTool = api.tools.get("spawn_subagent");
	const spawnResult = await spawnTool.execute(
		"call-spawn-answer",
		{ agent: "scout", task: "Say hello", mode: "headless", wait: false },
		undefined,
		undefined,
		ctx,
	);
	const run = spawnResult.details.runs[0];
	const subagentsCmd = api.commands.get("subagents");

	try {
		await subagentsCmd.handler(`answer ${run.id} use the other file`, ctx);
		const last = ctx.notifications[ctx.notifications.length - 1];
		assert.strictEqual(last.type, "error");
		assert.ok(last.msg.includes("headless"), last.msg);

		await subagentsCmd.handler("answer sa-nope-99 hi", ctx);
		assert.ok(ctx.notifications[ctx.notifications.length - 1].msg.includes("Unknown sub-agent"));
	} finally {
		const abortTool = api.tools.get("abort_subagent");
		await abortTool.execute("call-abort-answer", { id: run.id, force: true }, undefined, undefined, ctx);
	}
});

test("subagent_message rejects unknown and headless children", async () => {
	const api = createMockExtensionAPI();
	extensionFactory(api);
	const ctx = createMockContext();

	const messageTool = api.tools.get("subagent_message");
	const unknown = await messageTool.execute(
		"call-msg-unknown",
		{ id: "sa-nope-1", message: "hi" },
		undefined,
		undefined,
		ctx,
	);
	assert.strictEqual(unknown.isError, true);

	const spawnTool = api.tools.get("spawn_subagent");
	const spawnResult = await spawnTool.execute(
		"call-spawn-msg",
		{ agent: "scout", task: "Say hello", mode: "headless", wait: false },
		undefined,
		undefined,
		ctx,
	);
	const run = spawnResult.details.runs[0];
	try {
		const res = await messageTool.execute(
			"call-msg-headless",
			{ id: run.id, message: "extra context" },
			undefined,
			undefined,
			ctx,
		);
		assert.strictEqual(res.isError, true);
		assert.ok(res.content[0].text.includes("headless"));
	} finally {
		const abortTool = api.tools.get("abort_subagent");
		await abortTool.execute("call-abort-msg", { id: run.id, force: true }, undefined, undefined, ctx);
	}
});

test("layout worktree fails clearly outside a git repository", async () => {
	const api = createMockExtensionAPI();
	extensionFactory(api);
	const ctx = createMockContext();
	const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "pi-test-ext-worktree-"));

	try {
		const spawnTool = api.tools.get("spawn_subagent");
		const res = await spawnTool.execute(
			"call-worktree-fail",
			{ agent: "scout", task: "x", mode: "headless", layout: "worktree", cwd: tmp, wait: false },
			undefined,
			undefined,
			ctx,
		);
		assert.strictEqual(res.isError, true);
		assert.ok(res.content[0].text.includes("worktree"));
	} finally {
		fs.rmSync(tmp, { recursive: true, force: true });
	}
});

test("subagents command completions suggest subcommands and run ids", () => {
	const api = createMockExtensionAPI();
	extensionFactory(api);

	const cmd = api.commands.get("subagents");
	assert.ok(cmd);

	// Suggests subcommands when typing initial word
	const subcmdCompletions = cmd.getArgumentCompletions("");
	assert.ok(subcmdCompletions);
	const values = subcmdCompletions.map((c: any) => c.label);
	assert.ok(values.includes("list"));
	assert.ok(values.includes("focus"));
	assert.ok(values.includes("answer"));
	assert.ok(values.includes("abort"));
	assert.ok(values.includes("collect"));
	assert.ok(values.includes("cleanup"));
});

test("spawn_subagent executes in headless mode with wait: false", async () => {
	const api = createMockExtensionAPI();
	extensionFactory(api);
	const ctx = createMockContext();

	const spawnTool = api.tools.get("spawn_subagent");
	const result = await spawnTool.execute(
		"call-1",
		{
			agent: "scout",
			task: "Scan files",
			mode: "headless",
			wait: false,
		},
		undefined,
		undefined,
		ctx,
	);

	assert.strictEqual(result.isError, undefined);
	assert.ok(result.content[0].text.includes("Dispatched"));
	assert.strictEqual(result.details.mode, "headless");
	assert.strictEqual(result.details.runs.length, 1);

	// Check status
	const statusTool = api.tools.get("subagent_status");
	const statusResult = await statusTool.execute("call-2", {}, undefined, undefined, ctx);
	assert.ok(statusResult.details.runs.length >= 1);

	// Clean up headless run
	const abortTool = api.tools.get("abort_subagent");
	await abortTool.execute("call-abort-headless", { id: result.details.runs[0].id, force: true }, undefined, undefined, ctx);
});

test("spawn_subagent in pane mode, collect_subagents, and cleanup", async () => {
	if (!isHerdrAvailable()) return;

	const api = createMockExtensionAPI();
	extensionFactory(api);
	const ctx = createMockContext({ mode: "tui" });

	const spawnTool = api.tools.get("spawn_subagent");
	const collectTool = api.tools.get("collect_subagents");
	const abortTool = api.tools.get("abort_subagent");
	const subagentsCmd = api.commands.get("subagents");

	// 1. Dispatch sub-agent in Herdr pane (fire-and-forget)
	const spawnResult = await spawnTool.execute(
		"call-spawn-pane",
		{
			agent: "scout",
			task: "Say hello and test report generation",
			mode: "pane",
			layout: "pane",
			wait: false,
		},
		undefined,
		undefined,
		ctx,
	);

	assert.strictEqual(spawnResult.isError, undefined);
	const run = spawnResult.details.runs[0];
	assert.ok(run);
	assert.strictEqual(run.mode, "pane");
	assert.ok(run.paneId);
	assert.ok(spawnResult.content[0].text.includes("in Herdr pane"));

	try {
		// 2. Test command /subagents list
		await subagentsCmd.handler("list", ctx);
		assert.ok(ctx.notifications.length > 0);
		const lastNotification = ctx.notifications[ctx.notifications.length - 1];
		assert.ok(lastNotification.msg.includes(run.id));

		// 3. Test abort_subagent guard rail: refuse without force if working/running
		const abortRefused = await abortTool.execute(
			"call-abort-guard",
			{ id: run.id, force: false },
			undefined,
			undefined,
			ctx,
		);
		assert.strictEqual(abortRefused.isError, true);
		assert.ok(abortRefused.content[0].text.includes("without force: true"));

		// 4. Test collect_subagents
		const collectResult = await collectTool.execute(
			"call-collect",
			{ ids: [run.id], timeoutMs: 15000 },
			undefined,
			undefined,
			ctx,
		);
		assert.ok(collectResult.details.runs.length > 0);
	} finally {
		// 5. Clean up via abort with force
		await abortTool.execute(
			"call-abort-cleanup",
			{ id: run.id, force: true },
			undefined,
			undefined,
			ctx,
		);
	}
});

test("cleanup command closes open panes and marks paneClosed", async () => {
	if (!isHerdrAvailable()) return;

	const api = createMockExtensionAPI();
	extensionFactory(api);
	const ctx = createMockContext({ mode: "tui" });

	const spawnTool = api.tools.get("spawn_subagent");
	const abortTool = api.tools.get("abort_subagent");
	const subagentsCmd = api.commands.get("subagents");

	const spawnResult = await spawnTool.execute(
		"call-spawn-cleanup",
		{
			agent: "scout",
			task: "Test cleanup",
			mode: "pane",
			layout: "pane",
			wait: false,
		},
		undefined,
		undefined,
		ctx,
	);

	const run = spawnResult.details.runs[0];
	assert.ok(run?.paneId);

	try {
		// Run cleanup with force
		await subagentsCmd.handler("cleanup --force", ctx);
		assert.ok(ctx.notifications.some((n: any) => n.msg.includes("Cleaned up 1 sub-agent pane")));

		// Status tool should now show run with paneClosed: true
		const statusTool = api.tools.get("subagent_status");
		const statusRes = await statusTool.execute("call-status", { ids: [run.id] }, undefined, undefined, ctx);
		assert.strictEqual(statusRes.details.runs[0].paneClosed, true);
	} finally {
		try {
			await abortTool.execute("call-abort", { id: run.id, force: true }, undefined, undefined, ctx);
		} catch {
			/* ignore */
		}
	}
});

test("manually closed pane is reconciled and cleanup handles pane_not_found", async () => {
	if (!isHerdrAvailable()) return;

	const api = createMockExtensionAPI();
	extensionFactory(api);
	const ctx = createMockContext({ mode: "tui" });

	const spawnTool = api.tools.get("spawn_subagent");
	const statusTool = api.tools.get("subagent_status");
	const subagentsCmd = api.commands.get("subagents");

	const spawnResult = await spawnTool.execute(
		"call-spawn-manual-close",
		{ agent: "scout", task: "Test manual close reconciliation", mode: "pane", layout: "pane", wait: false },
		undefined,
		undefined,
		ctx,
	);
	const run = spawnResult.details.runs[0];
	assert.ok(run?.paneId);

	// Simulate the user closing the pane directly (outside the extension)
	await closePane(run.paneId);

	// 1. cleanup hits pane_not_found: marks paneClosed without counting it as closed
	await subagentsCmd.handler("cleanup --force", ctx);
	assert.ok(
		ctx.notifications.some((n: any) => n.msg.includes("Cleaned up 0 sub-agent pane(s).")),
		`expected cleanup to report 0 closed panes, got: ${JSON.stringify(ctx.notifications)}`,
	);

	// 2. status reconcile marks the run done with paneClosed true
	let view: any;
	for (let i = 0; i < 10; i++) {
		const statusRes = await statusTool.execute(
			"call-status-manual-close",
			{ ids: [run.id] },
			undefined,
			undefined,
			ctx,
		);
		view = statusRes.details.runs[0];
		if (view.status === "done" && view.paneClosed) break;
		await new Promise((r) => setTimeout(r, 300));
	}
	assert.strictEqual(view.status, "done");
	assert.strictEqual(view.paneClosed, true);
});

test("cleanup closes the herdr worktree workspace and removes its checkout", async (t) => {
	if (!isHerdrAvailable()) return;
	try {
		execFileSync("git", ["--version"], { stdio: "ignore" });
	} catch {
		return t.skip("git not available");
	}

	const parent = fs.mkdtempSync(path.join(os.tmpdir(), "pi-test-ext-wt-cleanup-"));
	const repo = path.join(parent, "repo");
	fs.mkdirSync(repo);
	execFileSync("git", ["init", "-q", "-b", "main"], { cwd: repo });
	fs.writeFileSync(path.join(repo, "README.md"), "hello\n");
	execFileSync("git", ["add", "."], { cwd: repo });
	execFileSync("git", ["-c", "user.email=test@test", "-c", "user.name=test", "commit", "-qm", "init"], {
		cwd: repo,
	});

	const api = createMockExtensionAPI();
	extensionFactory(api);
	const ctx = createMockContext({ mode: "tui" });
	const spawnTool = api.tools.get("spawn_subagent");
	const abortTool = api.tools.get("abort_subagent");
	const subagentsCmd = api.commands.get("subagents");

	let run: any;
	let workspaceId: string | undefined;
	let sourceWorkspaceId: string | undefined;
	try {
		const res = await spawnTool.execute(
			"call-spawn-wt-cleanup",
			{
				agent: "scout",
				task: "Reply with the single word: ready",
				mode: "pane",
				layout: "worktree",
				cwd: repo,
				wait: false,
			},
			undefined,
			undefined,
			ctx,
		);
		run = res.details.runs[0];
		assert.strictEqual(res.isError, undefined, res.content[0].text);
		if (run.worktreeMode !== "herdr") return t.skip("herdr worktree create unavailable");

		workspaceId = run.workspaceId;
		sourceWorkspaceId = run.ownedSourceWorkspace?.workspaceId;
		assert.ok(workspaceId, "worktree run should record its herdr workspace");
		assert.ok(sourceWorkspaceId, "worktree run should own the source workspace it opened");
		assert.ok(fs.existsSync(run.worktreePath), "worktree checkout should exist before cleanup");

		await subagentsCmd.handler("cleanup --force --worktrees", ctx);
		assert.ok(
			ctx.notifications.some((n: any) => n.msg.includes("worktree workspace(s)")),
			`expected the workspace close in the cleanup message, got: ${JSON.stringify(ctx.notifications)}`,
		);
		assert.ok(
			ctx.notifications.some((n: any) => n.msg.includes("source-checkout workspace(s)")),
			`expected the source workspace close in the cleanup message, got: ${JSON.stringify(ctx.notifications)}`,
		);
		assert.ok(!fs.existsSync(run.worktreePath), "worktree checkout should be removed with --worktrees --force");

		for (let i = 0; i < 20; i++) {
			const open = (await listWorkspaces()).map((w) => w.workspace_id);
			if (!open.includes(workspaceId!) && !open.includes(sourceWorkspaceId!)) break;
			await new Promise((r) => setTimeout(r, 250));
		}
		const remaining = (await listWorkspaces()).map((w) => w.workspace_id);
		assert.ok(
			!remaining.includes(workspaceId!),
			"extension-created worktree workspace should be closed by cleanup",
		);
		assert.ok(
			!remaining.includes(sourceWorkspaceId!),
			"extension-created source-checkout workspace should be closed by cleanup",
		);
	} finally {
		if (run) {
			try {
				await abortTool.execute("call-abort-wt-cleanup", { id: run.id, force: true }, undefined, undefined, ctx);
			} catch {
				/* ignore */
			}
		}
		// The extension opens the source-checkout workspace explicitly for a
		// worktree run; cleanup should close it, but close anything left pointing
		// into the temp dir (plus the tracked workspaces) if cleanup failed.
		try {
			const tempRoot = path.resolve(parent);
			for (const ws of await listWorkspaces()) {
				const checkout = ws.worktree?.checkout_path ?? ws.worktree?.path;
				const underTemp = !!checkout && path.resolve(checkout).startsWith(`${tempRoot}${path.sep}`);
				if (
					(workspaceId && ws.workspace_id === workspaceId) ||
					(sourceWorkspaceId && ws.workspace_id === sourceWorkspaceId) ||
					underTemp
				) {
					try {
						await closeWorkspace(ws.workspace_id);
					} catch {
						/* ignore */
					}
				}
			}
		} catch {
			/* ignore */
		}
		fs.rmSync(parent, { recursive: true, force: true });
	}
});

test("cleanup keeps a shared source workspace while a linked worktree workspace holds panes", async (t) => {
	if (!isHerdrAvailable()) return;
	try {
		execFileSync("git", ["--version"], { stdio: "ignore" });
	} catch {
		return t.skip("git not available");
	}

	const parent = fs.mkdtempSync(path.join(os.tmpdir(), "pi-test-ext-wt-shared-"));
	const repo = path.join(parent, "repo");
	fs.mkdirSync(repo);
	execFileSync("git", ["init", "-q", "-b", "main"], { cwd: repo });
	fs.writeFileSync(path.join(repo, "README.md"), "hello\n");
	execFileSync("git", ["add", "."], { cwd: repo });
	execFileSync(
		"git",
		["-c", "user.email=test@test", "-c", "user.name=test", "commit", "-qm", "init"],
		{ cwd: repo },
	);

	const api = createMockExtensionAPI();
	extensionFactory(api);
	const ctx = createMockContext({ mode: "tui" });
	const spawnTool = api.tools.get("spawn_subagent");
	const abortTool = api.tools.get("abort_subagent");
	const subagentsCmd = api.commands.get("subagents");

	let runA: any;
	let runB: any;
	let sourceWorkspaceId: string | undefined;
	let userPaneId: string | undefined;
	try {
		// Two worktree runs on the same checkout: the first opens (and owns) the
		// source-checkout workspace, the second reuses it.
		const spawnOne = (call: string) =>
			spawnTool.execute(
				call,
				{
					agent: "scout",
					task: "Reply with the single word: ready",
					mode: "pane",
					layout: "worktree",
					cwd: repo,
					wait: false,
				},
				undefined,
				undefined,
				ctx,
			);
		const resA = await spawnOne("call-spawn-wt-shared-a");
		runA = resA.details.runs[0];
		assert.strictEqual(resA.isError, undefined, resA.content[0].text);
		if (runA.worktreeMode !== "herdr") return t.skip("herdr worktree create unavailable");
		sourceWorkspaceId = runA.ownedSourceWorkspace?.workspaceId;
		assert.ok(sourceWorkspaceId, "the first run should own the source workspace it opened");

		const resB = await spawnOne("call-spawn-wt-shared-b");
		runB = resB.details.runs[0];
		assert.strictEqual(resB.isError, undefined, resB.content[0].text);
		assert.strictEqual(
			runB.sourceWorkspaceId,
			sourceWorkspaceId,
			"the second run should reuse the same source workspace",
		);
		assert.strictEqual(
			runB.ownedSourceWorkspace,
			undefined,
			"only the run that opened the source workspace should own closing it",
		);

		// The user adds a pane to the second run's worktree workspace.
		const userPane = await splitPane({ paneId: runB.paneId, direction: "right", cwd: repo, focus: false });
		userPaneId = userPane.pane_id;

		// Cleanup closes every agent pane; the shared source workspace must then
		// survive, because closing it would cascade onto the user's pane in the
		// second run's worktree workspace.
		await subagentsCmd.handler("cleanup --force", ctx);
		for (let i = 0; i < 20; i++) {
			const open = (await listWorkspaces()).map((w: any) => w.workspace_id);
			if (!open.includes(runA.workspaceId)) break;
			await new Promise((r) => setTimeout(r, 250));
		}
		const open = (await listWorkspaces()).map((w: any) => w.workspace_id);
		assert.ok(!open.includes(runA.workspaceId), "the first run's empty worktree workspace should be closed");
		assert.ok(
			open.includes(runB.workspaceId),
			"the second run's worktree workspace holds a user pane and must be kept",
		);
		assert.ok(
			open.includes(sourceWorkspaceId),
			"the shared source workspace must be kept while a linked worktree workspace still has panes",
		);
		assert.ok(
			ctx.notifications.some((n: any) => n.msg.includes("Kept 1 source-checkout workspace(s)")),
			`expected the kept source workspace in the cleanup message, got: ${JSON.stringify(ctx.notifications)}`,
		);
	} finally {
		if (userPaneId) {
			try {
				await closePane(userPaneId);
			} catch {
				/* ignore */
			}
		}
		for (const run of [runA, runB]) {
			if (!run) continue;
			try {
				await abortTool.execute(`abort-${run.id}`, { id: run.id, force: true }, undefined, undefined, ctx);
			} catch {
				/* ignore */
			}
			if (run.worktreePath) {
				try {
					await removeGitWorktree(run.worktreePath, { force: true });
				} catch {
					/* ignore */
				}
			}
		}
		// Close anything left pointing into the temp dir (the source and worktree
		// workspaces) in case the assertions above failed before cleanup could.
		try {
			const tempRoot = path.resolve(parent);
			for (const ws of await listWorkspaces()) {
				const checkout = ws.worktree?.checkout_path ?? ws.worktree?.path;
				const underTemp = !!checkout && path.resolve(checkout).startsWith(`${tempRoot}${path.sep}`);
				if (underTemp) {
					try {
						await closeWorkspace(ws.workspace_id);
					} catch {
						/* ignore */
					}
				}
			}
		} catch {
			/* ignore */
		}
		fs.rmSync(parent, { recursive: true, force: true });
	}
});
