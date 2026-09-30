/**
 * Issue board — the sanctioned cross-agent communication channel (Plan 3.7).
 *
 * Available to the parent session (registered from index.ts) and to every child
 * (children load this file with `-e issues.ts` alongside guard.ts).
 *
 * Two backends behind one tool surface:
 *   - GitHub checkouts (remote host github.com + `gh` available): `gh issue ...`
 *     scoped to the repository. Status transitions use `status:<state>` labels.
 *   - Everything else: a durable, diff-able file board at `<project>/.pi/issues/`
 *     (markdown files with YAML frontmatter).
 *
 * Contract for every issue written by an agent:
 *   - title is `[<agent>] <summary>` (the tools prefix it automatically)
 *   - body records the task, findings, and artifact paths
 *   - status transitions (open -> in-progress -> blocked -> done) are recorded
 *     by the working agent via `issue_comment`'s `status` param or `issue_close`.
 */

import { execFile } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import { parseFrontmatter, type ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type IssueStatus = "open" | "in-progress" | "blocked" | "done";

export const ISSUE_STATUSES: readonly IssueStatus[] = ["open", "in-progress", "blocked", "done"];

export interface IssueSummary {
	id: string;
	title: string;
	status: IssueStatus;
	labels: string[];
	assignee?: string;
	author?: string;
	updated?: string;
	url?: string;
}

export interface IssueComment {
	author?: string;
	createdAt?: string;
	body: string;
}

export interface IssueDetail extends IssueSummary {
	body: string;
	comments: IssueComment[];
}

export interface CommandResult {
	code: number;
	stdout: string;
	stderr: string;
}

export type CommandRunner = (
	command: string,
	args: string[],
	options?: { cwd?: string; input?: string },
) => Promise<CommandResult>;

export type Tracker =
	| { kind: "github"; root: string }
	| { kind: "file"; root: string; boardDir: string };

export interface IssueToolDetails {
	tracker?: "github" | "file";
	id?: string;
	count?: number;
	error?: string;
}

// ---------------------------------------------------------------------------
// Command execution
// ---------------------------------------------------------------------------

export const defaultRunner: CommandRunner = (command, args, options = {}) =>
	new Promise((resolve) => {
		const child = execFile(
			command,
			args,
			{ cwd: options.cwd, maxBuffer: 10 * 1024 * 1024 },
			(error: any, stdout, stderr) => {
				const code = error ? (typeof error.code === "number" ? error.code : 1) : 0;
				resolve({ code, stdout: stdout ?? "", stderr: stderr ?? "" });
			},
		);
		if (options.input !== undefined) {
			try {
				child.stdin?.end(options.input);
			} catch {
				/* stdin already closed */
			}
		}
	});

// ---------------------------------------------------------------------------
// Tracker detection
// ---------------------------------------------------------------------------

export function normalizeStatus(value: unknown): IssueStatus {
	return typeof value === "string" && (ISSUE_STATUSES as readonly string[]).includes(value)
		? (value as IssueStatus)
		: "open";
}

/**
 * Whether a status is represented by a `status:<state>` label. `open` is the
 * default state and `done` is represented by the closed issue itself, so only
 * the active in-between states carry a label (shared by issue_create and
 * applyGhStatus so both paths agree).
 */
export function wantStatusLabel(status: IssueStatus): boolean {
	return status !== "done" && status !== "open";
}

/**
 * Nearest shared project root (falls back to cwd when not a git checkout).
 *
 * Uses `--git-common-dir` so a linked worktree resolves to the main checkout:
 * the issue board must stay shared across worktree-isolated sub-agents.
 */
export async function findProjectRoot(cwd: string, run: CommandRunner = defaultRunner): Promise<string> {
	const common = await run("git", ["-C", cwd, "rev-parse", "--git-common-dir"]);
	if (common.code === 0 && common.stdout.trim()) {
		const raw = common.stdout.trim();
		const abs = path.isAbsolute(raw) ? raw : path.resolve(cwd, raw);
		if (path.basename(abs) === ".git") return path.dirname(abs);
	}

	const top = await run("git", ["-C", cwd, "rev-parse", "--show-toplevel"]);
	if (top.code === 0 && top.stdout.trim()) return top.stdout.trim();
	return cwd;
}

export async function detectTracker(cwd: string, run: CommandRunner = defaultRunner): Promise<Tracker> {
	const root = await findProjectRoot(cwd, run);
	const remote = await run("git", ["-C", root, "config", "--get", "remote.origin.url"]);
	const url = remote.code === 0 ? remote.stdout.trim() : "";
	const looksGitHub = /github\.com[:/]/i.test(url);

	if (looksGitHub) {
		const gh = await run("gh", ["--version"]);
		if (gh.code === 0) return { kind: "github", root };
	}

	return { kind: "file", root, boardDir: path.join(root, ".pi", "issues") };
}

const trackerCache = new Map<string, Promise<Tracker>>();

/** Cached detection (successes only, so a transient git/gh failure can recover). */
export function resolveTracker(cwd: string): Promise<Tracker> {
	const key = path.resolve(cwd);
	const cached = trackerCache.get(key);
	if (cached) return cached;

	const pending = detectTracker(key).catch((err) => {
		trackerCache.delete(key);
		throw err;
	});
	trackerCache.set(key, pending);
	return pending;
}

export function clearTrackerCache(): void {
	trackerCache.clear();
}

// ---------------------------------------------------------------------------
// File board
// ---------------------------------------------------------------------------

interface FileIssueMeta extends Record<string, unknown> {
	id?: unknown;
	title?: unknown;
	status?: unknown;
	labels?: unknown;
	assignee?: unknown;
	author?: unknown;
	created?: unknown;
	updated?: unknown;
}

function stringList(value: unknown): string[] {
	if (Array.isArray(value)) return value.filter((v): v is string => typeof v === "string");
	if (typeof value === "string" && value.trim()) return [value.trim()];
	return [];
}

function yamlScalar(value: string): string {
	return JSON.stringify(value);
}

export function serializeFrontmatter(meta: Record<string, unknown>): string {
	const lines = ["---"];
	for (const [key, value] of Object.entries(meta)) {
		if (value === undefined || value === null) continue;
		if (Array.isArray(value)) {
			lines.push(`${key}: [${value.map((v) => yamlScalar(String(v))).join(", ")}]`);
		} else if (typeof value === "number" || typeof value === "boolean") {
			lines.push(`${key}: ${value}`);
		} else {
			lines.push(`${key}: ${yamlScalar(String(value))}`);
		}
	}
	lines.push("---");
	return lines.join("\n");
}

export function slugify(title: string): string {
	return (
		title
			.toLowerCase()
			.replace(/\[[^\]]*\]/g, " ")
			.replace(/[^a-z0-9]+/g, "-")
			.replace(/^-+|-+$/g, "")
			.slice(0, 48)
			.replace(/-+$/, "") || "issue"
	);
}

