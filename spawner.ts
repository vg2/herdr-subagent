/**
 * Dual-mode sub-agent spawner.
 *
 * Phase 1 implements the `headless` backend only: a child `pi --mode json -p`
 * process whose stdout JSON events are streamed into the parent tool renderer
 * and whose final message (plus an optional report file) is the collected
 * result. Pane mode lands in phase 2 behind the same request shape.
 *
 * Every child is spawned with:
 *   --no-extensions --no-skills -e <guard.ts>
 * and a sanitized environment (`HERDR_ENV=0`, all `HERDR_*` ids stripped), so
 * it cannot reach herdr or contact sibling agents.
 */

import { spawn } from "node:child_process";
import * as crypto from "node:crypto";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import type { ThinkingLevel } from "@earendil-works/pi-agent-core";
import type { Message } from "@earendil-works/pi-ai";
import { getAgentDir, type ExtensionContext } from "@earendil-works/pi-coding-agent";
import { type AgentConfig, isThinkingLevel } from "./agents.ts";
import {
	closePane,
	isHerdrAvailable,
	promptAgent,
	resolveLayoutTarget,
	sendKeys,
	startAgent,
} from "./herdr.ts";
import type { LayoutChoice, SpawnMode, SubagentRun } from "./state.ts";

const EXTENSION_DIR = path.dirname(fileURLToPath(import.meta.url));
export const GUARD_PATH = path.join(EXTENSION_DIR, "guard.ts");

export const CROSS_AGENT_POLICY =
	"You cannot contact other agents directly, and you must not attempt to control herdr " +
	"(the terminal multiplexer) or other agent sessions. Shared findings, blockers, and " +
	"hand-offs go through the project issue tracker, which is the sanctioned channel.";

export interface HeadlessSpawnOptions {
	run: SubagentRun;
	persona: AgentConfig;
	delegationPrompt: string;
	signal?: AbortSignal;
	onProgress?: (run: SubagentRun) => void;
	onSettled?: (run: SubagentRun) => void;
}

export interface ModelResolution {
	/** Canonical `provider/id`, when resolved. */
	model?: string;
	thinking?: ThinkingLevel;
	/** Set when resolution failed; callers should surface this instead of spawning. */
	error?: string;
}

interface CatalogEntry {
	key: string;
	provider: string;
	id: string;
	name: string;
	reasoning: boolean;
}

// ---------------------------------------------------------------------------
// Temp files
// ---------------------------------------------------------------------------

/** Create the per-run scratch directory under the OS temp dir. */
export function createRunDir(runId: string): string {
	const base = path.join(os.tmpdir(), "pi-subagent");
	fs.mkdirSync(base, { recursive: true, mode: 0o700 });
	const dir = fs.mkdtempSync(path.join(base, `${sanitize(runId)}-`));
	fs.chmodSync(dir, 0o700);
	return dir;
}

function sanitize(name: string): string {
	return name.replace(/[^\w.-]+/g, "_");
}

function writePrivate(filePath: string, content: string): void {
	fs.writeFileSync(filePath, content, { encoding: "utf-8", mode: 0o600 });
}

// ---------------------------------------------------------------------------
// Model catalog resolution
// ---------------------------------------------------------------------------

function catalogOf(registry: ExtensionContext["modelRegistry"]): CatalogEntry[] {
	const available = registry.getAvailable();
	const models = available.length > 0 ? available : registry.getAll();
	return models.map((m) => ({
		key: `${m.provider}/${m.id}`,
		provider: m.provider,
		id: m.id,
		name: m.name,
		reasoning: Boolean(m.reasoning),
	}));
}

function levenshtein(a: string, b: string): number {
	const m = a.length;
	const n = b.length;
	if (m === 0) return n;
	if (n === 0) return m;
	let prev = Array.from({ length: n + 1 }, (_, i) => i);
	for (let i = 1; i <= m; i++) {
		const curr = [i];
		for (let j = 1; j <= n; j++) {
			const cost = a[i - 1] === b[j - 1] ? 0 : 1;
			curr[j] = Math.min(prev[j] + 1, curr[j - 1] + 1, prev[j - 1] + cost);
		}
		prev = curr;
	}
	return prev[n];
}

