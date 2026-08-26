# Agent Note: 手机 Session 导航使用浏览器 History

Status: implemented

[English](2026-08-26-mobile-session-navigation.md) | 中文

## Problem

桌面外壳会同时保留 Session 浏览器、对话和详情的访问能力。如果在大尺寸断点以下继续套用同一套三栏模型，侧边栏会缩成 56px 轨道，对话空间受到挤压，Session 列表也只是一个应用内面板开关，而不是手机导航的上一级。手机用户期望进入一个对话后占满 viewport，并通过平台返回手势回到全部对话列表。

Session 选择本身不能表达这种导航。空白 New Session 界面没有选中的 Session id；即使打开当前已选 Session，从列表进入对话仍是一次有意义的导航；浏览器返回也必须只改变可见界面，而不能清空或重新打开运行时 Session。

## Decision

`AppFrame` 在 `MOBILE_NAV_BREAKPOINT`（1024px）以下使用单栏布局。Session 列表和对话仍挂载在固定 grid 位置，但每次只有一个获得完整 frame 宽度，另一个在零宽轨道中裁切。此模式下详情栏和两个缩放手柄都以零宽渲染。在断点及以上，现有三栏求解器、可拖动宽度、详情让步和关闭侧边栏后的 56px 轨道保持不变。

ui-layout 的瞬时 store 以 `mobileView: 'auto' | 'sessions' | 'conversation'` 持有响应式目标。浏览器 History 中存在 DSH 标记时，`auto` 据此派生首帧；否则依据运行时是否有已选 Session 派生。显式的 `showSessionList` 与 `showConversation` 操作表达用户导航，不会改变 Session 业务状态。跨越断点时只重置响应式目标，桌面宽度偏好仍保留。

进入单栏模式的第一条 History 记录通过 `replaceState` 标记为 Session 列表。进入对话时会压入第二条 URL 相同的记录。`popstate` 将这些标记映射回布局操作，因此平台边缘侧滑、浏览器后退和前进都会在列表与对话之间移动，同时保留已选 Session 和两个已挂载 React 子树。应用内布局操作从对话返回列表时，如果当前记录是对话子级，就调用 `history.back()`，避免产生重复的列表记录。

ui-sidebar 在 New Session 后请求显示对话目标。ui-workspace 在新建或打开 Session 后，以及 fork 成功打开子 Session 后执行同一操作。这些都是通过 `ctx.layout` 实现的视图导航效果；运行时服务仍然是 Session 选择、创建和 fork 状态的唯一持有者。

## Alternatives considered

**手机继续保留 56px 轨道，并允许用户在对话上方展开。** 这能在所有宽度保留一种桌面交互，但展开的侧边栏仍与对话争用同一个狭窄 grid，平台返回也仍无法表达“全部对话”。

**把侧边栏渲染为覆盖在对话上的模态抽屉。** 抽屉可以让下层对话保持挂载，也不需要 History 状态。但它会把 Session 列表变成临时浮层，而不是导航上一级；手机原生返回手势究竟关闭实现特定的浮层还是离开应用，会依赖浏览器行为。

**在 URL 中编码选中的 Session id，并把列表和对话做成路由页面。** 可寻址的 Session URL 本身有价值，但会扩大 wire 与重新加载约定，而且仍无法覆盖空白 New Session 界面。本次变化只需要本地查看状态，因此 History 标记保持当前 URL 不变，把可寻址能力留给独立决策。

**卸载非活动目标。** 这样能让手机宽度下的 DOM 最小，但返回 Session 列表或对话时会重建本地滚动、搜索、composer 和 disclosure 状态。零宽挂载轨道复用了桌面外壳现有的状态保留规则。

## Consequences

- 手机宽度形成两级导航：完整 Session 列表，然后是一个完整对话。浏览器后退会回到列表，前进会恢复对话，且不发起 Host 请求。
- 桌面 split、面板偏好和 56px 轨道保持原行为，因为桌面求解器会忽略手机目标。
- 浏览器 History 只记录列表／对话目标，不记录 Session id。重新加载会独立恢复运行时已选 Session，因此可能显示不同于旧 History 记录原先对应的对话。
- 手机中隐藏侧边栏时，它收到 `{ collapsed: true, width: 0 }`。侧边栏仍保持挂载，并在裁切轨道内完成现有收起过渡。
- 发起 Session 导航的插件除了调用对应运行时操作，还必须调用 `ctx.layout.showConversation()`；ui-sidebar 和 ui-workspace 提供已发布入口。

## Testing

ui-layout 的 store、service 和 AppFrame 测试覆盖响应式目标切换、同值与跨断点重置、零宽／全宽 owner props、手机无拖动手柄、History push／back／pop 行为和桌面宽度恢复。ui-sidebar 与 ui-workspace wiring 测试覆盖 New Session、打开和 fork 新增的视图导航效果。

`apps/web/tests/navigation-panes.e2e.ts` 在 Chromium 的 390px 宽度下启动已发布 Web 组合，从内容搜索打开一个冷 Session，记录列表和对话的轨道几何，并驱动浏览器后退与前进，在真实 History 实现中验证两个目标。
