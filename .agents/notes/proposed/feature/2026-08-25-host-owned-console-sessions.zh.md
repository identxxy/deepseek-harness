# Agent Note: Host 持有的 Console 会话

Status: proposed

[English](2026-08-25-host-owned-console-sessions.md) | 中文

## 问题

现有持久 Terminal 能力由一个确切的 live Agent 持有，并把 PTY 适配为面向模型的行式工具。浏览器或本机 Human attachment 需要原始 VT 输出、resize、重连和显式输入所有权，同时不能削弱 Agent 授权。若进程绑定浏览器连接，刷新、布局变更和网络中断还会终止本应继续的 workload。

Codex、Claude、Human shell 和 dsh-native Agent 需要共用一个自托管 Workspace，但它们并不使用同一种交互表示。Codex 与 Claude 首先保持 terminal-native workload；dsh-native Agent 保留 durable conversation、tool、approval 和 subagent projection。Kitty 可以显示 terminal attachment，却不能渲染这些结构化 Agent 状态。

## 提案

新增 Console capability，其 Host-owned session 包含一个 PTY、一个 top-level workload、原始输出 replay 状态、lifecycle status，以及一个独占的输入与 geometry controller。Console session 在 attachment 丢失后继续运行，只能通过显式 stop、top-level process exit 或 provider teardown 结束。Agent Terminal 继续由确切 Agent 持有，不暴露内部 handle，也不扩宽 owner 类型。

第一个 provider 通过 `ctx.subprocess.spawnTerminal()` 启动。subprocess terminal handle 提供 provider-neutral resize；terminate 时，每个 provider 都会 join 或 abort 进行中的 resize。第一个 Console provider 与 dsh Host 同进程运行，但其 public interface 不假定 ownership 永远处于进程内，使后续独立 daemon 能在不改变 Console 语义的情况下跨 Host restart 保留 workload。

每次 attach、read、input、resize、signal 和 stop 除 branded Console id 外，还必须授权 principal 或不可猜测的 capability。多个 observer 可以接收输出，但只有当前 controller 可以输入或改变 PTY 尺寸。远程 viewer focus Console 不会自动获取控制权，也不会改变 geometry。

输出使用单调 sequence 和有界 retention。重连先获得 server 派生的 terminal snapshot 及其 sequence，再接收后续 delta；cursor 超出 retention 时返回显式 resynchronization 结果。terminal bytes 不写入 Agent session log，也不进入 connection-wide host event broadcast。

首个 remote consumer 用 Typert RPC 承载控制操作，并用 capability-checked bounded long-poll 读取输出。当实测吞吐确实需要时，可以用 dedicated duplex transport 替换 polling carrier，但必须保留 Console service 的 snapshot、delta、authorization 和 controller 语义。

Web Client 首先只在当前 Agent conversation 旁加入一个 Human Console tile，窄屏设备只渲染 focused tile。Device layout 与 focus 属于 viewer state；Console lifecycle、attention 与 control 属于 Host shared state。多个 Agent tile 同时显示需要另一项改动，使 Client session provider 可按地址获取，不再让所有 renderer 绑定一个 current session。

Kitty 保持 optional attachment launcher。后续 integration 打开或聚焦一个运行 `dsh console attach <console-id>` 的 pane；Kitty 不持有 PTY，不授权 Console 操作，也不提供正常 output replay。

## 包角色

- `dsh-console` 定义 Console identity、lifecycle、replay、authorization、control 与操作。
- `dsh-console-local` 通过 subprocess capability 提供 Host-local PTY。
- `dsh-api-remotes` 装配经过授权的 Remote consumer。
- `dsh-ui-console` 在 Web Client 中渲染并控制 Console attachment。
- 后续 local-attach、Kitty、daemon 和 tmux 包消费或提供相同 capability，不改变默认 execution substrate。

## 考虑过的替代方案

**把 Agent Terminal owner 扩成 `Agent | Human`。** 不采用，因为确切 live-Agent identity、行式输出、controlled prompt 和 exclusive model send 都是其有意提供的保证。union owner 或 raw-handle escape 会让 alternate caller 绕过这些规则。

**让 Kitty 或 bridge process 持有所有 PTY。** 不采用，因为 GUI lifecycle 与物理键盘会绕过 Host control，使远程操作依赖 Kitty session，并把不可靠的 screen scraping 变成 output authority。

**强制以 tmux 为 provider。** 不采用，因为它会在产品确实需要跨 Host persistence 之前，把 process、terminal、authorization 和 teardown ownership 转交外部 server。tmux 仍可以是 optional provider。

**通过现有 host event downlink 发送 terminal bytes。** 不采用，因为该 stream 会广播到每个已连接 Client，也不会逐 Console capability 授权；它还会把高流量 terminal traffic 与 Agent session reconnect 绑定。

**把 Codex 与 Claude terminal interface 解析为 structured Agent session。** 初始能力不采用，因为 filesystem 与 Git state 是可靠 shared facts，而第三方 TUI conversation format 不是稳定 integration contract。

## 验收标准

- Web Human Shell 能启动真实 PTY、接受 input 与 controller-owned resize，在不重启进程的情况下重连，并在显式 stop 后使 process tree quiescent。
- 即使调用方知道 Console id，Console authorization 仍拒绝 foreign principal 或 capability 的所有读取与修改。
- Observer 接收有序输出且 cursor 互不消费；retention gap 触发显式 snapshot resynchronization。
- Browser refresh、hidden tile、remote disconnect 与 Kitty attachment loss 都不会停止 workload。
- Agent Terminal 的 exact-owner tests 保持不变并通过。
- shipped Web profile 通过真实 Loader、HTTP/RPC、PTY 与 browser composition 证明该行为，并提供 keyless snapshot 和 GUI recording。

## 风险

Human Console 等价于 remote code execution。Host 必须位于强 external identity boundary 之后，对每次 Console 操作授权，清理 launcher environment 中的 harness credential，并让 session id 与 authority 分离。

进程内 local provider 无法在 Host crash 后保留 workload。首个版本必须明确该 lifecycle；承诺 crash persistence 之前需要独立 daemon。

原始 output retention 不是完整 terminal state。实现必须加入 headless terminal snapshot 或等价的 deterministic reset-and-replay mechanism，才能宣称任意重连都保持显示一致。

Bounded long-poll 更容易授权，但高吞吐 full-screen application 可能产生额外延迟或请求开销。Transport replacement 必须由测量驱动，并保留相同 authorization 与 replay 语义。
