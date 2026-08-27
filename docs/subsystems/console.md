# Durable Human Terminal Consoles

English | [中文](console.zh.md)

The Console subsystem gives a human an interactive terminal in a registered Workspace without widening the model-owned [terminal](terminal.md) capability. The Service Definition is [`@deepseek-ai/dsh-console`](../../packages/console/console/README.md), the durable provider is [`@deepseek-ai/dsh-console-tmux`](../../packages/console/console-tmux/README.md), and [`@deepseek-ai/dsh-console-remote`](../../packages/console/console-remote/README.md) carries the catalog and ephemeral attachment operations to the browser.

## Workload and attachment identity

`ConsoleId` identifies one durable tmux workload. It survives Host restart because the dedicated tmux server stores a versioned DSH metadata record on the session. Listing, creation, rename, archive, restore, and explicit termination rely on the deployment's authenticated ingress and do not place authority in tmux metadata.

```ts type-equiv
/** Authorized reference to one ephemeral attachment; the Console identity alone grants no terminal I/O. */
interface ConsoleAttachmentAccess {
  readonly attachmentId: ConsoleAttachmentId
  readonly capability: ConsoleAttachmentCapability
}
```

Each Web viewer receives a new process-local `ConsoleAttachmentId` and random bearer capability. Attachment I/O, output reads, resize, and detach require their pair. Capabilities never enter the durable catalog, tmux metadata, browser storage, or Agent Session log. A native `dsh console attach <console-id>` joins the same workload through the local Unix user's tmux socket permissions.

## Persistence and lifecycle

The provider uses a configured dedicated tmux server and adopts only sessions whose DSH-generated name and complete metadata agree. One Console maps to one tmux session. Browser and Host shutdown close only ephemeral tmux Client processes; archive changes catalog visibility without affecting the workload. `terminate(ConsoleId)` is the only DSH operation that kills the tmux session. An external kill leaves an ended catalog record after reconciliation.

Each attachment retains a bounded raw output window with absolute byte cursors. Reattaching starts a fresh tmux Client, so tmux redraws the current screen and the browser does not treat raw bytes as durable terminal state. A cursor older than the retained tail returns an explicit gap; invalid or future cursors fail.

```ts type-equiv
/** Atomic attachment state and output observation returned by a long-poll wait. */
interface ConsoleOutputObservation {
  readonly attachment: ConsoleAttachmentSnapshot
  readonly output: ConsoleOutputRead
}
```

Creation is a publication transaction: create the detached session, configure its size policy, write metadata, read it back, and only then publish the Console. A failed transaction rolls back only its newly allocated DSH session. Provider disposal blocks new operations, stops reconciliation, and detaches managed Web Clients without terminating durable workloads.

<!-- BEGIN GENERATED cordis-surface (gen-cordis-catalog.ts) — do not edit between markers -->

<a id="cordis-surface"></a>

## Cordis API

Generated from source by `scripts/gen-cordis-catalog.ts` (verified fresh by `pnpm run verify-cordis-catalog` in doc-sync; regenerate with `pnpm run gen-cordis-catalog`) — the language sides differ only in locale-specific paired document paths. Signature blocks use a `ts cordis-catalog` fence and keep the original source JSDoc; dispatch modes are defined in the [primer](../cordis-primer.md#dispatch-modes), and the framework-inherited `ctx` API lives in [cordis-api/inherited.md](../cordis-api/inherited.md).

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
