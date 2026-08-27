# @deepseek-ai/dsh-console-tmux

[English](README.md) | 中文

`ctx.consoles` 的持久 Human Terminal 提供方。每个 Console 对应配置的专属 tmux server 上的一个 session。DSH 生成的 session name 与 versioned tmux user option 保存稳定 Console identity、Workspace identity、working directory、title、creation time 与 archive state。提供方启动时只扫描该专属 server，并忽略没有完整匹配 DSH name 与 metadata record 的 session。

Console workload 的生命周期长于 browser attachment 与 Host process。每个 Web viewer 通过 `ctx.subprocess.spawnTerminal()` 获得独立的 `tmux attach-session -E` process、仅驻内存的 bearer capability、有界 raw output 以及自己的 rows 与 columns。Detach 或 disposal 只终止这些 tmux Client process。`terminate(ConsoleId)` 是唯一会运行 `tmux kill-session` 的提供方操作。

提供方要求 tmux 3.2 或更高版本。所有配置字段均为显式项：tmux 与 shell executable、专属 server name、外层 Client `TERM`、tmux window-size policy、command 与 attachment timeout、output limit、reconciliation cadence、Console limit 和 attachment limit。`shellArgs` 必须为空，因为 tmux 接受单个 shell-command string，不能保留 argv vector；解析后的 `shellPath` 通过 scrubbed `SHELL` environment 传给新建的专属 server。tmux 内 shell 通常看到 tmux 所有的 `TERM`，例如 `tmux-256color`，而不是外层 attachment 值。

Create 是 publication transaction：创建 detached session、配置 window-size policy、写 metadata、读回 metadata，随后才发布 Console。失败 transaction 只尝试 kill 其本次新分配的 DSH session。Rename 与 archive mutation 也只在 metadata read-back 后发布。未知、损坏、不匹配或不支持的 metadata 不会被接管或删除。

## 模型体验

### 持久 Human Terminal 执行

#### 模型看到的内容

无。`ctx.consoles` 不注册工具、不注入 prompt，也不写入 Agent Session event。

#### Token 影响

每次请求的直接 token 为零。

#### KV Cache 影响

与模型请求独立：该提供方从不改变 request prefix。

## 已知限制与延期工作

- 该提供方只支持 tmux platform。不支持的 Host composition 必须省略它，因此也不会暴露 Human Terminal 创建能力。
- tmux 允许多个 Client 同时写入。提供方不声称存在 native Kitty attachment 可以绕过的独占 controller。
- Raw terminal output 只在每个 ephemeral Web attachment 中保留。重新 attach 会从 tmux 获取当前 screen state，而不是 replay durable byte log。
