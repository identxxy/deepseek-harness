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

打开 **Kitty 终端**后，侧栏会话列表切换为 **Kitty 窗口**。每行显示窗口 ID、标题、前台程序及工作目录，点击即可进入该终端。原生窗格顶栏显示所选窗口标题和返回按钮。桌面端可以在侧栏直接切换窗口。手机端在终端内返回会进入窗口列表，再从列表返回主页面。浏览器的返回和前进也遵循这一层级。返回列表保留所选窗口及草稿；选择另一个窗口会清空草稿和暂存图片。

“发送”会按 Enter 提交草稿；“仅粘贴”保留在终端输入框。选图生成可移除预览，发送时图片引用与说明合并为一次粘贴。每次可暂存一张图片，剪贴板图片及拖放使用相同流程。

**Kitty 终端**与**新建终端**同属侧栏顶部操作区，共用按钮样式。选择终端后，可在窗口选择页使用**新建窗口**。它会在所选终端的工作目录中打开独立 Kitty 系统窗口，运行默认 shell，保持桌面焦点，并在选择页显示新窗口 ID。等待 shell 启动后选择该窗口。若新 shell 尚未列出，请刷新列表，不要重复创建。此功能需要已有本机 Kitty 实例。

屏幕默认折行；手机端的终端输出和草稿采用更紧凑的行距。窗口选择页的**终端选项**提供原始行宽、历史屏幕及跟随模式，切换窗口时保留这些设置。Ctrl/⌘ Enter 发送草稿，输入框内 Enter 换行。关闭面板停止轮询。从 profile 移除此 bundle 和依赖会卸载插件，不删除 CLI 或 DSH 会话数据。

### 配置

| 字段 | 默认值 |
| --- | --- |
| `binary` | `kitty` |
| `socketDirectory`, `socketPrefix` | `/tmp`, `kitty.sock-` |
| `timeoutMs`, `graceMs` | `20000`, `500` |
| `maxOutputBytes`, `maxTextBytes`, `maxImageBytes` | `4194304`, `131072`, `8388608` |
| `maxQueuedActions`, `pollIntervalMs` | `16`, `5000` |
| `imageDirectory` | `~/Pictures/voxpress` |

目录配置要求绝对路径。图片保存在 UTC 日期子目录，直至用户清理。支持 PNG、JPEG、WebP、GIF、HEIC、HEIF。配置校验与默认值由 [local.mjs](local.mjs) 定义。

-----

<a id="understand-the-implementation"></a>
## 实现说明

<details>
<summary>Host 与浏览器集成</summary>

[Host](host-plugin.js) 持有一个 [runtime](runtime.mjs)，注册已认证 HTTP 路由，并通过 DSH subprocess 执行 Kitty。[浏览器入口](src/client/index.ts) 注册侧栏。所有请求经过已有设备认证及 Connection 的 Host/Origin/Cookie 检查。Pane 标识绑定 socket inode、创建信息、PID 及进程启动时间；过期选择被拒绝，输入排队执行。卸载中止辅助进程，不关闭用户 pane。

Client 在原生布局中占据 keyed `sidebar.page`、`workspace.panel.header` 条目及 `workspace.panel` 内容区域。这些视图共享暂存的窗口选择、显示设置和已认证目录数据源。Shell 负责响应式导航和浏览器历史。终端与 DSH 共用对话及输入卡片样式、按钮、图标和附件展示组件。内容为 ANSI 终端屏幕快照，不是结构化 DSH 消息记录。

图片引用使用 `[image](file://...)`：开头的感叹号会触发 Codex shell 模式。ANSI 渲染器改编自本地 Kitty Remote Deck 实现，并拒绝可执行 OSC 超链接。

</details>

## 延伸阅读

[Profile 组合](../../docs/architecture.zh.md) · [可选插件](../README.zh.md)

<a id="model-experience"></a>
## 模型体验

无。本插件不注册模型工具，不改变模型请求、token 用量或 KV-cache 行为。输入进入所选的外部终端应用。

<a id="known-limitations-and-deferred-work"></a>
## 已知限制与后续工作

仅支持本机 Linux Kitty。Kitty 无法原子地比较前台进程并发送输入，进程可能在校验后退出。派发回执不证明模型收件或完成，失败的输入不会自动重试。远端浏览器可能无法打开主机 file URL。本插件没有文件下载服务、SSH 目标、共享 Cordis service 或原生 Agent 工具。获授权的浏览器 Agent 可以操作 UI；原生工具集成需共用 runtime，并添加 Session 目标授权及结果日志。

## 开发备注

无。
