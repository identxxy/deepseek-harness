# @deepseek-ai/dsh-console-tmux

English | [中文](README.zh.md)

Durable Human Terminal provider for `ctx.consoles`. One Console maps to one session on the configured dedicated tmux server. DSH-generated session names and a versioned tmux user option carry the stable Console identity, Workspace identity, working directory, title, creation time, and archive state. Provider startup scans only that dedicated server and ignores sessions without a complete matching DSH name and metadata record.

Console workloads outlive browser attachments and the Host process. Each Web viewer gets an independent `tmux attach-session -E` process through `ctx.subprocess.spawnTerminal()`, an in-memory bearer capability, bounded raw output, and its own rows and columns. Detaching or disposing the provider terminates only those tmux Client processes. `terminate(ConsoleId)` is the only provider operation that runs `tmux kill-session`.

The provider requires tmux 3.2 or newer. Every configuration field is explicit: tmux and shell executables, dedicated server name, outer Client `TERM`, tmux window-size policy, command and attachment timeouts, output limits, reconciliation cadence, Console limits, and attachment limits. `shellArgs` must be empty because tmux accepts one shell-command string rather than preserving an argv vector; the resolved `shellPath` reaches a newly created dedicated server through its scrubbed `SHELL` environment. The shell inside tmux normally observes a tmux-owned `TERM`, such as `tmux-256color`, rather than the outer attachment value.

Create is a publication transaction: create a detached session, configure its window-size policy, write metadata, read the metadata back, and only then publish the Console. A failed transaction attempts to kill only its newly allocated DSH session. Rename and archive mutations also publish only after metadata read-back. Unknown, malformed, mismatched, or unsupported metadata is never adopted or deleted.

## Model Experience

### Durable Human Terminal execution

#### What the model sees

Nothing. `ctx.consoles` registers no tools, injects no prompts, and writes no Agent Session events.

#### Token effect

Zero direct tokens on every request.

#### KV Cache effect

Independent of model requests: the provider never changes a request prefix.

## Known Limitations and Deferred Work

- This provider supports tmux platforms only. A composition for an unsupported host must omit it and therefore exposes no Human Terminal creation capability.
- tmux permits concurrent Clients to write. The provider does not claim an exclusive controller that a native Kitty attachment could bypass.
- Raw terminal output is retained only for each ephemeral Web attachment. Reattaching obtains current screen state from tmux instead of replaying a durable byte log.
