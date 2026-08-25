# @deepseek-ai/dsh-console

English | [中文](README.zh.md)

Service Definition for `ctx.consoles`. It opens a configured human shell in a registered workspace and returns an opaque id plus a bearer capability. Every later operation requires both values; unknown ids and incorrect capabilities return the same `ACCESS_DENIED` error.

Snapshots expose workspace, cwd, pid, dimensions, status, and absolute output offsets. They never expose the capability. Output reads are repeatable and cursor-based: retained bytes arrive in bounded pages, expired cursors return an explicit gap, and future or invalid cursors fail with `INVALID_CURSOR`. Cancellable waits atomically return the same bounded page with its console snapshot when output or terminal state changes.

`stop()` terminates the complete terminal session and removes the record only after quiescence. Process exit retains state and output until an authorized caller stops the record.

## Model Experience

### Host console state

#### What the model sees

Nothing. `ctx.consoles` registers no tools, injects no prompts, and writes no session events.

#### Token effect

Zero direct tokens on every request.

#### KV Cache effect

Independent of model requests: the package never changes a request prefix.

## Known Limitations and Deferred Work

- The seam has no listing, attachment, control lease, generic program launcher, or Agent ownership API. Those consumers require separate product contracts.
