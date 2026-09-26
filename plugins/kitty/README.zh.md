---
description: "通过可选 profile bundle 操作本机已有 Kitty 终端。"
kind: "package-bundle"
---

# @deepseek-ai/dsh-kitty

[English](README.md) | 中文

## 概述

从 DSH 侧栏操作本机 Linux 上已有的 Kitty pane。原生 DSH 对话窗格提供屏幕快照、文本、按键及待发送图片。本私有 workspace 为可选组件，不进入默认发布 profile。它不启动 Codex，也不注册 Agent 工具。

## 目录

- [使用](#use-this-package)
- [实现说明](#understand-the-implementation)
- [模型体验](#model-experience)
- [已知限制与后续工作](#known-limitations-and-deferred-work)

-----

<a id="use-this-package"></a>
## 使用

使用 Node ^22.19 或 >=24，在仓库根目录运行：

```sh
pnpm install
pnpm run check:kitty
```

检查包括插件类型检查、聚焦测试及 Host/Client 构建。依赖通过 pnpm workspace 链接，无需相邻 checkout 或手动链接脚本。构建产物位于 `lib/`，不纳入 Git。

本地安装时，在 web profile package 中添加指向本目录的 `@deepseek-ai/dsh-kitty` 的 `link:` 依赖，并将包名加入 `dsh.profile.bundles`。安装 profile 依赖后重启 `dsh --profile web`。[Patch](cordis.patch.yml) 插入 `kitty-host`；若服务 PATH 中没有 Kitty，请为其 `config.binary` 设置可执行文件路径。

打开 **Kitty 终端**后，侧栏会话列表切换为 **Kitty 窗口**。每行显示窗口 ID、标题、前台程序及工作目录，点击即可进入该终端。原生窗格顶栏显示所选窗口标题和返回按钮。桌面端可以在侧栏直接切换窗口。各窗格拥有自己的紧凑输入行，并保留草稿、暂存图片和末尾 Enter 选项。文本框默认一行，随草稿增高；普通输入行不为目标标签或状态额外占行。各窗格独立保留终端选择及跟随状态；侧栏选择只替换当前聚焦的窗格。新分屏最初显示当前聚焦的 Kitty 终端，侧栏高亮随窗格焦点切换。手机端在终端内返回会进入窗口列表，再从列表返回主页面。浏览器的返回和前进也遵循这一层级。返回列表保留所选窗口及草稿；选择另一个窗口会清空草稿和暂存图片。

页面在界面加载期间预取已认证的窗口列表。打开选择页时复用进行中的读取，或先显示保留的列表并同时刷新。手动刷新会替换正在进行的读取；读取失败后仍可重试。空布局打开主页面，不选择 Kitty 窗口，也不发送终端输入。

刷新或重新打开页面时，同一浏览器来源会恢复每个窗格对应的 Kitty 窗口。恢复从当前目录取得新 token，不发送输入。若原窗口已关闭或被替换，需要选择其他窗口；插件不会按标题或数字窗口 ID 匹配。目录读取失败时保留已保存的目标，可刷新重试。草稿、暂存图片和末尾 Enter 选项在重新加载时重置。

电脑和手机均使用一个**发送**按钮，旁边显示带文字标签的**末尾换行**勾选框。默认勾选时，“发送”和 Ctrl/⌘ Enter 会先粘贴草稿，再发送 Enter。取消勾选后省略最后的 Enter，草稿中已有的换行保持原样。没有文本或暂存图片时，“发送”和 Ctrl/⌘ Enter 均发送一次 Enter，不受勾选框影响。每个分屏独立记住选项，切换窗口时保留，刷新页面后恢复默认。打开**终端按键**（#）可使用 **Alt + ↑** 及 **↑ ↓ ← →** 按钮。方向按钮只发送对应方向键，不附加 Enter，并保留草稿。**Alt + ↑** 向所选终端发送该组合键，例如切换到 Codex 的待回答问题。该快捷键在手机上排在首位，并保留草稿。选图生成可移除预览，发送时图片引用与说明合并为一次粘贴。每次可暂存一张图片，剪贴板图片及拖放使用相同流程。

**Kitty 终端**与**新建终端**同属侧栏顶部操作区，共用按钮样式。选择终端后，可在窗口选择页使用**新建窗口**。它会在所选终端的工作目录中打开独立 Kitty 系统窗口，运行默认 shell，保持桌面焦点，并在选择页显示新窗口 ID。等待 shell 启动后选择该窗口。若新 shell 尚未列出，请刷新列表，不要重复创建。此功能需要已有本机 Kitty 实例。

屏幕默认折行。桌面端终端内容占各窗格宽度的 90%，左右各留 5% 边距；手机端保留 16px 侧边距，终端输出和草稿采用更紧凑的行距。仅包含横向分隔符或 Braille 字符及空格的行保持为一行，超出当前窗格宽度的部分裁切。星点位置变化不会撑高这些行；混有正文的行仍正常换行。窗口选择页的**终端选项**提供原始行宽、历史屏幕及跟随模式，切换窗口时保留这些设置。Ctrl/⌘ Enter 发送草稿，输入框内 Enter 换行。关闭面板停止轮询。从 profile 移除此 bundle 和依赖会卸载插件，不删除 CLI 或 DSH 会话数据。

关闭**包含历史屏幕**时，滚轮和单指手势先在网页内滚动显示的文本，到达顶部或底部后，继续滑动会滚动所选 Kitty 视口并立即读取屏幕。**最新输出**让 Kitty 返回实时屏幕。开启**包含历史屏幕**时，全部滚动都在浏览器内进行。滚屏保留草稿；切换窗口或模式会丢弃待发送手势并取消过时读取。

点击终端中的 HTTP(S) 或 `file://` 链接，即可在右侧打开**浏览器**。它从 DSH 主机读取报告，包括使用相对路径样式、图片和脚本的本地 HTML 报告。拖动左边缘调整宽度，固定小窗后可同时操作终端，也可以通过右侧竖排 **BROWSER** 窄标签重新打开。桌面端窗格为标签留出空间，避免遮住窗格或输入按钮。手机上向右滑动浏览器标题栏即可关闭。系统浏览器返回先收起小窗，再从终端返回窗口列表和主页面；小窗自己的返回与前进按钮用于报告导航。关闭小窗保留终端草稿和当前报告。

地址栏和终端链接会开始新的报告历史。报告内的链接和 GET 表单只能访问其真实目录或 HTTP 来源；显式输入地址可选择其他位置。相对路径的 GET/HEAD `fetch` 请求遵循相同限制。导航失败时保留当前报告。报告在沙箱中运行，无法访问 DSH 页面或凭据。

### 配置

| 字段 | 默认值 |
| --- | --- |
| `binary` | `kitty` |
| `socketDirectory`, `socketPrefix` | `/tmp`, `kitty.sock-` |
| `timeoutMs`, `graceMs` | `20000`, `500` |
| `maxOutputBytes`, `maxTextBytes`, `maxImageBytes` | `4194304`, `131072`, `8388608` |
| `maxQueuedActions`, `pollIntervalMs` | `16`, `5000` |
| `scrollDebounceMs`, `maxScrollLines` | `70`, `80` |
| `scrollPixelsPerLine`, `touchScrollSensitivity` | `42`, `5` |
| `previewMaxBytes`, `previewMaxResources` | `67108864`, `64` |
| `previewAssetDirectories` | `[]` |
| `imageDirectory` | `~/Pictures/voxpress` |

`previewAssetDirectories` 接受绝对目录路径数组。对于本地报告，Host 的 HTML 处理可内嵌这些显式配置目录中的静态图片、封面、视频及其他资源。默认 `[]` 不允许额外目录。Iframe fetch 和导航仍限制在所选报告目录内；HTTP 报告不能使用此本地文件权限。已打开的文件及符号链接必须位于允许的真实目录内。

目录配置要求绝对路径。图片保存在 UTC 日期子目录，直至用户清理。支持 PNG、JPEG、WebP、GIF、HEIC、HEIF。配置校验与默认值由 [local.mjs](local.mjs) 定义。

滚屏手势在 `scrollDebounceMs` 内累积后发送，每次只有一个请求在执行，且单次不超过 `maxScrollLines` 行。`scrollPixelsPerLine` 将像素转换为行数，`touchScrollSensitivity` 缩放触摸移动量，两者都接受正的小数。滚屏失败会清空待发送移动量，再次滑动会发起新请求。Host 已受理的滚屏可能在离开窗口后完成。

报告读取使用 `timeoutMs`；`maxQueuedActions` 同时限制并发预览请求数。`previewMaxBytes` 限制每次请求的源文件字节数、资源展开量和 JSON 输出量；base64 资源计入输出限制。默认 64 MiB 预算可容纳内嵌图表报告；更大的报告需要提高配置上限。浏览器会区分文件缺失、大小超限及预览服务不可用。`previewMaxResources` 限制文档资源与重定向次数。关闭浏览器取消其请求；卸载插件中止并等待 Host 读取结束。

-----

<a id="understand-the-implementation"></a>
## 实现说明

<details>
<summary>Host 与浏览器集成</summary>

[Host](host-plugin.js) 持有一个 [runtime](runtime.mjs)，注册已认证 HTTP 路由，并通过 DSH subprocess 执行 Kitty。[浏览器入口](src/client/index.ts) 注册侧栏。所有请求经过已有设备认证及 Connection 的 Host/Origin/Cookie 检查。非凭据标识 `windowId` 使用主机启动标识和原窗口进程，在 runtime 重启、前台程序、标题或目录变化时保持稳定。Pane token 绑定 socket inode、创建信息、PID 及进程启动时间；过期选择被拒绝，输入排队执行。卸载中止辅助进程，不关闭用户 pane。

Client 在原生布局中占据 keyed `sidebar.page`、`workspace.panel.header` 条目及 `workspace.panel` 内容区域。每个内容区域渲染指向自身窗格的 `KittyComposer`。插件按布局窗格 ID 保存终端选择、草稿、暂存图片、发送状态和跟随状态；行宽、历史屏幕选项及已认证目录数据源由各窗格共享。输入请求保留发起时的窗格及选择版本，因此延迟回执不会清空替换后的草稿。浏览器仅在当前来源的本地存储中持久化窗格与 `windowId` 的对应关系；凭据和输入状态只保存在内存中。Shell 负责响应式导航和浏览器历史。终端与 DSH 共用对话及输入卡片样式、按钮、图标和附件展示组件。内容为 ANSI 终端屏幕快照，不是结构化 DSH 消息记录。

Host 向首页注入凭据模式匹配的 fetch preload。Client 激活时消费该响应，其余界面挂载无需等待列表完成。目录读取的 HTTP 响应仍使用 `no-store`；保留的列表仅属于当前页面。Client 构建在开发模式之外压缩 JavaScript，并保留函数名和类名。

图片引用使用 `[image](file://...)`：开头的感叹号会触发 Codex shell 模式。ANSI 渲染器改编自本地 Kitty Remote Deck 实现，并拒绝可执行 OSC 超链接。

Browser 侧栏同时支持内网 HTTP 页面和 HTTPS 页面。

浏览器使用 `shell.overlay` 和不透明来源的 `srcDoc` iframe。父页面向 `/api/dsh/kitty/preview` 发送已认证 JSON 请求，不提供可执行报告路由，也不绕过登录。[读取器](preview.mjs) 签发仅由父页面持有的目录或来源限制，打开 Linux 常规文件后检查文件描述符，并校验每次 HTTP 重定向。[HTML/CSS 处理](preview-html.mjs) 使用 parse5 和 css-tree 内嵌范围内的资源。[设计记录](../../.agents/notes/implemented/feature/2026-09-12-kitty-report-browser.zh.md) 说明传输与隔离选择。

</details>

## 延伸阅读

[Profile 组合](../../docs/architecture.zh.md) · [可选插件](../README.zh.md)

<a id="model-experience"></a>
## 模型体验

无。本插件不注册模型工具，不改变模型请求、token 用量或 KV-cache 行为。输入进入所选的外部终端应用。

<a id="known-limitations-and-deferred-work"></a>
## 已知限制与后续工作

仅支持本机 Linux Kitty。Kitty 视口滚动作用于主屏幕及其历史缓冲；使用备用屏幕的应用自行管理内部滚动。Kitty 无法原子地比较前台进程并发送输入，进程可能在校验后退出。派发回执不证明模型收件或完成，失败的输入不会自动重试。本插件没有文件下载服务、SSH 目标、共享 Cordis service 或原生 Agent 工具。获授权的浏览器 Agent 可以操作 UI；原生工具集成需共用 runtime，并添加 Session 目标授权及结果日志。

浏览器预览 HTML、文本、图片及有大小限制的音视频，并非完整网页代理。外部 HTTP(S) CDN 资源由查看设备加载。不支持上游浏览器 Cookie 会话、POST 转发、WebSocket、XHR、JavaScript module import 重写及 PDF 查看。嵌套 frame/object 会被省略，响应式图片使用 `src` 后备资源。脚本直接设置导航地址或动态插入资源 URL 不经过报告桥接。

## 开发备注

无。
