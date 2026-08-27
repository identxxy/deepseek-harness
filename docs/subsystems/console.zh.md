# 持久 Human Terminal Console

[English](console.md) | 中文

Console 子系统让用户在已注册 Workspace 中使用交互式 terminal，而不扩大模型拥有的 [terminal](terminal.zh.md) 能力。Service Definition 是 [`@deepseek-ai/dsh-console`](../../packages/console/console/README.zh.md)，持久 provider 是 [`@deepseek-ai/dsh-console-tmux`](../../packages/console/console-tmux/README.zh.md)，[`@deepseek-ai/dsh-console-remote`](../../packages/console/console-remote/README.zh.md) 负责把 catalog 与临时 attachment 操作传给浏览器。

## Workload 与 attachment 标识

`ConsoleId` 标识一个持久 tmux workload。专属 tmux server 把带版本的 DSH metadata record 存在 session 上，因此该标识可跨 Host 重启。列举、创建、重命名、归档、恢复与显式终止依赖部署的已认证入口，不把 authority 写入 tmux metadata。

```ts type-equiv
/** Authorized reference to one ephemeral attachment; the Console identity alone grants no terminal I/O. */
interface ConsoleAttachmentAccess {
  readonly attachmentId: ConsoleAttachmentId
  readonly capability: ConsoleAttachmentCapability
}
```

每个 Web viewer 都会得到新的进程内 `ConsoleAttachmentId` 与随机 bearer capability。Attachment I/O、输出读取、resize 与 detach 都要求这对值。Capability 不会进入持久 catalog、tmux metadata、浏览器存储或 Agent Session log。原生 `dsh console attach <console-id>` 通过本地 Unix 用户的 tmux socket 权限加入同一个 workload。

## 持久性与生命周期

Provider 使用配置的专属 tmux server，并且只接管 DSH 生成的名称与完整 metadata 相互一致的 session。一个 Console 对应一个 tmux session。浏览器与 Host 关闭只结束临时 tmux Client process；archive 只改变 catalog 可见性。`terminate(ConsoleId)` 是 DSH 唯一会 kill tmux session 的操作。外部 kill 经 reconcile 后留下 ended catalog record。

每个 attachment 保留一个有界 raw output window，cursor 是绝对字节位置。重新 attach 会启动新的 tmux Client，由 tmux 重绘当前屏幕，因此浏览器不会把 raw byte 当成持久 terminal state。早于保留尾部的 cursor 返回明确 gap；无效或未来 cursor 会失败。

```ts type-equiv
/** Atomic attachment state and output observation returned by a long-poll wait. */
interface ConsoleOutputObservation {
  readonly attachment: ConsoleAttachmentSnapshot
  readonly output: ConsoleOutputRead
}
```

创建是 publication transaction：建立 detached session、配置尺寸策略、写入 metadata、读回验证，然后才发布 Console。失败 transaction 只 rollback 本次新分配的 DSH session。Provider disposal 会阻止新操作、停止 reconcile，并 detach 受管 Web Client，但不会终止持久 workload。

<!-- BEGIN GENERATED cordis-surface (gen-cordis-catalog.ts) — do not edit between markers -->

<a id="cordis-surface"></a>

## Cordis API

