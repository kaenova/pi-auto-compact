/**
 * Mock smoke test for extensions/auto-compact.ts.
 *
 * Runs with plain Node (>=22.18 / >=23.6 native TS type stripping):
 *   npm test
 *
 * Mocks the ExtensionAPI surface (events, commands, ctx.ui, ctx.compact) and
 * covers: threshold math, soft-error fail-open, hard-fail fail-closed,
 * concurrent-prompt serialization, session-switch guarding, and config
 * persistence/hot reload. The real pi SDK is imported for
 * estimateTokens/getAgentDir; no agent state is touched because
 * PI_CODING_AGENT_DIR points at a throwaway temp dir set before the
 * extension module resolves CONFIG_FILE.
 */
import assert from "node:assert/strict";
import {
	existsSync,
	mkdtempSync,
	readFileSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { test } from "node:test";
import { tmpdir } from "node:os";
import { join } from "node:path";

const agentDir = mkdtempSync(join(tmpdir(), "pi-auto-compact-smoke-"));
process.env.PI_CODING_AGENT_DIR = agentDir;
const CONFIG_FILE = join(agentDir, "pi-auto-compact.json");

const { default: createExtension } = await import(
	"../extensions/auto-compact.ts"
);

const { SettingsManager } = await import("@earendil-works/pi-coding-agent");

type Handler = (event: any, ctx: any) => any;

interface MockPi {
	pi: any;
	events: Map<string, Handler[]>;
	commands: Map<string, { description: string; handler: Handler }>;
}

function makePi(): MockPi {
	const events = new Map<string, Handler[]>();
	const commands = new Map<string, { description: string; handler: Handler }>();
	const pi = {
		on(name: string, handler: Handler) {
			if (!events.has(name)) events.set(name, []);
			events.get(name)!.push(handler);
		},
		registerCommand(
			name: string,
			def: { description: string; handler: Handler },
		) {
			commands.set(name, def);
		},
	};
	return { pi, events, commands };
}

function install(pi: MockPi) {
	createExtension(pi.pi);
	return {
		fireInput: (event: any, ctx: any) =>
			pi.events.get("input")![0]!({ source: "interactive", ...event }, ctx),
		fireTurnEnd: (ctx: any) => pi.events.get("turn_end")!.map((h) => h({}, ctx)),
		fireSessionStart: (ctx: any) =>
			pi.events.get("session_start")!.map((h) => h({}, ctx)),
		command: (name: string) => pi.commands.get(name)!,
	};
}

interface CompactHandler {
	onComplete?: (result: any) => void;
	onError?: (error: Error) => void;
}

interface CtxHarness {
	ctx: any;
	compacts: CompactHandler[];
	statuses: (string | undefined)[];
	activationStatuses: (string | undefined)[];
	notifies: { text: string; kind: string }[];
}

function makeCtx(opts: {
	usage?: { tokens: number | null; contextWindow: number };
	onCompact?: (handlers: CompactHandler) => void;
	availableModels?: { provider: string; id: string; contextWindow: number }[];
}): CtxHarness {
	const compacts: CompactHandler[] = [];
	const harness: CtxHarness = {
		ctx: {
			hasUI: true,
			getContextUsage: () => opts.usage,
			modelRegistry: { getAvailable: () => opts.availableModels ?? [] },
			compact(handlers: CompactHandler) {
				compacts.push(handlers);
				// Default to a soft failure, so an unexpected compaction fails fast
				// instead of leaving compactAndWait() pending and hanging the suite.
				if (opts.onCompact) opts.onCompact(handlers);
				else handlers.onError?.(new Error("Nothing to compact"));
			},
			ui: {
				setStatus: (key: string, text: string | undefined) => {
					(key.endsWith("-active") ? harness.activationStatuses : harness.statuses).push(text);
				},
				notify: (text: string, kind: string) => {
					harness.notifies.push({ text, kind });
				},
				theme: { fg: (_kind: string, text: string) => text },
			},
		},
		compacts,
		statuses: [],
		activationStatuses: [],
		notifies: [],
	};
	return harness;
}

function writeConfig(value: Record<string, unknown>) {
	writeFileSync(CONFIG_FILE, JSON.stringify(value, null, 2), "utf8");
}

/** Test context window. Budgets are real token counts, so tests use a real scale. */
const WINDOW = 100_000;
/** Usage at a percentage of WINDOW, keeping the test intent readable. */
const at = (percent: number) => ({
	tokens: Math.round((WINDOW * percent) / 100),
	contextWindow: WINDOW,
});

test("runtime thresholds hot-reload without changing Pi settings; shutdown restores the method", async () => {
	const mock = makePi();
	const pi = install(mock);
	const before = SettingsManager.prototype.getCompactionSettings;
	const manager = SettingsManager.inMemory({ compaction: { enabled: false, keepRecentTokens: 321 } });
	const model = { provider: "9router", id: "test", contextWindow: 100000 };
	const h = makeCtx({ usage: undefined });
	h.ctx.model = model;
	writeConfig({ thresholdTokens: 150000 });
	pi.fireSessionStart(h.ctx);
	assert.equal(h.activationStatuses.at(-1), "auto-compact: on · 90000 tokens");
	assert.deepEqual(manager.getCompactionSettings(model), { enabled: true, keepRecentTokens: 321, reserveTokens: 10000 });
	await pi.command("compact-threshold").handler("50000", h.ctx);
	assert.equal(manager.getCompactionSettings(model).reserveTokens, 50000);
	assert.equal(h.activationStatuses.at(-1), "auto-compact: on · 50000 tokens");
	writeConfig({ thresholdTokens: 60000 });
	assert.equal(manager.getCompactionSettings(model).reserveTokens, 40000);
	assert.equal(manager.getCompactionEnabled(), false, "underlying setting untouched");
	mock.events.get("session_shutdown")![0]!({}, h.ctx);
	assert.equal(SettingsManager.prototype.getCompactionSettings, before);
	pi.fireSessionStart(h.ctx);
	assert.equal(manager.getCompactionSettings(model).reserveTokens, 40000, "session switch reinstalls patch");
	mock.events.get("session_shutdown")![0]!({}, h.ctx);
	writeConfig({ thresholdTokens: 80000 });
});

// --- baseline gating ---------------------------------------------------------

// Baseline limit for the gating tests: 80_000 of a 100_000 window.
writeConfig({ thresholdTokens: 80_000 });

test("below threshold: prompt flows through without compaction", async () => {
	const pi = install(makePi());
	const h = makeCtx({ usage: at(10) });
	const res = await pi.fireInput({ text: "hi" }, h.ctx);
	assert.equal(res.action, "continue");
	assert.equal(h.compacts.length, 0);
});

test("unknown usage or queued steer/followUp: preflight skipped", async () => {
	const pi = install(makePi());
	const noUsage = makeCtx({ usage: undefined });
	assert.equal(
		(await pi.fireInput({ text: "hi" }, noUsage.ctx)).action,
		"continue",
	);
	assert.equal(noUsage.compacts.length, 0);

	const nullTokens = makeCtx({ usage: { tokens: null, contextWindow: WINDOW } });
	assert.equal(
		(await pi.fireInput({ text: "hi" }, nullTokens.ctx)).action,
		"continue",
	);

	const queued = makeCtx({ usage: at(99) });
	const res = await pi.fireInput(
		{ text: "hi", streamingBehavior: "steer" },
		queued.ctx,
	);
	assert.equal(res.action, "continue");
	assert.equal(queued.compacts.length, 0);
});

test("projected over threshold: compact once, then send", async () => {
	const pi = install(makePi());
	const h = makeCtx({
		usage: at(90),
		onCompact: (c) => c.onComplete?.({}),
	});
	const res = await pi.fireInput({ text: "a long prompt goes here" }, h.ctx);
	assert.equal(res.action, "continue");
	assert.equal(h.compacts.length, 1);
	assert.match(h.statuses[0]!, /projected/);
	assert.equal(h.statuses.at(-1), undefined, "status cleared after success");
});

test("image prompts project image cost into usage (text alone stays below)", async () => {
	const pi = install(makePi());
	const textOnly = makeCtx({ usage: at(79) });
	await pi.fireInput({ text: "hi" }, textOnly.ctx);
	assert.equal(
		textOnly.compacts.length,
		0,
		"79_000 + ~1 token stays under the 80_000 line",
	);

	const withImage = makeCtx({
		usage: at(79),
		onCompact: (c) => c.onComplete?.({}),
	});
	const res = await pi.fireInput(
		{
			text: "hi",
			images: [{ type: "image", data: "Zm9v", mimeType: "image/png" }],
		},
		withImage.ctx,
	);
	assert.equal(res.action, "continue");
	assert.equal(
		withImage.compacts.length,
		1,
		"image adds 4800 chars (~1200 tokens), pushing projection past the line",
	);
});

// --- failure classification --------------------------------------------------

test("soft errors fail open without an error status", async () => {
	for (const message of [
		"Nothing to compact (session too small)",
		"Already compacted",
	]) {
		const pi = install(makePi());
		const h = makeCtx({
			usage: at(90),
			onCompact: (c) => c.onError?.(new Error(message)),
		});
		const res = await pi.fireInput({ text: "hi" }, h.ctx);
		assert.equal(res.action, "continue", message);
		assert.equal(h.notifies.at(-1)?.kind, "warning", message);
		assert.match(h.notifies.at(-1)!.text, /Sending prompt anyway/, message);
		assert.ok(!h.statuses.includes("compact failed"), message);
	}
});

test("aborted compaction is fail-closed: prompt not sent", async () => {
	const pi = install(makePi());
	const error = new Error("Compaction cancelled");
	error.name = "AbortError";
	const h = makeCtx({
		usage: at(90),
		onCompact: (c) => c.onError?.(error),
	});
	const res = await pi.fireInput({ text: "hi" }, h.ctx);
	assert.equal(res.action, "handled");
	assert.equal(h.notifies.at(-1)?.kind, "error");
	assert.match(h.notifies.at(-1)!.text, /Prompt not sent/);
	assert.ok(h.statuses.includes("compact failed"));
});

test("hard error: prompt not sent", async () => {
	const pi = install(makePi());
	const h = makeCtx({
		usage: at(90),
		onCompact: (c) => c.onError?.(new Error("provider exploded")),
	});
	const res = await pi.fireInput({ text: "important long prompt" }, h.ctx);
	assert.equal(res.action, "handled");
	assert.equal(h.notifies.at(-1)?.kind, "error");
	assert.match(h.notifies.at(-1)!.text, /Prompt not sent — resubmit when ready/);
});

// --- concurrency / session guarding -------------------------------------------

test("two prompts racing past the guard share one compaction", async () => {
	const pi = install(makePi());
	const h = makeCtx({
		usage: at(90),
		onCompact: () => undefined,
	});
	const p1 = pi.fireInput({ text: "first" }, h.ctx);
	const p2 = pi.fireInput({ text: "second" }, h.ctx);
	h.compacts[0]!.onComplete?.({});
	assert.equal((await p1).action, "continue");
	assert.equal((await p2).action, "continue");
	assert.equal(h.compacts.length, 1);
});

test("session switch mid-compaction: stale callbacks never touch UI", async () => {
	const pi = install(makePi());
	const h = makeCtx({
		usage: at(90),
		onCompact: () => undefined,
	});
	const pending = pi.fireInput({ text: "hi" }, h.ctx);
	pi.fireSessionStart(makeCtx({ usage: undefined }).ctx); // bumps generation
	h.compacts[0]!.onComplete?.({});
	assert.equal((await pending).action, "continue");
	assert.equal(
		h.statuses.length,
		1,
		"only the pre-compaction status was written",
	);
	assert.equal(h.notifies.length, 0);
});

// --- configuration -------------------------------------------------------------

test("turn_end status reflects the threshold and clears below it", async () => {
	writeConfig({ thresholdTokens: 50_000 });
	try {
		const pi = install(makePi());
		const hot = makeCtx({ usage: at(90) });
		pi.fireTurnEnd(hot.ctx);
		assert.match(hot.statuses.at(-1)!, /compact before next prompt/);
		const cool = makeCtx({ usage: at(10) });
		pi.fireTurnEnd(cool.ctx);
		assert.equal(cool.statuses.at(-1), undefined);
	} finally {
		writeConfig({ thresholdTokens: 78_000 });
	}
});

test("threshold hot-reloads from disk between prompts", async () => {
	writeConfig({ thresholdTokens: 95_000 });
	const pi = install(makePi());
	const calm = makeCtx({ usage: at(89) });
	await pi.fireInput({ text: "hi" }, calm.ctx);
	assert.equal(calm.compacts.length, 0, "90% < 95% threshold");

	writeConfig({ thresholdTokens: 50_000 });
	const hot = makeCtx({
		usage: at(90),
		onCompact: (c) => c.onComplete?.({}),
	});
	await pi.fireInput({ text: "hi" }, hot.ctx);
	assert.equal(hot.compacts.length, 1, "90% >= 50% after hot reload");

	// Out-of-range hand edits must fall back to the last valid value (92), not the tampered one.
	writeConfig({ thresholdTokens: 92_000 });
	const above92 = makeCtx({ usage: at(89) });
	await pi.fireInput({ text: "hi" }, above92.ctx);
	assert.equal(above92.compacts.length, 0, "90% < 92%");

	writeConfig({ thresholdTokens: 0 }); // below the floor: reject, keep 92_000
	const tampered = makeCtx({ usage: at(89) });
	await pi.fireInput({ text: "hi" }, tampered.ctx);
	assert.equal(tampered.compacts.length, 0, "tampered 0.5% must not take effect");
});

test("all providers use the lower of the budget and 90% of the window", async () => {
	const pi = install(makePi());
	writeConfig({ thresholdTokens: 150_000 });

	// 200k window at 150k used: at the budget. 80% would have been 160k.
	const big = makeCtx({
		usage: { tokens: 150000, contextWindow: 200000 },
		onCompact: (c) => c.onComplete?.({}),
	});
	await pi.fireInput({ text: "hi" }, big.ctx);
	assert.equal(big.compacts.length, 1, "150k reaches the 150k budget");

	const underBudget = makeCtx({ usage: { tokens: 149000, contextWindow: 200000 } });
	await pi.fireInput({ text: "hi" }, underBudget.ctx);
	assert.equal(underBudget.compacts.length, 0, "149k < 150k budget");

	const belowCap = makeCtx({ usage: { tokens: 89000, contextWindow: 100000 } });
	await pi.fireInput({ text: "hi" }, belowCap.ctx);
	assert.equal(belowCap.compacts.length, 0);
	const small = makeCtx({ usage: { tokens: 90000, contextWindow: 100000 } });
	await pi.fireInput({ text: "hi" }, small.ctx);
	assert.equal(small.compacts.length, 1, "90% triggers below the budget");
	const equalWindow = makeCtx({ usage: { tokens: 135000, contextWindow: 150000 } });
	await pi.fireInput({ text: "hi" }, equalWindow.ctx);
	assert.equal(equalWindow.compacts.length, 1, "window equal to budget also uses 90%");


});

test("an out-of-range hand-edited thresholdTokens falls back to the last valid value", async () => {
	writeConfig({ thresholdTokens: 200_000 });
	const pi = install(makePi());

	const over = makeCtx({
		usage: { tokens: 250000, contextWindow: 300000 },
		onCompact: (c) => c.onComplete?.({}),
	});
	await pi.fireInput({ text: "hi" }, over.ctx);
	assert.equal(over.compacts.length, 1, "250k clears the 200k budget");

	// 180k stays under the 200k budget, so silence proves the budget governs.
	const between = makeCtx({ usage: { tokens: 180000, contextWindow: 300000 } });
	await pi.fireInput({ text: "hi" }, between.ctx);
	assert.equal(between.compacts.length, 0, "180k < 200k budget");

	// Hand-edited below the floor: rejected, last valid budget kept. A 500-token
	// budget would have triggered here, so silence is the assertion.
	writeConfig({ thresholdTokens: 500 });
	const tampered = makeCtx({ usage: { tokens: 180000, contextWindow: 300000 } });
	await pi.fireInput({ text: "hi" }, tampered.ctx);
	assert.equal(tampered.compacts.length, 0, "tampered 500 rejected; 200k still in force");
});

test("/compact-threshold persists atomically, merges keys, validates input", async () => {
	writeConfig({ thresholdTokens: 78_000, compactTimeoutMs: 5000 });
	const pi = install(makePi());
	const cmd = pi.command("compact-threshold");
	const h = makeCtx({ usage: undefined });

	await cmd.handler("", h.ctx);
	assert.equal(h.notifies.at(-1)!.text, "Auto-compaction limit: 78000 tokens (capped at 90% of model context window)");

	await cmd.handler("62000", h.ctx);
	const saved = JSON.parse(readFileSync(CONFIG_FILE, "utf8"));
	assert.equal(saved.thresholdTokens, 62000);
	assert.equal(
		saved.compactTimeoutMs,
		5000,
		"unknown config keys survive a save",
	);
	assert.match(h.notifies.at(-1)!.text, /62000 tokens/);

	for (const bad of ["0", "0.5", "abc", "99", "100", "-5", "500", "50%"]) {
		const before = readFileSync(CONFIG_FILE, "utf8");
		await cmd.handler(bad, h.ctx);
		assert.equal(h.notifies.at(-1)!.kind, "warning", bad);
		assert.equal(
			readFileSync(CONFIG_FILE, "utf8"),
			before,
			`${bad} must not touch the file`,
		);
	}

	await cmd.handler("reset", h.ctx);
	assert.ok(!existsSync(CONFIG_FILE), "reset removes the config file");
});

