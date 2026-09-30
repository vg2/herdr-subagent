/**
 * Herdr CLI wrapper and layout policy for sub-agents.
 *
 * Implements Plan 3.1 & 3.5:
 *   - Auto layout policy:
 *       1-2 subagents -> sibling panes in current tab (split right/down by geometry)
 *       3+ subagents -> dedicated tab in current workspace ("subagents")
 *   - Env hygiene: passes `--env HERDR_ENV=0` on every split/tab creation
 *   - Never steals focus: `--no-focus` everywhere unless explicitly requested
 *   - Agent lifecycle control: start, prompt, wait, send-keys, read, get, list
 */

import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

// ---------------------------------------------------------------------------
// Herdr types
// ---------------------------------------------------------------------------

export interface HerdrResponse<T = any> {
	id: string;
	result?: T;
	error?: {
		code: string;
		message: string;
	};
	type?: string;
}

export interface PaneInfo {
	pane_id: string;
	tab_id: string;
	workspace_id: string;
	cwd: string;
	focused: boolean;
	agent_status?: string;
	terminal_id?: string;
}

export interface PaneRect {
	x: number;
	y: number;
	width: number;
	height: number;
}

export interface PaneLayoutItem {
	pane_id: string;
	focused: boolean;
	rect: PaneRect;
}

export interface PaneLayout {
	area: PaneRect;
	focused_pane_id?: string;
	panes: PaneLayoutItem[];
	splits: any[];
	tab_id: string;
	workspace_id: string;
	zoomed?: boolean;
}

export interface TabInfo {
	tab_id: string;
	workspace_id: string;
	label: string;
	focused: boolean;
	pane_count: number;
}

export interface HerdrAgent {
	agent: string;
	name?: string;
	agent_status: "idle" | "working" | "blocked" | "done" | "unknown" | string;
	interactive_ready?: boolean;
	pane_id: string;
	tab_id: string;
	workspace_id: string;
	cwd?: string;
	focused?: boolean;
	terminal_title?: string;
}

// ---------------------------------------------------------------------------
// CLI Execution
// ---------------------------------------------------------------------------

export class HerdrError extends Error {
	code: string;

	constructor(code: string, message: string) {
		super(`herdr error [${code}]: ${message}`);
		this.name = "HerdrError";
		this.code = code;
	}
}

export const CLEAN_CHILD_ENV: Record<string, string> = {
	HERDR_ENV: "0",
	HERDR_PANE_ID: "",
	HERDR_TAB_ID: "",
	HERDR_WORKSPACE_ID: "",
};

export function isNotFoundError(err: unknown): boolean {
	return (
		err instanceof HerdrError &&
		(err.code === "agent_not_found" || err.code === "pane_not_found" || err.code === "tab_not_found")
	);
}

export function isHerdrAvailable(): boolean {
	return process.env.HERDR_ENV === "1";
}

export async function herdrExec<T = any>(
	args: string[],
	options: { timeoutMs?: number; signal?: AbortSignal } = {},
): Promise<T> {
	try {
		const { stdout, stderr } = await execFileAsync("herdr", args, {
			timeout: options.timeoutMs,
			signal: options.signal,
			maxBuffer: 10 * 1024 * 1024,
		});

		const text = stdout.trim() || stderr.trim();
		if (!text) return {} as T;

		let parsed: HerdrResponse<T>;
		try {
			parsed = JSON.parse(text);
		} catch {
			return text as unknown as T;
		}

		if (parsed.error) {
			throw new HerdrError(parsed.error.code, parsed.error.message);
		}

		return (parsed.result ?? parsed) as T;
	} catch (err: any) {
		if (err instanceof HerdrError) throw err;
		if (err.stdout || err.stderr) {
			const text = (err.stderr || err.stdout || "").trim();
			let parsedError: { code: string; message: string } | undefined;
			try {
				const parsed = JSON.parse(text);
				if (parsed.error) {
					parsedError = parsed.error;
				}
			} catch {
				/* ignore JSON parse failure */
			}
			if (parsedError) {
				throw new HerdrError(parsedError.code, parsedError.message);
			}
		}
		throw err;
	}
}

// ---------------------------------------------------------------------------
// Pane operations
// ---------------------------------------------------------------------------

export async function isPaneAlive(paneId: string): Promise<boolean> {
	try {
		const res = await herdrExec<{ layout: PaneLayout | null }>(["pane", "layout", "--pane", paneId]);
		const layout = res.layout ?? null;
		return layout !== null && layout.panes.some((p) => p.pane_id === paneId);
	} catch (err) {
		// Only a confirmed "pane_not_found" means the pane is gone; transient
		// herdr failures must propagate so callers don't declare a live pane dead.
		if (isNotFoundError(err)) return false;
		throw err;
	}
}

export async function getPaneLayout(paneId?: string): Promise<PaneLayout | null> {
	try {
		const args = ["pane", "layout"];
		if (paneId) args.push("--pane", paneId);
		else args.push("--current");
		const res = await herdrExec<{ layout: PaneLayout }>(args);
		return res.layout ?? null;
	} catch {
		return null;
	}
}

