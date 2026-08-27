# @deepseek-ai/dsh-client-ui-console

[English](README.md) | 中文

面向 tmux-backed Human Terminal 的浏览器插件。它负责 Console catalog 镜像、临时 attachment capability、xterm renderer、Workspace 导航 row、创建操作、生命周期菜单和手机 terminal 辅助键栏。关闭 pane 或卸载浏览器插件只 detach Web tmux Client；archive 保持 workload 运行，而确认 terminate 会删除该 Console 的导航 row 与所有 pane。

桌面导航会在活动 Actor pane 或相邻 split 中打开 Console。窄布局只显示当前 focus Actor，并使用 shell 的浏览器 history 导航返回统一的 Agent 与 Human Terminal 列表。Pane tree 是设备本地浏览器状态；attachment capability 只保留在 live plugin instance 中。

Host 会把必填部署配置 `catalogRefreshIntervalMs` 注入浏览器 bootstrap。Catalog refresh 只有一条当前 list request；该请求期间到达的 demand 最多共享一条 deferred request，因此即使 refresh interval 短于 list latency，每个 caller 也只等待一条有界 request。后台 refresh 会为 React observer 保留已经完整的 ready catalog；refresh 失败后会保持 error，直到后续 request 成功。被 connection 或 mutation 取代的 response 不能发布。浏览器只根据 ready 且完整的 catalog 协调导航与 pane reference：running Console 保持可用，包括仍有打开 pane 的 archived workload；ended 或不存在的 Console 会从导航和所有 split 中消失。Attachment 观察到 workload 结束时会立即请求 catalog refresh；请求失败时保留可见的 ended phase，并由有界周期 refresh 重试清理。Catalog mutation 按调用顺序执行。Remote mutation 成功、本地点投影和完整 catalog recovery 是相互独立的结果：即使后台 refresh 失败，基于先前完整 baseline 的 point mutation 也会把 patched catalog 发布为 ready；connection reset 会清除该完整性并要求 recovery。必要的 recovery 失败会被报告，但不会改变成功的 mutation result。Connection reset 会在本地废止旧 bearer capability 和 pending mutation result，在不改变 Remote wire signature 的情况下 abort catalog mutation、list request 和 attachment I/O 的浏览器等待，递增可观察的 connection epoch，并让所有已挂载 terminal pane 建立新 attachment。Plugin dispose 使用相同的 browser-side cancellation 并等待本地结果收敛，因此无响应的 carrier 不会让 teardown 一直 pending。

每个 attachment 的 input write 严格 FIFO。一次结果不确定的 write failure 会 poison 对应 write lane，后续 command fragment 会被拒绝，而不会接在提交状态未知的前缀之后发送。Resize request 串行执行，排队尺寸可以合并为最新值。即使 carrier 忽略已有 signal，每个 attachment Remote wait 也具有 browser-side cancellation。Pane cleanup 与 plugin dispose 最多共享一次 detach Remote 调用；dispose 会 memoize 同一 cleanup 结果，取消卡住的 attach、read、write、resize 和 detach 等待，并只在所有已追踪 browser work 本地收敛后结束。Dispose 开始后，public detach 只能 join 已有 detach 或观察已经 detached 的 attachment；unknown access 会被拒绝，不会创建 lane 或 Remote work。底层 carrier promise 如果稍后 reject，仍会被消费。

## 模型体验

### Human Terminal 浏览器界面

#### 模型看到的内容

无。`ctx.consoleClient` 不注册模型工具、prompt section 或 Agent Session event。

#### Token 影响

每次请求的直接 token 为零。

#### KV Cache 影响

与模型请求独立：该包从不改变请求前缀。

## 已知限制与延期工作

- Terminal 输出目前使用有界 long polling，而不是 duplex 浏览器 stream。
- 多个 Web 与原生 tmux Client 可以同时输入；UI 不声称提供独占控制。
- 第一版的重命名与终止确认使用浏览器原生 dialog。
