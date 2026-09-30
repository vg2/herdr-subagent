import test from "node:test";
import assert from "node:assert";
import extensionFactory from "../index.ts";
import { closePane, isHerdrAvailable } from "../herdr.ts";

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