export async function listPanes(workspaceId?: string): Promise<PaneInfo[]> {
	const args = ["pane", "list"];
	if (workspaceId) args.push("--workspace", workspaceId);
	const res = await herdrExec<{ panes: PaneInfo[] }>(args);
	return res.panes ?? [];
}

export interface SplitPaneOptions {
	current?: boolean;
	paneId?: string;
	direction?: "right" | "down";
	ratio?: number;
	cwd?: string;
	env?: Record<string, string>;
	focus?: boolean;
}

export async function splitPane(options: SplitPaneOptions = {}): Promise<PaneInfo> {
	const args = ["pane", "split"];
	if (options.current) {
		args.push("--current");
	} else if (options.paneId) {
		args.push(options.paneId);
	}
	if (options.direction) {
		args.push("--direction", options.direction);
	}
	if (options.ratio !== undefined) {
		args.push("--ratio", options.ratio.toString());
	}
	if (options.cwd) {
		args.push("--cwd", options.cwd);
	}
	if (options.env) {
		for (const [key, value] of Object.entries(options.env)) {
			args.push("--env", `${key}=${value}`);
		}
	}
	if (options.focus) {
		args.push("--focus");
	} else {
		args.push("--no-focus");
	}

	const res = await herdrExec<{ pane: PaneInfo }>(args);
	if (!res.pane) throw new Error("herdr pane split did not return a pane");
	return res.pane;
}

export async function closePane(paneId: string): Promise<void> {
	await herdrExec(["pane", "close", paneId]);
}

// ---------------------------------------------------------------------------
// Tab operations
// ---------------------------------------------------------------------------

export async function listTabs(workspaceId?: string): Promise<TabInfo[]> {
	const args = ["tab", "list"];
	if (workspaceId) args.push("--workspace", workspaceId);
	const res = await herdrExec<{ tabs: TabInfo[] }>(args);
	return res.tabs ?? [];
}

export interface CreateTabOptions {
	label?: string;
	cwd?: string;
	env?: Record<string, string>;
	focus?: boolean;
	workspaceId?: string;
}

export async function createTab(
	options: CreateTabOptions = {},
): Promise<{ tab: TabInfo; rootPane: PaneInfo }> {
	const args = ["tab", "create"];
	if (options.workspaceId) args.push("--workspace", options.workspaceId);
	if (options.label) args.push("--label", options.label);
	if (options.cwd) args.push("--cwd", options.cwd);
	if (options.env) {
		for (const [key, value] of Object.entries(options.env)) {
			args.push("--env", `${key}=${value}`);
		}
	}
	if (options.focus) args.push("--focus");
	else args.push("--no-focus");

	const res = await herdrExec<{ tab: TabInfo; root_pane: PaneInfo }>(args);
	if (!res.tab || !res.root_pane) {
		throw new Error("herdr tab create did not return tab and root_pane");
	}
	return { tab: res.tab, rootPane: res.root_pane };
}

export async function focusTab(tabId: string): Promise<void> {
	await herdrExec(["tab", "focus", tabId]);
}

export async function closeTab(tabId: string): Promise<void> {
	await herdrExec(["tab", "close", tabId]);
}

// ---------------------------------------------------------------------------
// Agent operations
// ---------------------------------------------------------------------------

export async function listAgents(): Promise<HerdrAgent[]> {
	try {
		const res = await herdrExec<{ agents: HerdrAgent[] }>(["agent", "list"]);
		return res.agents ?? [];
	} catch {
		return [];
	}
}

export async function getAgent(target: string): Promise<HerdrAgent | null> {
	try {
		const res = await herdrExec<{ agent: HerdrAgent }>(["agent", "get", target]);
		return res.agent ?? null;
	} catch (err: any) {
		if (isNotFoundError(err)) {
			return null;
		}
		throw err;
	}
}

export interface StartAgentOptions {
	name: string;
	kind: "pi";
	paneId: string;
	timeoutMs?: number;
	args: string[];
}

export async function startAgent(options: StartAgentOptions): Promise<HerdrAgent> {
	const cmd = [
		"agent",
		"start",
		options.name,
		"--kind",
		options.kind,
		"--pane",
		options.paneId,
	];
	if (options.timeoutMs) {
		cmd.push("--timeout", options.timeoutMs.toString());
	}
	cmd.push("--", ...options.args);

	const res = await herdrExec<{ agent: HerdrAgent }>(cmd);
	if (!res.agent) throw new Error(`Failed to start agent "${options.name}"`);
	return res.agent;
}

export interface PromptAgentOptions {
	wait?: boolean;
	until?: string[];
	timeoutMs?: number;
}

export async function promptAgent(
	target: string,
	text: string,
	options: PromptAgentOptions = {},
): Promise<HerdrAgent> {
	const cmd = ["agent", "prompt", target, text];
	if (options.wait) cmd.push("--wait");
	if (options.until) {
		for (const st of options.until) {
			cmd.push("--until", st);
		}
	}
	if (options.timeoutMs) {
		cmd.push("--timeout", options.timeoutMs.toString());
	}

	const res = await herdrExec<{ agent: HerdrAgent }>(cmd);
	return res.agent;
}

