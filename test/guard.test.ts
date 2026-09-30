import test from "node:test";
import assert from "node:assert";

test("guard import has no env side effects; the factory scrubs herdr env", async () => {
	// Snapshot so live herdr tests elsewhere are unaffected by this test.
	const snapshot = new Map<string, string | undefined>();
	for (const key of Object.keys(process.env)) {
		if (key.startsWith("HERDR_")) snapshot.set(key, process.env[key]);
	}

	process.env.HERDR_ENV = "1";
	process.env.HERDR_PANE_ID = "wF:p1";
	process.env.HERDR_WORKSPACE_ID = "wF";

	try {
		// Dynamic import: this must be the first load of guard.ts in this process
		// so an import-time scrub would be observable here.
		const mod = await import("../guard.ts");
		assert.strictEqual(process.env.HERDR_ENV, "1", "importing guard.ts must not mutate the environment");
		assert.strictEqual(process.env.HERDR_PANE_ID, "wF:p1");

		const events: string[] = [];
		mod.default({ on: (event: string) => events.push(event) } as any);

		assert.deepStrictEqual(events, ["tool_call", "user_bash"]);
		assert.strictEqual(process.env.HERDR_ENV, "0");
		assert.strictEqual(process.env.HERDR_PANE_ID, undefined);
		assert.strictEqual(process.env.HERDR_WORKSPACE_ID, undefined);
	} finally {
		for (const key of Object.keys(process.env)) {
			if (key.startsWith("HERDR_")) delete process.env[key];
		}
		for (const [key, value] of snapshot) {
			if (value !== undefined) process.env[key] = value;
		}
	}
});

test("guard matches herdr command tokens but not herdr-subagent names", async () => {
	const { isHerdrCommand } = await import("../guard.ts");

	assert.ok(isHerdrCommand("herdr agent list"));
	assert.ok(isHerdrCommand("/usr/local/bin/herdr pane split --current"));
	assert.ok(isHerdrCommand("HERDR_ENV=1 herdr workspace list"));
	assert.ok(isHerdrCommand("$(which herdr) tab list"));
	assert.ok(isHerdrCommand("herdr"));

	// This project's own name must not trip the guard.
	assert.ok(!isHerdrCommand("cd /home/vishen/projects/herdr-subagent && npm test"));
	assert.ok(!isHerdrCommand("grep -r herdr-subagent README.md"));
	assert.ok(!isHerdrCommand("cat my-herdr/notes.md"));
	assert.ok(!isHerdrCommand("ls herdr_helper.ts"));
});
