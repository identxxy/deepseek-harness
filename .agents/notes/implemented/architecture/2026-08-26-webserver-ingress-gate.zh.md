# Agent Note: Webserver 单所有者入口分发

Status: implemented

[English](2026-08-26-webserver-ingress-gate.md) | 中文

## Problem

应用级访问策略必须先于所有浏览器载体执行，然后载体才能到达 HTTP 精确 route、前缀 route、静态 fallback、自动 404、命中的 upgrade route 或未命中的 upgrade 关闭分支。在现有 route 所有者中分别注册检查会重复策略，使新增 route 默认不受保护，也无法覆盖 webserver 自身的 404 与未命中 upgrade 分支。

webserver 必须在不引入身份、认证、Cookie、来源、代理或 harness 概念的前提下提供这种顺序。这些决策属于组合插件；载体所有者则继续负责路由与请求级异常隔离。

## 决定

`WebServer.registerIngressGate()` 公开一个应用级注册席位。其所有者同时实现 `handleHttp(req, res)` 与 `handleUpgrade(req, socket, head)`。每个方法都返回闭合的 `WebIngressDecision` 联合类型：`allow` 继续执行 route 查找，`handled` 则表示所有者已经结束响应或 socket，分发随即停止。

入口方法在 URL 解析以及所有命中或未命中的分发分支之前运行。同步抛错或 Promise 拒绝使用现有 HTTP 或 upgrade 异常隔离，因此策略失败不会变成未处理的 Promise 拒绝或进程退出。

webserver 在等待入口决策之前跟踪 upgrade socket。因此，资源释放会销毁并等待策略仍处于 pending 状态的载体；若 pending 决策在 socket 已销毁后才完成，分发也会停止。

该席位在组合阶段拒绝重复注册。其 disposer 只释放自身创建的注册，调用方把 disposer 绑定到提供注册的 Cordis effect。webserver 不定义多个所有者之间的策略顺序；需要多项检查的部署在唯一的入口插件内部按领域规则组合它们。

## Alternatives considered

**在各 route 所有者内部检查。** 这种方案不修改 webserver，但完整覆盖依赖所有当前及未来 route 各自正确实现，无法先于内置的未命中分支执行，而且会重复 WebSocket 处理。

**有序 middleware 链。** 多个独立排序的策略提供方会让安全敏感路径的短路与响应所有权语义变得模糊。单一所有者为应用提供一个可审计决策点，并且仍可在内部按领域顺序组合策略。

**在 webserver 包中实现认证。** 这会把与 harness 无关的 HTTP 载体耦合到某个部署的身份与凭据模型。webserver 只提供分发顺序与所有权。

**只在反向代理中强制执行。** 反向代理仍可作为部署防御的一部分，但它无法保护直接的非回环绑定，也无法通过同一个运行时组合测试应用的 HTTP 与 WebSocket 策略。

## 验证

Package test 与真实 Loader 组合覆盖入口先于精确 route、前缀 route、fallback、404、命中的 upgrade 和未命中的 upgrade 分发执行；同步及异步 `allow` 与 `handled` 决策；单载体异常隔离；异步决策 pending 时的 teardown；重复注册；Cordis effect disposal；以及过期 disposer 隔离。公共类型、JSDoc 与双语 package README 定义执行时机、返回值差异、所有权、失败行为以及不内置策略这一事实。

## 影响

入口所有者返回 `handled` 却未结束载体时，可能让请求或 socket 保持打开；该返回值会有意把这项生命周期义务转移给所有者。单一注册席位也会阻止独立插件在没有显式组合所有者的情况下分层执行检查。类型与 webserver 都无法证明获准请求已经过授权；安全性仍由注册的策略插件负责。
