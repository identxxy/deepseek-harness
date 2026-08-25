# @deepseek-ai/dsh-console-remote

[English](README.md) | 中文

面向已获授权 Host-owned console 的 Remote Consumer。它在 `consoles` wire namespace 下暴露 `snapshot`、long-poll `read`、`write`、`resize`、`signal` 与 `stop`，绝不开放创建、列举、发现、签发或重新附加会话的接口。

所有配置均为必填：`maxPollWaitMs` 限制单次调用等待时间，`maxWriteBytes` 限制解码后的 UTF-8 输入。输出使用 base64，游标仍按解码后的原始字节计数。业务失败仅公开稳定 code，不公开内部诊断；carrier 与编程错误仍作为传输错误。

## 模型体验

### 已授权 Console 传输

#### 模型看到的内容

无。`ctx.consoleRemote` 不注册工具、不注入提示词，也不写入 session event。

#### Token 影响

每次请求的直接 token 为零。

#### KV Cache 影响

与模型请求独立：该包从不改变请求前缀。

## 已知限制与延期工作

- 本包不提供外部 identity authentication，也未挂入 shipped bundle。浏览器 attachment、VT snapshot 与 UI 不属于本包。
