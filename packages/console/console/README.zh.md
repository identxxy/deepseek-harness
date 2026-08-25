# @deepseek-ai/dsh-console

[English](README.md) | 中文

`ctx.consoles` 的 Service Definition。它在已注册 workspace 中打开配置的人类 shell，并返回不透明 id 与 bearer capability。之后每个操作都要求同时提供这两个值；未知 id 和错误 capability 均返回相同的 `ACCESS_DENIED` 错误。

Snapshot 暴露 workspace、cwd、pid、尺寸、状态和绝对输出偏移，绝不暴露 capability。输出读取可重复并基于 cursor：保留字节按有界页面返回，过期 cursor 返回明确 gap，未来或无效 cursor 以 `INVALID_CURSOR` 失败。可取消等待会在输出或终端状态变化时，原子返回同一有界页面及其 console snapshot。

`stop()` 终止完整 terminal session，并只在达到静止后删除记录。进程退出后仍保留状态和输出，直到获授权调用方停止记录。

## 模型体验

### Host console 状态

#### 模型看到的内容

无。`ctx.consoles` 不注册工具、不注入提示词，也不写入 session event。

#### Token 影响

每次请求的直接 token 为零。

#### KV Cache 影响

与模型请求独立：该包从不改变请求前缀。

## 已知限制与延期工作

- 该 seam 没有列表、attachment、control lease、通用程序 launcher 或 Agent ownership API。这些 consumer 需要独立产品约定。
