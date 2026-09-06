---
description: "创建和管理独立于 Agent 终端会话的持久 Human Terminal。"
kind: "package-reference"
---
# @deepseek-ai/dsh-console

[English](README.md) | 中文

## 概述

创建和管理独立于 Agent 终端会话的持久 Human Terminal。

## 目录

- [使用此包](#use-this-package)
- [模型体验](#model-experience)
- [已知限制与延期工作](#known-limitations-and-deferred-work)
- [开发备注](#dev-note)

-----

<a id="use-this-package"></a>
## 使用此包

`ctx.consoles` Service Definition 分别管理持久 Console 工作负载与临时查看器连接。目录操作在部署的认证入口后列出、创建、重命名、归档、恢复和终止工作负载。每个连接获得自己的 id 和 bearer capability；终端 I/O 同时要求提供两者。

工作负载 snapshot 暴露 Workspace、cwd、标题、创建时间、归档状态和进程状态。连接 snapshot 暴露终端尺寸、进程状态和绝对输出偏移，不暴露 capability。基于 cursor 的输出读取返回有界页面或明确的 gap；无效 cursor 以 `INVALID_CURSOR` 失败。

`detach()` 释放一个查看器。`terminate()` 结束工作负载及其连接。身份和生命周期语义见 [Console 子系统](../../../docs/subsystems/console.zh.md)。

<a id="model-experience"></a>
## 模型体验

### Host console 状态

#### 模型看到的内容

无。`ctx.consoles` 不注册工具、不注入提示词，也不写入 session event。

#### Token 影响

每次请求的直接 token 为零。

#### KV Cache 影响

与模型请求独立：该包从不改变请求前缀。

## 已知限制与延期工作

<a id="known-limitations-and-deferred-work"></a>
- 该 seam 不提供独占输入 lease：多个查看器可以同时向同一工作负载写入。

未发布运行时 invariant companion，因为抽象 Console 服务不拥有 provider 状态。

<a id="dev-note"></a>
### 开发备注

无。