function similarity(a: string, b: string): number {
	const longest = Math.max(a.length, b.length);
	if (longest === 0) return 1;
	return 1 - levenshtein(a, b) / longest;
}

function scoreEntry(entry: CatalogEntry, raw: string): number {
	const needle = raw.toLowerCase();
	const id = entry.id.toLowerCase();
	const key = entry.key.toLowerCase();
	const name = entry.name.toLowerCase();

	if (key === needle || id === needle) return 1000;
	if (name === needle) return 950;
	if (id.startsWith(needle) || key.startsWith(needle)) return 800 - Math.abs(id.length - needle.length);
	if (id.includes(needle) || key.includes(needle) || name.includes(needle)) return 600;

	const best = Math.max(similarity(needle, id), similarity(needle, name));
	return Math.round(best * 500);
}

/**
 * Resolve a user/parent supplied model string to a canonical `provider/id`.
 *
 * Accepts `provider/id`, a bare `id`, a display name, or any of those with a
 * `:<thinking>` suffix. Unknown values are fuzzy-matched against the catalog;
 * a miss returns the closest alternatives instead of spawning with a bad model.
 */
export function resolveModel(input: string, registry: ExtensionContext["modelRegistry"]): ModelResolution {
	let raw = input.trim();
	let thinking: ThinkingLevel | undefined;

	const colon = raw.lastIndexOf(":");
	if (colon > 0) {
		const suffix = raw.slice(colon + 1);
		if (isThinkingLevel(suffix)) {
			thinking = suffix;
			raw = raw.slice(0, colon);
		}
	}

	if (!raw) return { error: "Model string is empty." };

	const catalog = catalogOf(registry);
	if (catalog.length === 0) {
		// No catalog available: trust the CLI to validate the id.
		return { model: raw, thinking };
	}

	let best: CatalogEntry | undefined;
	let bestScore = -1;
	let ties = 0;
	for (const entry of catalog) {
		const score = scoreEntry(entry, raw);
		if (score > bestScore) {
			best = entry;
			bestScore = score;
			ties = 1;
		} else if (score === bestScore) {
			ties += 1;
		}
	}

	const exact = catalog.find(
		(e) => e.key.toLowerCase() === raw.toLowerCase() || e.id.toLowerCase() === raw.toLowerCase(),
	);
	const chosen = exact ?? best;

	// Require a real signal; below this the "closest match" is too far away to
	// be a typo and we refuse to silently spawn with the wrong model.
	if (!chosen || bestScore < 400) {
		const closest = catalog
			.map((e) => ({ entry: e, score: scoreEntry(e, raw) }))
			.sort((a, b) => b.score - a.score)
			.slice(0, 5)
			.map((c) => c.entry.key);
		return {
			error:
				`Unknown model "${input}". Available models use the form provider/id. ` +
				`Closest matches: ${closest.join(", ") || "(catalog empty)"}.`,
		};
	}

	if (exact === undefined && ties > 1 && bestScore < 900) {
		const alternatives = catalog
			.filter((e) => scoreEntry(e, raw) === bestScore)
			.slice(0, 5)
			.map((e) => e.key);
		return {
			error:
				`Model "${input}" is ambiguous. Matches: ${alternatives.join(", ")}. ` +
				`Pass an explicit provider/id.`,
		};
	}

	return { model: chosen.key, thinking };
}

/** Compact, grouped catalog for the spawn tool description. */
export function formatModelCatalog(registry: ExtensionContext["modelRegistry"]): string {
	const catalog = catalogOf(registry);
	if (catalog.length === 0) return "(no models discovered)";

	const byProvider = new Map<string, CatalogEntry[]>();
	for (const entry of catalog) {
		const list = byProvider.get(entry.provider) ?? [];
		list.push(entry);
		byProvider.set(entry.provider, list);
	}

	const lines: string[] = [];
	for (const [provider, entries] of byProvider) {
		lines.push(`- ${provider}: ${entries.map((e) => e.id).join(", ")}`);
	}
	return lines.join("\n");
}

