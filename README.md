# pi-auto-compact

A minimal Pi extension that compacts the conversation **before sending a prompt** when the projected context (current usage plus the new input) reaches the effective **token limit**. The default budget is **150000 tokens**, capped at **90% of the active model's context window**. Applies to every provider, including custom providers and 9router.

Compaction itself always reuses Pi's built-in `ctx.compact()` implementation. Pi's own automatic compaction is untouched — if enabled in Pi's settings, it still acts as the final safety net.

## Install

```bash
pi install git:github.com/kaenova/pi-auto-compact
```

## Configuration

Inside Pi:

```text
/compact-threshold 150000   # compact at 150000 tokens
/compact-threshold          # show the active budget
/compact-threshold reset    # back to the 150000 default
```

The budget must be at least 1000 tokens. Lower values are rejected rather than guessed at, since they read like a mistyped percentage and would compact on essentially every prompt. It is saved atomically, merging into the existing file so other keys survive.

You can also edit `~/.pi/agent/pi-auto-compact.json` directly:

```json
{ "thresholdTokens": 150000 }
```

The config is re-read before every prompt, so changes apply without restarting the session.

### One rule for every provider and model

```text
trigger = min(thresholdTokens, floor(model.contextWindow × 0.9))
```

With a 150000 budget:

| Model context window | Trigger |
|---|---|
| 32000 | 28800 |
| 128000 | 115200 |
| 200000 | 150000 |
| 1000000 | 150000 |

No provider whitelist. Custom providers and 9router use the same rule. Pi must know the model's correct context window; missing/invalid windows are skipped. Router aliases should report a window safe for every backend they can select.

**Keep `compaction.enabled: true` in Pi settings for between-turn coverage.** The extension does not change this flag. If disabled, only idle-prompt preflight runs; queued input and tool-result growth cannot trigger native auto-compaction.

## Pi's own threshold is mirrored

> [!WARNING]
> **This extension writes to your Pi settings file.** Setting a budget modifies
> `~/.pi/agent/settings.json` by adding `compaction.modelOverrides` entries — one per
> model with a known context window. That changes Pi's own compaction behavior
> globally, for every session, not just the one you are in.
>
> What it does and does not touch:
>
> - **Only adds** `compaction.modelOverrides.<provider>/<id>.reserveTokens`. It never
>   edits other settings, and merges rather than overwrites, so unrelated keys and
>   any overrides you already had survive.
> - **Never removes** an override. Raising or resetting the budget recalculates
>   overrides for currently available models; unavailable models retain old values.
>   Uninstalling the extension does not restore Pi's original thresholds. The 10%
>   reserve can be smaller than Pi's default 16384 on small windows.
> - Takes effect on `/reload` or restart; Pi caches settings at startup.
>
> **A backup is taken for you.** Before the first mirror write, your original
> settings are copied to `~/.pi/agent/settings.json.bak`. It is written **once and
> never rotated**, so it always holds the pre-extension state. Restore it with:
>
> ```bash
> cp ~/.pi/agent/settings.json.bak ~/.pi/agent/settings.json
> ```
>
> To stop the mirroring entirely, drop the config file and the overrides:
>
> ```bash
> rm -f ~/.pi/agent/pi-auto-compact.json
> ```
>
> ...then remove `compaction.modelOverrides` from `~/.pi/agent/settings.json`, or
> restore the backup above.

Setting the budget also writes Pi's own compaction setting, so Pi's between-turn check fires at the **same point**:

```json
// ~/.pi/agent/settings.json
{ "compaction": { "modelOverrides": {
  "anthropic/claude": { "reserveTokens": 50000 },
  "openai/gpt-large": { "reserveTokens": 850000 }
} } }
```

An override is written for **every available model with a known window**, plus the active one, so the rule is model-independent: whichever model you select, Pi's own check uses your budget. `reserveTokens = contextWindow − min(budget, floor(contextWindow × 0.9))` per `provider/modelId`, merged into the file — pre-existing overrides for other models and unrelated keys survive. Unchanged values are not rewritten, and the original file is backed up to `settings.json.bak` the first time this happens.

Why per model rather than one global `reserveTokens`: Pi's check is `contextTokens > contextWindow - reserveTokens`, so the reserve you need is `window − budget`, which differs per model. One global value cannot express that.

Pi caches settings at startup, so a change applies on the next `/reload` or restart; the extension tells you when it writes.

This closes the gap the preflight cannot see: content queued mid-run (steer/followUp) and `/skill:` / `/template` expansion, which Pi compacts between turns at `contextTokens > contextWindow - reserveTokens`.

## Behavior

- **Preflight trigger**: when you submit a prompt while the agent is idle, the extension estimates `current context + your input` (using Pi's own token estimator). At or above the effective limit, it compacts once before the prompt is sent, so long inputs never interrupt a running tool chain.
- **Failure policy**: if preflight compaction fails, the prompt is **not sent** (fail-closed; recall it from the editor history and resubmit) and an error is shown. Exception: "Nothing to compact" / "Already compacted" mean the context is already minimal, so the prompt is sent anyway.
- **Status**: the footer shows a warning when context is past the budget (next prompt will compact) and while preflight compaction is running.
- **Not preflighted**: messages queued during an active run (steer/followUp), slash commands handled before the input event, and content injected later by `/skill:` or `/template` expansion. Those are covered by the mirrored `reserveTokens` above, and by Pi's built-in compaction as the final safety net.
- **Requires a known context window**: if the active model doesn't report one (or usage is unknown, e.g. right after a compaction), the preflight is skipped and Pi's built-in compaction covers it. Smaller windows use the 90% cap instead of being skipped.
- Session switches/reloads mid-compaction are detected; stale callbacks never touch the new session's status.

## Development

```bash
npm install
npm run typecheck
npm test
pi -e .
```

`npm test` runs a mock smoke suite (`test/smoke.ts`, Node native TS type stripping) that covers budget gating, failure classification, concurrency, session guarding, config persistence, image-prompt projection, and the `settings.json` `reserveTokens` mirror.

## License

MIT
