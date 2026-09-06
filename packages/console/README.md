---
description: "Choose console services for durable Human Terminals and authorized browser attachment."
kind: "package-group"
---
# Console

English | [中文](README.zh.md)

## Summary

Choose console services for durable Human Terminals and authorized browser attachment.

## Table of Contents

- [Use this package](#use-this-package)
- [Dev Note](#dev-note)

-----

<a id="use-this-package"></a>
## Use this package

Host-owned interactive console capability family.

| Package | Role | `ctx` key |
|---|---|---|
| [`@deepseek-ai/dsh-console`](console/README.md) | Service Definition | `consoles` |
| [`@deepseek-ai/dsh-console-tmux`](console-tmux/README.md) | Durable tmux provider | `consoles` |
| [`@deepseek-ai/dsh-console-remote`](console-remote/README.md) | Authorized Remote consumer | `consoles` |

The console family is separate from model-owned [`terminal`](../terminal/README.md) sessions: every Web attachment has its own in-memory bearer capability, and no Console operation is exposed as an Agent tool.

[The Console subsystem](../../docs/subsystems/console.md) describes workload and attachment lifetimes.

<a id="dev-note"></a>
## Dev Note

None.