// ---------------------------------------------------------------------------
// Child invocation
// ---------------------------------------------------------------------------

function getPiInvocation(args: string[]): { command: string; args: string[] } {
	const currentScript = process.argv[1];
	const isBunVirtualScript = currentScript?.startsWith("/$bunfs/root/");
	if (currentScript && !isBunVirtualScript && fs.existsSync(currentScript)) {
		return { command: process.execPath, args: [currentScript, ...args] };
	}

	const execName = path.basename(process.execPath).toLowerCase();
	const isGenericRuntime = /^(node|bun)(\.exe)?$/.test(execName);
	if (!isGenericRuntime) {
		return { command: process.execPath, args };
	}

	return { command: "pi", args };
}

/**
 * Environment hygiene: no herdr discovery for children, and no inherited
 * `HERDR_*` identifiers that could be used to address the parent's panes.
 */
export function childEnv(): NodeJS.ProcessEnv {
	const env: NodeJS.ProcessEnv = {};
	for (const [key, value] of Object.entries(process.env)) {
		if (key.startsWith("HERDR_")) continue;
		env[key] = value;
	}
	env.HERDR_ENV = "0";
	return env;
}

export function buildDelegationPrompt(options: {
	task: string;
	context?: string;
	scope?: string;
	deliverable?: string;
	reportPath: string;
	cwd: string;
}): string {
	const { task, context, scope, deliverable, reportPath, cwd } = options;
	return [
		"You are a sub-agent running in an isolated context window. You do not share the parent",
		"agent's conversation and cannot see its history. Complete exactly the task below, then",
		"produce a final report.",
		"",
		"## Task",
		task.trim(),
		"",
		"## Context",
		context?.trim() || "(none provided)",
		"",
		"## Scope",
		scope?.trim() || `Working directory: ${cwd}`,
		"",
		"## Deliverable",
		deliverable?.trim() ||
			"A markdown report: what you did, findings, files touched (with exact paths), and " +
				"anything the parent must know. Be concise and specific.",
		"",
		"## Report",
		`Your final assistant message is captured as the report. If you have the write tool,`,
		`also save the report to: ${reportPath}`,
		"",
		"## Cross-agent policy",
		CROSS_AGENT_POLICY,
	].join("\n");
}

function getFinalOutput(messages: Message[]): string {
	for (let i = messages.length - 1; i >= 0; i--) {
		const msg = messages[i];
		if (msg.role === "assistant") {
			for (const part of msg.content) {
				if (part.type === "text") return part.text;
			}
		}
	}
	return "";
}

function finalizeReport(run: SubagentRun): void {
	let report = "";
	try {
		if (fs.existsSync(run.reportPath)) {
			report = fs.readFileSync(run.reportPath, "utf-8").trim();
		}
	} catch {
		/* ignore */
	}

	if (!report) {
		report = getFinalOutput(run.messages).trim();
	}

	if (!report) {
		report = run.errorMessage || run.stderr.trim() || "(no output)";
	}

	// Persist whatever we captured so the report path is a durable artifact.
	try {
		if (!fs.existsSync(run.reportPath)) writePrivate(run.reportPath, report);
	} catch {
		/* ignore */
	}

	run.report = report;
}

/**
 * Start a headless child and resolve once it exits. The run object is mutated
 * in place as events arrive; `onProgress` is called for streaming updates and
 * `onSettled` once the final status/report are set.
 */
