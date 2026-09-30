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
	getAgent,
	isHerdrAvailable,
	readAgent,
	showNotification,
	waitAgent,
} from "./herdr.ts";
import {
	isSettled,
	type RunRegistry,
	type SubagentRun,
	type UsageStats,
	wrapUntrustedReport,
} from "./state.ts";

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
 * Harvest final report and usage stats for a run (headless or pane).
 */
export async function harvestReport(run: SubagentRun): Promise<void> {
	let report = "";

	// 1. Primary: report.md written by child to scratch directory
	try {
		if (fs.existsSync(run.reportPath)) {
			report = fs.readFileSync(run.reportPath, "utf-8").trim();
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
				}
				// Merge usage stats if run didn't already have them
				if (sessionData.usage.turns > 0 && run.usage.turns === 0) {
					run.usage = sessionData.usage;
				}
				if (!run.model && sessionData.model) run.model = sessionData.model;
				if (!run.stopReason && sessionData.stopReason) run.stopReason = sessionData.stopReason;
			}
		}
	}

	// 3. Fallback: herdr agent read (terminal output) for pane runs
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

	// 4. Fallback: error message or placeholder
	if (!report) {
		report = run.errorMessage || run.stderr.trim() || "(no output)";
	}

	// Save captured report to reportPath if not already present
	try {
		if (!fs.existsSync(run.reportPath)) {
			fs.writeFileSync(run.reportPath, report, { encoding: "utf-8", mode: 0o600 });
		}
	} catch {
		/* ignore */
	}

	run.report = report;

	// Send notification if settled and not yet notified
	if (run.status === "done" && !run.notified) {
		run.notified = true;
		if (isHerdrAvailable()) {
			const taskSummary = run.task.length > 60 ? `${run.task.slice(0, 60)}...` : run.task;
			await showNotification(`Sub-agent ${run.agent} done`, {
				body: taskSummary,
				sound: "done",
			});
		}
	}
}

/**
 * Wait for runs to settle, then harvest their reports and usage.
 */
export async function collectRuns(options: {
	runs: SubagentRun[];
	timeoutMs?: number;
	pendingPromises?: Map<string, Promise<void>>;
}): Promise<SubagentRun[]> {
	const { runs, timeoutMs = 300000, pendingPromises } = options;

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
		} else if (run.mode === "pane" && run.agentName && isHerdrAvailable()) {
			try {
				const agent = await waitAgent(run.agentName, {
					until: ["idle", "done", "blocked"],
					timeoutMs: timeoutMs > 0 ? timeoutMs : undefined,
				});

				if (agent) {
					if (agent.agent_status === "blocked") {
						run.status = "blocked";
					} else if (agent.agent_status === "done" || agent.agent_status === "idle") {
						run.status = "done";
						run.endedAt = Date.now();
					}
				}
			} catch (err: any) {
				// If wait failed, check live agent state or process
				const agent = await getAgent(run.agentName);
				if (!agent) {
					// Agent exited
					run.status = "done";
					run.endedAt = Date.now();
				} else if (agent.agent_status === "blocked") {
					run.status = "blocked";
				} else if (agent.agent_status === "done" || agent.agent_status === "idle") {
					run.status = "done";
					run.endedAt = Date.now();
				}
			}
		}

		await harvestReport(run);
		if (isSettled(run.status) || run.status === "blocked") {
			run.collected = true;
		}
	};

	await Promise.all(runs.map((r) => waitOne(r)));
	return runs;
}
