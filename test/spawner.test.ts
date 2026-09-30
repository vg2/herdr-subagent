import test from "node:test";
import assert from "node:assert";
import * as path from "node:path";
import {
	childEnv,
	childIdentityEnv,
	childToolAllowlist,
	resolveSpawnMode,
	resolveModel,
	buildDelegationPrompt,
	createRunDir,
	startPane,
} from "../spawner.ts";
import { ISSUE_TOOL_NAMES } from "../issues.ts";
import { isHerdrAvailable, getAgent, listAgents } from "../herdr.ts";
import { emptyUsage, type SubagentRun, RunRegistry } from "../state.ts";
import type { AgentConfig } from "../agents.ts";

test("resolveSpawnMode resolves according to Plan 3.1", () => {
	const origHerdr = process.env.HERDR_ENV;
	try {
		// Inside Herdr TUI
		process.env.HERDR_ENV = "1";
		assert.strictEqual(resolveSpawnMode("auto", "tui").mode, "pane");
		assert.strictEqual(resolveSpawnMode(undefined, "tui").mode, "pane");
		assert.strictEqual(resolveSpawnMode("pane", "tui").mode, "pane");
		assert.strictEqual(resolveSpawnMode("headless", "tui").mode, "headless");

		// Inside Herdr but non-TUI (e.g. print/rpc)
		assert.strictEqual(resolveSpawnMode("auto", "text").mode, "headless");
		assert.ok(resolveSpawnMode("pane", "text").error);

		// Outside Herdr
		process.env.HERDR_ENV = "0";
		assert.strictEqual(resolveSpawnMode("auto", "tui").mode, "headless");
		assert.strictEqual(resolveSpawnMode(undefined, "tui").mode, "headless");
		assert.ok(resolveSpawnMode("pane", "tui").error);
		assert.strictEqual(resolveSpawnMode("headless", "tui").mode, "headless");
	} finally {
		process.env.HERDR_ENV = origHerdr;
	}
});

test("buildDelegationPrompt builds prompt containing task, scope, deliverable and cross-agent policy", () => {
	const prompt = buildDelegationPrompt({
		task: "Investigate performance bottleneck",
		context: "Prior finding: query X is slow",
		scope: "src/db",
		deliverable: "Findings list",
		reportPath: "/tmp/report.md",
		cwd: "/home/user/project",
	});

	assert.ok(prompt.includes("## Task"));
	assert.ok(prompt.includes("Investigate performance bottleneck"));
	assert.ok(prompt.includes("## Context"));
	assert.ok(prompt.includes("Prior finding: query X is slow"));
	assert.ok(prompt.includes("## Scope"));
	assert.ok(prompt.includes("src/db"));
	assert.ok(prompt.includes("## Deliverable"));
	assert.ok(prompt.includes("Findings list"));
	assert.ok(prompt.includes("/tmp/report.md"));
	assert.ok(prompt.includes("## Cross-agent policy"));
	assert.ok(prompt.includes("cannot contact other agents directly"));
});

test("RunRegistry.nextId enforces length <= 32 and avoids collisions", () => {
	const registry = new RunRegistry();

	// Normal short name
	const id1 = registry.nextId("scout");
	assert.strictEqual(id1, "sa-scout-1");
	assert.ok(id1.length <= 32);

	// Very long persona name (e.g. 50 characters)
	const longName = "super-long-codebase-migration-refactoring-specialist-expert";
	const id2 = registry.nextId(longName);
	assert.ok(id2.length <= 32);
	assert.ok(id2.startsWith("sa-"));
	assert.ok(id2.endsWith("-2"));

	// Collision avoidance against live agents
	const liveAgents = ["sa-worker-3", "sa-worker-4"];
	const id3 = registry.nextId("worker", liveAgents);
	assert.strictEqual(id3, "sa-worker-5"); // 3 and 4 were occupied, jumps to 5
	assert.ok(id3.length <= 32);
});

test("RunRegistry.openPaneRuns counts open panes and ignores closed ones", () => {
	const registry = new RunRegistry();

	const run1: SubagentRun = {
		id: "sa-test-1",
		agent: "scout",
		agentSource: "user",
		task: "task 1",
		cwd: "/tmp",
		status: "done", // done, but pane is still open!
		startedAt: Date.now(),
		messages: [],
		usage: emptyUsage(),
		stderr: "",
		dir: "/tmp",
		reportPath: "/tmp/report.md",
		collected: false,
		report: "",
		mode: "pane",
		paneId: "wF:p1",
		paneClosed: false,
		abort: () => {},
	};

	const run2: SubagentRun = {
		id: "sa-test-2",
		agent: "worker",
		agentSource: "user",
		task: "task 2",
		cwd: "/tmp",
		status: "done",
		startedAt: Date.now(),
		messages: [],
		usage: emptyUsage(),
		stderr: "",
		dir: "/tmp",
		reportPath: "/tmp/report.md",
		collected: false,
		report: "",
		mode: "pane",
		paneId: "wF:p2",
		paneClosed: true, // pane was closed
		abort: () => {},
	};

	const run3: SubagentRun = {
		id: "sa-test-3",
		agent: "planner",
		agentSource: "user",
		task: "task 3",
		cwd: "/tmp",
		status: "running",
		startedAt: Date.now(),
		messages: [],
		usage: emptyUsage(),
		stderr: "",
		dir: "/tmp",
		reportPath: "/tmp/report.md",
		collected: false,
		report: "",
		mode: "headless", // headless
		abort: () => {},
	};

	registry.add(run1);
	registry.add(run2);
	registry.add(run3);

	const openPanes = registry.openPaneRuns();
	assert.strictEqual(openPanes.length, 1);
	assert.strictEqual(openPanes[0].id, "sa-test-1");

	// excludeId excludes the specified run
	assert.strictEqual(registry.openPaneRuns("sa-test-1").length, 0);
});