export function startHeadless(options: HeadlessSpawnOptions): Promise<void> {
	const { run, persona, delegationPrompt, signal, onProgress, onSettled } = options;

	const args: string[] = [
		"--mode",
		"json",
		"-p",
		"--no-session",
		"--no-extensions",
		"--no-skills",
		"-e",
		GUARD_PATH,
	];

	if (run.model) args.push("--model", run.model);
	if (run.thinking) args.push("--thinking", run.thinking);
	if (persona.tools && persona.tools.length > 0) args.push("--tools", persona.tools.join(","));

	let personaPath: string | null = null;
	if (persona.systemPrompt.trim()) {
		personaPath = path.join(run.dir, "persona.md");
		const systemPrompt = `${persona.systemPrompt.trim()}\n\n## Cross-agent policy\n${CROSS_AGENT_POLICY}\n`;
		writePrivate(personaPath, systemPrompt);
		args.push("--append-system-prompt", personaPath);
	}

	args.push(delegationPrompt);

	const controller = new AbortController();
	let wasAborted = false;
	run.abort = () => {
		wasAborted = true;
		controller.abort();
	};

	if (signal) {
		if (signal.aborted) run.abort();
		else signal.addEventListener("abort", () => run.abort(), { once: true });
	}

	return new Promise<void>((resolve) => {
		const invocation = getPiInvocation(args);
		const proc = spawn(invocation.command, invocation.args, {
			cwd: run.cwd,
			shell: false,
			stdio: ["ignore", "pipe", "pipe"],
			env: childEnv(),
		});

		let buffer = "";

		const processLine = (line: string) => {
			if (!line.trim()) return;
			let event: any;
			try {
				event = JSON.parse(line);
			} catch {
				return;
			}

			if (event.type === "message_end" && event.message) {
				const msg = event.message as Message;
				run.messages.push(msg);

				if (msg.role === "assistant") {
					run.usage.turns += 1;
					const usage = msg.usage;
					if (usage) {
						run.usage.input += usage.input || 0;
						run.usage.output += usage.output || 0;
						run.usage.cacheRead += usage.cacheRead || 0;
						run.usage.cacheWrite += usage.cacheWrite || 0;
						run.usage.cost += usage.cost?.total || 0;
						run.usage.contextTokens = usage.totalTokens || run.usage.contextTokens;
					}
					if (!run.model && msg.model) run.model = msg.model;
					if (msg.stopReason) run.stopReason = msg.stopReason;
					if (msg.errorMessage) run.errorMessage = msg.errorMessage;
				}
				onProgress?.(run);
			}

			if (event.type === "tool_result_end" && event.message) {
				run.messages.push(event.message as Message);
				onProgress?.(run);
			}
		};

		proc.stdout.on("data", (data) => {
			buffer += data.toString();
			const lines = buffer.split("\n");
			buffer = lines.pop() || "";
			for (const line of lines) processLine(line);
		});

		proc.stderr.on("data", (data) => {
			run.stderr += data.toString();
		});

		const kill = () => {
			try {
				proc.kill("SIGTERM");
			} catch {
				/* ignore */
			}
			setTimeout(() => {
				if (proc.exitCode === null && proc.signalCode === null) {
					try {
						proc.kill("SIGKILL");
					} catch {
						/* ignore */
					}
				}
			}, 5000);
		};

		controller.signal.addEventListener("abort", kill, { once: true });
		if (controller.signal.aborted) kill();

		proc.on("close", (code) => {
			if (buffer.trim()) processLine(buffer);
			run.exitCode = code ?? 0;
			run.endedAt = Date.now();

			const failed =
				wasAborted ||
				controller.signal.aborted ||
				run.stopReason === "aborted" ||
				(code ?? 0) !== 0 ||
				run.stopReason === "error";

			if (wasAborted || run.stopReason === "aborted") run.status = "aborted";
			else if (failed) run.status = "failed";
			else run.status = "done";

			finalizeReport(run);

			if (personaPath) {
				try {
					fs.unlinkSync(personaPath);
				} catch {
					/* ignore */
				}
			}

			onProgress?.(run);
			onSettled?.(run);
			resolve();
		});

		proc.on("error", (err) => {
			run.endedAt = Date.now();
			run.status = "failed";
			run.exitCode = 1;
			run.errorMessage = err instanceof Error ? err.message : String(err);
			finalizeReport(run);
			onSettled?.(run);
			resolve();
		});
	});
}

/** Directory holding guard.ts, reused by pane mode in phase 2. */
export function extensionDir(): string {
	return EXTENSION_DIR;
}

