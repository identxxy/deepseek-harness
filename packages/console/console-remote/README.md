# @deepseek-ai/dsh-console-remote

English | [中文](README.zh.md)

Remote Consumer for already-authorized host-owned consoles. It exposes `snapshot`, long-poll `read`, `write`, `resize`, `signal`, and `stop` under the `consoles` wire namespace. It never opens, lists, discovers, mints, or reattaches sessions.

All configuration is required: `maxPollWaitMs` caps each caller wait and `maxWriteBytes` caps decoded UTF-8 input. Output uses base64 while cursors continue to count raw decoded bytes. Business failures expose stable codes without internal diagnostics; carrier and programming failures remain transport errors.

## Model Experience

### Authorized console transport

#### What the model sees

Nothing. `ctx.consoleRemote` registers no tools, injects no prompts, and writes no session events.

#### Token effect

Zero direct tokens on every request.

#### KV Cache effect

Independent of model requests: the package never changes a request prefix.

## Known Limitations and Deferred Work

- This package does not provide external identity authentication and is not mounted by a shipped bundle. Browser attachment, VT snapshots, and UI remain outside this package.
