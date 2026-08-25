# Host-owned Console Runtime

[English](console.md) | 中文

Console 子系统让 Host 在已注册 workspace 中使用交互式 terminal process，而不扩大模型拥有的 [terminal](terminal.zh.md) 能力。Service Definition 是 [`@deepseek-ai/dsh-console`](../../packages/console/console/README.zh.md)，进程内提供方是 [`@deepseek-ai/dsh-console-local`](../../packages/console/console-local/README.zh.md)。

## 标识与授权

`ConsoleId` 标识一个 runtime record。`ConsoleCapability` 是独立随机 bearer secret。每次读取、修改、signal 和 stop 都要求这对值；未知 id 与错误 capability 都以 `ACCESS_DENIED` 失败，因此调用方无法把授权失败用作 existence oracle。

```ts type-equiv
/** Authorized reference to one console session. */
interface ConsoleAccess {
  readonly consoleId: ConsoleId
  readonly capability: ConsoleCapability
}
```

Snapshot 省略 capability，并暴露 workspace id、精确 cwd、顶层 pid、当前尺寸、状态和 output window offset。状态是判别联合：`running`、带 process outcome 的 `exited`，或带 transport diagnostic 的 `failed`。

## 输出与生命周期

Output cursor 是全流绝对字节位置。Data result 返回新的 `Uint8Array`、请求与续读 cursor，以及最新可用 cursor。早于保留尾部的 cursor 只返回 gap；未来、负数或非整数 cursor 以 `INVALID_CURSOR` 失败。

```ts type-equiv
/** Atomic console state and output observation returned by a long-poll wait. */
interface ConsoleOutputObservation {
  readonly console: ConsoleSnapshot
  readonly output: ConsoleOutputRead
}
```

进程内提供方只在 terminal output 结束后提交 exit。显式 stop 在删除 record 前等待 subprocess terminal 完全静止。Service disposal 阻止新工作、中止未发布 open，并尝试清理每个已发布 record。

<!-- BEGIN GENERATED cordis-surface (gen-cordis-catalog.ts) — do not edit between markers -->

<a id="cordis-surface"></a>

## Cordis API

Generated from source by `scripts/gen-cordis-catalog.ts` (verified fresh by `pnpm run verify-cordis-catalog` in doc-sync; regenerate with `pnpm run gen-cordis-catalog`) — the language sides differ only in locale-specific paired document paths. Signature blocks use a `ts cordis-catalog` fence and keep the original source JSDoc; dispatch modes are defined in the [primer](../cordis-primer.zh.md#dispatch-modes), and the framework-inherited `ctx` API lives in [cordis-api/inherited.md](../cordis-api/inherited.md).

<a id="ctxconsoleremote--consoleremoteservice"></a>

### `ctx.consoleRemote` — `ConsoleRemoteService`

Remote-only authorized console operations under the `consoles` wire namespace.

```ts cordis-catalog
/**
 * Project one authorized snapshot without host process coordinates.
 * @param request - Authorized console reference.
 * @returns JSON-safe snapshot or business failure.
 */
@Remote('snapshot') snapshot(request: ConsoleRemoteAccessRequest): ConsoleRemoteResult<ConsoleRemoteSnapshot>

/**
 * Read immediately or wait once for output or terminal state.
 * @param request - Authorized cursor and requested wait.
 * @param signal - Carrier cancellation.
 * @returns bounded observation, timeout observation, or business failure.
 */
@Remote('read') async read(request: ConsoleRemoteReadRequest, signal: AbortSignal): Promise<ConsoleRemoteResult<ConsoleRemoteObservation>>

/**
 * Write bounded UTF-8 input after capability authorization.
 * @param request - Authorized UTF-8 terminal input.
 * @returns completion or business failure.
 */
@Remote('write') async write(request: ConsoleRemoteWriteRequest): Promise<ConsoleRemoteResult<null>>

/**
 * Resize one authorized console.
 * @param request - Authorized terminal dimensions.
 * @returns completion or business failure.
 */
@Remote('resize') async resize(request: ConsoleRemoteResizeRequest): Promise<ConsoleRemoteResult<null>>

/**
 * Signal one authorized console's foreground process group.
 * @param request - Authorized foreground signal.
 * @returns delivery facts or business failure.
 */
@Remote('signal') async signal(request: ConsoleRemoteSignalRequest): Promise<ConsoleRemoteResult<{ delivered: true; targetPgid: number }>>

/**
 * Stop and remove one authorized console.
 * @param request - Authorized console reference.
 * @returns completion or business failure.
 */
@Remote('stop') async stop(request: ConsoleRemoteAccessRequest): Promise<ConsoleRemoteResult<null>>
```

Source: [`packages/console/console-remote/src/index.ts`](../../packages/console/console-remote/src/index.ts)

<a id="ctxconsoles--consoleruntime-abstract-seam"></a>

### `ctx.consoles` — `ConsoleRuntime` (abstract seam)

Abstract host-owned console runtime.

```ts cordis-catalog
/**
 * Open the configured human shell in one available workspace.
 * @param request - Workspace and initial dimensions.
 * @param signal - Allocation cancellation.
 * @returns the authorized live console after publication.
 */
abstract openHumanShell(request: HumanShellOpenRequest, signal?: AbortSignal): Promise<ConsoleOpenResult>

/**
 * Read current public state without exposing the bearer capability.
 * @param access - Authorized console reference.
 * @returns fresh public state.
 */
abstract snapshot(access: ConsoleAccess): ConsoleSnapshot

/**
 * Read one repeatable bounded page from an absolute whole-stream cursor.
 * @param access - Authorized console reference.
 * @param fromByte - Absolute output cursor.
 * @returns retained bytes or an explicit retention gap.
 */
abstract readOutput(access: ConsoleAccess, fromByte: number): ConsoleOutputRead

/**
 * Wait for output, a retention gap, or a terminal state transition and return one atomic observation.
 * @param access - Authorized console reference.
 * @param fromByte - Absolute output cursor.
 * @param signal - Caller cancellation for this one wait.
 * @returns current console state and one bounded output page.
 */
abstract waitOutput(access: ConsoleAccess, fromByte: number, signal: AbortSignal): Promise<ConsoleOutputObservation>

/**
 * Deliver text to the live terminal input.
 * @param access - Authorized console reference.
 * @param data - Terminal input text.
 * @returns after delivery.
 */
abstract write(access: ConsoleAccess, data: string): Promise<void>

/**
 * Resize the live terminal and commit the dimensions after provider success.
 * @param access - Authorized console reference.
 * @param size - New dimensions.
 * @returns after resize.
 */
abstract resize(access: ConsoleAccess, size: ConsoleSize): Promise<void>

/**
 * Signal the terminal's current foreground process group.
 * @param access - Authorized console reference.
 * @param signal - Foreground signal.
 * @returns the exact process group that received the signal.
 */
abstract signal(access: ConsoleAccess, signal: ConsoleSignal): Promise<ConsoleSignalResult>

/**
 * Terminate the complete terminal session and remove its record.
 * @param access - Authorized console reference.
 * @returns after complete session quiescence.
 */
abstract stop(access: ConsoleAccess): Promise<void>
```

Source: [`packages/console/console/src/index.ts`](../../packages/console/console/src/index.ts)
<!-- END GENERATED cordis-surface -->