/** Default agent directory (user-scoped personas). */
export function userAgentsDir(): string {
	return path.join(getAgentDir(), "agents");
}

/**
 * Resolve dispatch mode according to Plan 3.1:
 *   - "pane": default when HERDR_ENV=1 and ctx.mode === "tui"
 *   - "headless": fallback when no herdr or ctx.mode !== "tui"
 */
export function resolveSpawnMode(
	requestedMode: "auto" | "pane" | "headless" | undefined,
	ctxMode: string,
): { mode: SpawnMode; error?: string } {
	if (requestedMode === "pane") {
		if (!isHerdrAvailable()) {
			return { mode: "pane", error: "Herdr is not available (HERDR_ENV !== 1). Cannot spawn in pane mode." };
		}
		if (ctxMode !== "tui") {
			return { mode: "pane", error: `Pane mode requires interactive TUI mode (current mode: ${ctxMode}).` };
		}
		return { mode: "pane" };
	}

	if (requestedMode === "headless") {
		return { mode: "headless" };
	}

	// "auto" (default)
	if (isHerdrAvailable() && ctxMode === "tui") {
		return { mode: "pane" };
	}
	return { mode: "headless" };
}

export interface PaneSpawnOptions {
	run: SubagentRun;
	persona: AgentConfig;
	delegationPrompt: string;
	layout: LayoutChoice;
	signal?: AbortSignal;
	activePaneCount: number;
}

/**
 * Start a sub-agent inside an interactive Herdr pane (Plan 3.1 & 3.5 & 4 Phase 2).
 * Returns once the child process is started and the initial prompt has reached `working`.
 */
export async function startPane(options: PaneSpawnOptions): Promise<void> {
	const { run, persona, delegationPrompt, layout, signal, activePaneCount } = options;

	run.mode = "pane";
	run.layout = layout;
	run.sessionId = crypto.randomUUID();

	const target = await resolveLayoutTarget({
		layout,
		cwd: run.cwd,
		activePaneSubagentsCount: activePaneCount,
	});

	run.paneId = target.paneId;
	run.tabId = target.tabId;
	run.agentName = run.id;

	const args: string[] = [
		"--session-id",
		run.sessionId,
		"--name",
		run.id,
		"--no-extensions",
		"--no-skills",
		"-e",
		GUARD_PATH,
	];

	if (run.model) args.push("--model", run.model);
	if (run.thinking) args.push("--thinking", run.thinking);
	if (persona.tools && persona.tools.length > 0) args.push("--tools", persona.tools.join(","));

	let personaPath: string | null = null;
	if (persona.systemPrompt.trim()) {
		personaPath = path.join(run.dir, "persona.md");
		const systemPrompt = `${persona.systemPrompt.trim()}\n\n## Cross-agent policy\n${CROSS_AGENT_POLICY}\n`;
		writePrivate(personaPath, systemPrompt);
		args.push("--append-system-prompt", personaPath);
	}

	run.abort = async (reason?: string) => {
		try {
			if (run.agentName) {
				await sendKeys(run.agentName, "ctrl+c");
			}
		} catch {
			/* ignore */
		}
		await new Promise((r) => setTimeout(r, 1000));
		try {
			if (run.paneId) {
				await closePane(run.paneId);
			}
		} catch {
			/* ignore */
		}
		run.status = "aborted";
		run.stopReason = reason ?? "aborted";
		run.endedAt = Date.now();
	};

	if (signal) {
		if (signal.aborted) {
			await run.abort("aborted by caller");
			return;
		}
		signal.addEventListener(
			"abort",
			() => {
				void run.abort("aborted by caller");
			},
			{ once: true },
		);
	}

	await startAgent({
		name: run.agentName,
		kind: "pi",
		paneId: run.paneId,
		timeoutMs: 60000,
		args,
	});

	await promptAgent(run.agentName, delegationPrompt, {
		wait: true,
		until: ["working", "done", "idle"],
		timeoutMs: 15000,
	});
}

