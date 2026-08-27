# Console

English | [中文](README.zh.md)

Host-owned interactive console capability family.

| Package | Role | `ctx` key |
|---|---|---|
| [`@deepseek-ai/dsh-console`](console/README.md) | Service Definition | `consoles` |
| [`@deepseek-ai/dsh-console-tmux`](console-tmux/README.md) | Durable tmux provider | `consoles` |
| [`@deepseek-ai/dsh-console-remote`](console-remote/README.md) | Authorized Remote consumer | `consoles` |

The console family is separate from model-owned [`terminal`](../terminal/README.md) sessions: every Web attachment has its own in-memory bearer capability, and no Console operation is exposed as an Agent tool.
