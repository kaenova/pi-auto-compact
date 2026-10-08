import {
	mkdirSync,
	readFileSync,
	renameSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { dirname, join } from "node:path";
import {
	estimateTokens,
	SettingsManager,
	getAgentDir,
	type ExtensionAPI,
	type ExtensionContext,
} from "@earendil-works/pi-coding-agent";

const DEFAULT_THRESHOLD_TOKENS = 150000;
/**
 * Floor for the token budget. Lower values read like a mistyped percentage and
 * would compact on essentially every prompt.
 */
const MIN_THRESHOLD_TOKENS = 1000;
const STATUS_KEY = "pi-auto-compact";
const CONFIG_FILE = join(getAgentDir(), "pi-auto-compact.json");
/** Compaction errors meaning "the context is already as small as it can get" — safe to send the prompt anyway. */
const SOFT_COMPACT_ERRORS = ["Nothing to compact", "Already compacted"];

/** Provider-independent trigger: the budget or 90% of the model window, whichever is lower. */
interface CompactConfig {
	thresholdTokens: number;
}

const DEFAULT_CONFIG: CompactConfig = {
	thresholdTokens: DEFAULT_THRESHOLD_TOKENS,
};

function parseConfig(raw: unknown, fallback: CompactConfig): CompactConfig {
	const tokens = (raw as { thresholdTokens?: unknown } | null | undefined)
		?.thresholdTokens;
	return {
		thresholdTokens:
			typeof tokens === "number" &&
			Number.isSafeInteger(tokens) &&
			tokens >= MIN_THRESHOLD_TOKENS
				? tokens
				: fallback.thresholdTokens,
	};
}

/** Read the config from disk, keeping the last-known value when missing/invalid (hot reload). */
function loadConfig(fallback: CompactConfig = DEFAULT_CONFIG): CompactConfig {
	try {
		return parseConfig(JSON.parse(readFileSync(CONFIG_FILE, "utf8")), fallback);
	} catch {
		// Use the fallback when no valid config exists.
		return fallback;
	}
}

/** Unknown/invalid windows cannot provide a safe trigger. */
function resolveLimit(
	config: CompactConfig,
	contextWindow: number,
): number | undefined {
	return Number.isFinite(contextWindow) && contextWindow > 0
		? Math.min(config.thresholdTokens, Math.floor(contextWindow * 0.9))
		: undefined;
}

/** Human-readable summary of the active rule, for notifications. */
function describeConfig(config: CompactConfig): string {
	return `${config.thresholdTokens} tokens (capped at 90% of model context window)`;
}

function readJsonObject(file: string): Record<string, unknown> {
	try {
		const raw = JSON.parse(readFileSync(file, "utf8"));
		if (raw && typeof raw === "object") return raw as Record<string, unknown>;
	} catch {
		// Missing or corrupt file: start from a clean object.
	}
	return {};
}

/** Write JSON via temp+rename, so a crash can never leave a half-written file. */
function writeJsonAtomic(file: string, value: unknown): void {
	mkdirSync(dirname(file), { recursive: true });
	const tempFile = `${file}.${process.pid}.${Date.now()}.tmp`;
	writeFileSync(tempFile, `${JSON.stringify(value, null, 2)}\n`, "utf8");
	try {
		renameSync(tempFile, file);
	} catch (error) {
		try {
			rmSync(tempFile, { force: true });
		} catch {
			// Best-effort cleanup; the rename error matters more.
		}
		throw error;
	}
}

function saveConfig(config: CompactConfig): void {
	// Merge into the existing file so unknown keys survive.
	writeJsonAtomic(CONFIG_FILE, {
		...readJsonObject(CONFIG_FILE),
		thresholdTokens: config.thresholdTokens,
	});
}

type StatusKind = "info" | "warning" | "error";

function setStatus(
	ctx: ExtensionContext,
	text: string | undefined,
	kind: StatusKind = "info",
): void {
	if (!ctx.hasUI) return;
	try {
		if (text === undefined) ctx.ui.setStatus(STATUS_KEY, undefined);
		else
			ctx.ui.setStatus(
				STATUS_KEY,
				kind === "info" ? text : ctx.ui.theme.fg(kind, text),
			);
	} catch {
		// The ctx may be stale after a session switch/reload; never break the prompt flow over status updates.
	}
}

/** Context usage worth acting on, or undefined when tokens are unknown (e.g. right after compaction). */
function getValidUsage(
	ctx: ExtensionContext,
): { tokens: number; contextWindow: number } | undefined {
	const usage = ctx.getContextUsage();
	if (!usage || usage.tokens == null || usage.contextWindow <= 0)
		return undefined;
	return { tokens: usage.tokens, contextWindow: usage.contextWindow };
}

/** Fire-and-forget notify that survives a stale ctx. */
function notifySafe(
	ctx: ExtensionContext,
	text: string,
	kind: StatusKind,
): void {
	try {
		ctx.ui.notify(text, kind);
	} catch {
		// Ignore UI failures.
	}
}

function isSoftCompactionError(error: Error): boolean {
	return SOFT_COMPACT_ERRORS.some((message) => error.message.includes(message));
}

export default function (pi: ExtensionAPI) {
	/** Last-known valid config; re-read from disk before each prompt (hot reload). */
	let config = loadConfig();
	let original: typeof SettingsManager.prototype.getCompactionSettings | undefined;
	// ponytail: process-wide SDK patch. Replace with a public runtime settings API when Pi exposes one.
	const patched: typeof SettingsManager.prototype.getCompactionSettings = function (this: SettingsManager, model) {
		const settings = original!.call(this, model);
		config = loadConfig(config);
		const window = (model as { contextWindow?: number } | undefined)?.contextWindow;
		const limit = window == null ? undefined : resolveLimit(config, window);
		return limit == null ? settings : {
			...settings,
			enabled: true,
			reserveTokens: Math.round(window! - limit),
		};
	};
	function updateActivationStatus(ctx: ExtensionContext) {
		if (!ctx.hasUI) return;
		const limit = ctx.model ? resolveLimit(config, ctx.model.contextWindow) : undefined;
		try {
			ctx.ui.setStatus(`${STATUS_KEY}-active`, SettingsManager.prototype.getCompactionSettings !== patched
				? "auto-compact: runtime override inactive"
				: limit == null
				? "auto-compact: native fallback (window unknown)"
				: `auto-compact: on · ${limit} tokens`);
		} catch { /* Session context may be stale. */ }
	}
	function installRuntimePatch() {
		if (original) return;
		original = SettingsManager.prototype.getCompactionSettings;
		SettingsManager.prototype.getCompactionSettings = patched;
	}
	function removeRuntimePatch() {
		if (SettingsManager.prototype.getCompactionSettings === patched) {
			SettingsManager.prototype.getCompactionSettings = original!;
			original = undefined;
		}
	}
	/** Bumped on session start/shutdown so async callbacks can detect a replaced session. */
	let sessionGeneration = 0;
	/** Shared in-flight preflight compaction; resolves to the failure (or null) once the compaction attempt settles. */
	let inFlight: Promise<Error | null> | null = null;

	/**
	 * Run ctx.compact() and wait for it to settle. ctx.compact() is fire-and-forget,
	 * so completion is observed through its onComplete/onError callbacks (Pi invokes
	 * exactly one). Resolves to the failure, or null on success. All UI access is
	 * guarded: if the session was replaced mid-compaction (gen mismatch) the old
	 * session's status bar is left alone.
	 */
	const compactAndWait = (
		ctx: ExtensionContext,
		gen: number,
	): Promise<Error | null> =>
		new Promise<Error | null>((resolve) => {
			try {
				ctx.compact({
					onComplete: () => {
						if (gen === sessionGeneration) setStatus(ctx, undefined);
						resolve(null);
					},
					onError: (error) => {
						if (gen === sessionGeneration && !isSoftCompactionError(error)) {
							setStatus(ctx, "compact failed", "error");
						}
						resolve(error);
					},
				});
			} catch (error) {
				resolve(error instanceof Error ? error : new Error(String(error)));
			}
		});

	pi.on("session_start", (_event, ctx) => {
		sessionGeneration++;
		setStatus(ctx, undefined);
		config = loadConfig(config);
		installRuntimePatch();
		updateActivationStatus(ctx);
	});

	pi.on("model_select", (_event, ctx) => {
		config = loadConfig(config);
		updateActivationStatus(ctx);
	});

	pi.on("session_shutdown", () => {
		sessionGeneration++;
		removeRuntimePatch();
	});

	pi.registerCommand("compact-threshold", {
		description: `Show or set the auto-compaction token budget: /compact-threshold <${MIN_THRESHOLD_TOKENS}+> | reset`,
		handler: async (args, ctx) => {
			const input = args.trim();
			if (!input) {
				ctx.ui.notify(
					`Auto-compaction limit: ${describeConfig(loadConfig(config))}`,
					"info",
				);
				return;
			}

			if (input.toLowerCase() === "reset") {
				try {
					rmSync(CONFIG_FILE, { force: true });
					config = DEFAULT_CONFIG;
					updateActivationStatus(ctx);
					ctx.ui.notify(
						`Auto-compaction limit reset to ${describeConfig(config)}`,
						"info",
					);
				} catch {
					ctx.ui.notify("Could not reset auto-compaction limit", "error");
				}
				return;
			}

			const value = Number(input);
			if (!Number.isSafeInteger(value) || value < MIN_THRESHOLD_TOKENS) {
				ctx.ui.notify(
					`Usage: /compact-threshold <${MIN_THRESHOLD_TOKENS}+> (a token budget), or reset`,
					"warning",
				);
				return;
			}

			try {
				// Persist first, then update memory, so a failed save never desyncs the two.
				const next: CompactConfig = { thresholdTokens: value };
				saveConfig(next);
				config = next;
				updateActivationStatus(ctx);
				ctx.ui.notify(
					`Auto-compaction limit set to ${describeConfig(config)}`,
					"info",
				);
			} catch {
				ctx.ui.notify("Could not save auto-compaction limit", "error");
			}
		},
	});

	// Status-only: show when the context is already past the limit and the next
	// prompt will trigger a preflight compaction. No compaction happens here.
	pi.on("turn_end", (_event, ctx) => {
		config = loadConfig(config);
		updateActivationStatus(ctx);
		const usage = getValidUsage(ctx);
		if (!usage) {
			setStatus(ctx, undefined);
			return;
		}
		const limit = resolveLimit(config, usage.contextWindow);
		if (limit != null && usage.tokens >= limit) {
			// Pi's own status bar already shows usage/window; only add the actionable hint.
			setStatus(ctx, "compact before next prompt", "warning");
		} else {
			setStatus(ctx, undefined);
		}
	});

	// Preflight: when the agent is idle and the projected context (current usage plus
	// the new prompt) crosses the budget, compact once before the prompt is sent.
	// The prompt itself keeps flowing through Pi's normal path (no re-injection), and
	// Pi's built-in auto-compaction stays enabled as the final safety net.
	pi.on("input", async (event, ctx) => {
		// Messages queued during an active run (steer/followUp) cannot be preflighted:
		// ctx.compact() would abort the running agent.
		if (event.streamingBehavior !== undefined) return { action: "continue" };

		// Re-read per prompt so /compact-threshold changes from other sessions apply here.
		config = loadConfig(config);
		updateActivationStatus(ctx);
		const usage = getValidUsage(ctx);
		if (!usage) return { action: "continue" };
		const limit = resolveLimit(config, usage.contextWindow);
		if (limit == null) return { action: "continue" };

		const content =
			event.images && event.images.length > 0
				? [{ type: "text" as const, text: event.text }, ...event.images]
				: event.text;
		const projected =
			usage.tokens +
			estimateTokens({ role: "user", content, timestamp: Date.now() });
		if (projected < limit) return { action: "continue" };

		const gen = sessionGeneration;
		const projectedPercent = ((projected / usage.contextWindow) * 100).toFixed(1);
		setStatus(
			ctx,
			`projected ${projectedPercent}% · compacting before send`,
			"warning",
		);

		// Serialize concurrent prompts that race past Pi's own compaction guard:
		// reuse the in-flight compaction instead of starting a second one.
		if (!inFlight) {
			inFlight = compactAndWait(ctx, gen);
			void inFlight.finally(() => {
				inFlight = null;
			});
		}
		const error = await inFlight;
		if (gen !== sessionGeneration) return { action: "continue" };

		if (error) {
			if (isSoftCompactionError(error)) {
				// The context is already minimal (e.g. compacted seconds ago); sending is safe.
				notifySafe(
					ctx,
					`Auto-compact skipped: ${error.message}. Sending prompt anyway.`,
					"warning",
				);
			} else {
				// Fail-closed: the context state is uncertain, so the prompt is not sent
				// and the user resubmits (recall it from the editor history). Note Pi's
				// compaction mutex stays locked while ctx.compact() is genuinely still
				// running, so a resubmit queues until the background compaction settles.
				notifySafe(
					ctx,
					`Auto-compact failed: ${error.message}. Prompt not sent — resubmit when ready.`,
					"error",
				);
				return { action: "handled" };
			}
		}
		return { action: "continue" };
	});
}