Generated from source by `scripts/gen-cordis-catalog.ts` (verified fresh by `pnpm run verify-cordis-catalog` in doc-sync; regenerate with `pnpm run gen-cordis-catalog`) — the language sides differ only in locale-specific paired document paths. Signature blocks use a `ts cordis-catalog` fence and keep the original source JSDoc; dispatch modes are defined in the [primer](../cordis-primer.zh.md#dispatch-modes), and the framework-inherited `ctx` API lives in [cordis-api/inherited.md](../cordis-api/inherited.md).

<a id="ctxconsoleremote--consoleremoteservice"></a>

### `ctx.consoleRemote` — `ConsoleRemoteService`

Remote Console catalog, lifecycle, attachment, and terminal I/O operations under the `consoles` wire namespace.

```ts cordis-catalog
/**
 * List the complete durable Console catalog.
 * @returns The catalog or a provider business failure.
 */
@Remote('list') async list(): Promise<ConsoleRemoteResult<readonly ConsoleRemoteSnapshot[]>>

/**
 * Create one durable Console through the authorized carrier.
 * @param request - Workspace, title, and initial dimensions.
 * @param signal - Carrier cancellation.
 * @returns The durable Console or a business failure.
 */
@Remote('create') async create(request: ConsoleRemoteCreateRequest, signal: AbortSignal): Promise<ConsoleRemoteResult<ConsoleRemoteSnapshot>>

/**
 * Read the current public state of one Console.
 * @param request - Durable Console identity.
 * @returns Its current state or a business failure.
 */
@Remote('snapshot') snapshot(request: ConsoleRemoteIdRequest): ConsoleRemoteResult<ConsoleRemoteSnapshot>

/**
 * Replace one Console's display title.
 * @param request - Console identity and replacement title.
 * @returns State after metadata durability or a business failure.
 */
@Remote('rename') async rename(request: ConsoleRemoteRenameRequest): Promise<ConsoleRemoteResult<ConsoleRemoteSnapshot>>

/**
 * Archive or restore one durable Console.
 * @param request - Console identity and desired archive state.
 * @returns State after metadata durability or a business failure.
 */
@Remote('setArchived') async setArchived(request: ConsoleRemoteArchiveRequest): Promise<ConsoleRemoteResult<ConsoleRemoteSnapshot>>

/**
 * Start one ephemeral terminal Client for a running Console.
 * @param request - Running Console and initial attachment dimensions.
 * @param signal - Carrier cancellation.
 * @returns A new authorized attachment or a business failure.
 */
@Remote('attach') async attach( request: ConsoleRemoteAttachRequest, signal: AbortSignal, ): Promise<ConsoleRemoteResult<ConsoleRemoteAttachmentOpenResult>>

/**
 * Read one authorized attachment's current state.
 * @param request - Authorized attachment reference.
 * @returns Its current state or a business failure.
 */
@Remote('attachmentSnapshot') attachmentSnapshot(request: ConsoleRemoteAttachmentAccessRequest): ConsoleRemoteResult<ConsoleRemoteAttachmentSnapshot>

/**
 * Read immediately or wait once for attachment output or state.
 * @param request - Authorized cursor and requested wait.
 * @param signal - Carrier cancellation.
 * @returns A bounded observation or business failure.
 */
@Remote('read') async read(request: ConsoleRemoteReadRequest, signal: AbortSignal): Promise<ConsoleRemoteResult<ConsoleRemoteObservation>>

/**
 * Write bounded UTF-8 terminal input to one attachment.
 * @param request - Authorized terminal input.
 * @param signal - Carrier cancellation.
 * @returns Completion or a business failure.
 */
@Remote('write') async write(request: ConsoleRemoteWriteRequest, signal?: AbortSignal): Promise<ConsoleRemoteResult<null>>

/**
 * Resize one authorized terminal attachment.
 * @param request - Authorized attachment dimensions.
 * @param signal - Carrier cancellation.
 * @returns Completion or a business failure.
 */
@Remote('resize') async resize(request: ConsoleRemoteResizeRequest, signal?: AbortSignal): Promise<ConsoleRemoteResult<null>>

/**
 * Detach one terminal Client without stopping its Console.
 * @param request - Authorized attachment reference.
 * @returns Completion after only the tmux Client exits, or a business failure.
 */
@Remote('detach') async detach(request: ConsoleRemoteAttachmentAccessRequest): Promise<ConsoleRemoteResult<null>>

/**
 * Terminate one durable Console workload explicitly.
 * @param request - Durable Console identity.
 * @returns Completion after termination, or a business failure.
 */
@Remote('terminate') async terminate(request: ConsoleRemoteIdRequest): Promise<ConsoleRemoteResult<null>>
```

Source: [`packages/console/console-remote/src/index.ts`](../../packages/console/console-remote/src/index.ts)

<a id="ctxconsoles--consoleruntime-abstract-seam"></a>

### `ctx.consoles` — `ConsoleRuntime` (abstract seam)

Abstract runtime for durable Human Terminals and their ephemeral terminal Clients.

```ts cordis-catalog
/**
 * List every durable Console known to this provider.
 * @returns The current catalog, including archived and ended records.
 */
abstract list(): Promise<readonly ConsoleSnapshot[]>

/**
 * Read one Console from the current catalog.
 * @param consoleId - Durable Console identity.
 * @returns Its current public state.
 */
abstract snapshot(consoleId: ConsoleId): ConsoleSnapshot

/**
 * Create and publish one durable Console workload.
 * @param request - Workspace, title, and initial tmux dimensions.
 * @param signal - Allocation cancellation.
 * @returns The published durable Console.
 */
abstract create(request: ConsoleCreateRequest, signal?: AbortSignal): Promise<ConsoleSnapshot>

/**
 * Replace one Console's display title.
 * @param consoleId - Durable Console identity.
 * @param title - Replacement display title.
 * @returns State after metadata durability.
 */
abstract rename(consoleId: ConsoleId, title: string): Promise<ConsoleSnapshot>

/**
 * Change whether one Console appears in the active catalog.
 * @param consoleId - Durable Console identity.
 * @param archived - Desired catalog visibility.
 * @returns State after metadata durability.
 */
abstract setArchived(consoleId: ConsoleId, archived: boolean): Promise<ConsoleSnapshot>

/**
 * Start one ephemeral terminal Client for a running Console.
 * @param request - Running Console and initial Client dimensions.
 * @param signal - Allocation cancellation.
 * @returns A newly authorized attachment.
 */
abstract attach(request: ConsoleAttachRequest, signal?: AbortSignal): Promise<ConsoleAttachmentOpenResult>

/**
 * Read one attachment's current process and output state.
 * @param access - Authorized attachment reference.
 * @returns Fresh public attachment state.
 */
abstract attachmentSnapshot(access: ConsoleAttachmentAccess): ConsoleAttachmentSnapshot

/**
 * Read retained output immediately from one attachment.
 * @param access - Authorized attachment reference.
 * @param fromByte - Absolute output cursor.
 * @returns Retained bytes or an explicit retention gap.
 */
abstract readOutput(access: ConsoleAttachmentAccess, fromByte: number): ConsoleOutputRead

/**
 * Wait until one attachment has output or changes state.
 * @param access - Authorized attachment reference.
 * @param fromByte - Absolute output cursor.
 * @param signal - Cancellation for this wait.
 * @returns Current attachment state and one output page.
 */
abstract waitOutput(access: ConsoleAttachmentAccess, fromByte: number, signal: AbortSignal): Promise<ConsoleOutputObservation>

/**
 * Write raw input to one terminal Client.
 * @param access - Authorized attachment reference.
 * @param data - Raw terminal input.
 * @returns After delivery to the tmux Client PTY.
 */
abstract write(access: ConsoleAttachmentAccess, data: string): Promise<void>

/**
 * Resize one terminal Client PTY.
 * @param access - Authorized attachment reference.
 * @param size - New Client dimensions.
 * @returns After PTY resize.
 */
abstract resize(access: ConsoleAttachmentAccess, size: ConsoleSize): Promise<void>

/**
 * Detach one ephemeral terminal Client without stopping its Console.
 * @param access - Authorized attachment reference.
 * @returns After the tmux Client exits; the Console workload remains alive.
 */
abstract detach(access: ConsoleAttachmentAccess): Promise<void>

/**
 * Terminate one durable Console workload and all of its attachments.
 * @param consoleId - Durable Console identity.
 * @returns After provider termination and attachment quiescence.
 */
abstract terminate(consoleId: ConsoleId): Promise<void>
```

Source: [`packages/console/console/src/index.ts`](../../packages/console/console/src/index.ts)
<!-- END GENERATED cordis-surface -->
