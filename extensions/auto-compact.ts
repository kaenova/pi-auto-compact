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
/** Pi's own global settings file, where `compaction.modelOverrides` lives. */
const SETTINGS_FILE = join(getAgentDir(), "settings.json");
/** Compaction errors meaning "the context is already as small as it can get" — safe to send the prompt anyway. */
const SOFT_COMPACT_ERRORS = ["Nothing to compact", "Already compacted"];

/**
 * Compaction trigger: a flat token budget.
 *
 * A model whose context window cannot exceed the budget gets no preflight and no
 * mirrored reserve. That is deliberate: `reserveTokens = window - budget` would
 * be negative there, and clamping it to 0 turns Pi's own check into
 * `contextTokens > contextWindow`, which *disables* the native safety net
 * instead of tightening it. Leaving such models alone keeps Pi's default.
 */
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
			Number.isInteger(tokens) &&
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

/**
 * Tokens at which to compact, or undefined when the window cannot exceed the
 * budget (see CompactConfig).
 */
function resolveLimit(
	config: CompactConfig,
	contextWindow: number,
): number | undefined {
	return contextWindow > config.thresholdTokens
		? config.thresholdTokens
		: undefined;
}

/** Human-readable summary of the active rule, for notifications. */
function describeConfig(config: CompactConfig): string {
	return `${config.thresholdTokens} tokens`;
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

type ModelLike = { provider: string; id: string; contextWindow: number };

/**
 * Mirror the compaction limit into Pi's own settings, so Pi's between-turn check
 * (`contextTokens > contextWindow - reserveTokens`) fires at the same point for
 * content the preflight cannot see (steer/followUp queues, skill/template
 * expansion). The limit is window-dependent, so this writes one override per
 * model. Models that cannot reach the budget are skipped (see CompactConfig).
 * Existing overrides for other models and unrelated settings are preserved. Pi
 * caches settings, so a change only applies after /reload or a restart. Returns
 * the number of overrides written (0 = nothing to do).
 */
function syncPiReserveTokens(
	models: readonly ModelLike[],
	config: CompactConfig,
): number {
	const settings = readJsonObject(SETTINGS_FILE);
	const compaction = (settings.compaction ?? {}) as Record<string, unknown>;
	const overrides = {
		...((compaction.modelOverrides as Record<string, unknown>) ?? {}),
	};
	let written = 0;
	for (const model of models) {
		if (!Number.isFinite(model.contextWindow) || model.contextWindow <= 0)
			continue;
		const limit = resolveLimit(config, model.contextWindow);
		if (limit == null) continue;
		const key = `${model.provider}/${model.id}`;
		const reserveTokens = Math.round(model.contextWindow - limit);
		const existing = overrides[key] as { reserveTokens?: unknown } | undefined;
		if (existing?.reserveTokens === reserveTokens) continue;
		overrides[key] = { ...existing, reserveTokens };
		written++;
	}
	if (written === 0) return 0;
	writeJsonAtomic(SETTINGS_FILE, {
		...settings,
		compaction: { ...compaction, modelOverrides: overrides },
	});
	return written;
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

/**
 * Mirror the limit for every model Pi could use, plus the active one, so the
 * rule stays model-independent: whichever model is selected, Pi's own
 * between-turn check fires at our limit. The active model is added separately
 * because the registry may not list it yet.
 */
function applyConfigToPi(ctx: ExtensionContext, config: CompactConfig): void {
	try {
		const models = new Map<string, ModelLike>();
		for (const model of ctx.modelRegistry.getAvailable())
			models.set(`${model.provider}/${model.id}`, model);
		if (ctx.model)
			models.set(`${ctx.model.provider}/${ctx.model.id}`, ctx.model);
		const written = syncPiReserveTokens([...models.values()], config);
		if (written === 0) return;
		notifySafe(
			ctx,
			`Pi compaction limit mirrored at ${describeConfig(config)} for ${written} model(s) (${SETTINGS_FILE}). Run /reload or restart Pi to apply.`,
			"info",
		);
	} catch {
		notifySafe(ctx, "Could not update Pi settings.json", "warning");
	}
}

export default function (pi: ExtensionAPI) {
	/** Last-known valid config; re-read from disk before each prompt (hot reload). */
	let config = loadConfig();
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
		applyConfigToPi(ctx, (config = loadConfig(config)));
	});

	// A model switch can reveal models that gained auth since startup.
	pi.on("model_select", (_event, ctx) => {
		applyConfigToPi(ctx, config);
	});

	pi.on("session_shutdown", () => {
		sessionGeneration++;
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
					applyConfigToPi(ctx, config);
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
			if (!Number.isInteger(value) || value < MIN_THRESHOLD_TOKENS) {
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
				applyConfigToPi(ctx, config);
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
