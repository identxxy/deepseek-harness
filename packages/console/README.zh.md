# Console

[English](README.md) | 中文

由 Host 拥有的交互式 console 能力系列。

| 包 | 角色 | `ctx` 键 |
|---|---|---|
| [`@deepseek-ai/dsh-console`](console/README.zh.md) | Service Definition | `consoles` |
| [`@deepseek-ai/dsh-console-local`](console-local/README.zh.md) | 进程内提供方 | `consoles` |
| [`@deepseek-ai/dsh-console-remote`](console-remote/README.zh.md) | 已授权 Remote consumer | `consoles` |

Console 系列与模型拥有的 [`terminal`](../terminal/README.zh.md) 会话分离：Host 操作由 bearer capability 授权，不会把 console 操作暴露为 Agent tool。
