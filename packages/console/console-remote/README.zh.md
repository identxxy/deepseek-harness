# @deepseek-ai/dsh-console-remote

[English](README.md) | 中文

面向持久 Human Terminal Console 的 Remote Consumer。它在 `consoles` wire namespace 下暴露 catalog `list`、`create`、`snapshot`、`rename`、archive/restore、显式 `terminate`，以及临时 attachment `attach`、`attachmentSnapshot`、long-poll `read`、`write`、`resize` 与 `detach`。

所有配置均为必填：`maxPollWaitMs` 限制单次调用等待时间，`maxWriteBytes` 限制解码后的 UTF-8 输入，`maxTitleBytes` 限制 Console 标题。输出使用 base64，cursor 仍按解码后的原始字节计数。业务失败仅公开稳定 code，不公开内部诊断；carrier 与编程错误仍作为传输错误。外部 device authentication 属于 Web ingress；经过该入口后，attachment capability 再提供每个 Client 的 I/O 授权。

生成的 `./typert` 与 `./remote` face 会在运行时 import `zod`。因此即使 `src` 不 import 它，本包仍直接声明该依赖；限定在该 workspace 的 Knip 例外只覆盖这些生成产物。

## 模型体验

### 已授权 Console 传输

#### 模型看到的内容

无。`ctx.consoleRemote` 不注册工具、不注入提示词，也不写入 session event。

#### Token 影响

每次请求的直接 token 为零。

#### KV Cache 影响

与模型请求独立：该包从不改变请求前缀。

## 已知限制与延期工作

- 本包不提供外部 identity authentication。部署必须通过已认证入口保护浏览器 transport，例如 shipped device-auth composition。
- Terminal 输出使用有界 long-poll response。未来 duplex carrier 必须保留 attachment capability、byte cursor、cancellation 与 teardown 语义。