function issueFilePath(boardDir: string, id: string): string | null {
	if (!fs.existsSync(boardDir)) return null;
	const padded = /^\d+$/.test(id) ? String(Number(id)).padStart(4, "0") : id;
	const files = fs.readdirSync(boardDir).filter((f) => f.endsWith(".md"));
	const match = files.find((f) => f.startsWith(`${padded}-`) || f === `${padded}.md` || f === id);
	return match ? path.join(boardDir, match) : null;
}

function parseIssueFile(filePath: string): IssueDetail | null {
	let content: string;
	try {
		content = fs.readFileSync(filePath, "utf-8");
	} catch {
		return null;
	}

	const { frontmatter, body } = parseFrontmatter<FileIssueMeta>(content);
	const base = path.basename(filePath, ".md");
	const id =
		typeof frontmatter.id === "number" || typeof frontmatter.id === "string"
			? String(frontmatter.id)
			: base.split("-")[0];
	const title = typeof frontmatter.title === "string" ? frontmatter.title : base;
	const rawLabels = stringList(frontmatter.labels);
	const status = normalizeStatus(frontmatter.status);

	const comments: IssueComment[] = [];
	let issueBody = body;
	const commentsIdx = body.indexOf("\n## Comments");
	const bodyText = commentsIdx >= 0 ? body.slice(0, commentsIdx) : body;
	issueBody = bodyText.trim();

	if (commentsIdx >= 0) {
		const commentsText = body.slice(commentsIdx + "\n## Comments".length);
		for (const chunk of commentsText.split(/\n### /).slice(1)) {
			const newline = chunk.indexOf("\n");
			const heading = newline >= 0 ? chunk.slice(0, newline) : chunk;
			const text = newline >= 0 ? chunk.slice(newline + 1) : "";
			const [createdAt, author] = heading.split(" — ").map((s) => s.trim());
			comments.push({ createdAt, author: author || undefined, body: text.trim() });
		}
	}

	return {
		id,
		title,
		status,
		labels: rawLabels,
		assignee: typeof frontmatter.assignee === "string" ? frontmatter.assignee : undefined,
		author: typeof frontmatter.author === "string" ? frontmatter.author : undefined,
		updated: typeof frontmatter.updated === "string" ? frontmatter.updated : undefined,
		body: issueBody,
		comments,
	};
}

function nextIssueId(boardDir: string): number {
	if (!fs.existsSync(boardDir)) return 1;
	let max = 0;
	for (const file of fs.readdirSync(boardDir)) {
		const match = /^(\d+)-/.exec(file);
		if (match) max = Math.max(max, Number(match[1]));
	}
	return max + 1;
}

export interface FileIssueInput {
	title: string;
	body: string;
	labels?: string[];
	assignee?: string;
	author?: string;
	status?: IssueStatus;
}

export function createFileIssue(boardDir: string, input: FileIssueInput): { id: string; title: string; filePath: string } {
	fs.mkdirSync(boardDir, { recursive: true });
	const id = nextIssueId(boardDir);
	const title = input.title;
	const now = new Date().toISOString();
	const meta: Record<string, unknown> = {
		id,
		title,
		status: input.status ?? "open",
		labels: input.labels ?? [],
		assignee: input.assignee,
		author: input.author,
		created: now,
		updated: now,
	};
	const filePath = path.join(boardDir, `${String(id).padStart(4, "0")}-${slugify(title)}.md`);
	if (fs.existsSync(filePath)) throw new Error(`Issue file already exists: ${filePath}`);
	fs.writeFileSync(filePath, `${serializeFrontmatter(meta)}\n\n${input.body.trim()}\n`, {
		encoding: "utf-8",
		mode: 0o644,
	});
	return { id: String(id), title, filePath };
}

export interface FileIssueFilter {
	status?: IssueStatus | "all";
	label?: string;
	assignee?: string;
	limit?: number;
}

export function listFileIssues(boardDir: string, filter: FileIssueFilter = {}): IssueSummary[] {
	if (!fs.existsSync(boardDir)) return [];
	const status = filter.status ?? "all";
	const limit = filter.limit && filter.limit > 0 ? filter.limit : 20;

	const issues: IssueSummary[] = [];
	for (const file of fs.readdirSync(boardDir)) {
		if (!file.endsWith(".md")) continue;
		const detail = parseIssueFile(path.join(boardDir, file));
		if (!detail) continue;
		if (status !== "all" && detail.status !== status) continue;
		if (filter.label && !detail.labels.includes(filter.label)) continue;
		if (filter.assignee && detail.assignee !== filter.assignee) continue;
		const { body: _body, comments: _comments, ...summary } = detail;
		issues.push(summary);
	}

	issues.sort((a, b) => Number(b.id) - Number(a.id));
	return issues.slice(0, limit);
}

export function readFileIssue(boardDir: string, id: string): IssueDetail | null {
	const filePath = issueFilePath(boardDir, id);
	return filePath ? parseIssueFile(filePath) : null;
}

function updateFileIssue(
	boardDir: string,
	id: string,
	patch: (meta: Record<string, unknown>, body: string) => { meta?: Record<string, unknown>; body?: string },
): IssueDetail | null {
	const filePath = issueFilePath(boardDir, id);
	if (!filePath) return null;

	const content = fs.readFileSync(filePath, "utf-8");
	const { frontmatter, body } = parseFrontmatter<FileIssueMeta>(content);
	const meta: Record<string, unknown> = { ...frontmatter };
	const { meta: metaPatch, body: bodyPatch } = patch(meta, body);

	Object.assign(meta, metaPatch ?? {}, { updated: new Date().toISOString() });
	const finalBody = bodyPatch ?? body;
	fs.writeFileSync(filePath, `${serializeFrontmatter(meta)}\n\n${finalBody.replace(/^\n+/, "")}`, {
		encoding: "utf-8",
		mode: 0o644,
	});
	return parseIssueFile(filePath);
}

export function addFileIssueComment(
	boardDir: string,
	id: string,
	input: { body: string; author?: string; status?: IssueStatus },
): IssueDetail | null {
	return updateFileIssue(boardDir, id, (meta, body) => {
		if (input.status) meta.status = input.status;
		const heading = input.author ? `${new Date().toISOString()} — ${input.author}` : new Date().toISOString();
		const block = `### ${heading}\n\n${input.body.trim()}\n`;
		const nextBody = body.includes("\n## Comments")
			? `${body.replace(/\s*$/, "")}\n\n${block}`
			: `${body.replace(/\s*$/, "")}\n\n## Comments\n\n${block}`;
		return { body: nextBody };
	});
}

export function closeFileIssue(
	boardDir: string,
	id: string,
	input: { comment?: string; author?: string } = {},
): IssueDetail | null {
	const detail = updateFileIssue(boardDir, id, (meta, body) => {
		meta.status = "done";
		let nextBody = body;
		if (input.comment?.trim()) {
			const heading = input.author ? `${new Date().toISOString()} — ${input.author}` : new Date().toISOString();
			const block = `### ${heading}\n\n${input.comment.trim()}\n`;
			nextBody = body.includes("\n## Comments")
				? `${body.replace(/\s*$/, "")}\n\n${block}`
				: `${body.replace(/\s*$/, "")}\n\n## Comments\n\n${block}`;
		}
		return { body: nextBody };
	});
	return detail;
}

// ---------------------------------------------------------------------------
// GitHub backend
// ---------------------------------------------------------------------------

function ghArgs(root: string, args: string[]): string[] {
	return ["-C", root, ...args];
}

async function gh(
	root: string,
	args: string[],
	options: { input?: string; run?: CommandRunner } = {},
): Promise<CommandResult> {
	return (options.run ?? defaultRunner)("gh", ghArgs(root, args), { cwd: root, input: options.input });
}

interface GhLabelJson {
	name: string;
}

/**
 * Ensure each label exists on the repository. `gh issue create` fails the whole
 * issue when a label is missing, and agent-shaped labels (e.g. `agent:scout`)
 * are normally new, so the board creates them on demand. Existing labels are
 * left untouched (checked first, no `--force`) so repository colors survive.
 */
export async function ensureGhLabels(
	root: string,
	names: string[],
	run: CommandRunner = defaultRunner,
): Promise<string | null> {
	const unique = Array.from(new Set(names.map((n) => n.trim()).filter(Boolean)));
	if (unique.length === 0) return null;

	const existing = new Set<string>();
	const listed = await gh(root, ["label", "list", "--limit", "200", "--json", "name"], { run });
	if (listed.code === 0) {
		try {
			for (const label of JSON.parse(listed.stdout || "[]") as GhLabelJson[]) existing.add(label.name);
		} catch {
			/* fall through to create-and-recheck */
		}
	}

	for (const name of unique) {
		if (existing.has(name)) continue;
		const created = await gh(root, ["label", "create", name, "--color", "ededed"], { run });
		if (created.code !== 0) {
			// Race, or the label exists beyond the list limit: verify before failing.
			let found = false;
			const recheck = await gh(
				root,
				["label", "list", "--search", name, "--limit", "50", "--json", "name"],
				{ run },
			);
			if (recheck.code === 0) {
				try {
					found = (JSON.parse(recheck.stdout || "[]") as GhLabelJson[]).some((l) => l.name === name);
				} catch {
					/* ignore */
				}
			}
			if (!found) return created.stderr.trim() || `could not create label "${name}"`;
		}
		existing.add(name);
	}
	return null;
}

export interface GhCreateIssueInput {
	title: string;
	body: string;
	labels: string[];
	assignee?: string;
}

export interface GhCreateIssueResult {
	result: CommandResult;
	/** Set when the initial attempt failed and the no-assignee retry succeeded. */
	assigneeSkipped?: string;
	/** Error of the first (assignee) attempt, kept so the skip/failure reason is accurate. */
	assigneeError?: string;
	/** True when both attempts failed; `result` is then the no-assignee attempt. */
	retriedWithoutAssignee?: boolean;
}

/**
 * Create a GitHub issue. Assignees must be real GitHub logins, so an
 * agent-shaped name (e.g. "scout") would fail the entire create; in that case
 * the issue is retried without the assignee and the caller reports the skip,
 * together with the original error so an unrelated failure is not mislabeled.
 */
export async function ghCreateIssue(
	root: string,
	input: GhCreateIssueInput,
	run: CommandRunner = defaultRunner,
): Promise<GhCreateIssueResult> {
	const base = [
		"issue",
		"create",
		"--title",
		input.title,
		"--body-file",
		"-",
		...input.labels.flatMap((label) => ["--label", label]),
	];
	const attempt = (assignee?: string) => {
		const args = [...base];
		if (assignee) args.push("--assignee", assignee);
		return gh(root, args, { input: input.body, run });
	};

	const result = await attempt(input.assignee);
	if (result.code === 0 || !input.assignee) return { result };

	const assigneeError = result.stderr.trim() || "gh issue create failed";
	const retry = await attempt(undefined);
	if (retry.code === 0) return { result: retry, assigneeSkipped: input.assignee, assigneeError };
	return { result: retry, assigneeError, retriedWithoutAssignee: true };
}

interface GhIssueStateJson {
	state?: string;
	labels?: GhLabelJson[];
}

async function ghStatusLabels(
	root: string,
	id: string,
	run: CommandRunner,
): Promise<{ state?: string; labels: string[] } | null> {
	const res = await gh(root, ["issue", "view", id, "--json", "state,labels"], { run });
	if (res.code !== 0) return null;
	try {
		const data = JSON.parse(res.stdout || "{}") as GhIssueStateJson;
		return {
			state: data.state,
			labels: (data.labels ?? []).map((l) => l.name).filter((name) => name.startsWith("status:")),
		};
	} catch {
		return null;
	}
}

export interface GhStatusResult {
	/** The transition itself failed (edit/close/reopen); nothing reliable applied. */
	error?: string;
	/**
	 * The transition applied, but the `status:<state>` label could not be created
	 * or applied (e.g. no triage permission). Displayed status falls back to
	 * `open`, mirroring `issue_create`'s label fallback instead of failing the
	 * whole transition.
	 */
	warning?: string;
}

/**
 * Record a status transition on a GitHub issue. `done` is represented by the
 * closed state (every `status:*` label is removed, then the issue is closed)
 * and `open` by the absence of a status label, matching `issue_create`; the
 * active in-between states carry `status:<state>` with every stale label
 * removed. An issue moved from closed back to an active state is reopened.
 *
 * Label-creation failures are reported as a `warning` rather than aborting the
 * transition, so the comment or close the caller already made is not reported
 * as failed and stale labels are still cleaned up.
 */
export async function applyGhStatus(
	root: string,
	id: string,
	status: IssueStatus,
	run: CommandRunner = defaultRunner,
): Promise<GhStatusResult> {
	const current = await ghStatusLabels(root, id, run);
	const statusLabels = current?.labels ?? [];
	const target = `status:${status}`;
	// done/open are represented by the issue state itself, so every status label
	// is stale; active states keep the target label and drop the rest.
	const wantLabel = wantStatusLabel(status);
	const stale = statusLabels.filter((name) => name !== target || !wantLabel);

	if (status === "done") {
		if (stale.length > 0) {
			const res = await gh(
				root,
				["issue", "edit", id, ...stale.flatMap((label) => ["--remove-label", label])],
				{ run },
			);
			if (res.code !== 0) return { error: res.stderr.trim() || "gh issue edit failed" };
		}
		// Already closed: idempotent, and the stale labels above are still gone.
		if (current?.state?.toLowerCase() === "closed") return {};
		const res = await gh(root, ["issue", "close", id], { run });
		return res.code === 0 ? {} : { error: res.stderr.trim() || "gh issue close failed" };
	}

	const addLabel = wantLabel && !statusLabels.includes(target);
	let warning: string | undefined;
	if (addLabel) {
		const labelError = await ensureGhLabels(root, [target], run);
		if (labelError) warning = `status label "${target}" was not applied (${labelError})`;
	}

	const args = ["issue", "edit", id];
	if (addLabel && !warning) args.push("--add-label", target);
	for (const label of stale) args.push("--remove-label", label);
	if (args.length > 3) {
		const res = await gh(root, args, { run });
		if (res.code !== 0) return { error: res.stderr.trim() || "gh issue edit failed" };
	}

	if (current?.state?.toLowerCase() === "closed") {
		const res = await gh(root, ["issue", "reopen", id], { run });
		if (res.code !== 0) return { error: res.stderr.trim() || "gh issue reopen failed" };
	}
	return warning ? { warning } : {};
}

interface GhIssueJson {
	number: number;
	title: string;
	state: string;
	body?: string;
	labels?: Array<{ name: string }>;
	assignees?: Array<{ login: string }>;
	author?: { login: string };
	url?: string;
	updatedAt?: string;
	comments?: Array<{ author?: { login: string }; createdAt?: string; body?: string }>;
}

function ghStatusOf(issue: GhIssueJson): IssueStatus {
	if (issue.state?.toLowerCase() === "closed") return "done";
	const statusLabel = issue.labels?.map((l) => l.name).find((name) => name.startsWith("status:"));
	return normalizeStatus(statusLabel?.slice("status:".length));
}

function toGhDetail(issue: GhIssueJson): IssueDetail {
	return {
		id: String(issue.number),
		title: issue.title,
		status: ghStatusOf(issue),
		labels: (issue.labels ?? []).map((l) => l.name).filter((name) => !name.startsWith("status:")),
		assignee: issue.assignees?.[0]?.login,
		author: issue.author?.login,
		updated: issue.updatedAt,
		url: issue.url,
		body: issue.body ?? "",
		comments: (issue.comments ?? []).map((c) => ({
			author: c.author?.login,
			createdAt: c.createdAt,
			body: c.body ?? "",
		})),
	};
}

async function ghList(root: string, filter: FileIssueFilter): Promise<IssueDetail[]> {
	const args = [
		"issue",
		"list",
		"--state",
		"all",
		"--json",
		"number,title,state,labels,assignees,author,url,updatedAt,body,comments",
		"--limit",
		String(filter.limit && filter.limit > 0 ? filter.limit : 20),
	];
	if (filter.label) args.push("--label", filter.label);
	if (filter.assignee) args.push("--assignee", filter.assignee);

	const res = await gh(root, args);
	if (res.code !== 0) throw new Error(res.stderr.trim() || "gh issue list failed");

	const issues = JSON.parse(res.stdout || "[]") as GhIssueJson[];
	return issues
		.map(toGhDetail)
		.filter((issue) => {
			const status = filter.status ?? "all";
			return status === "all" || issue.status === status;
		});
}

// ---------------------------------------------------------------------------
// Shared helpers
// ---------------------------------------------------------------------------

/**
 * Resolve the author for issue attribution: explicit param, then the child
 * identity env (set at spawn), then the pi session name (a `sa-*` run id, set
 * on every pane child), then `parent`.
 */
export function resolveAuthor(
	explicit?: string,
	ctx?: { sessionManager?: { getSessionName?(): string | undefined } },
): string {
	if (explicit?.trim()) return explicit.trim();
	const env = process.env.PI_SUBAGENT_AGENT?.trim();
	if (env) return env;

	let sessionName: string | undefined;
	try {
		sessionName = ctx?.sessionManager?.getSessionName?.()?.trim();
	} catch {
		/* session lookup is best-effort */
	}
	if (sessionName && sessionName.startsWith("sa-")) return sessionName;

	return "parent";
}

export function ensureAuthorPrefix(title: string, author: string): string {
	return title.trim().startsWith("[") ? title.trim() : `[${author}] ${title.trim()}`;
}

function summarize(issue: IssueSummary): string {
	const labels = issue.labels.length > 0 ? ` {${issue.labels.join(", ")}}` : "";
	const assignee = issue.assignee ? ` @${issue.assignee}` : "";
	const author = issue.author ? ` by ${issue.author}` : "";
	return `#${issue.id} [${issue.status}] ${issue.title}${labels}${assignee}${author}`;
}

function renderDetail(issue: IssueDetail): string {
	const lines = [summarize(issue)];
	if (issue.url) lines.push(`url: ${issue.url}`);
	if (issue.body.trim()) lines.push("", issue.body.trim());
	if (issue.comments.length > 0) {
		lines.push("", `Comments (${issue.comments.length}):`);
		for (const comment of issue.comments) {
			const when = comment.createdAt ? ` at ${comment.createdAt}` : "";
			lines.push(`- ${comment.author ?? "unknown"}${when}: ${comment.body.trim()}`);
		}
	}
	return lines.join("\n");
}

function ok(text: string, details: IssueToolDetails) {
	return { content: [{ type: "text" as const, text }], details };
}

function fail(text: string, details: IssueToolDetails = {}) {
	return { content: [{ type: "text" as const, text }], details: { ...details, error: text }, isError: true };
}

// ---------------------------------------------------------------------------
// Tool registration
// ---------------------------------------------------------------------------

export const ISSUE_TOOL_NAMES = [
	"issue_create",
	"issue_comment",
	"issue_list",
	"issue_get",
	"issue_close",
] as const;

const StatusSchema = Type.Optional(
	Type.Union(
		[
			Type.Literal("open"),
			Type.Literal("in-progress"),
			Type.Literal("blocked"),
			Type.Literal("done"),
		],
		{ description: "Lifecycle state for the issue." },
	),
);

const IssueToolGuidelines = [
	"The issue board is the only sanctioned channel for cross-agent coordination: record findings, blockers, and hand-offs with issue_create/issue_comment instead of messaging other agents.",
	"Issue titles follow `[<agent>] <summary>`; the tools add the `[<agent>]` prefix automatically.",
];

/**
 * Register the issue_* tools. Safe to call from the main extension (parent
 * session) and from a standalone `-e issues.ts` load (child sessions).
 */
export function registerIssueTools(pi: ExtensionAPI): void {
	pi.registerTool({
		name: "issue_create",
		label: "Create Issue",
		description:
			"Create an issue on the project board (GitHub via `gh` for GitHub checkouts, otherwise a file board " +
			"at `<project>/.pi/issues/`). Use this to record delegated work, findings, blockers, or hand-offs for " +
			"other agents and the human. The title is prefixed with the author (`[<agent>] <summary>`). " +
			"Body should state the task, findings, and any artifact paths. Optionally set status or labels.",
		promptSnippet: "Create a shared issue on the project board",
		promptGuidelines: IssueToolGuidelines,
		parameters: Type.Object({
			title: Type.String({ description: "Issue summary (the `[<agent>]` prefix is added automatically)." }),
			body: Type.String({ description: "Task, findings, and artifact paths. Markdown is fine." }),
			labels: Type.Optional(Type.Array(Type.String(), { description: "Labels to apply." })),
			assignee: Type.Optional(
				Type.String({
					description:
						"Agent or user responsible for the issue. On GitHub checkouts the value must be an existing " +
						"GitHub login; agent-shaped names are recorded on the file board and reported as skipped on GitHub.",
				}),
			),
			status: StatusSchema,
			agent: Type.Optional(
				Type.String({ description: "Author name override. Defaults to the sub-agent name, or `parent`." }),
			),
		}),

		async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
			const author = resolveAuthor(params.agent, ctx);
			const title = ensureAuthorPrefix(params.title, author);
			const status = normalizeStatus(params.status);

			try {
				const tracker = await resolveTracker(ctx.cwd);
				if (tracker.kind === "github") {
					const labels = [...new Set(params.labels ?? [])];
					const statusLabel = `status:${status}`;
					// done is represented by the closed state and open by the absence of a
					// status label (see applyGhStatus); only active states get a label.
					if (wantStatusLabel(status) && !labels.includes(statusLabel)) labels.push(statusLabel);

					// Labels that cannot be created (e.g. no triage permission) must not
					// sink the whole issue. Create with the ones that do apply and report
					// the rest, mirroring the assignee fallback below.
					let effectiveLabels = labels;
					let labelWarning = await ensureGhLabels(tracker.root, labels);
					if (labelWarning) {
						// One bad label must not drop the others: retry individually and
						// keep every label that can be applied.
						effectiveLabels = [];
						const unapplied: string[] = [];
						for (const label of labels) {
							if ((await ensureGhLabels(tracker.root, [label])) === null) effectiveLabels.push(label);
							else unapplied.push(label);
						}
						labelWarning = unapplied.join(", ");
					}

					const { result, assigneeSkipped, assigneeError, retriedWithoutAssignee } = await ghCreateIssue(
						tracker.root,
						{
							title,
							body: params.body,
							labels: effectiveLabels,
							assignee: params.assignee,
						},
					);
					if (result.code !== 0) {
						let msg = result.stderr.trim() || "gh issue create failed";
						if (retriedWithoutAssignee) {
							msg += `\n(retry without the assignee also failed; first attempt: ${assigneeError})`;
						}
						return fail(msg, { tracker: "github" });
					}
					const id = result.stdout.match(/\/issues\/(\d+)/)?.[1];
					const url = result.stdout.trim().split("\n").pop() ?? "";

					if (status === "done" && id) {
						const closeResult = await applyGhStatus(tracker.root, id, "done");
						if (closeResult.error) {
							return fail(`Created issue #${id} but closing it as done failed: ${closeResult.error}`, {
								tracker: "github",
								id,
							});
						}
					}

					const notes: string[] = [];
					if (labelWarning) notes.push(`labels not applied: ${labelWarning}`);
					if (status === "done" && !id) {
						notes.push("could not determine the issue number to close it; close it manually");
					}
					if (assigneeSkipped) {
						notes.push(
							`assignee "${assigneeSkipped}" was not applied (first attempt failed: ${assigneeError ?? "unknown error"}); ` +
								"GitHub assignees must be GitHub logins — use labels for agent assignment",
						);
					}
					const suffix = notes.length > 0 ? `\n(${notes.join("; ")})` : "";
					// Only claim it was closed when the issue number was known and the close
					// actually ran; otherwise the note above explains the fallback.
					const closed = status === "done" && id ? " (closed as done)" : "";
					return ok(`Created issue #${id ?? "?"}: ${title}${closed}${url ? `\n${url}` : ""}${suffix}`, {
						tracker: "github",
						id,
					});
				}

				const created = createFileIssue(tracker.boardDir, {
					title,
					body: params.body,
					labels: params.labels,
					assignee: params.assignee,
					author,
					status,
				});
				return ok(
					`Created issue #${created.id}: ${title}\nboard: ${tracker.boardDir}\nfile: ${created.filePath}`,
					{ tracker: "file", id: created.id },
				);
			} catch (err: any) {
				return fail(`Failed to create issue: ${err?.message ?? String(err)}`);
			}
		},
	});

	pi.registerTool({
		name: "issue_comment",
		label: "Comment on Issue",
		description:
			"Append a comment to an issue on the project board. Use it to report progress, findings, or blockers " +
			"and to record a status transition (open -> in-progress -> blocked -> done).",
		promptSnippet: "Comment on a shared issue and optionally transition its status",
		promptGuidelines: IssueToolGuidelines,
		parameters: Type.Object({
			id: Type.String({ description: "Issue number/id on the board." }),
			body: Type.String({ description: "Comment body (markdown is fine)." }),
			status: StatusSchema,
			agent: Type.Optional(Type.String({ description: "Author name override." })),
		}),

		async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
			const author = resolveAuthor(params.agent, ctx);
			const status = params.status ? normalizeStatus(params.status) : undefined;

			try {
				const tracker = await resolveTracker(ctx.cwd);
				if (tracker.kind === "github") {
					const res = await gh(tracker.root, ["issue", "comment", params.id, "--body-file", "-"], {
						input: params.body,
					});
					if (res.code !== 0) return fail(res.stderr.trim() || "gh issue comment failed", { tracker: "github" });
					let statusNote = "";
					let appliedStatus = status;
					if (status) {
						const statusResult = await applyGhStatus(tracker.root, params.id, status);
						if (statusResult.error) {
							return fail(
								`Comment posted, but the status transition to "${status}" failed: ${statusResult.error}`,
								{ tracker: "github", id: params.id },
							);
						}
						if (statusResult.warning) {
							statusNote = `\n(${statusResult.warning})`;
							// The label could not be applied, so the effective status is
							// open; report what was applied, not what was requested.
							appliedStatus = "open";
						}
					}
					return ok(
						`Commented on issue #${params.id}${status ? ` (status: ${appliedStatus})` : ""}.${statusNote}`,
						{ tracker: "github", id: params.id },
					);
				}

				const updated = addFileIssueComment(tracker.boardDir, params.id, { body: params.body, author, status });
				if (!updated) return fail(`Issue #${params.id} not found on the file board.`, { tracker: "file" });
				return ok(`Commented on issue #${updated.id}${status ? ` (status: ${updated.status})` : ""}.`, {
					tracker: "file",
					id: updated.id,
				});
			} catch (err: any) {
				return fail(`Failed to comment on issue #${params.id}: ${err?.message ?? String(err)}`);
			}
		},
	});

	pi.registerTool({
		name: "issue_list",
		label: "List Issues",
		description:
			"List issues on the project board, newest first. Check this before starting delegated work to pick up " +
			"dependencies, findings, or blockers recorded by other agents. Filter by status, label, or assignee.",
		promptSnippet: "List shared issues recorded by other agents",
		promptGuidelines: IssueToolGuidelines,
		parameters: Type.Object({
			status: Type.Optional(
				Type.Union(
					[
						Type.Literal("open"),
						Type.Literal("in-progress"),
						Type.Literal("blocked"),
						Type.Literal("done"),
						Type.Literal("all"),
					],
					{ description: 'Filter by lifecycle state. Default: "all".' },
				),
			),
			label: Type.Optional(Type.String({ description: "Only issues with this label." })),
			assignee: Type.Optional(Type.String({ description: "Only issues assigned to this agent/user." })),
			limit: Type.Optional(Type.Number({ description: "Maximum issues to return. Default: 20.", default: 20 })),
		}),

		async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
			const filter: FileIssueFilter = {
				status: params.status ?? "all",
				label: params.label,
				assignee: params.assignee,
				limit: params.limit ?? 20,
			};

			try {
				const tracker = await resolveTracker(ctx.cwd);
				if (tracker.kind === "github") {
					const issues = await ghList(tracker.root, filter);
					const text =
						issues.length === 0
							? "No issues matched."
							: issues.map(summarize).join("\n");
					return ok(text, { tracker: "github", count: issues.length });
				}

				const issues = listFileIssues(tracker.boardDir, filter);
				const text =
					issues.length === 0
						? `No issues matched.\nboard: ${tracker.boardDir}`
						: `${issues.map(summarize).join("\n")}\nboard: ${tracker.boardDir}`;
				return ok(text, { tracker: "file", count: issues.length });
			} catch (err: any) {
				return fail(`Failed to list issues: ${err?.message ?? String(err)}`);
			}
		},
	});

	pi.registerTool({
		name: "issue_get",
		label: "Get Issue",
		description:
			"Read one issue with its full body and comments. Use it to pick up a hand-off or check a blocker " +
			"recorded on the project board.",
		promptSnippet: "Read a shared issue with its comments",
		promptGuidelines: IssueToolGuidelines,
		parameters: Type.Object({
			id: Type.String({ description: "Issue number/id on the board." }),
		}),

		async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
			try {
				const tracker = await resolveTracker(ctx.cwd);
				if (tracker.kind === "github") {
					const res = await gh(tracker.root, [
						"issue",
						"view",
						params.id,
						"--json",
						"number,title,state,body,labels,assignees,author,url,updatedAt,comments",
					]);
					if (res.code !== 0) return fail(res.stderr.trim() || `Issue #${params.id} not found.`, { tracker: "github" });
					const detail = toGhDetail(JSON.parse(res.stdout || "{}") as GhIssueJson);
					return ok(renderDetail(detail), { tracker: "github", id: detail.id });
				}

				const detail = readFileIssue(tracker.boardDir, params.id);
				if (!detail) return fail(`Issue #${params.id} not found on the file board.`, { tracker: "file" });
				return ok(renderDetail(detail), { tracker: "file", id: detail.id });
			} catch (err: any) {
				return fail(`Failed to read issue #${params.id}: ${err?.message ?? String(err)}`);
			}
		},
	});

	pi.registerTool({
		name: "issue_close",
		label: "Close Issue",
		description:
			"Close an issue as done, optionally with a final comment. Use it when the work described by the issue " +
			"is complete and verified.",
		promptSnippet: "Close a shared issue as done",
		promptGuidelines: IssueToolGuidelines,
		parameters: Type.Object({
			id: Type.String({ description: "Issue number/id on the board." }),
			comment: Type.Optional(Type.String({ description: "Final summary comment." })),
			agent: Type.Optional(Type.String({ description: "Author name override." })),
		}),

		async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
			const author = resolveAuthor(params.agent, ctx);
			try {
				const tracker = await resolveTracker(ctx.cwd);
				if (tracker.kind === "github") {
					if (params.comment?.trim()) {
						const res = await gh(tracker.root, ["issue", "comment", params.id, "--body-file", "-"], {
							input: params.comment,
						});
						if (res.code !== 0) return fail(res.stderr.trim() || "gh issue comment failed", { tracker: "github" });
					}
					// Route through applyGhStatus so closing strips stale status:* labels
					// and is idempotent on an already-closed issue.
					const statusResult = await applyGhStatus(tracker.root, params.id, "done");
					if (statusResult.error) {
						const prefix = params.comment?.trim() ? "Comment posted, but closing failed: " : "";
						return fail(`${prefix}${statusResult.error}`, { tracker: "github", id: params.id });
					}
					// Unreachable for "done" today (no status label is applied), but the
					// warning is surfaced rather than dropped if that ever changes.
					const closeNote = statusResult.warning ? `\n(${statusResult.warning})` : "";
					return ok(`Closed issue #${params.id}.${closeNote}`, { tracker: "github", id: params.id });
				}

				const closed = closeFileIssue(tracker.boardDir, params.id, { comment: params.comment, author });
				if (!closed) return fail(`Issue #${params.id} not found on the file board.`, { tracker: "file" });
				return ok(`Closed issue #${closed.id} (status: done).`, { tracker: "file", id: closed.id });
			} catch (err: any) {
				return fail(`Failed to close issue #${params.id}: ${err?.message ?? String(err)}`);
			}
		},
	});
}

/** Default extension entry point: lets children load this file directly with `-e`. */
export default function issuesExtension(pi: ExtensionAPI): void {
	registerIssueTools(pi);
}
