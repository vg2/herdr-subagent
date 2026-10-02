/**
 * Subagent collection and report harvesting.
 *
 * Implements Plan 3.3, 3.9 & 4 Phase 2:
 *   - Wait for `idle/done/blocked` lifecycle states
 *   - Primary result channel: `report.md` written to scratch directory
 *   - Fallback result channel: child session JSONL
 *   - Secondary fallback: `herdr agent read`
 *   - Harvests token usage, cost, turns, and model from session JSONL
 *   - Notifications on completion
 */

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { getAgentDir } from "@earendil-works/pi-coding-agent";
import {
	closePane,
	getAgent,
	isHerdrAvailable,
	isPaneAlive,
	listAgents,
	readAgent,
	sendKeys,
	showNotification,
	waitAgent,
	type HerdrAgent,
} from "./herdr.ts";
import {
	isSettled,
	type SubagentRun,
	type UsageStats,
	wrapUntrustedReport,
} from "./state.ts";
import { firstLine } from "./format.ts";

/**
 * Locate a pi session file by cwd and sessionId.
 */
export function findSessionFile(cwd: string, sessionId?: string): string | null {
	if (!sessionId) return null;

	const baseDir = path.join(getAgentDir(), "sessions");
	const resolvedCwd = path.resolve(cwd);
	const slug = "--" + resolvedCwd.replace(/^[/\\]+/, "").replace(/[/\\:]/g, "-") + "--";
	const groupDir = path.join(baseDir, slug);

	const searchDir = (dir: string): string | null => {
		if (!fs.existsSync(dir)) return null;
		try {
			const files = fs.readdirSync(dir).filter((f) => f.endsWith(".jsonl"));
			// First try exact filename match suffix
			const suffix = `_${sessionId}.jsonl`;
			const matched = files.find((f) => f.endsWith(suffix));
			if (matched) return path.join(dir, matched);

			// Fallback: inspect line 1 header
			for (const file of files) {
				const full = path.join(dir, file);
				try {
					const firstLine = fs.readFileSync(full, "utf-8").split("\n")[0];
					if (!firstLine) continue;
					const header = JSON.parse(firstLine);
					if (header.id === sessionId) return full;
				} catch {
					/* ignore parse error */
				}
			}
		} catch {
			/* ignore */
		}
		return null;
	};

	const inGroup = searchDir(groupDir);
	if (inGroup) return inGroup;

	// Fallback: search all group directories under baseDir
	if (fs.existsSync(baseDir)) {
		try {
			for (const sub of fs.readdirSync(baseDir)) {
				const subPath = path.join(baseDir, sub);
				if (fs.statSync(subPath).isDirectory()) {
					const found = searchDir(subPath);
					if (found) return found;
				}
			}
		} catch {
			/* ignore */
		}
	}

	return null;
}

export interface HarvestedSessionData {
	lastAssistantText: string;
	usage: UsageStats;
	model?: string;
	stopReason?: string;
}

/**
 * Parse a pi session JSONL file to extract assistant messages and usage stats.
 */
export function parseSessionJsonl(filePath: string): HarvestedSessionData | null {
	if (!fs.existsSync(filePath)) return null;

	try {
		const content = fs.readFileSync(filePath, "utf-8");
		const lines = content.split("\n");

		let lastAssistantText = "";
		let model: string | undefined;
		let stopReason: string | undefined;
		const usage: UsageStats = {
			input: 0,
			output: 0,
			cacheRead: 0,
			cacheWrite: 0,
			cost: 0,
			contextTokens: 0,
			turns: 0,
		};

		for (const line of lines) {
			if (!line.trim()) continue;
			try {
				const entry = JSON.parse(line);
				if (entry.type === "message" && entry.message) {
					const msg = entry.message;
					if (msg.role === "assistant") {
						usage.turns += 1;
						if (msg.model && !model) model = msg.model;
						if (msg.stopReason) stopReason = msg.stopReason;

						if (msg.usage) {
							usage.input += msg.usage.input || 0;
							usage.output += msg.usage.output || 0;
							usage.cacheRead += msg.usage.cacheRead || 0;
							usage.cacheWrite += msg.usage.cacheWrite || 0;
							usage.cost += msg.usage.cost?.total || 0;
							if (msg.usage.totalTokens) usage.contextTokens = msg.usage.totalTokens;
						}

						// Extract assistant text
						if (Array.isArray(msg.content)) {
							let text = "";
							for (const part of msg.content) {
								if (part.type === "text") text += part.text;
							}
							if (text.trim()) lastAssistantText = text;
						} else if (typeof msg.content === "string" && msg.content.trim()) {
							lastAssistantText = msg.content;
						}
					}
				}
			} catch {
				/* ignore malformed lines */
			}
		}

		return { lastAssistantText, usage, model, stopReason };
	} catch {
		return null;
	}
}

