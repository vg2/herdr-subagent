/**
 * Agent (persona) discovery and configuration.
 *
 * Adapted from the shipped subagent example. The frontmatter format is
 * Claude-Code-compatible:
 *
 *     ---
 *     name: scout
 *     description: Fast codebase recon
 *     tools: read, grep, find, ls, bash
 *     model: provider/model-id      # optional
 *     thinking: low                 # optional
 *     cwd: /path/or/relative        # optional
 *     ---
 *
 *     System prompt body ...
 *
 * Phase 1 adds `thinking` and `cwd` on top of the shipped example.
 */

import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import type { ThinkingLevel } from "@earendil-works/pi-agent-core";
import { CONFIG_DIR_NAME, getAgentDir, parseFrontmatter } from "@earendil-works/pi-coding-agent";

export type AgentScope = "user" | "project" | "both";

/** Starter personas that ship inside the extension directory. */
export const BUNDLED_AGENTS_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), "agents");

export type AgentSource = "user" | "project" | "adhoc";

export interface AgentConfig {
	name: string;
	description: string;
	tools?: string[];
	model?: string;
	thinking?: ThinkingLevel;
	cwd?: string;
	systemPrompt: string;
	source: AgentSource;
	filePath: string;
}

export interface AgentDiscoveryResult {
	agents: AgentConfig[];
	projectAgentsDir: string | null;
}

export const THINKING_LEVELS: readonly ThinkingLevel[] = [
	"off",
	"minimal",
	"low",
	"medium",
	"high",
	"xhigh",
	"max",
] as const;

export function isThinkingLevel(value: unknown): value is ThinkingLevel {
	return typeof value === "string" && (THINKING_LEVELS as readonly string[]).includes(value);
}

/**
 * Raw agent frontmatter. Values are `unknown` because `parseFrontmatter` runs a
 * real YAML parser, so any scalar or collection can appear here.
 */
type AgentFrontmatter = {
	name?: unknown;
	description?: unknown;
	tools?: unknown;
	model?: unknown;
	thinking?: unknown;
	cwd?: unknown;
};

/**
 * Normalize a frontmatter `tools` value to a list of tool names.
 *
 * Both spellings are valid YAML and both are in use:
 *
 *     tools: read, bash        # string
 *     tools: [read, bash]      # array
 */
function parseToolList(value: unknown): string[] | undefined {
	const raw = Array.isArray(value) ? value : typeof value === "string" ? value.split(",") : [];
	const tools = raw
		.filter((t): t is string => typeof t === "string")
		.map((t) => t.trim())
		.filter(Boolean);
	return tools.length > 0 ? tools : undefined;
}

function parseAgentContent(
	content: string,
	source: AgentSource,
	filePath: string,
): AgentConfig | undefined {
	const { frontmatter, body } = parseFrontmatter<AgentFrontmatter>(content);

	if (typeof frontmatter.name !== "string" || typeof frontmatter.description !== "string") {
		return undefined;
	}

	return {
		name: frontmatter.name,
		description: frontmatter.description,
		tools: parseToolList(frontmatter.tools),
		model: typeof frontmatter.model === "string" ? frontmatter.model : undefined,
		thinking: isThinkingLevel(frontmatter.thinking) ? frontmatter.thinking : undefined,
		cwd: typeof frontmatter.cwd === "string" ? frontmatter.cwd : undefined,
		systemPrompt: body,
		source,
		filePath,
	};
}

function loadAgentsFromDir(dir: string, source: "user" | "project"): AgentConfig[] {
	const agents: AgentConfig[] = [];

	if (!fs.existsSync(dir)) {
		return agents;
	}

	let entries: fs.Dirent[];
	try {
		entries = fs.readdirSync(dir, { withFileTypes: true });
	} catch {
		return agents;
	}

	for (const entry of entries) {
		if (!entry.name.endsWith(".md")) continue;
		if (!entry.isFile() && !entry.isSymbolicLink()) continue;

		const filePath = path.join(dir, entry.name);
		let content: string;
		try {
			content = fs.readFileSync(filePath, "utf-8");
		} catch {
			continue;
		}

		const agent = parseAgentContent(content, source, filePath);
		if (agent) agents.push(agent);
	}

	return agents;
}

function isDirectory(p: string): boolean {
	try {
		return fs.statSync(p).isDirectory();
	} catch {
		return false;
	}
}

function findNearestProjectAgentsDir(cwd: string): string | null {
	let currentDir = cwd;
	while (true) {
		const candidate = path.join(currentDir, CONFIG_DIR_NAME, "agents");
		if (isDirectory(candidate)) return candidate;

		const parentDir = path.dirname(currentDir);
		if (parentDir === currentDir) return null;
		currentDir = parentDir;
	}
}

export function discoverAgents(cwd: string, scope: AgentScope): AgentDiscoveryResult {
	const userDir = path.join(getAgentDir(), "agents");
	const projectAgentsDir = findNearestProjectAgentsDir(cwd);

	// Bundled starter personas are treated as user-level defaults; a persona of
	// the same name in `~/.pi/agent/agents` or `.pi/agents` overrides them.
	const bundledAgents = scope === "project" ? [] : loadAgentsFromDir(BUNDLED_AGENTS_DIR, "user");
	const userAgents = scope === "project" ? [] : loadAgentsFromDir(userDir, "user");
	const projectAgents = scope === "user" || !projectAgentsDir ? [] : loadAgentsFromDir(projectAgentsDir, "project");

	const agentMap = new Map<string, AgentConfig>();

	if (scope === "both") {
		for (const agent of bundledAgents) agentMap.set(agent.name, agent);
		for (const agent of userAgents) agentMap.set(agent.name, agent);
		for (const agent of projectAgents) agentMap.set(agent.name, agent);
	} else if (scope === "user") {
		for (const agent of bundledAgents) agentMap.set(agent.name, agent);
		for (const agent of userAgents) agentMap.set(agent.name, agent);
	} else {
		for (const agent of projectAgents) agentMap.set(agent.name, agent);
	}

	return { agents: Array.from(agentMap.values()), projectAgentsDir };
}

/**
 * Resolve an ad-hoc `prompt` argument into an AgentConfig.
 *
 * If `prompt` points at an existing `.md` file it is parsed as a persona
 * definition; otherwise it is treated as an inline system prompt. Inline
 * personas are named `adhoc` and inherit the parent's tools/model unless
 * overridden per-spawn.
 */
export function loadAdhocAgent(prompt: string, cwd: string): AgentConfig {
	const candidate = path.isAbsolute(prompt) ? prompt : path.resolve(cwd, prompt);
	if (candidate.endsWith(".md") && fs.existsSync(candidate) && fs.statSync(candidate).isFile()) {
		const content = fs.readFileSync(candidate, "utf-8");
		const agent = parseAgentContent(content, "adhoc", candidate);
		if (agent) return agent;
	}

	return {
		name: "adhoc",
		description: "Ad-hoc persona supplied inline by the parent agent",
		systemPrompt: prompt,
		source: "adhoc",
		filePath: "(inline)",
	};
}

export function formatAgentList(agents: AgentConfig[], maxItems: number): { text: string; remaining: number } {
	if (agents.length === 0) return { text: "none", remaining: 0 };
	const listed = agents.slice(0, maxItems);
	const remaining = agents.length - listed.length;
	return {
		text: listed.map((a) => `${a.name} (${a.source}): ${a.description}`).join("; "),
		remaining,
	};
}
