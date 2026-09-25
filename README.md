# pi-auto-compact

A minimal Pi extension that compacts the conversation **before sending a prompt** when the projected context (current usage plus the new input) crosses a configurable **token budget**. The default is **150000 tokens**.

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

### Windows smaller than the budget are skipped

A budget can only trigger on a model whose context window exceeds it. Models with a smaller window get **no preflight and no mirrored setting**, which is deliberate:

- `reserveTokens = window − budget` would be negative there, and clamping it to `0` turns Pi's check into `contextTokens > contextWindow` — that *disables* Pi's native safety net rather than tightening it.
- Leaving those models untouched keeps Pi's own default, so overflow is still caught.

So a 150000 budget applies to a 200k or 1M window and is ignored on a 32k one. Pick a budget at or below the smallest window you actually use if you want it to apply everywhere.

## Pi's own threshold is mirrored

> [!WARNING]
> **This extension writes to your Pi settings file.** Setting a budget modifies
> `~/.pi/agent/settings.json` by adding `compaction.modelOverrides` entries — one per
> model that can reach the budget. That changes Pi's own compaction behavior
> globally, for every session, not just the one you are in.
>
> What it does and does not touch:
>
> - **Only adds** `compaction.modelOverrides.<provider>/<id>.reserveTokens`. It never
>   edits other settings, and merges rather than overwrites, so unrelated keys and
>   any overrides you already had survive.
> - **Never removes** an override. If you later raise the budget, or `reset` back to
>   the default, models whose window no longer exceeds the budget are skipped and
>   keep their previously mirrored `reserveTokens`. That stale value is typically
>   *smaller* than Pi's default 16384, meaning Pi compacts **later** than stock — so
>   a stale mirror can be less safe than Pi's untouched default.
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

An override is written for **every model that can reach the budget**, plus the active one, so the rule is model-independent: whichever model you select, Pi's own check uses your budget. `reserveTokens = contextWindow − budget` per `provider/modelId`, merged into the file — pre-existing overrides for other models and unrelated keys survive. Unchanged values are not rewritten, and the original file is backed up to `settings.json.bak` the first time this happens.

Why per model rather than one global `reserveTokens`: Pi's check is `contextTokens > contextWindow - reserveTokens`, so the reserve you need is `window − budget`, which differs per model. One global value cannot express that.

Pi caches settings at startup, so a change applies on the next `/reload` or restart; the extension tells you when it writes.

This closes the gap the preflight cannot see: content queued mid-run (steer/followUp) and `/skill:` / `/template` expansion, which Pi compacts between turns at `contextTokens > contextWindow - reserveTokens`.

## Behavior

- **Preflight trigger**: when you submit a prompt while the agent is idle, the extension estimates `current context + your input` (using Pi's own token estimator). At or above the budget, it compacts once before the prompt is sent, so long inputs never interrupt a running tool chain.
- **Failure policy**: if preflight compaction fails, the prompt is **not sent** (fail-closed; recall it from the editor history and resubmit) and an error is shown. Exception: "Nothing to compact" / "Already compacted" mean the context is already minimal, so the prompt is sent anyway.
- **Status**: the footer shows a warning when context is past the budget (next prompt will compact) and while preflight compaction is running.
- **Not preflighted**: messages queued during an active run (steer/followUp), slash commands handled before the input event, and content injected later by `/skill:` or `/template` expansion. Those are covered by the mirrored `reserveTokens` above, and by Pi's built-in compaction as the final safety net.
- **Requires a known context window**: if the active model doesn't report one (or usage is unknown, e.g. right after a compaction), the preflight is skipped and Pi's built-in compaction covers it. The same applies when the window is smaller than the budget.
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
