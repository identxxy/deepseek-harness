# Host-owned Console Runtime

English | [中文](console.zh.md)

The console subsystem gives a Host an interactive terminal process in a registered workspace without widening the model-owned [terminal](terminal.md) capability. The Service Definition is [`@deepseek-ai/dsh-console`](../../packages/console/console/README.md); the process-local provider is [`@deepseek-ai/dsh-console-local`](../../packages/console/console-local/README.md).

## Identity and authorization

`ConsoleId` identifies one runtime record. `ConsoleCapability` is an independent random bearer secret. Every read, mutation, signal, and stop requires their pair; an unknown id and an incorrect capability both fail as `ACCESS_DENIED`, so callers cannot use authorization failures as an existence oracle.

```ts type-equiv
/** Authorized reference to one console session. */
interface ConsoleAccess {
  readonly consoleId: ConsoleId
  readonly capability: ConsoleCapability
}
```

Snapshots omit the capability and expose the workspace id, exact cwd, top-level pid, current dimensions, status, and output window offsets. Status is discriminated as `running`, `exited` with process outcome, or `failed` with a transport diagnostic.

## Output and lifecycle

Output cursors are absolute whole-stream byte positions. A data result returns a fresh `Uint8Array`, the requested and resume cursors, and the latest available cursor. A cursor older than the retained tail returns only a gap; a future, negative, or non-integer cursor fails as `INVALID_CURSOR`.

```ts type-equiv
/** Atomic console state and output observation returned by a long-poll wait. */
interface ConsoleOutputObservation {
  readonly console: ConsoleSnapshot
  readonly output: ConsoleOutputRead
}
```

The process-local provider commits exit only after terminal output ends. Explicit stop awaits complete subprocess-terminal quiescence before deleting the record. Service disposal prevents new work, aborts unpublished opens, and attempts cleanup for every published record.

<!-- BEGIN GENERATED cordis-surface (gen-cordis-catalog.ts) — do not edit between markers -->

<a id="cordis-surface"></a>

## Cordis API

Generated from source by `scripts/gen-cordis-catalog.ts` (verified fresh by `pnpm run verify-cordis-catalog` in doc-sync; regenerate with `pnpm run gen-cordis-catalog`) — the language sides differ only in locale-specific paired document paths. Signature blocks use a `ts cordis-catalog` fence and keep the original source JSDoc; dispatch modes are defined in the [primer](../cordis-primer.md#dispatch-modes), and the framework-inherited `ctx` API lives in [cordis-api/inherited.md](../cordis-api/inherited.md).

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
