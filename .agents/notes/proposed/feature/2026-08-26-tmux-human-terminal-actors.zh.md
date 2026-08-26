# Agent Note: tmux 支持的 Human Terminal actor

Status: proposed

[English](2026-08-26-tmux-human-terminal-actors.md) | 中文

## 问题

自托管 Workspace 需要在同一套导航与布局模型中容纳模型 Agent 和 Human 直接操作的 Terminal。现有持久 Terminal 能力有意由一个确切的 live Agent 持有，并把 PTY 适配为模型工具调用；扩宽到 Human caller 会削弱其 ownership、输出与取消保证。Human Terminal 还必须在浏览器 attachment 与 dsh Host 退出后继续运行，使本机 Kitty Client 与远程 Web Client 能操作同一个 shell，同时不让 Kitty 成为服务端依赖。

产品把两种 workload 都称为 actor，但直接 Terminal 没有模型、prompt、inbox、turn 或 agent loop。把它注册成 core `Agent` 会让模型 lifecycle event 与 durable Session log 描述从未发生的工作。

## 提案

把 Human Terminal 作为 Console 能力支持的一等产品 actor，而不是 core `Agent`。统一 Workspace UI 同时列出模型 Agent Session 与 Human Console，但两种 actor 保留各自的 runtime 与 renderer。Agent conversation 继续采用事件溯源；Terminal byte 不写入 Session log、telemetry 或 connection-wide Host event stream。

一个 Console 标识一个 DSH-owned tmux session。独立的 Console Attachment 标识一个临时 tmux Client，具有自己的 bearer capability、Terminal 尺寸、输出 cursor 与 idle cleanup。每个 Web viewer 都获得一个新的 attachment，因此 tmux 会直接绘制当前屏幕，浏览器重连不依赖任意 raw-byte history 的 replay。Kitty 作为另一个原生 tmux Client attach，并观察相同的 shell、process、window、pane 与 input。

tmux provider 使用配置的专属 tmux server，而不是用户默认的 server。它在 subprocess seam 的 scrubbed environment 下启动，只接受 DSH 生成的 session name，在 tmux user option 中记录非敏感 identity 与 Workspace metadata，并忽略没有有效 DSH metadata 的 session。Console identity 跨 Host restart 保留，process-local capability 不保留。Web 与本地 CLI attachment 禁止 tmux environment update，防止 Harness credential 被隐式写入现有 session。

创建操作只有在 detached tmux session 及其 metadata 已写入并读回后才发布。离开 pane 会 detach 对应 attachment。归档会隐藏 Console，但让 tmux session 继续运行。显式终止需要确认，并 kill tmux session。provider dispose 与 Host exit 会 detach 受管 Client，而不 kill Console workload。

Desktop Client 在可调整尺寸的水平或垂直 split 中渲染可寻址的 Agent 与 Console actor。普通 Sidebar 打开操作进入 active pane；显式操作会在新 split 中打开 actor。layout state 属于各 Client device。窄屏 Client 只渲染一个 focused actor，并通过 browser history 返回统一列表。本地 `dsh console attach <console-id>` 命令会用原生 tmux Client 替换自身进程；它会检测现有 tmux Client，避免创建不受支持的 nested attachment。

## 包角色

- `dsh-console` 定义 durable Console identity、ephemeral attachment identity、authorization、lifecycle 与 provider operation。
- `dsh-console-tmux` 通过 subprocess 能力提供 DSH-owned tmux workload 与 tmux-client attachment。
- `dsh-console-remote` 暴露经过授权的 list、create、attach、archive、terminate、attachment I/O、resize、signal 与 detach 操作。
- Client Console runtime 与 `dsh-ui-console` 把 Console 投影到统一 Workspace actor list，并渲染 Web Terminal pane。
- CLI consumer 解析 Console id 并执行原生 tmux attachment，不把 Kitty 变成依赖。

## 考虑过的替代方案

**注册一个 no-model core Agent。** 不采用，因为它必须模仿 inbox、turn、status、Session 与 request 行为，使 core Agent event 与 durable log 报告不存在的模型 lifecycle。

**把 Agent-owned Terminal 能力扩宽到 `Agent | Human`。** 不采用，因为确切 live-Agent ownership、面向模型的行式输出、controlled prompt 与 exclusive send 都是有意提供的保证。Human raw-terminal attachment 需要独立能力。

**每个 Console 保留一个 process-local PTY。** 这是被取代的 [Host-owned Console 提案](../../rejected/feature/2026-08-25-host-owned-console-sessions.zh.md)。它不能跨 Host restart 保留 workload，还需要额外的 Terminal emulator 或 reset protocol 才能重建任意 full-screen state。tmux 已经同时持有 persistence 与 redraw。

**每个 Workspace 使用一个 tmux session，并把 Console 建模为 window。** 不采用，因为 Console lifecycle、archive、title、access 与 termination 会影响同一个共享容器。每个 Console 对应一个 tmux session，可以保留独立 resource identity，同时仍允许 Console 内部使用 window 与 pane。

**从用户默认 tmux server 导入 session。** 不采用，因为 DSH 无法区分 ownership 或安全终止 resource。专属 server 与 DSH metadata 让普通 tmux workload 保持在产品控制之外。

**所有 viewer 共享一个 Web tmux Client。** 不采用，因为尺寸、重连 redraw、cursor retention 与 attachment cleanup 都属于 viewer。每个 viewer 使用临时 attachment，符合 tmux 原生 Client 模型。

## 验收标准

- 在已注册 Workspace 中创建 Human Terminal，会在专属 tmux server 上启动一个真实 session，并在 Agent Session 旁显示，同时不创建 core Agent 或 model turn。
- 同一个 Console 接受并发的 Web 与原生 tmux attachment；Client 之间可以看见 input 与屏幕更新，detach 所有 Client 后 workload 仍继续运行。
- 重启 dsh Host 会保留 tmux workload 与 Console id，使旧 process-local capability 失效，并允许新的 Web attachment 获得完整屏幕 redraw。
- Desktop Client 可以把 Agent 与 Console actor 放入可调整尺寸的 split；窄屏 Client focus 一个 actor，并通过 browser history 返回统一列表。
- Archive、restore、detach、external termination 与 explicit confirmed termination 具有不同的可观察状态，且不会 kill 无关 tmux session。
- provider 不继承 Harness credential-shaped environment variable、不导入任意 tmux session、不把 remote value 插入 shell command，也不在 tmux metadata 中存储 authority。
- 真实 tmux integration、Host restart、remote authorization、GUI behavior、keyless snapshot 与现有 Agent Terminal ownership test 覆盖 shipped composition。

## 风险

Human Terminal access 等价于 remote code execution，依赖现有 device-auth ingress 与 per-attachment capability。已 enroll device 一旦泄露，在撤销其 device credential 之前会获得与用户相同的 shell authority。

tmux 允许多个 Client 同时向同一 Terminal 输入。产品直接暴露这一事实，不声称拥有 exclusive input ownership；用户必须避免并发冲突输入。配置的 tmux window-size policy 也会用精确的 per-viewer geometry 换取稳定的共享屏幕。

当环境没有兼容的 tmux executable 或 Unix-user socket permission 时，tmux provider 不可用。Human Terminal 入口由能力是否存在决定；没有该 provider 的部署会省略入口，而不是显示无法使用的 control。

long-poll transport 可能给高吞吐 full-screen application 增加开销。后续 duplex carrier 只有在保留 attachment authorization、bounded output、cancellation 与 cleanup behavior 时才能替换它。
