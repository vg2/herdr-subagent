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
	extractBlockedQuestion,
	reconcileRuns,
	settlePaneAgentStatus,
	STUCK_IDLE_GRACE_MS,
	STUCK_STOP_REASON,
} from "../collect.ts";
import { emptyUsage, type SubagentRun } from "../state.ts";
import { isHerdrAvailable, type HerdrAgent } from "../herdr.ts";

/**
 * Run `fn` with `getAgentDir()` pointed at a throwaway dir so tests that write
 * session JSONL never touch the real `~/.pi/agent`. Asserts the redirect up
 * front — before anything is written — so a renamed env var fails the test
 * instead of polluting the real agent dir.
 */
async function withTempAgentDir(fn: (agentDir: string) => Promise<void> | void): Promise<void> {
	const envKey = "PI_CODING_AGENT_DIR";
	const prev = process.env[envKey];
	const tmpAgentDir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-test-agentdir-"));
	process.env[envKey] = tmpAgentDir;
	try {
		assert.strictEqual(
			getAgentDir(),
			tmpAgentDir,
			`${envKey} must redirect getAgentDir() (env var renamed upstream?)`,
		);
		await fn(tmpAgentDir);
	} finally {
		if (prev === undefined) delete process.env[envKey];
		else process.env[envKey] = prev;
		fs.rmSync(tmpAgentDir, { recursive: true, force: true });
	}
}

test("findSessionFile locates session by cwd and sessionId", async () => {
	await withTempAgentDir((agentDir) => {
		const cwd = process.cwd();
		const baseDir = path.join(agentDir, "sessions");
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

test("harvestReport and collectRuns do not poison reportPath while run is running", async () => {
	const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-test-collect-running-"));
	const reportPath = path.join(tmpDir, "report.md");

	const run: SubagentRun = {
		id: "sa-test-running",
		agent: "scout",
		agentSource: "user",
		task: "Long running task",
		cwd: process.cwd(),
		status: "running",
		startedAt: Date.now(),
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
		// 1. Direct harvestReport call on running run does not create report.md
		await harvestReport(run);
		assert.strictEqual(run.report, "");
		assert.strictEqual(fs.existsSync(reportPath), false);

		// 2. collectRuns with timeout does not mark collected or create report.md
		// Create a headless pending promise that does not settle in 100ms
		const pendingPromises = new Map<string, Promise<void>>();
		const neverResolving = new Promise<void>(() => {});
		pendingPromises.set(run.id, neverResolving);

		const results = await collectRuns({ runs: [run], timeoutMs: 100, pendingPromises });
		assert.strictEqual(results[0].status, "running");
		assert.strictEqual(results[0].collected, false);
		assert.strictEqual(fs.existsSync(reportPath), false);

		// 3. Now simulate run completing and writing session JSONL
		run.status = "done";
		run.sessionId = "subsequent-complete-uuid";

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
					content: [{ type: "text", text: "Genuine completed report from assistant" }],
					usage: { input: 100, output: 50, cost: { total: 0.001 }, totalTokens: 150 },
				},
			}),
		];
		fs.writeFileSync(sessionFile, sessionLines.join("\n"), "utf-8");

		try {
			await harvestReport(run);
			assert.strictEqual(run.report, "Genuine completed report from assistant");
			// Genuine report was saved to reportPath
			assert.strictEqual(fs.existsSync(reportPath), true);
			assert.strictEqual(fs.readFileSync(reportPath, "utf-8"), "Genuine completed report from assistant");
		} finally {
			if (fs.existsSync(sessionFile)) fs.unlinkSync(sessionFile);
		}
	} finally {
		fs.rmSync(tmpDir, { recursive: true, force: true });
	}
});

