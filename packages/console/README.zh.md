---
description: "选择用于持久 Human Terminal 与授权浏览器连接的 Console 服务。"
kind: "package-group"
---
# Console

[English](README.md) | 中文

## 概述

选择用于持久 Human Terminal 与授权浏览器连接的 Console 服务。

## 目录

- [使用此包](#use-this-package)
- [开发备注](#dev-note)

-----

<a id="use-this-package"></a>
## 使用此包

由 Host 拥有的交互式 console 能力系列。

| 包 | 角色 | `ctx` 键 |
|---|---|---|
| [`@deepseek-ai/dsh-console`](console/README.zh.md) | Service Definition | `consoles` |
| [`@deepseek-ai/dsh-console-tmux`](console-tmux/README.zh.md) | 持久 tmux 提供方 | `consoles` |
| [`@deepseek-ai/dsh-console-remote`](console-remote/README.zh.md) | 已授权 Remote consumer | `consoles` |

Console 系列与模型拥有的 [`terminal`](../terminal/README.zh.md) 会话分离：每个 Web attachment 都有独立的内存 bearer capability，并且不会把 Console 操作暴露为 Agent tool。

[Console 子系统](../../docs/subsystems/console.zh.md)说明工作负载和连接的生命周期。

<a id="dev-note"></a>
## 开发备注

无。
