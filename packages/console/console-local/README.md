# @deepseek-ai/dsh-console-local

English | [中文](README.zh.md)

Process-local provider for `ctx.consoles`. It resolves `shellPath` at service initialization, then uses `ctx.subprocess.spawnTerminal()` with the workspace path as `cwd` and the configured terminal type; it adds no explicit environment entries.

All configuration is required: `shellPath`, `shellArgs`, `term`, `disposeGraceMs`, `outputRetentionBytes`, `maxReadBytes`, and `maxOutputWaitersPerConsole`. Strings must be non-empty, numeric values must be positive safe integers, and `maxReadBytes` cannot exceed retention.

The provider retains a bounded raw-byte tail with absolute whole-stream offsets. Output drain precedes the exited transition. Transport failures become `failed`, preserve prior bytes, and trigger terminal cleanup. Concurrent stops join one cleanup; failed cleanup leaves the authorized record retryable. Service disposal fences operations, aborts unpublished opens, and attempts every published cleanup.

## Model Experience

### Process-local console execution

#### What the model sees

Nothing. `ctx.consoles` registers no tools, injects no prompts, and writes no session events.

#### Token effect

Zero direct tokens on every request.

#### KV Cache effect

Independent of model requests: the provider never changes a request prefix.

## Known Limitations and Deferred Work

- Records and output exist only for the provider process lifetime. A daemon-backed provider, remote attachment, VT snapshots, control leases, and browser or Kitty consumers are deferred.