/**
 * Human-readable pending prompt for a blocked child. Kept display-only: a
 * blocked run may resume, so this must never be persisted as its report.
 */
export function extractBlockedQuestion(text: string | undefined | null, limit = 500): string | undefined {
	if (!text) return undefined;
	const collapsed = text
		.split("\n")
		.map((line) => line.trim())
		.filter(Boolean)
		.join("\n");
	if (!collapsed || collapsed === "(no output)") return undefined;
	return collapsed.length > limit ? `${collapsed.slice(0, limit - 1)}…` : collapsed;
}

/**
 * Harvest final report and usage stats for a run (headless or pane).
 */
export async function harvestReport(run: SubagentRun): Promise<void> {
	// Never harvest or overwrite reports for still-running agents.
	if (run.status === "running") {
		return;
	}

	let report = "";
	let isGenuineReport = false;

	// 1. Primary: report.md written by child to scratch directory
	try {
		if (fs.existsSync(run.reportPath)) {
			const onDisk = fs.readFileSync(run.reportPath, "utf-8").trim();
			if (onDisk) {
				report = onDisk;
				isGenuineReport = true;
			}
		}
	} catch {
		/* ignore */
	}

	// 2. Secondary fallback: session JSONL (for pane runs and headless)
	if (run.sessionId || run.mode === "pane") {
		const sessionFile = findSessionFile(run.cwd, run.sessionId);
		if (sessionFile) {
			const sessionData = parseSessionJsonl(sessionFile);
			if (sessionData) {
				if (!report && sessionData.lastAssistantText) {
					report = sessionData.lastAssistantText.trim();
					// A run abandoned at restore may have died mid-turn: its session text
					// is display-only, never a persisted final report.
					isGenuineReport = run.abandoned !== true;
				}
				// A pane child's session JSONL is the cumulative usage source of truth.
				// Re-read it on every harvest so a blocked run that resumes (and then
				// finishes) reports its full totals, not the partial snapshot taken when
				// it first blocked.
				if (sessionData.usage.turns > 0 && sessionData.usage.turns >= run.usage.turns) {
					run.usage = sessionData.usage;
				}
				if (!run.model && sessionData.model) run.model = sessionData.model;
				if (!run.stopReason && sessionData.stopReason) run.stopReason = sessionData.stopReason;
			}
		}
	}

	// 3. Fallback: herdr agent read (terminal output) for pane runs (display only, never persisted)
	if (!report && run.mode === "pane" && run.agentName && isHerdrAvailable()) {
		try {
			const termOutput = await readAgent(run.agentName, {
				source: "recent-unwrapped",
				lines: 100,
			});
			if (termOutput.trim()) {
				report = termOutput.trim();
			}
		} catch {
			/* ignore */
		}
	}

	// 4. Fallback: a report already known (e.g. restored from the session branch) or
	// the error output. Restored runs may have lost their scratch report file when
	// the previous parent session cleaned up, so never clobber their known report.
	if (!report) {
		report = run.report?.trim() || run.errorMessage || run.stderr.trim() || "(no output)";
	}

	// Persisting a report is only safe once the child can no longer change it.
	// A blocked child may resume after the user answers it, so its intermediate
	// session text must stay display-only and must never mask the final report.
	const allowPersist = run.status !== "blocked";

	// Save captured genuine report to reportPath if not already present on disk.
	// Never persist placeholder "(no output)" or transient terminal scrapes to reportPath.
	if (isGenuineReport && allowPersist) {
		try {
			if (!fs.existsSync(run.reportPath)) {
				fs.writeFileSync(run.reportPath, report, { encoding: "utf-8", mode: 0o600 });
			}
		} catch {
			/* ignore */
		}
	}

	run.report = report;

	// Blocked runs are waiting on input, not finished: keep the pending prompt in
	// its own display-only field and never treat it as a report.
	run.blockedQuestion = run.status === "blocked" ? extractBlockedQuestion(report) : undefined;

	// Send notification if settled or blocked and not yet notified
	if (!run.notified && isHerdrAvailable()) {
		if (run.status === "done") {
			run.notified = true;
			const taskSummary = run.task.length > 60 ? `${run.task.slice(0, 60)}...` : run.task;
			await showNotification(`Sub-agent ${run.agent} done`, {
				body: taskSummary,
				sound: "done",
			});
		} else if (run.status === "failed") {
			run.notified = true;
			const errMsg = run.errorMessage || "Unknown error";
			const body = errMsg.length > 60 ? `${errMsg.slice(0, 60)}...` : errMsg;
			await showNotification(`Sub-agent ${run.agent} failed`, {
				body,
				sound: "request",
			});
		} else if (run.status === "blocked") {
			run.notified = true;
			const question = firstLine(extractBlockedQuestion(run.report) ?? "requires input", 80);
			await showNotification(`Sub-agent ${run.agent} waiting for input`, {
				body: `${run.id}: ${question}`,
				sound: "request",
			});
		} else if (run.status === "aborted") {
			run.notified = true;
			await showNotification(`Sub-agent ${run.agent} aborted`, {
				body: `Sub-agent ${run.id} was aborted.`,
			});
		}
	}
}

