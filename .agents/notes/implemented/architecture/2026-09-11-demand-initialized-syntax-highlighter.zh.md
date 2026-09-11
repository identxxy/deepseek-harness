# Agent Note: 按需初始化语法高亮器

Status: implemented

[English](2026-09-11-demand-initialized-syntax-highlighter.md) | 中文

## 问题

即使用户只浏览 Session 或打开 Kitty，共享 UI primitives 也会在 Web 启动时加载。因此，模块级定时器构建 Shiki 单例会在没有代码需要高亮时增加主线程工作。本机 CPU profile 将单例构建识别为启动长任务；这证明的是该机器上的瓶颈，不是跨设备性能保证。

## 决策

`highlight.ts` 在首次受支持的高亮请求中同步构建文档局部单例。导入模块不会安排单例预热。未知或缺省语言提示保持纯文本，不构建单例。`CodeBlock` 和 `ReadBlock` 既有的视口激活机制将受支持的请求延迟至内容可见；不提供 `IntersectionObserver` 时仍沿用立即激活的回退路径。

构建保留三种随包语法（TypeScript、shell 和 JSON）的代表性 tokenize，并使用 `tokenizeTimeLimit: 0`。这在扫描用户内容的预算之外准备其 scanner pattern。语法模块仍随包提供，23 种扩展语法仍通过动态 import 加载，高亮保留同步输出、token 样式和流式缓存。

本决策负责初始化时机。[Shiki 选型](../process/2026-07-26-web-syntax-highlighting-shiki.zh.md)、[视口激活](2026-08-31-viewport-activated-syntax-highlighting.zh.md)与[读取卡片语法加载](../feature/2026-07-30-web-read-card-frontend.zh.md)决策保留各自独立的依赖、渲染和惰性导入依据。

## 曾考虑的替代方案

**保留模块加载时由定时器驱动的单例预热。** 它能降低首个代码块的延迟，但也会在无代码和仅查看 Kitty 的页面构建高亮器，并与启动交互争用主线程。

**同时移除随包语法的 tokenize 预热。** 这会减少初始构建工作，却把 scanner pattern 编译移入用户内容的超时预算，削弱既有机制对主机争用下不完整 token 流的保护。按需初始化改变该准备工作的执行时机，不改变其正确性作用。

## 影响

无代码的启动避免构建单例。首个激活的受支持代码块承担同步初始化，可能产生长任务；后续代码块复用同一实例。这不会减少初始 bundle 中的语法字节，也不保证首次代码渲染更快。模型可见输入、Session 事件和持久化数据均不改变。