export interface WaitAgentOptions {
	until?: string[];
	timeoutMs?: number;
}

export async function waitAgent(
	target: string,
	options: WaitAgentOptions = {},
): Promise<HerdrAgent> {
	const cmd = ["agent", "wait", target];
	if (options.until) {
		for (const st of options.until) {
			cmd.push("--until", st);
		}
	}
	if (options.timeoutMs) {
		cmd.push("--timeout", options.timeoutMs.toString());
	}

	const res = await herdrExec<{ agent: HerdrAgent }>(cmd);
	return res.agent;
}

export async function sendKeys(target: string, ...keys: string[]): Promise<void> {
	await herdrExec(["agent", "send-keys", target, ...keys]);
}

export async function readAgent(
	target: string,
	options: {
		source?: "visible" | "recent" | "recent-unwrapped" | "detection";
		lines?: number;
	} = {},
): Promise<string> {
	const cmd = ["agent", "read", target];
	if (options.source) cmd.push("--source", options.source);
	if (options.lines) cmd.push("--lines", options.lines.toString());
	try {
		const out = await herdrExec<string>(cmd);
		return typeof out === "string" ? out : JSON.stringify(out);
	} catch {
		return "";
	}
}

export async function focusAgent(target: string): Promise<void> {
	await herdrExec(["agent", "focus", target]);
}

export async function showNotification(
	title: string,
	options: { body?: string; sound?: "none" | "done" | "request" } = {},
): Promise<void> {
	try {
		const cmd = ["notification", "show", title];
		if (options.body) cmd.push("--body", options.body);
		if (options.sound) cmd.push("--sound", options.sound);
		await herdrExec(cmd);
	} catch {
		/* ignore notification failures */
	}
}

// ---------------------------------------------------------------------------
// Layout Policy
// ---------------------------------------------------------------------------

export type LayoutPolicy = "auto" | "pane" | "tab";

export interface ResolvedPaneTarget {
	paneId: string;
	tabId: string;
	layoutMode: "pane" | "tab";
}

/**
 * Determine split direction from the layout geometry of the target pane.
 * Wide pane -> "right", tall/narrow pane -> "down".
 */
export async function getGeometrySplitDirection(targetPaneId?: string): Promise<"right" | "down"> {
	const layout = await getPaneLayout(targetPaneId);
	if (!layout) return "right";

	const pane = targetPaneId
		? layout.panes.find((p) => p.pane_id === targetPaneId)
		: layout.panes.find((p) => p.focused) ?? layout.panes[0];

	const rect = pane?.rect ?? layout.area;
	if (!rect) return "right";

	// If width is at least 1.5x the height, split side-by-side (right)
	return rect.width >= rect.height * 1.5 ? "right" : "down";
}

/**
 * Resolve layout according to Section 3.5:
 *   - "auto":
 *       activePaneSubagents < 2 -> sibling pane in caller's current tab
 *       activePaneSubagents >= 2 -> dedicated "subagents" tab in workspace
 *   - "pane": sibling pane in caller's tab
 *   - "tab": dedicated "subagents" tab in workspace
 */
export async function resolveLayoutTarget(options: {
	layout: LayoutPolicy;
	cwd: string;
	activePaneSubagentsCount: number;
	workspaceId?: string;
}): Promise<ResolvedPaneTarget> {
	const { layout, cwd, activePaneSubagentsCount } = options;
	const workspaceId = options.workspaceId ?? process.env.HERDR_WORKSPACE_ID;

	const useTab = layout === "tab" || (layout === "auto" && activePaneSubagentsCount >= 2);

	if (useTab) {
		const tabs = await listTabs(workspaceId);
		const existingSubagentsTab = tabs.find((t) => t.label === "subagents");

		if (existingSubagentsTab) {
			const panes = await listPanes(workspaceId);
			const tabPanes = panes.filter((p) => p.tab_id === existingSubagentsTab.tab_id);

			if (tabPanes.length > 0) {
				const targetPane = tabPanes[tabPanes.length - 1];
				const direction = await getGeometrySplitDirection(targetPane.pane_id);
				const pane = await splitPane({
					paneId: targetPane.pane_id,
					direction,
					cwd,
					env: CLEAN_CHILD_ENV,
					focus: false,
				});
				return { paneId: pane.pane_id, tabId: existingSubagentsTab.tab_id, layoutMode: "tab" };
			}
		}

		// Create dedicated subagents tab
		const created = await createTab({
			label: "subagents",
			cwd,
			env: CLEAN_CHILD_ENV,
			focus: false,
			workspaceId,
		});
		return {
			paneId: created.rootPane.pane_id,
			tabId: created.tab.tab_id,
			layoutMode: "tab",
		};
	}

	// Sibling pane in current tab
	const direction = await getGeometrySplitDirection();
	const pane = await splitPane({
		current: true,
		direction,
		cwd,
		env: CLEAN_CHILD_ENV,
		focus: false,
	});
	return { paneId: pane.pane_id, tabId: pane.tab_id, layoutMode: "pane" };
}
