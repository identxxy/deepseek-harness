# @deepseek-ai/dsh-client-ui-layout

[English](README.md) | 中文

外壳插件：响应式 AppFrame 加 `ctx.layout` 查看状态服务；它注册到运行时拥有的 `root` slot，并声明 `sidebar`、`conversation`、`details`、`conversation.empty`、`shell.overlay` 和 `workspace.console`。在 1024px 及以上宽度，AppFrame 是带拖动手柄和让步链的三栏外壳。中间栏渲染递归 pane tree，每个 leaf 寻址一个 Agent Session 或 Human Console。Leaf 可以替换 actor、向右或向下分屏、关闭和 focus，divider 可在 20–80% 范围内调整。侧边栏的缩放边界是不可见命中条带，详情栏边界则保留其浮动胶囊；让步期间只有详情栏会收缩并随后自动关闭。关闭的桌面侧边栏仍保留 56px 控制栏，详情栏则关闭到零宽度。在 1024px 以下，AppFrame 把 focused actor 渲染成一个全宽目标。浏览器返回和平台边缘侧滑手势会先回到统一的 Agent 与 Human Terminal 列表，再离开 DSH；split control、详情栏和拖动手柄均保持隐藏。该包还提供主题呈现器：它消费解析后的 `ctx.theme` 快照，并将其投影到 document（用 `html { color-scheme }` 驱动原生 UA 控件，依据当前配色方案设置 `body[data-ds-dark-theme]`，并将主题的别名 token 设为 body 上的内联变量，同时拥有一个 `<meta name="theme-color">`，其内容随计算后的 body 背景色更新）。在应用调色板和 token 后进行测量，可确保渲染后的背景成为唯一的颜色依据；呈现器在 dispose（资源释放）时会移除其自有的元数据节点，并一并清除其写入的其他全局状态。

AppFrame 始终挂载侧边栏、actor canvas 和详情栏。在 pane tree 尚不存在时，稳定的隐式 Agent scaffold 会接纳首个选中的 Session，而不替换 conversation DOM 或持久化 layout state；首次分屏才会实例化显式寻址的 pane tree。Agent leaf 通过显式寻址的 `SessionProvider` 渲染；Console leaf 通过 `workspace.console` slot 渲染，因此两个 pane 不会共享一个隐式 current Session。Store 只把带版本的 pane tree 与 active leaf 持久化到设备本地 browser storage。恢复前会校验精确字段、actor tag、唯一 id、深度、节点数、ratio 和 active leaf；非法数据会回退到全新 layout。Panel width 与响应式导航仍为瞬时状态。手机 History 只记录当前显示哪个目标。手机端非活跃目标保持以 viewport 宽度挂载，但不可见且不可交互，因此不会经历零宽重排，并能保留滚动与局部 layout state；手机目标切换立即完成，因为 desktop 列宽插值不能与 viewport 宽度的 center 同时生效。选择 Agent pane 会把它设为 details 与导航使用的全局 current Session；选择 Console 不会伪造 Agent Session。Conversation owner share 为空，sidebar owner share 只包含 `collapsed` 和 `width`；注册方通过标准钩子获取业务数据，并从各自的 inject 接口获取操作。

Pane chrome 使用语义中性的容器，使内层 conversation header 保留页面 banner landmark。Actor 标签、不可用状态以及分屏/关闭控件会跟随当前 Web locale。

`/client` 导出表层包含插件主体（`apply`／`inject`）、`LayoutController` 和四个 owner-share 接口。AppFrame、面板 store 与让步求解器仍属于包内部。

## 模型体验

无。布局外壳管理浏览器查看状态；这里没有任何内容进入模型请求。

#### KV Cache 影响

无；该包既不组装也不发送提供方请求。

## 已知限制与暂缓事项

- **面板几何信息是瞬时状态**：重新加载会恢复侧边栏默认值，并使详情栏保持关闭；在不同会话 id 之间切换同样会关闭详情栏，并忘记拖动后的宽度。Pane split 与 active actor 属于设备本地持久状态。
- **让步链自动关闭通过推导零宽度实现，不会改动宽度偏好**：窗口变宽时面板会自行恢复；消费方禁止把 store 中的详情宽度当作实际渲染状态。
- **挤压重排期间不提供滚动锚定**：布局变化可能移动读者的 viewport。
- **手机 History 不会在 URL 中编码 actor id**：重新加载时恢复设备本地 pane selection，History 只负责列表／actor 导航。
- **Catalog owner 显式协调过期 actor reference**：`ctx.layout.reconcileActorCatalog(kind, availableIds)` 会原子删除该类型完整 catalog 中不存在 actor 的所有 pane、折叠剩余 split、保留仍存活的 active pane，并在手机工作区清空后返回 Session 列表。