// ---------------------------------------------------------------------------
// Completion evidence (issue #1)
// ---------------------------------------------------------------------------

/** How long an evidence-free pane child may sit before the parent gives up on it. */
export const STUCK_IDLE_GRACE_MS = 45000;
/** Stop reason for a pane child that never began processing its task. */
export const STUCK_STOP_REASON =
	"pane child never began processing the task (no turn observed; the prompt may not have been submitted)";
/** One `herdr agent wait` slice: the live state is probed after each slice. */
const PANE_WAIT_SLICE_MS = 5000;

/**
 * The one completion-evidence rule for pane runs: a pane child that was never
 * observed processing a turn — no `working` observation, no recorded turn, no
 * disk report, no turn in its session JSONL — must never settle as `done` on
 * an `idle` observation alone. A pre-task TUI is idle too, so a child whose
 * prompt was never submitted would otherwise settle instantly with an empty
 * report while it keeps running (issue #1).
 */
export function hasTurnEvidence(run: SubagentRun): boolean {
	if (run.sawWorking === true) return true;
	if (run.usage.turns >= 1) return true;
	if (hasDiskReport(run)) return true;
	if (run.sessionId) {
		const sessionFile = findSessionFile(run.cwd, run.sessionId);
		if (sessionFile) {
			const session = parseSessionJsonl(sessionFile);
			if (session && session.usage.turns >= 1) return true;
		}
	}
	return false;
}

/**
 * Settle a pane run from an observed herdr agent state, applying the
 * completion-evidence rule. Mutates `run` and returns whether it settled or
 * blocked. `idle`/`done` without first-turn evidence leaves the run `running`
 * (the caller applies the stuck-idle grace); `working` records the evidence.
 */
export function settlePaneAgentStatus(run: SubagentRun, agent: HerdrAgent | null): boolean {
	if (agent === null) {
		// Confirmed gone: it finished only if it ever processed a turn.
		if (hasTurnEvidence(run)) {
			run.status = "done";
		} else {
			run.status = "failed";
			run.stopReason = "pane child exited without processing the task";
		}
		// Never re-stamp a finished run's completion time (durationMs would grow).
		run.endedAt ??= Date.now();
		return true;
	}

	switch (agent.agent_status) {
		case "blocked":
			run.status = "blocked";
			return true;
		case "working":
			run.sawWorking = true;
			run.status = "running";
			run.endedAt = undefined;
			return false;
		case "idle":
		case "done":
			if (!hasTurnEvidence(run)) return false;
			run.status = "done";
			// Never re-stamp a finished run's completion time (durationMs would grow).
			run.endedAt ??= Date.now();
			return true;
		default:
			// "unknown" or an unrecognized observation: leave the run as-is.
			return false;
	}
}

function defaultSleep(ms: number): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Wait for runs to settle, then harvest their reports and usage.
 */
