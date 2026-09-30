/**
 * Herdr guard — loaded into every sub-agent (alongside `-e issues.ts`).
 *
 * Children are spawned with `--no-extensions --no-skills -e <this file> -e
 * <issues.ts>`, so the guard is the only enforcement code they run. It
 * hard-enforces the no-direct-communication rule at the tool boundary:
 *
 *   - `tool_call`: blocks any `bash` invocation that invokes the herdr CLI.
 *   - `user_bash`: blocks the same pattern for user-initiated (! / !!) commands.
 *   - Environment: Herdr's identifiers are scrubbed from this process by the
 *     extension factory so tool subprocesses never inherit them, even on spawn
 *     paths that cannot set env directly (e.g. `herdr worktree create`, which
 *     has no --env flag). The spawner also sets `HERDR_ENV=0` and the child
 *     identity vars at spawn time.
 *
 * Raw access to herdr's Unix socket from a child's bash remains out of scope
 * (accepted residual risk; the documented paths are closed).
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

/**
 * Matches an actual `herdr` command token, not names that merely contain the
 * word as a hyphen/underscore segment. `herdr-subagent` (this project) must not
 * trip the guard, while `herdr agent list`, `/usr/bin/herdr`, and
 * `HERDR_ENV=1 herdr` must.
 */
export const HERDR_PATTERN = /(?<![\w-])herdr(?![\w-])/i;

/** True when a shell command line invokes or references the herdr CLI. */
export function isHerdrCommand(command: string): boolean {
	return HERDR_PATTERN.test(command);
}

/**
 * Strip Herdr discovery and identity from this child process. Called from the
 * extension factory (not at import time) so merely importing this module — e.g.
 * from a test — has no process-wide side effects.
 */
export function scrubHerdrEnv(): void {
	process.env.HERDR_ENV = "0";
	for (const key of Object.keys(process.env)) {
		if (key.startsWith("HERDR_") && key !== "HERDR_ENV") delete process.env[key];
	}
}

const BLOCK_REASON =
	"Sub-agents cannot control herdr or contact other agents directly. " +
	"Route coordination through the project issue tracker (issue_* tools) instead.";

export default function (pi: ExtensionAPI) {
	scrubHerdrEnv();

	pi.on("tool_call", async (event) => {
		if (event.toolName !== "bash") return undefined;

		const command = typeof event.input.command === "string" ? event.input.command : "";
		if (isHerdrCommand(command)) {
			return { block: true, reason: BLOCK_REASON };
		}
		return undefined;
	});

	pi.on("user_bash", async (event) => {
		if (!isHerdrCommand(event.command)) return undefined;
		return {
			result: {
				output: `Blocked: ${BLOCK_REASON}`,
				exitCode: 1,
				cancelled: false,
				truncated: false,
			},
		};
	});
}
