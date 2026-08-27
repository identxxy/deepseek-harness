# @deepseek-ai/dsh-console-remote

English | [中文](README.zh.md)

Remote Consumer for durable Human Terminal Consoles. It exposes catalog `list`, `create`, `snapshot`, `rename`, archive/restore, explicit `terminate`, and ephemeral attachment `attach`, `attachmentSnapshot`, long-poll `read`, `write`, `resize`, and `detach` under the `consoles` wire namespace.

All configuration is required: `maxPollWaitMs` caps each caller wait, `maxWriteBytes` caps decoded UTF-8 input, and `maxTitleBytes` caps Console titles. Output uses base64 while cursors continue to count raw decoded bytes. Business failures expose stable codes without internal diagnostics; carrier and programming failures remain transport errors. External device authentication belongs to the Web ingress; attachment capabilities add per-Client I/O authorization after that ingress.

The generated `./typert` and `./remote` faces import `zod` at runtime. The package declares it directly even though `src` does not import it; the workspace-scoped Knip exception covers only those generated artifacts.

## Model Experience

### Authorized console transport

#### What the model sees

Nothing. `ctx.consoleRemote` registers no tools, injects no prompts, and writes no session events.

#### Token effect

Zero direct tokens on every request.

#### KV Cache effect

Independent of model requests: the package never changes a request prefix.

## Known Limitations and Deferred Work

- This package does not provide external identity authentication. Deployments must protect its browser transport through an authenticated ingress such as the shipped device-auth composition.
- Terminal output uses bounded long-poll responses. A future duplex carrier must preserve attachment capabilities, byte cursors, cancellation, and teardown semantics.