export async function collectRuns(options: {
	runs: SubagentRun[];
	timeoutMs?: number;
	pendingPromises?: Map<string, Promise<void>>;
	/** Test seam: pane wait slice (defaults to herdr `waitAgent`). */
	paneWait?: (agentName: string, opts: { until: string[]; timeoutMs: number }) => Promise<HerdrAgent | null>;
	/** Test seam: pane state probe (defaults to herdr `getAgent`). */
	paneGet?: (agentName: string) => Promise<HerdrAgent | null>;
	/** Test seam: clock (defaults to `Date.now`). */
	now?: () => number;
	/** Test seam: sleep between no-change loop iterations (defaults to a real timeout). */
	sleep?: (ms: number) => Promise<void>;
}): Promise<SubagentRun[]> {
	const { runs, timeoutMs = 300000, pendingPromises, paneWait, paneGet } = options;
	const nowFn = options.now ?? Date.now;
	const sleepFn = options.sleep ?? defaultSleep;

	const waitOne = async (run: SubagentRun): Promise<void> => {
		if (isSettled(run.status)) {
			await harvestReport(run);
			run.collected = true;
			return;
		}

		if (run.mode === "headless") {
			const pending = pendingPromises?.get(run.id);
			if (pending) {
				if (timeoutMs <= 0) {
					await pending;
				} else {
					let timer: NodeJS.Timeout | undefined;
					const timeout = new Promise<void>((resolve) => {
						timer = setTimeout(resolve, timeoutMs);
					});
					await Promise.race([pending, timeout]);
					if (timer) clearTimeout(timer);
				}
			}
		} else if (
			run.mode === "pane" &&
			run.agentName &&
			(paneWait !== undefined || paneGet !== undefined || isHerdrAvailable())
		) {
			const paneWaitFn = paneWait ?? waitAgent;
			const paneGetFn = paneGet ?? getAgent;
			const loopStart = nowFn();

			// Slice loop (issue #1): `herdr agent wait` returns immediately when the
			// agent is already in an `until` state, and an `idle` observation alone
			// never settles a run — a pre-task TUI is idle too. Probe the live state
			// after each slice and settle it through the one completion-evidence
			// rule; an evidence-free idle child is failed by the stuck-idle grace
			// instead of being collected as `done` with an empty report.
			while (true) {
				try {
					await paneWaitFn(run.agentName, {
						until: ["idle", "done", "blocked"],
						timeoutMs: PANE_WAIT_SLICE_MS,
					});
				} catch {
					/* slice timeout or transient failure: the probe below decides */
				}

				let probe: HerdrAgent | null | undefined;
				try {
					probe = await paneGetFn(run.agentName);
				} catch {
					probe = undefined; // transient probe failure: nothing settled this slice
				}
				if (probe !== undefined && settlePaneAgentStatus(run, probe)) break;

				if (
					run.status === "running" &&
					!hasTurnEvidence(run) &&
					nowFn() - run.startedAt > STUCK_IDLE_GRACE_MS
				) {
					run.status = "failed";
					run.stopReason = STUCK_STOP_REASON;
					run.endedAt = nowFn();
					break;
				}

				// Long tasks may outlive the caller's budget: break leaving the run
				// `running` (the child keeps working; collect again later).
				if (timeoutMs > 0 && nowFn() - loopStart >= timeoutMs) break;

				await sleepFn(1000);
			}
		}

		if (isSettled(run.status) || run.status === "blocked") {
			await harvestReport(run);
			run.collected = true;
		}
	};

	await Promise.all(runs.map((r) => waitOne(r)));
	return runs;
}

// ---------------------------------------------------------------------------
// Reconciliation after a parent restart (phase 4)
// ---------------------------------------------------------------------------

/** Abort for a pane run restored from the session (its spawner closure is gone). */
function restoredPaneAbort(run: SubagentRun): (reason?: string) => Promise<void> {
	return async (reason?: string) => {
		try {
			if (run.agentName) await sendKeys(run.agentName, "ctrl+c");
		} catch {
			/* the agent may already be gone */
		}
		await new Promise((resolve) => setTimeout(resolve, 1000));
		try {
			if (run.paneId && !run.paneClosed) {
				await closePane(run.paneId);
				run.paneClosed = true;
			}
		} catch {
			/* cleanup retries, or the pane is already gone */
		}
		run.status = "aborted";
		run.stopReason = reason ?? "aborted";
		run.endedAt = Date.now();
	};
}

export interface ReconcileOptions {
	runs: SubagentRun[];
	/** Called once per run whose status changed, so the caller can persist the correction. */
	onChange?: (run: SubagentRun) => void;
	/** Test seam: live agents to match against (defaults to `herdr agent list`). */
	liveAgents?: HerdrAgent[];
	/** Test seam: pane liveness probe (defaults to `herdr pane layout`). */
	paneAlive?: (paneId: string) => Promise<boolean>;
}

/** Whether the child wrote a final report to its scratch directory before dying. */
function hasDiskReport(run: SubagentRun): boolean {
	try {
		return fs.existsSync(run.reportPath) && fs.readFileSync(run.reportPath, "utf-8").trim().length > 0;
	} catch {
		return false;
	}
}

export interface ReconcileSummary {
	restored: number;
	/** Runs with a matching live herdr agent, re-adopted and tracked again. */
	adopted: string[];
	/** Runs transitioned to a final status because no live process backs them. */
	settled: string[];
	/** Runs settled mid-flight in a pane that is still alive but untrackable (no live agent owns it). */
	orphaned: string[];
}

