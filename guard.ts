/**
 * Herdr guard — loaded into every sub-agent.
 *
 * Children are spawned with `--no-extensions --no-skills -e <this file>`, so
 * this is the only extension code they run. It hard-enforces the no-direct-
 * communication rule at the tool boundary:
 *
 *   - `tool_call`: blocks any `bash` invocation whose command mentions herdr.
 *   - `user_bash`: blocks the same pattern for user-initiated (! / !!) commands.
 *
 * The environment is also sanitized (`HERDR_ENV=0`, `HERDR_*` stripped) by the
 * spawner, so the documented herdr paths are closed even though raw access to
 * herdr's Unix socket from a child's bash is out of scope.
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

const HERDR_PATTERN = /\bherdr\b/i;

const BLOCK_REASON =
	"Sub-agents cannot control herdr or contact other agents directly. " +
	"Route coordination through the project issue tracker (issue_* tools) instead.";

export default function (pi: ExtensionAPI) {
	pi.on("tool_call", async (event) => {
		if (event.toolName !== "bash") return undefined;

		const command = typeof event.input.command === "string" ? event.input.command : "";
		if (HERDR_PATTERN.test(command)) {
			return { block: true, reason: BLOCK_REASON };
		}
		return undefined;
	});

	pi.on("user_bash", async (event) => {
		if (!HERDR_PATTERN.test(event.command)) return undefined;
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
