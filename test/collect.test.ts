import test from "node:test";
import assert from "node:assert";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import { getAgentDir } from "@earendil-works/pi-coding-agent";
import {
	findSessionFile,
	parseSessionJsonl,
	harvestReport,
	collectRuns,
} from "../collect.ts";
import { emptyUsage, type SubagentRun } from "../state.ts";

test("findSessionFile locates session by cwd and sessionId", () => {
	const cwd = process.cwd();
	const baseDir = path.join(getAgentDir(), "sessions");
	const slug = "--" + path.resolve(cwd).replace(/^[/\\]+/, "").replace(/[/\\:]/g, "-") + "--";
	const groupDir = path.join(baseDir, slug);
	fs.mkdirSync(groupDir, { recursive: true });

	const testId = "test-session-uuid-12345";
	const testFile = path.join(groupDir, `2026-09-29T00-00-00-000Z_${testId}.jsonl`);
	const header = JSON.stringify({ type: "session", version: 3, id: testId, cwd }) + "\n";
	fs.writeFileSync(testFile, header, "utf-8");

	try {
		const found = findSessionFile(cwd, testId);
		assert.strictEqual(found, testFile);

		const notFound = findSessionFile(cwd, "non-existent-session-id");
		assert.strictEqual(notFound, null);
	} finally {
		if (fs.existsSync(testFile)) fs.unlinkSync(testFile);
	}
});

test("parseSessionJsonl correctly extracts assistant message and usage", () => {
	const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-test-collect-"));
	const testFile = path.join(tmpDir, "session.jsonl");

	const lines = [
		JSON.stringify({ type: "session", version: 3, id: "uuid-1", cwd: "/tmp" }),
		JSON.stringify({
			type: "message",
			id: "msg-1",
			message: { role: "user", content: [{ type: "text", text: "Hello" }] },
		}),
		JSON.stringify({
			type: "message",
			id: "msg-2",
			message: {
				role: "assistant",
				content: [{ type: "text", text: "First response." }],
				model: "opencode-go/glm-5.3-flash",
				usage: { input: 100, output: 20, cacheRead: 10, cacheWrite: 5, cost: { total: 0.001 }, totalTokens: 120 },
			},
		}),
		JSON.stringify({
			type: "message",
			id: "msg-3",
			message: {
				role: "assistant",
				content: [{ type: "text", text: "Final report from subagent." }],
				model: "opencode-go/glm-5.3-flash",
				usage: { input: 150, output: 50, cacheRead: 0, cacheWrite: 0, cost: { total: 0.002 }, totalTokens: 200 },
			},
		}),
	];
	fs.writeFileSync(testFile, lines.join("\n"), "utf-8");

	try {
		const parsed = parseSessionJsonl(testFile);
		assert.ok(parsed);
		assert.strictEqual(parsed.lastAssistantText, "Final report from subagent.");
		assert.strictEqual(parsed.model, "opencode-go/glm-5.3-flash");
		assert.strictEqual(parsed.usage.turns, 2);
		assert.strictEqual(parsed.usage.input, 250);
		assert.strictEqual(parsed.usage.output, 70);
		assert.strictEqual(parsed.usage.cacheRead, 10);
		assert.strictEqual(parsed.usage.cacheWrite, 5);
		assert.strictEqual(Math.round(parsed.usage.cost * 1000) / 1000, 0.003);
	} finally {
		fs.rmSync(tmpDir, { recursive: true, force: true });
	}
});

test("harvestReport prioritizes report.md, then session JSONL", async () => {
	const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-test-harvest-"));
	const reportPath = path.join(tmpDir, "report.md");
	fs.writeFileSync(reportPath, "Content from report.md", "utf-8");

	const run: SubagentRun = {
		id: "sa-test-1",
		agent: "scout",
		agentSource: "user",
		task: "Test task",
		cwd: process.cwd(),
		status: "done",
		startedAt: Date.now() - 1000,
		messages: [],
		usage: emptyUsage(),
		stderr: "",
		dir: tmpDir,
		reportPath,
		collected: false,
		report: "",
		mode: "pane",
		abort: () => {},
	};

	try {
		await harvestReport(run);
		assert.strictEqual(run.report, "Content from report.md");

		// Case 2: report.md deleted, but session JSONL exists
		fs.unlinkSync(reportPath);
		run.report = "";
		run.sessionId = "harvest-session-uuid";

		const baseDir = path.join(getAgentDir(), "sessions");
		const slug = "--" + path.resolve(run.cwd).replace(/^[/\\]+/, "").replace(/[/\\:]/g, "-") + "--";
		const groupDir = path.join(baseDir, slug);
		fs.mkdirSync(groupDir, { recursive: true });

		const sessionFile = path.join(groupDir, `2026-09-29T00-00-00-000Z_${run.sessionId}.jsonl`);
		const sessionLines = [
			JSON.stringify({ type: "session", version: 3, id: run.sessionId, cwd: run.cwd }),
			JSON.stringify({
				type: "message",
				message: {
					role: "assistant",
					content: [{ type: "text", text: "Content from session JSONL" }],
					usage: { input: 500, output: 100, cost: { total: 0.005 }, totalTokens: 600 },
				},
			}),
		];
		fs.writeFileSync(sessionFile, sessionLines.join("\n"), "utf-8");

		try {
			await harvestReport(run);
			assert.strictEqual(run.report, "Content from session JSONL");
			assert.strictEqual(run.usage.turns, 1);
			assert.strictEqual(run.usage.input, 500);
			assert.strictEqual(run.usage.output, 100);
		} finally {
			if (fs.existsSync(sessionFile)) fs.unlinkSync(sessionFile);
		}
	} finally {
		fs.rmSync(tmpDir, { recursive: true, force: true });
	}
});

test("collectRuns harvests already settled runs immediately", async () => {
	const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-test-collect-runs-"));
	const reportPath = path.join(tmpDir, "report.md");
	fs.writeFileSync(reportPath, "Settled run report", "utf-8");

	const run: SubagentRun = {
		id: "sa-test-settled",
		agent: "worker",
		agentSource: "user",
		task: "Settled task",
		cwd: process.cwd(),
		status: "done",
		startedAt: Date.now() - 5000,
		messages: [],
		usage: emptyUsage(),
		stderr: "",
		dir: tmpDir,
		reportPath,
		collected: false,
		report: "",
		mode: "headless",
		abort: () => {},
	};

	try {
		const results = await collectRuns({ runs: [run], timeoutMs: 1000 });
		assert.strictEqual(results.length, 1);
		assert.strictEqual(results[0].report, "Settled run report");
		assert.strictEqual(results[0].collected, true);
	} finally {
		fs.rmSync(tmpDir, { recursive: true, force: true });
	}
});
