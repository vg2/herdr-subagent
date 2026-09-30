import test from "node:test";
import assert from "node:assert";
import * as path from "node:path";
import {
	resolveSpawnMode,
	resolveModel,
	buildDelegationPrompt,
	createRunDir,
	startPane,
} from "../spawner.ts";
import { isHerdrAvailable, getAgent } from "../herdr.ts";
import { emptyUsage, type SubagentRun } from "../state.ts";
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
