import test from "node:test";
import assert from "node:assert";
import { RunRegistry, reconstructRuns, sumUsage, type RunView, type UsageStats } from "../state.ts";

function usage(partial: Partial<UsageStats> = {}): UsageStats {
	return { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, contextTokens: 0, turns: 0, ...partial };
}

function view(overrides: Partial<RunView> & { id: string; startedAt: number }): RunView {
	return {
		agent: "scout",
		agentSource: "user",
		task: "task",
		cwd: "/tmp",
		status: "running",
		usage: usage(),
		reportPath: "/tmp/pi-subagent/sa-x/report.md",
		collected: false,
		mode: "headless",
		...overrides,
	} as RunView;
}

function entry(data: unknown, customType = "herdr-subagent-run") {
	return { type: "custom", customType, data };
}

test("reconstructRuns merges snapshots per run, newest status and final report win", () => {
	const runs = reconstructRuns([
		entry(view({ id: "sa-scout-1", startedAt: 100, status: "running" })),
		entry(
			view({
				id: "sa-scout-1",
				startedAt: 100,
				status: "blocked",
				blockedQuestion: "May I delete this file?",
				report: "May I delete this file?",
				usage: usage({ turns: 2, input: 100 }),
			}),
		),
		entry(
			view({
				id: "sa-scout-1",
				startedAt: 100,
				status: "done",
				endedAt: 200,
				report: "Final report.",
				usage: usage({ turns: 5, input: 400, output: 50, cost: 0.01 }),
			}),
		),
	]);

	assert.strictEqual(runs.length, 1);
	const run = runs[0];
	assert.strictEqual(run.status, "done");
	assert.strictEqual(run.report, "Final report.");
	assert.strictEqual(run.blockedQuestion, undefined, "a settled run must not keep a blocked question");
	assert.strictEqual(run.usage.turns, 5);
	assert.strictEqual(run.usage.input, 400);
	assert.strictEqual(run.collected, false, "the settle snapshot had not been collected yet");
});

test("reconstructRuns keeps an earlier report when a later snapshot has none", () => {
	const runs = reconstructRuns([
		entry(view({ id: "sa-x-1", startedAt: 1, status: "blocked", report: "pending question", blockedQuestion: "pending question" })),
		// Steering snapshot: status running again, no report field.
		entry(view({ id: "sa-x-1", startedAt: 1, status: "running", usage: usage({ turns: 1 }) })),
	]);

	assert.strictEqual(runs.length, 1);
	assert.strictEqual(runs[0].status, "running");
	assert.strictEqual(runs[0].report, "pending question");
	assert.strictEqual(runs[0].blockedQuestion, undefined);
	assert.strictEqual(runs[0].endedAt, undefined);
});

test("reconstructRuns never moves cumulative usage backwards", () => {
	const runs = reconstructRuns([
		entry(view({ id: "sa-x-2", startedAt: 1, status: "running", usage: usage({ turns: 5, input: 500 }) })),
		entry(view({ id: "sa-x-2", startedAt: 1, status: "running", usage: usage({ turns: 2, input: 100 }) })),
	]);
	assert.strictEqual(runs[0].usage.turns, 5);
	assert.strictEqual(runs[0].usage.input, 500);
});

test("reconstructRuns preserves worktree ownership fields and sorts by start time", () => {
	const owned = { workspaceId: "%9", paneIds: ["%9"] };
	const runs = reconstructRuns([
		entry(
			view({
				id: "sa-b-2",
				startedAt: 200,
				mode: "pane",
				paneId: "%2",
				agentName: "sa-b-2",
				worktreePath: "/repo-wt/sa-b-2",
				worktreeRepoRoot: "/repo",
				worktreeMode: "herdr",
				workspaceId: "%8",
				ownedSourceWorkspace: owned,
			}),
		),
		entry(view({ id: "sa-a-1", startedAt: 100 })),
	]);

	assert.deepStrictEqual(
		runs.map((r) => r.id),
		["sa-a-1", "sa-b-2"],
	);
	assert.strictEqual(runs[1].ownedSourceWorkspace?.workspaceId, "%9");
	assert.strictEqual(runs[1].worktreePath, "/repo-wt/sa-b-2");
	assert.strictEqual(runs[1].dir, "/tmp/pi-subagent/sa-x");
});

test("reconstructRuns ignores malformed and unrelated entries", () => {
	assert.deepStrictEqual(reconstructRuns([]), []);
	assert.deepStrictEqual(reconstructRuns([{ type: "custom", customType: "other", data: { id: "x" } }]), []);
	assert.deepStrictEqual(
		reconstructRuns([entry({ id: 42 }), entry(null), entry({ id: "ok", agent: "scout" })]),
		[],
		"entries missing required fields are skipped",
	);
});

test("sumUsage totals turns/tokens/cost and takes the max context size", () => {
	const total = sumUsage([
		{ usage: usage({ turns: 2, input: 100, output: 10, cacheRead: 5, cacheWrite: 1, cost: 0.01, contextTokens: 1000 }) },
		{ usage: usage({ turns: 3, input: 200, output: 20, cacheRead: 0, cacheWrite: 2, cost: 0.02, contextTokens: 4000 }) },
	]);
	assert.strictEqual(total.turns, 5);
	assert.strictEqual(total.input, 300);
	assert.strictEqual(total.output, 30);
	assert.strictEqual(total.cacheRead, 5);
	assert.strictEqual(total.cacheWrite, 3);
	assert.strictEqual(Math.round(total.cost * 100), 3);
	assert.strictEqual(total.contextTokens, 4000);
});

test("RunRegistry.restore replaces state and keeps new ids from colliding", () => {
	const registry = new RunRegistry();
	const restored = [
		{
			id: "sa-scout-7",
			agent: "scout",
			agentSource: "user" as const,
			task: "t",
			cwd: "/tmp",
			status: "done" as const,
			startedAt: 1,
			messages: [],
			usage: usage(),
			stderr: "",
			dir: "/tmp",
			reportPath: "/tmp/report.md",
			collected: true,
			report: "r",
			abort: () => {},
			mode: "headless" as const,
		},
	];

	registry.restore(restored);
	assert.strictEqual(registry.list().length, 1);
	assert.strictEqual(registry.get("sa-scout-7")?.agent, "scout");

	const next = registry.nextId("scout");
	assert.ok(!registry.get(next), "generated id must not collide with a restored run");
});
