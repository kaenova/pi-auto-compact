# pi-auto-compact

Automatic context compaction at a configurable token budget, for every provider and model—including 9router. Requires **Pi 1.1.0 or newer**.

```text
trigger = min(thresholdTokens, floor(model.contextWindow × 0.9))
```

Default budget: **150000 tokens**. A 128000-token model triggers at 115200; a 200000-token or 1M-token model triggers at 150000.

## Install and use

```bash
pi install git:github.com/kaenova/pi-auto-compact
```

Start Pi. If installing into an already-open Pi session, run `/reload` once to load the extension.

```text
/compact-threshold 150000
/compact-threshold
/compact-threshold reset
```

Budget changes apply immediately, **without reload or restart**. Use Pi normally:

- **Idle prompt:** estimates current context plus new input; compacts before sending if the limit is reached.
- **Running agent:** Pi's native scheduler compacts after tool results, before the next model response. Active tools and streaming responses are not interrupted.

Budget must be a safe integer of at least 1000. Config is saved atomically in `~/.pi/agent/pi-auto-compact.json` (or the directory selected by `PI_CODING_AGENT_DIR`). Unknown config keys survive writes.

```json
{ "thresholdTokens": 150000 }
```

Direct file edits hot-reload at each preflight/native compaction-settings check. Invalid edits retain the last valid budget.

## Runtime integration

> [!WARNING]
> This extension patches the exported `SettingsManager.prototype.getCompactionSettings` at runtime. This is **not a supported Pi extension settings-update API**. It affects SettingsManager instances sharing that class within the process; another extension patching the same method or future Pi changes can interfere. Verified against actual Pi 1.1.0 through 9router in tmux.

For models with known windows, the wrapper supplies `enabled: true` and `reserveTokens = contextWindow − trigger`, preserving `keepRecentTokens`. This enables native running-agent compaction even when your stored `compaction.enabled` is false. Unknown/invalid windows retain Pi's original settings.

The extension **does not write Pi's `settings.json`**. The wrapper is restored on session shutdown/unload when still owned by this extension, then reinstalled on the next session start. Use the normal package import; importing another SDK copy may patch a different class and have no effect.

### Upgrading from the settings-mirror version

Older versions wrote `compaction.enabled` and per-model reserves into `settings.json`. This version leaves those existing entries untouched. To undo them, manually restore your preferred settings after reviewing `settings.json.bak`. Restoring the entire backup replaces unrelated changes made since that backup. Runtime thresholds override stored thresholds while this extension is active.

```bash
pi update git:github.com/kaenova/pi-auto-compact
```

Reload once to load the updated code; subsequent budget changes need no reload.

## Custom providers and 9router

No provider whitelist or separate configuration. Models must report accurate `contextWindow` metadata to Pi. Routing aliases should report a window safe for every backend they may choose. The extension cannot discover a hidden backend's true window.

## Troubleshooting

- **Activation footer:** `auto-compact: on · 150000 tokens` shows the effective limit for the active model. Updates on model selection, budget changes, and prompt/turn checks. `auto-compact: native fallback (window unknown)` means the runtime override is skipped for that model. This indicates the wrapper is installed, not independent proof that another extension has not replaced it.
- **Footer says `compact before next prompt`:** a preflight warning, not proof of compaction. Native compaction shows `Auto-compacting...` and a summary.
- **Usage exceeds the budget:** the budget is a trigger, not a hard cap. Tool batches can overshoot; summaries plus retained history can remain above it. Model switching alone does not compact.
- **`Nothing to compact` / `Already compacted`:** no eligible history; preflight warns and lets the prompt through. Very small budgets may cause repeated attempts.
- **Hard preflight failure:** prompt is blocked. Recall it with ↑ and resend when ready.
- **Agent still does not compact:** confirm Pi version and correct model window; check conflicts with extensions patching the same method. Unknown windows use Pi's original behavior.

## Remove

```bash
pi remove git:github.com/kaenova/pi-auto-compact
```

Reload or restart to unload the extension. Stored config may be removed separately. Removing config alone resets the budget; it does not disable the extension. Historical settings-mirror entries are not automatically removed.

## Development

```bash
npm install
npm run typecheck
npm test
pi -e .
```

Tests cover runtime hot changes/restoration, provider-independent thresholds, preflight projection, errors, concurrent prompts, session guards, and atomic config writes.

## License

MIT
