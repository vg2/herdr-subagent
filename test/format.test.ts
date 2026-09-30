import test from "node:test";
import assert from "node:assert";
import {
	firstLine,
	formatRunSummary,
	formatUsageTotals,
	statusIcon,
} from "../format.ts";
import type { RunView, UsageStats } from "../state.ts";

function usage(partial: Partial<UsageStats> = {}): UsageStats {
	return { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, contextTokens: 0, turns: 0, ...partial };
}

function view(overrides: Partial<RunView>): RunView {
	return {
		id: "sa-scout-1",
		agent: "scout",
		agentSource: "user",
		task: "Recon the auth module",
		cwd: "/tmp",
		status: "done",
		startedAt: Date.now() - 5000,
		endedAt: Date.now(),
		usage: usage(),
		reportPath: "/tmp/pi-subagent/sa-scout-1/report.md",
		collected: false,
		mode: "pane",
		...overrides,
	} as RunView;
}

test("formatRunSummary renders a blocked child with its question and answer hint", () => {
	const summary = formatRunSummary(
		view({
			status: "blocked",
			paneId: "%3",
			blockedQuestion: "Allow the command `rm -rf build`?",
			report: "Allow the command `rm -rf build`?",
		}),
	);

	assert.ok(summary.includes("⏸"), summary);
	assert.ok(summary.includes("blocked"));
	assert.ok(summary.includes("blocked on: Allow the command"));
	assert.ok(summary.includes('subagent_message { id: "sa-scout-1"'));
	assert.ok(!summary.includes("report: /tmp"), "blocked runs must not be presented as having a final report");
});

test("formatRunSummary renders settled runs with the report path", () => {
	const summary = formatRunSummary(
		view({ status: "done", usage: usage({ turns: 3, input: 1200, output: 200, cost: 0.004 }) }),
	);
	assert.ok(summary.includes("✓"));
	assert.ok(summary.includes("3 turns"));
	assert.ok(summary.includes("report: /tmp/pi-subagent/sa-scout-1/report.md"));
});

test("formatUsageTotals sums children and counts settled runs", () => {
	const totals = formatUsageTotals([
		{ status: "done", usage: usage({ turns: 2, input: 1000, output: 100, cost: 0.001 }) },
		{ status: "running", usage: usage({ turns: 1, input: 500, output: 50, cacheRead: 200, cost: 0.002 }) },
		{ status: "blocked", usage: usage({ turns: 4, input: 100, output: 10, cost: 0 }) },
	]);

	assert.ok(totals.startsWith("Totals: 3 sub-agents (1 settled)"), totals);
	assert.ok(totals.includes("7 turns"), totals);
	assert.ok(totals.includes("↑1.6k"), totals);
	assert.ok(totals.includes("↓160"), totals);
	assert.ok(totals.includes("R200"), totals);
});

test("formatUsageTotals handles a single run with no usage", () => {
	assert.strictEqual(formatUsageTotals([]), "");
	const totals = formatUsageTotals([{ status: "running", usage: usage() }]);
	assert.strictEqual(totals, "Totals: 1 sub-agent");
});

test("firstLine collapses to the first non-empty line and truncates", () => {
	assert.strictEqual(firstLine("\n\n  hello world  \nsecond"), "hello world");
	assert.strictEqual(firstLine("a".repeat(50), 10), `${"a".repeat(9)}…`);
	assert.strictEqual(statusIcon("blocked"), "⏸");
});
