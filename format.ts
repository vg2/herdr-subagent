/**
 * Status and usage formatting shared by tool output, TUI renderers, and the
 * `/subagents` command.
 */

import { isSettled, sumUsage, type RunStatus, type RunView, type UsageStats } from "./state.ts";

export function formatTokens(count: number): string {
	if (count < 1000) return count.toString();
	if (count < 10000) return `${(count / 1000).toFixed(1)}k`;
	if (count < 1000000) return `${Math.round(count / 1000)}k`;
	return `${(count / 1000000).toFixed(1)}M`;
}

export function formatUsageStats(
	usage: {
		input: number;
		output: number;
		cacheRead: number;
		cacheWrite: number;
		cost: number;
		contextTokens?: number;
		turns?: number;
	},
	model?: string,
): string {
	const parts: string[] = [];
	if (usage.turns) parts.push(`${usage.turns} turn${usage.turns > 1 ? "s" : ""}`);
	if (usage.input) parts.push(`↑${formatTokens(usage.input)}`);
	if (usage.output) parts.push(`↓${formatTokens(usage.output)}`);
	if (usage.cacheRead) parts.push(`R${formatTokens(usage.cacheRead)}`);
	if (usage.cacheWrite) parts.push(`W${formatTokens(usage.cacheWrite)}`);
	if (usage.cost) parts.push(`$${usage.cost.toFixed(4)}`);
	if (usage.contextTokens && usage.contextTokens > 0) parts.push(`ctx:${formatTokens(usage.contextTokens)}`);
	if (model) parts.push(model);
	return parts.join(" ");
}

export function formatDuration(ms?: number): string {
	if (!ms || ms <= 0) return "";
	const s = Math.round(ms / 1000);
	if (s < 60) return `${s}s`;
	const m = Math.floor(s / 60);
	const remS = s % 60;
	return `${m}m ${remS}s`;
}

/** Compact pane/worktree location suffix for status lines. */
export function formatLocation(view: RunView): string {
	const parts: string[] = [];
	if (view.paneId) parts.push(`pane: ${view.paneId}`);
	if (view.worktreeBranch) parts.push(`worktree: ${view.worktreeBranch}`);
	return parts.length > 0 ? ` [${parts.join(", ")}]` : "";
}

export function statusIcon(status: RunStatus): string {
	switch (status) {
		case "running":
			return "⏳";
		case "done":
			return "✓";
		case "aborted":
			return "■";
		case "blocked":
			return "⏸";
		default:
			return "✗";
	}
}

/** First non-empty line of `text`, trimmed to `max` characters. */
export function firstLine(text: string, max = 200): string {
	for (const line of text.split("\n")) {
		const trimmed = line.trim();
		if (!trimmed) continue;
		return trimmed.length > max ? `${trimmed.slice(0, max - 1)}…` : trimmed;
	}
	return "";
}

/** Actionable hint for a blocked child, model-facing (the parent can relay via `subagent_message`). */
export function formatBlockedHint(view: RunView): string {
	return (
		`\nblocked on: ${view.blockedQuestion ? firstLine(view.blockedQuestion) : "(prompt not captured — open the pane to see it)"}` +
		`\nanswer: relay with subagent_message { id: "${view.id}", message: "..." } ` +
		`(or ask the user to answer in ${view.paneId ? `pane ${view.paneId}` : "the child's pane"})`
	);
}

/** One run as a multi-line status block (tool output and `/subagents list`). */
export function formatRunSummary(view: RunView): string {
	const usageStr = formatUsageStats(view.usage, view.model);
	const durationStr = formatDuration(view.durationMs);
	const paneStr = formatLocation(view);
	let text =
		`${statusIcon(view.status)} ${view.id} (${view.agent})${paneStr} — ${view.status}` +
		(durationStr ? ` (${durationStr})` : "") +
		(usageStr ? `\n   ${usageStr}` : "") +
		`\n   task: ${view.task.split("\n")[0]}`;
	if (view.errorMessage) text += `\n   error: ${view.errorMessage}`;
	if (view.worktreeBranch && !view.paneId) text += `\n   worktree: ${view.worktreeBranch}`;
	if (view.status === "blocked") {
		text += formatBlockedHint(view).split("\n").map((line) => `   ${line}`).join("\n");
	} else {
		text += `\n   report: ${view.reportPath}`;
	}
	return text;
}

/** Session-wide totals across children (turns, tokens, cache, cost, max context). */
export function formatUsageTotals(runs: readonly { usage: UsageStats; status: RunStatus }[]): string {
	if (runs.length === 0) return "";

	const total = sumUsage(runs);

	const settled = runs.filter((run) => isSettled(run.status)).length;
	const counts =
		`${runs.length} sub-agent${runs.length === 1 ? "" : "s"}` + (settled > 0 ? ` (${settled} settled)` : "");
	const usageStr = formatUsageStats(total);
	return usageStr ? `Totals: ${counts} — ${usageStr}` : `Totals: ${counts}`;
}
