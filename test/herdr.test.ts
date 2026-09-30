import test from "node:test";
import assert from "node:assert";
import {
	isHerdrAvailable,
	herdrExec,
	getPaneLayout,
	getGeometrySplitDirection,
	splitPane,
	closePane,
	listTabs,
	createTab,
	closeTab,
	resolveLayoutTarget,
	showNotification,
} from "../herdr.ts";

test("isHerdrAvailable returns true when HERDR_ENV is 1", () => {
	const orig = process.env.HERDR_ENV;
	try {
		process.env.HERDR_ENV = "1";
		assert.strictEqual(isHerdrAvailable(), true);
		process.env.HERDR_ENV = "0";
		assert.strictEqual(isHerdrAvailable(), false);
		delete process.env.HERDR_ENV;
		assert.strictEqual(isHerdrAvailable(), false);
	} finally {
		process.env.HERDR_ENV = orig;
	}
});

test("herdrExec handles valid commands and errors", async () => {
	if (!isHerdrAvailable()) return;

	// Valid command
	const tabs = await listTabs();
	assert.ok(Array.isArray(tabs));

	// Error command
	await assert.rejects(async () => {
		await herdrExec(["agent", "get", "nonexistent-agent-12345"]);
	}, /herdr error/);
});

test("getPaneLayout and getGeometrySplitDirection work in active session", async () => {
	if (!isHerdrAvailable()) return;

	const layout = await getPaneLayout();
	assert.ok(layout);
	assert.ok(layout.area);
	assert.ok(layout.area.width > 0);
	assert.ok(layout.area.height > 0);

	const direction = await getGeometrySplitDirection();
	assert.ok(direction === "right" || direction === "down");
});

test("splitPane and closePane create and clean up pane with HERDR_ENV=0", async () => {
	if (!isHerdrAvailable()) return;

	const pane = await splitPane({
		current: true,
		direction: "right",
		cwd: process.cwd(),
		env: { HERDR_ENV: "0" },
		focus: false,
	});

	assert.ok(pane);
	assert.ok(pane.pane_id);
	assert.strictEqual(pane.focused, false);

	// Close pane
	await closePane(pane.pane_id);
});

test("createTab and closeTab create and clean up dedicated tab", async () => {
	if (!isHerdrAvailable()) return;

	const { tab, rootPane } = await createTab({
		label: "test-subagents-tab",
		cwd: process.cwd(),
		env: { HERDR_ENV: "0" },
		focus: false,
	});

	assert.ok(tab);
	assert.ok(tab.tab_id);
	assert.strictEqual(tab.label, "test-subagents-tab");
	assert.ok(rootPane);
	assert.ok(rootPane.pane_id);

	// Clean up tab
	await closeTab(tab.tab_id);
});

test("resolveLayoutTarget resolves pane and tab topology", async () => {
	if (!isHerdrAvailable()) return;

	// 1. "pane" layout
	const paneTarget = await resolveLayoutTarget({
		layout: "pane",
		cwd: process.cwd(),
		activePaneSubagentsCount: 0,
	});
	assert.strictEqual(paneTarget.layoutMode, "pane");
	assert.ok(paneTarget.paneId);
	await closePane(paneTarget.paneId);

	// 2. "tab" layout
	const tabTarget = await resolveLayoutTarget({
		layout: "tab",
		cwd: process.cwd(),
		activePaneSubagentsCount: 0,
	});
	assert.strictEqual(tabTarget.layoutMode, "tab");
	assert.ok(tabTarget.tabId);
	assert.ok(tabTarget.paneId);
	await closeTab(tabTarget.tabId);

	// 3. "auto" with < 2 active subagents -> pane
	const autoTarget1 = await resolveLayoutTarget({
		layout: "auto",
		cwd: process.cwd(),
		activePaneSubagentsCount: 1,
	});
	assert.strictEqual(autoTarget1.layoutMode, "pane");
	await closePane(autoTarget1.paneId);

	// 4. "auto" with >= 2 active subagents -> tab
	const autoTarget2 = await resolveLayoutTarget({
		layout: "auto",
		cwd: process.cwd(),
		activePaneSubagentsCount: 2,
	});
	assert.strictEqual(autoTarget2.layoutMode, "tab");
	await closeTab(autoTarget2.tabId);
});

test("showNotification does not throw", async () => {
	if (!isHerdrAvailable()) return;
	await showNotification("test notification", { body: "testing from test suite" });
});