/**
 * Settle a mid-flight run whose process can no longer be tracked: the child
 * wrote its final report to disk before the parent restart (finished) or died
 * mid-flight (marked `abandoned` — its harvested text is display-only and is
 * never persisted as a final report). A pane that is still alive but no longer
 * owned by any live agent is surfaced as orphaned instead of silently dropped.
 */
async function settleMidFlight(
	run: SubagentRun,
	paneLive: boolean,
	summary: Pick<ReconcileSummary, "orphaned" | "settled">,
): Promise<void> {
	const finished = hasDiskReport(run);
	if (!finished) {
		run.abandoned = true;
		run.errorMessage ??= paneLive
			? `Abandoned at restore: pane ${run.paneId} is alive but no live Herdr agent tracks this child; the report may be mid-flight.`
			: `Abandoned at restore: the child was still ${run.status} and its pane is gone; the report may be mid-flight.`;
	}
	run.status = finished ? "done" : "failed";
	run.endedAt ??= Date.now();
	if (!finished && paneLive) summary.orphaned.push(run.id);
	await harvestReport(run);
	summary.settled.push(run.id);
}

/**
 * Reconcile runs reconstructed from the session branch against live Herdr
 * agents. Live pane children are re-adopted (with a fresh abort handle) so the
 * poller keeps tracking them — matched by agent name first, then by pane id
 * (agent names can be reassigned after a herdr restart; the pane is the run's
 * durable identity). Runs with no live agent are settled: a child that wrote
 * its final report to disk finished cleanly; anything else died mid-flight,
 * is marked `abandoned` and failed, and one abandoned in a live untracked pane
 * is surfaced as orphaned. Stale headless runs are failed the same way.
 */
export async function reconcileRuns(options: ReconcileOptions): Promise<ReconcileSummary> {
	const { runs, onChange, paneAlive } = options;
	const summary: ReconcileSummary = { restored: runs.length, adopted: [], settled: [], orphaned: [] };
	if (runs.length === 0) return summary;

	const herdrReady = isHerdrAvailable();
	let live: Map<string, HerdrAgent>;
	if (options.liveAgents) {
		live = new Map(options.liveAgents.map((agent) => [agent.name || agent.agent, agent]));
	} else if (herdrReady) {
		live = new Map((await listAgents()).map((agent) => [agent.name || agent.agent, agent]));
	} else {
		live = new Map();
	}

	const liveByPane = new Map<string, HerdrAgent>();
	for (const agent of live.values()) {
		if (agent.pane_id) liveByPane.set(agent.pane_id, agent);
	}

	const probePane = paneAlive ?? (herdrReady ? isPaneAlive : async () => false);

	for (const run of runs) {
		const before = run.status;

		if (run.mode === "headless") {
			// A headless child is a child of the old parent process: nothing to adopt.
			if (run.status === "running") {
				const finished = hasDiskReport(run);
				if (!finished) {
					run.abandoned = true;
					run.errorMessage ??=
						"Parent session ended while this headless child was running; the process could not be adopted. " +
						"The report may be mid-flight.";
				}
				run.status = finished ? "done" : "failed";
				run.endedAt ??= Date.now();
				await harvestReport(run);
				summary.settled.push(run.id);
			}
			if (run.status !== before) onChange?.(run);
			continue;
		}

		let agent = run.agentName ? live.get(run.agentName) : undefined;
		if (!agent && run.paneId) {
			// The agent name no longer matches (e.g. reassigned after a herdr
			// restart) but the pane is the run's durable identity: adopt whichever
			// live agent now owns that pane and keep tracking it by its current name.
			agent = liveByPane.get(run.paneId);
		}
		if (agent) {
			run.paneClosed = false;
			if (agent.pane_id) run.paneId = agent.pane_id;
			if (agent.tab_id) run.tabId = agent.tab_id;
			const liveName = agent.name || agent.agent;
			if (liveName && run.agentName !== liveName) run.agentName = liveName;
			run.abort = restoredPaneAbort(run);
			// One completion-evidence rule (issue #1): an adopted `idle` child that
			// never processed a turn stays running instead of being settled `done`;
			// the poller applies the stuck-idle grace to it.
			settlePaneAgentStatus(run, agent);
			if (run.status === "running") {
				run.endedAt = undefined;
			} else if (!run.endedAt) {
				run.endedAt = Date.now();
			}
			if (run.status !== "running") await harvestReport(run);
			summary.adopted.push(run.id);
		} else {
			const paneLive = run.paneId ? await probePane(run.paneId) : false;
			run.paneClosed = !paneLive;
			if (!isSettled(run.status)) {
				await settleMidFlight(run, paneLive, summary);
			}
		}

		if (run.status !== before) onChange?.(run);
	}

	return summary;
}