test("harvestReport keeps blocked-run text display-only so a later harvest reads the final report", async () => {
	const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-test-collect-blocked-"));
	const reportPath = path.join(tmpDir, "report.md");

	const run: SubagentRun = {
		id: "sa-test-blocked",
		agent: "reviewer",
		agentSource: "user",
		task: "Blocked task",
		cwd: process.cwd(),
		status: "blocked",
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

	const sessionId = "blocked-harvest-uuid";
	run.sessionId = sessionId;
	const baseDir = path.join(getAgentDir(), "sessions");
	const slug = "--" + path.resolve(run.cwd).replace(/^[/\\]+/, "").replace(/[/\\:]/g, "-") + "--";
	const groupDir = path.join(baseDir, slug);
	fs.mkdirSync(groupDir, { recursive: true });
	const sessionFile = path.join(groupDir, `2026-09-29T00-00-00-000Z_${sessionId}.jsonl`);

	const assistantLine = (text: string) =>
		JSON.stringify({
			type: "message",
			message: {
				role: "assistant",
				content: [{ type: "text", text }],
				usage: { input: 10, output: 5, cost: { total: 0.0001 }, totalTokens: 15 },
			},
		});

	fs.writeFileSync(
		sessionFile,
		[
			JSON.stringify({ type: "session", version: 3, id: sessionId, cwd: run.cwd }),
			assistantLine("Intermediate text while blocked"),
		].join("\n"),
		"utf-8",
	);

	try {
		await harvestReport(run);
		assert.strictEqual(run.report, "Intermediate text while blocked");
		assert.strictEqual(run.blockedQuestion, "Intermediate text while blocked");
		assert.strictEqual(run.usage.turns, 1);
		assert.strictEqual(fs.existsSync(reportPath), false, "blocked-run text must not be persisted to reportPath");

		// Child is unblocked and finishes: the final assistant message lands in the session
		fs.appendFileSync(sessionFile, `\n${assistantLine("Final report after unblock")}\n`, "utf-8");
		run.status = "done";

		await harvestReport(run);
		assert.strictEqual(run.report, "Final report after unblock");
		assert.strictEqual(run.blockedQuestion, undefined, "a finished run must clear the blocked question");
		assert.strictEqual(run.usage.turns, 2, "usage is re-read from the session after a resumed run finishes");
		assert.strictEqual(run.usage.input, 20);
		assert.strictEqual(fs.readFileSync(reportPath, "utf-8"), "Final report after unblock");
	} finally {
		if (fs.existsSync(sessionFile)) fs.unlinkSync(sessionFile);
		fs.rmSync(tmpDir, { recursive: true, force: true });
	}
});

test("harvestReport marks aborted runs as notified", async () => {
	const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-test-collect-aborted-"));

	const run: SubagentRun = {
		id: "sa-test-aborted",
		agent: "worker",
		agentSource: "user",
		task: "Aborted task",
		cwd: process.cwd(),
		status: "aborted",
		startedAt: Date.now() - 1000,
		messages: [],
		usage: emptyUsage(),
		stderr: "",
		dir: tmpDir,
		reportPath: path.join(tmpDir, "report.md"),
		collected: false,
		report: "",
		mode: "headless",
		abort: () => {},
	};

	try {
		await harvestReport(run);
		if (isHerdrAvailable()) {
			assert.strictEqual(run.notified, true);
		}
	} finally {
		fs.rmSync(tmpDir, { recursive: true, force: true });
	}
});

// ---------------------------------------------------------------------------
// extractBlockedQuestion + reconciliation (phase 4)
// ---------------------------------------------------------------------------

function makeRun(overrides: Partial<SubagentRun> & { id: string }): SubagentRun {
	return {
		agent: "scout",
		agentSource: "user",
		task: "task",
		cwd: process.cwd(),
		status: "running",
		startedAt: Date.now(),
		messages: [],
		usage: emptyUsage(),
		stderr: "",
		dir: "/tmp/pi-subagent/test",
		reportPath: path.join(os.tmpdir(), "pi-subagent", overrides.id, "report.md"),
		collected: false,
		report: "",
		mode: "pane",
		abort: () => {},
		paneId: "%1",
		agentName: overrides.id,
		...overrides,
	};
}

test("extractBlockedQuestion collapses whitespace, ignores placeholders, and caps length", () => {
	assert.strictEqual(extractBlockedQuestion(undefined), undefined);
	assert.strictEqual(extractBlockedQuestion("   \n\n "), undefined);
	assert.strictEqual(extractBlockedQuestion("(no output)"), undefined);
	assert.strictEqual(extractBlockedQuestion("  line one  \n\n line two "), "line one\nline two");
	const capped = extractBlockedQuestion("x".repeat(1000), 10);
	assert.strictEqual(capped?.length, 10);
	assert.ok(capped?.endsWith("…"));
});

test("reconcileRuns re-adopts a live blocked pane child with its pending question", async () => {
	const run = makeRun({ id: "sa-test-reconcile-blocked", status: "running", paneId: "%7" });
	try {
		const live: HerdrAgent[] = [
			{
				agent: run.id,
				name: run.id,
				agent_status: "blocked",
				pane_id: "%8",
				tab_id: "tab-1",
				workspace_id: "ws-1",
			},
		];
		const changed: SubagentRun[] = [];
		const summary = await reconcileRuns({
			runs: [run],
			liveAgents: live,
			paneAlive: async () => true,
			onChange: (r) => changed.push(r),
		});

		assert.deepStrictEqual(summary.adopted, [run.id]);
		assert.deepStrictEqual(summary.settled, []);
		assert.strictEqual(run.status, "blocked");
		assert.strictEqual(run.paneClosed, false);
		assert.strictEqual(run.paneId, "%8", "live agent pane wins over the persisted pane id");
		assert.strictEqual(typeof run.abort, "function");
		assert.deepStrictEqual(changed.map((r) => r.id), [run.id]);
	} finally {
		/* nothing to clean up: no herdr calls were made (test seams supplied) */
	}
});

test("reconcileRuns settles runs with no live agent and reports pane closure", async () => {
	const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-test-reconcile-dead-"));
	const reportPath = path.join(tmpDir, "report.md");
	fs.writeFileSync(reportPath, "persisted report");
	const run = makeRun({
		id: "sa-test-reconcile-dead",
		status: "running",
		paneId: "%9",
		dir: tmpDir,
		reportPath,
	});

	try {
		const probed: string[] = [];
		const changed: SubagentRun[] = [];
		const summary = await reconcileRuns({
			runs: [run],
			liveAgents: [],
			paneAlive: async (paneId) => {
				probed.push(paneId);
				return false;
			},
			onChange: (r) => changed.push(r),
		});

		assert.deepStrictEqual(summary.settled, [run.id]);
		assert.strictEqual(run.status, "done");
		assert.strictEqual(run.paneClosed, true);
		assert.strictEqual(run.report, "persisted report");
		assert.deepStrictEqual(probed, ["%9"]);
		assert.deepStrictEqual(changed.map((r) => r.id), [run.id]);
	} finally {
		fs.rmSync(tmpDir, { recursive: true, force: true });
	}
});

test("reconcileRuns fails a stale running headless child and leaves settled runs alone", async () => {
	const running = makeRun({ id: "sa-test-headless-stale", status: "running", mode: "headless" });
	running.agentName = undefined;
	running.paneId = undefined;
	const settled = makeRun({ id: "sa-test-headless-done", status: "done", mode: "headless" });
	settled.agentName = undefined;
	settled.paneId = undefined;

	const changed: SubagentRun[] = [];
	const summary = await reconcileRuns({
		runs: [running, settled],
		liveAgents: [],
		paneAlive: async () => false,
		onChange: (r) => changed.push(r),
	});

	assert.deepStrictEqual(summary.settled, [running.id]);
	assert.strictEqual(running.status, "failed");
	assert.ok(running.abandoned, "a headless child that never wrote a final report is abandoned mid-flight");
	assert.ok(running.errorMessage?.includes("could not be adopted"));
	assert.ok(running.report.includes("could not be adopted"));
	assert.strictEqual(settled.status, "done", "already-settled runs keep their status");
	assert.deepStrictEqual(changed.map((r) => r.id), [running.id]);
});

test("reconcileRuns marks a headless child that wrote its final report as done, not failed", async () => {
	const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-test-reconcile-finished-"));
	const reportPath = path.join(tmpDir, "report.md");
	fs.writeFileSync(reportPath, "Final report written before the crash");
	const run = makeRun({ id: "sa-test-reconcile-finished", status: "running", mode: "headless", dir: tmpDir, reportPath });
	run.agentName = undefined;
	run.paneId = undefined;

	const summary = await reconcileRuns({ runs: [run], liveAgents: [], paneAlive: async () => false });

	assert.strictEqual(run.status, "done", "a child that wrote its final report finished cleanly");
	assert.strictEqual(run.abandoned, undefined);
	assert.strictEqual(run.report, "Final report written before the crash");
	assert.deepStrictEqual(summary.settled, [run.id]);
});

test("reconcileRuns re-adopts a live agent by pane id when the persisted name no longer matches", async () => {
	const run = makeRun({ id: "sa-test-reconcile-pane", status: "running", paneId: "%5", agentName: "sa-old-name" });
	const summary = await reconcileRuns({
		runs: [run],
		liveAgents: [
			{
				agent: "reassigned-agent",
				name: "sa-new-name",
				agent_status: "working",
				pane_id: "%5",
				tab_id: "tab-1",
				workspace_id: "ws-1",
			},
		],
		paneAlive: async () => true,
	});

	assert.deepStrictEqual(summary.adopted, [run.id]);
	assert.strictEqual(run.agentName, "sa-new-name", "tracking resumes under the live agent's current name");
	assert.strictEqual(run.paneId, "%5");
	assert.strictEqual(run.paneClosed, false);
	assert.strictEqual(run.status, "running");
	assert.strictEqual(typeof run.abort, "function");
});

test("reconcileRuns never persists mid-flight session text for an abandoned pane child", async () => {
	const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-test-reconcile-midflight-"));
	const reportPath = path.join(tmpDir, "report.md");
	const sessionId = "reconcile-midflight-uuid";
	const run = makeRun({
		id: "sa-test-reconcile-midflight",
		status: "blocked",
		paneId: "%6",
		agentName: "sa-test-reconcile-midflight",
		sessionId,
		dir: tmpDir,
		reportPath,
	});

	const baseDir = path.join(getAgentDir(), "sessions");
	const slug = "--" + path.resolve(run.cwd).replace(/^[\/\\]+/, "").replace(/[\\/:]/g, "-") + "--";
	const groupDir = path.join(baseDir, slug);
	fs.mkdirSync(groupDir, { recursive: true });
	const sessionFile = path.join(groupDir, `2026-09-30T00-00-00-000Z_${sessionId}.jsonl`);
	fs.writeFileSync(
		sessionFile,
		[
			JSON.stringify({ type: "session", version: 3, id: sessionId, cwd: run.cwd }),
			JSON.stringify({
				type: "message",
				message: {
					role: "assistant",
					content: [{ type: "text", text: "Approve this edit?" }],
					usage: { input: 10, output: 5, cost: { total: 0.0001 }, totalTokens: 15 },
				},
			}),
		].join("\n"),
		"utf-8",
	);

	try {
		// Pane is gone: the child died blocked mid-flight, its pending question must
		// stay display-only and never be persisted as its final report.
		const deadPane = await reconcileRuns({ runs: [run], liveAgents: [], paneAlive: async () => false });

		assert.strictEqual(run.status, "failed");
		assert.ok(run.abandoned);
		assert.ok(run.errorMessage?.includes("mid-flight"), run.errorMessage);
		assert.ok(run.report.includes("Approve this edit?"), "the question remains visible as display text");
		assert.strictEqual(fs.existsSync(reportPath), false, "mid-flight text must not be persisted to reportPath");
		assert.deepStrictEqual(deadPane.settled, [run.id]);
		assert.deepStrictEqual(deadPane.orphaned, []);

		// Pane still alive but no agent owns it: surfaced as orphaned, not silently done.
		const run2 = makeRun({
			id: "sa-test-reconcile-orphan",
			status: "blocked",
			paneId: "%7",
			agentName: "sa-test-reconcile-orphan",
			sessionId,
			dir: tmpDir,
			reportPath: path.join(tmpDir, "report-orphan.md"),
		});
		const livePane = await reconcileRuns({ runs: [run2], liveAgents: [], paneAlive: async () => true });

		assert.strictEqual(run2.status, "failed");
		assert.ok(run2.abandoned);
		assert.ok(run2.errorMessage?.includes("alive but no live Herdr agent"), run2.errorMessage);
		assert.strictEqual(run2.paneClosed, false);
		assert.strictEqual(fs.existsSync(run2.reportPath), false);
		assert.deepStrictEqual(livePane.orphaned, [run2.id]);
	} finally {
		if (fs.existsSync(sessionFile)) fs.unlinkSync(sessionFile);
		fs.rmSync(tmpDir, { recursive: true, force: true });
	}
});

test("reconcileRuns adopts a live working agent and resumes tracking", async () => {
	const run = makeRun({ id: "sa-test-reconcile-live", status: "blocked", blockedQuestion: "old question" });
	const summary = await reconcileRuns({
		runs: [run],
		liveAgents: [
			{
				agent: run.id,
				name: run.id,
				agent_status: "working",
				pane_id: "%2",
				tab_id: "tab-1",
				workspace_id: "ws-1",
			},
		],
		paneAlive: async () => true,
	});

	assert.deepStrictEqual(summary.adopted, [run.id]);
	assert.strictEqual(run.status, "running");
	assert.strictEqual(run.endedAt, undefined);
});

// ---------------------------------------------------------------------------
// Pane completion evidence + slice-loop waiting (issue #1)
// ---------------------------------------------------------------------------

function paneAgentOf(run: SubagentRun, status: string): HerdrAgent {
	return {
		agent: run.agentName!,
		name: run.agentName,
		agent_status: status,
		pane_id: run.paneId ?? "%1",
		tab_id: "tab-1",
		workspace_id: "ws-1",
	};
}

test("collectRuns fails an evidence-free idle pane child after the stuck-idle grace", async () => {
	const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-test-collect-stuck-"));
	const run = makeRun({
		id: "sa-collect-stuck",
		status: "running",
		dir: tmpDir,
		reportPath: path.join(tmpDir, "report.md"),
		sessionId: "collect-stuck-no-session-uuid",
	});
	const idle = paneAgentOf(run, "idle");

	try {
		const results = await collectRuns({
			runs: [run],
			timeoutMs: 300000,
			paneWait: async () => idle,
			paneGet: async () => idle,
			now: () => run.startedAt + STUCK_IDLE_GRACE_MS + 1000,
			sleep: async () => {},
		});

		assert.strictEqual(results[0], run);
		assert.strictEqual(run.status, "failed", "an evidence-free idle child must not settle as done");
		assert.strictEqual(run.stopReason, STUCK_STOP_REASON);
		assert.strictEqual(
			fs.existsSync(run.reportPath),
			false,
			"no report may be persisted for a child that never processed its task",
		);
		assert.strictEqual(run.collected, true);
	} finally {
		fs.rmSync(tmpDir, { recursive: true, force: true });
	}
});

test("collectRuns settles an idle pane child that was observed working", async () => {
	const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-test-collect-sawworking-"));
	const run = makeRun({
		id: "sa-collect-sawworking",
		status: "running",
		sawWorking: true,
		dir: tmpDir,
		reportPath: path.join(tmpDir, "report.md"),
		sessionId: "collect-sawworking-no-session-uuid",
	});
	const idle = paneAgentOf(run, "idle");

	try {
		await collectRuns({
			runs: [run],
			timeoutMs: 300000,
			paneWait: async () => idle,
			paneGet: async () => idle,
			now: () => run.startedAt,
			sleep: async () => {},
		});

		assert.strictEqual(run.status, "done");
		assert.strictEqual(run.collected, true);
		assert.strictEqual(run.endedAt !== undefined, true);
	} finally {
		fs.rmSync(tmpDir, { recursive: true, force: true });
	}
});

test("collectRuns settles an idle pane child that wrote its report to disk", async () => {
	const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-test-collect-diskreport-"));
	const reportPath = path.join(tmpDir, "report.md");
	fs.writeFileSync(reportPath, "Final report from disk", "utf-8");
	const run = makeRun({
		id: "sa-collect-diskreport",
		status: "running",
		dir: tmpDir,
		reportPath,
		sessionId: "collect-diskreport-no-session-uuid",
	});
	const idle = paneAgentOf(run, "idle");

	try {
		await collectRuns({
			runs: [run],
			timeoutMs: 300000,
			paneWait: async () => idle,
			paneGet: async () => idle,
			now: () => run.startedAt,
			sleep: async () => {},
		});

		assert.strictEqual(run.status, "done");
		assert.strictEqual(run.report, "Final report from disk");
		assert.strictEqual(run.collected, true);
	} finally {
		fs.rmSync(tmpDir, { recursive: true, force: true });
	}
});

test("collectRuns fails a gone pane child without evidence and finishes one with a disk report", async () => {
	const parent = fs.mkdtempSync(path.join(os.tmpdir(), "pi-test-collect-gone-"));

	const stuck = makeRun({
		id: "sa-collect-gone-stuck",
		status: "running",
		dir: parent,
		reportPath: path.join(parent, "stuck-report.md"),
		sessionId: "collect-gone-stuck-no-session-uuid",
	});
	const reportPath = path.join(parent, "finished-report.md");
	fs.writeFileSync(reportPath, "Finished before the wait noticed", "utf-8");
	const finished = makeRun({
		id: "sa-collect-gone-finished",
		status: "running",
		dir: parent,
		reportPath,
		sessionId: "collect-gone-finished-no-session-uuid",
	});

	const waitThrows = async (): Promise<HerdrAgent | null> => {
		throw new Error("slice timeout");
	};

	try {
		await collectRuns({
			runs: [stuck, finished],
			timeoutMs: 300000,
			paneWait: waitThrows,
			paneGet: async () => null,
			now: () => stuck.startedAt,
			sleep: async () => {},
		});

		assert.strictEqual(stuck.status, "failed");
		assert.strictEqual(stuck.stopReason, "pane child exited without processing the task");
		assert.strictEqual(fs.existsSync(stuck.reportPath), false);

		assert.strictEqual(finished.status, "done");
		assert.strictEqual(finished.report, "Finished before the wait noticed");
	} finally {
		fs.rmSync(parent, { recursive: true, force: true });
	}
});

test("collectRuns keeps waiting on a working pane child until the caller's timeout", async () => {
	const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-test-collect-working-"));
	const run = makeRun({
		id: "sa-collect-working",
		status: "running",
		dir: tmpDir,
		reportPath: path.join(tmpDir, "report.md"),
		sessionId: "collect-working-no-session-uuid",
	});
	const working = paneAgentOf(run, "working");

	let clock = 0;
	try {
		await collectRuns({
			runs: [run],
			timeoutMs: 5000,
			paneWait: async (): Promise<HerdrAgent | null> => {
				throw new Error("slice timeout: still working");
			},
			paneGet: async () => working,
			now: () => (clock += 6000),
			sleep: async () => {},
		});

		assert.strictEqual(run.status, "running", "a working child outliving the budget stays running");
		assert.strictEqual(run.collected, false);
		assert.strictEqual(run.sawWorking, true, "the working observation is recorded as evidence");
		assert.strictEqual(fs.existsSync(run.reportPath), false);
	} finally {
		fs.rmSync(tmpDir, { recursive: true, force: true });
	}
});

test("collectRuns surfaces a blocked pane child's pending question", async () => {
	const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-test-collect-blocked2-"));
	const reportPath = path.join(tmpDir, "report.md");
	const sessionId = "collect-blocked-uuid";
	const run = makeRun({
		id: "sa-collect-blocked",
		status: "running",
		dir: tmpDir,
		reportPath,
		sessionId,
	});
	const blocked = paneAgentOf(run, "blocked");

	// A blocked child has turn evidence (it asked a question), so it settles.
	// Hermetic: getAgentDir() points at a throwaway dir while the session JSONL
	// is written and read, so nothing touches the real `~/.pi/agent`.
	try {
		await withTempAgentDir(async (agentDir) => {
			const baseDir = path.join(agentDir, "sessions");
			const slug = "--" + path.resolve(run.cwd).replace(/^[/\\]+/, "").replace(/[/\\:]/g, "-") + "--";
			const groupDir = path.join(baseDir, slug);
			fs.mkdirSync(groupDir, { recursive: true });
			const sessionFile = path.join(groupDir, `2026-09-30T00-00-00-000Z_${sessionId}.jsonl`);
			fs.writeFileSync(
				sessionFile,
				[
					JSON.stringify({ type: "session", version: 3, id: sessionId, cwd: run.cwd }),
					JSON.stringify({
						type: "message",
						message: {
							role: "assistant",
							content: [{ type: "text", text: "Should I delete the stale build directory?" }],
							usage: { input: 10, output: 5, cost: { total: 0.0001 }, totalTokens: 15 },
						},
					}),
				].join("\n"),
				"utf-8",
			);

			await collectRuns({
				runs: [run],
				timeoutMs: 300000,
				paneWait: async () => blocked,
				paneGet: async () => blocked,
				now: () => run.startedAt,
				sleep: async () => {},
			});

			assert.strictEqual(run.status, "blocked");
			assert.strictEqual(run.usage.turns, 1);
			assert.ok(run.blockedQuestion?.includes("stale build directory"));
			assert.strictEqual(
				fs.existsSync(reportPath),
				false,
				"a blocked child's pending prompt must stay display-only",
			);
			assert.strictEqual(run.collected, true);
		});
	} finally {
		fs.rmSync(tmpDir, { recursive: true, force: true });
	}
});

test("reconcileRuns settles an adopted idle child only with first-turn evidence", async () => {
	const finished = makeRun({
		id: "sa-reconcile-idle-done",
		status: "running",
		usage: { ...emptyUsage(), turns: 3 },
	});
	const stuck = makeRun({ id: "sa-reconcile-idle-stuck", status: "running" });

	const changed: string[] = [];
	const summary = await reconcileRuns({
		runs: [finished, stuck],
		liveAgents: [paneAgentOf(finished, "idle"), paneAgentOf(stuck, "idle")],
		paneAlive: async () => true,
		onChange: (r) => changed.push(r.id),
	});

	assert.deepStrictEqual(summary.adopted, [finished.id, stuck.id]);
	assert.strictEqual(finished.status, "done", "an adopted idle child with recorded turns finished");
	assert.strictEqual(
		stuck.status,
		"running",
		"an adopted idle child with no turn evidence stays running (stuck-idle grace applies)",
	);
	assert.deepStrictEqual(changed, [finished.id]);
});

test("settlePaneAgentStatus never re-stamps a finished run's endedAt", () => {
	// Confirmed-gone arm (issue #1 review C2): an already-finished run keeps its
	// original completion time instead of re-stamping it on every observation.
	const gone = makeRun({
		id: "sa-settle-gone",
		status: "done",
		endedAt: 111,
		sawWorking: true,
	});
	settlePaneAgentStatus(gone, null);
	assert.strictEqual(gone.status, "done");
	assert.strictEqual(gone.endedAt, 111);

	// Idle/done arm with evidence: same no-re-stamp rule.
	const idle = makeRun({
		id: "sa-settle-idle",
		status: "done",
		endedAt: 222,
		sawWorking: true,
	});
	settlePaneAgentStatus(idle, paneAgentOf(idle, "idle"));
	assert.strictEqual(idle.status, "done");
	assert.strictEqual(idle.endedAt, 222);

	// Working arm still clears endedAt (a blocked child resumed working).
	const resumed = makeRun({
		id: "sa-settle-resumed",
		status: "blocked",
		endedAt: 333,
		sawWorking: true,
	});
	settlePaneAgentStatus(resumed, paneAgentOf(resumed, "working"));
	assert.strictEqual(resumed.status, "running");
	assert.strictEqual(resumed.endedAt, undefined);
});
