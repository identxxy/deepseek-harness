# @deepseek-ai/dsh-console-local

[English](README.md) | 中文

`ctx.consoles` 的进程内提供方。它在服务初始化时解析 `shellPath`，随后用 workspace path 作为 `cwd`、用配置值作为终端类型调用 `ctx.subprocess.spawnTerminal()`；它不添加显式环境项。

所有配置均为必填：`shellPath`、`shellArgs`、`term`、`disposeGraceMs`、`outputRetentionBytes`、`maxReadBytes` 与 `maxOutputWaitersPerConsole`。字符串必须非空，数值必须是正 safe integer，且 `maxReadBytes` 不得超过 retention。

提供方保留有界原始字节尾部和绝对全流偏移。输出 drain 先于 exited 状态提交。Transport failure 转为 `failed`，保留此前字节并触发 terminal cleanup。并发 stop 复用同一次 cleanup；cleanup 失败会保留授权记录以供重试。服务 disposal 会阻止操作、中止未发布 open，并尝试清理每个已发布记录。

## 模型体验

### 进程内 console 执行

#### 模型看到的内容

无。`ctx.consoles` 不注册工具、不注入提示词，也不写入 session event。

#### Token 影响

每次请求的直接 token 为零。

#### KV Cache 影响

与模型请求独立：该提供方从不改变请求前缀。

## 已知限制与延期工作

- 记录与输出仅在提供方进程生命周期内存在。Daemon-backed provider、remote attachment、VT snapshot、control lease 及 browser 或 Kitty consumer 均延期。