test("nextId dedupes against a live Herdr agent from a previous session", async () => {
	if (!isHerdrAvailable()) return;

	const id = "sa-livetest-1";
	const dir = createRunDir(id);

	const persona: AgentConfig = {
		name: "livetest",
		description: "Live-agent name dedupe test",
		tools: ["read"],
		model: "opencode-go/glm-5.3-flash",
		thinking: "low",
		systemPrompt: "You are a test agent.",
		source: "user",
	};

	const run: SubagentRun = {
		id,
		agent: persona.name,
		agentSource: persona.source,
		task: "Name dedupe test",
		cwd: process.cwd(),
		status: "running",
		startedAt: Date.now(),
		messages: [],
		usage: emptyUsage(),
		stderr: "",
		dir,
		reportPath: path.join(dir, "report.md"),
		collected: false,
		report: "",
		mode: "pane",
		abort: () => {},
	};

	try {
		await startPane({
			run,
			persona,
			delegationPrompt: "Reply with the single word: ready",
			layout: "pane",
			activePaneCount: 0,
		});

		const agents = await listAgents();
		const liveNames = agents.map((a) => a.name || a.agent);
		assert.ok(liveNames.includes(id), `expected live agent ${id}, got: ${liveNames.join(", ")}`);

		// A restarted parent session gets a fresh registry; it must not reuse the live name
		const fresh = new RunRegistry();
		assert.strictEqual(fresh.nextId("livetest", liveNames), "sa-livetest-2");
	} finally {
		await run.abort("test cleanup");
	}
});

test("startPane creates pane child and abort cleans it up", async () => {
	if (!isHerdrAvailable()) return;

	const id = `sa-test-${Date.now()}`;
	const dir = createRunDir(id);
	const reportPath = path.join(dir, "report.md");

	const persona: AgentConfig = {
		name: "scout",
		description: "Fast read-only recon",
		tools: ["read", "bash"],
		model: "opencode-go/glm-5.3-flash",
		thinking: "low",
		systemPrompt: "You are a scout agent.",
		source: "user",
	};

	const run: SubagentRun = {
		id,
		agent: persona.name,
		agentSource: persona.source,
		task: "Echo test message and write report",
		model: persona.model,
		thinking: persona.thinking,
		cwd: process.cwd(),
		status: "running",
		startedAt: Date.now(),
		messages: [],
		usage: emptyUsage(),
		stderr: "",
		dir,
		reportPath,
		collected: false,
		report: "",
		mode: "pane",
		abort: () => {},
	};

	const delegationPrompt = buildDelegationPrompt({
		task: run.task,
		reportPath,
		cwd: run.cwd,
	});

	try {
		await startPane({
			run,
			persona,
			delegationPrompt,
			layout: "pane",
			activePaneCount: 0,
		});

		assert.ok(run.paneId);
		assert.ok(run.agentName);
		assert.strictEqual(run.mode, "pane");

		// Verify agent was recognized by Herdr
		const agent = await getAgent(run.agentName);
		assert.ok(agent);
		assert.strictEqual(agent.name, run.agentName);

		// Test abort
		await run.abort("test completed");
		assert.strictEqual(run.status, "aborted");

		// Verify pane was closed
		const afterAgent = await getAgent(run.agentName);
		assert.strictEqual(afterAgent, null);
	} finally {
		// Ensure pane closed in case of failure
		if (run.paneId) {
			try {
				await run.abort();
			} catch {
				/* ignore */
			}
		}
	}
});

test("childToolAllowlist appends the shared issue tools to persona allowlists", () => {
	const persona: AgentConfig = {
		name: "scout",
		description: "test",
		tools: ["read", "grep"],
		systemPrompt: "",
		source: "user",
		filePath: "(test)",
	};

	const tools = childToolAllowlist(persona);
	assert.ok(tools);
	assert.ok(tools.includes("read"));
	assert.ok(tools.includes("grep"));
	for (const name of ISSUE_TOOL_NAMES) {
		assert.ok(tools.includes(name), `expected issue tool ${name}`);
	}

	// Personas without an allowlist keep full tool access (issue tools included).
	assert.strictEqual(childToolAllowlist({ ...persona, tools: undefined }), undefined);
});

test("childEnv strips HERDR_* and adds the child identity vars", () => {
	const previousPane = process.env.HERDR_PANE_ID;
	const previousAgent = process.env.PI_SUBAGENT_AGENT;
	process.env.HERDR_PANE_ID = "wF:p1";

	try {
		const run = { id: "sa-scout-1" } as SubagentRun;
		const persona: AgentConfig = {
			name: "scout",
			description: "test",
			systemPrompt: "",
			source: "user",
			filePath: "(test)",
		};

		const env = childEnv(childIdentityEnv(run, persona));
		assert.strictEqual(env.HERDR_ENV, "0");
		assert.strictEqual(env.HERDR_PANE_ID, undefined);
		assert.strictEqual(env.PI_SUBAGENT_AGENT, "scout");
		assert.strictEqual(env.PI_SUBAGENT_ID, "sa-scout-1");
	} finally {
		if (previousPane === undefined) delete process.env.HERDR_PANE_ID;
		else process.env.HERDR_PANE_ID = previousPane;
		if (previousAgent === undefined) delete process.env.PI_SUBAGENT_AGENT;
		else process.env.PI_SUBAGENT_AGENT = previousAgent;
	}
});
