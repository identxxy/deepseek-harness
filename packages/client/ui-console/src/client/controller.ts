/** Browser-side Console catalog and ephemeral attachment capability owner. */

import type {
  ClientRemote, ConsoleRemoteAttachmentAccess, ConsoleRemoteAttachmentOpenResult,
  ConsoleRemoteCreateRequest, ConsoleRemoteFailure, ConsoleRemoteObservation,
  ConsoleRemoteResult, ConsoleRemoteSize, ConsoleRemoteSnapshot,
} from '@deepseek-ai/dsh-api-remotes/client'
import { createSnapshotStore } from '@deepseek-ai/dsh-client-runtime/client'
import type { SnapshotStore } from '@deepseek-ai/dsh-client-runtime/client'
import type { RemoteResult } from '@deepseek-ai/dsh-typert-protocol'

type ConsoleRemote = ClientRemote['consoles']

interface ResizeWaiter {
  resolve: () => void
  reject: (error: unknown) => void
}

interface PendingResize {
  size: ConsoleRemoteSize
  waiters: ResizeWaiter[]
}

interface Deferred<T> {
  readonly promise: Promise<T>
  readonly resolve: (value: T | PromiseLike<T>) => void
  readonly reject: (error: unknown) => void
}

interface AttachmentIoLane {
  writeTail: Promise<void>
  readonly abort: AbortController
  readonly detachAbort: AbortController
  readonly detachStarted: Deferred<void>
  writeFailure?: Error
  closing: boolean
  pendingResize?: PendingResize
  resizePump?: Promise<void>
  detachPromise?: Promise<void>
}

/** Observable Console catalog; only `ready` proves that `items` is a complete Host list. */
export interface ConsoleCatalogState {
  phase: 'cold' | 'loading' | 'ready' | 'error'
  items: readonly ConsoleRemoteSnapshot[]
  connectionEpoch: number
  error?: string | undefined
}

/** Stable Console business failure exposed to presentation code. */
export class ConsoleClientError extends Error {
  override readonly name = 'ConsoleClientError'

  /**
   * @param code - stable Host business code.
   */
  constructor(readonly code: ConsoleRemoteFailure['code']) {
    super(`Console operation failed: ${code}`)
  }
}

function carrierError(error: { readonly code: string; readonly message: string }): Error {
  return new Error(`Console transport failed: ${error.code}: ${error.message}`)
}

function normalizedError(error: unknown): Error {
  return error instanceof Error ? error : new Error(String(error))
}

function deferred<T>(): Deferred<T> {
  let resolve!: (value: T | PromiseLike<T>) => void
  let reject!: (error: unknown) => void
  const promise = new Promise<T>((done, fail) => { resolve = done; reject = fail })
  return { promise, resolve, reject }
}

function abortError(signal: AbortSignal): Error {
  return signal.reason instanceof Error ? signal.reason : new DOMException('Console operation aborted', 'AbortError')
}

function abortableAwait<T>(operation: Promise<T>, signal: AbortSignal): Promise<T> {
  if (signal.aborted) {
    void operation.catch(() => {})
    return Promise.reject(abortError(signal))
  }
  return new Promise<T>((resolve, reject) => {
    let settled = false
    const finish = (complete: () => void): void => {
      if (settled) return
      settled = true
      signal.removeEventListener('abort', onAbort)
      complete()
    }
    const onAbort = (): void => { finish(() => { reject(abortError(signal)) }) }
    signal.addEventListener('abort', onAbort, { once: true })
    void operation.then(
      (value) => { finish(() => { resolve(value) }) },
      (error: unknown) => { finish(() => { reject(normalizedError(error)) }) },
    )
  })
}

function acceptsWriteFailure(lane: AttachmentIoLane): boolean {
  return !lane.closing
}

async function unwrap<T>(request: Promise<RemoteResult<ConsoleRemoteResult<T>>>): Promise<T> {
  const transported = await request
  if (!transported.ok) throw carrierError(transported.error)
  if (!transported.value.ok) throw new ConsoleClientError(transported.value.error.code)
  return transported.value.value
}

/** Browser Console service used by navigation and xterm renderers. */
export class ConsoleClient {
  private readonly catalog: SnapshotStore<ConsoleCatalogState> = createSnapshotStore({ phase: 'cold', items: [], connectionEpoch: 0 })
  private readonly attachments = new Map<string, ConsoleRemoteAttachmentAccess>()
  private readonly ioLanes = new Map<string, AttachmentIoLane>()
  private readonly activeDetachLanes = new Set<AttachmentIoLane>()
  private readonly attachmentWork = new Set<Promise<void>>()
  private readonly detached = new Set<string>()
  private disposed = false
  private connectionAbort = new AbortController()
  private catalogMutationAbort = new AbortController()
  private authorityEpoch = 0
  private mutationConnectionEpoch = 0
  private hasCompleteCatalog = false
  private refreshInFlight?: Promise<void>
  private queuedRefresh?: Deferred<void>
  private mutationTail: Promise<void> = Promise.resolve()
  private disposePromise?: Promise<void>

  /**
   * @param remote - generated `consoles` Remote namespace.
   */
  constructor(private readonly remote: ConsoleRemote) {}

  /**
   * Read the current observable Console catalog.
   * @returns Current catalog snapshot.
   */
  getSnapshot(): ConsoleCatalogState { return this.catalog.getSnapshot() }

  /**
   * Subscribe to catalog changes.
   * @param listener - notification callback.
   * @returns unsubscribe.
   */
  subscribe(listener: () => void): () => void { return this.catalog.subscribe(listener) }

  /**
   * Request one complete Host list; concurrent demand coalesces into at most one following request.
   * Each caller waits for either the current request or the single queued request, never for later demand.
   * Superseded mutation responses complete without publishing, while connection cancellation and authoritative failure reject.
   * @returns Completion of the request assigned to this demand.
   */
  refresh(): Promise<void> {
    if (this.disposed) return Promise.reject(new Error('Console client is disposed'))
    if (this.refreshInFlight === undefined) return this.startRefreshRequest()
    this.queuedRefresh ??= deferred<void>()
    return this.queuedRefresh.promise
  }

  /**
   * Create a durable tmux-backed Console.
   * @param request - workspace, title, and initial dimensions.
   * @param signal - optional carrier cancellation.
   * Mutations run in invocation order and reject without publishing if their connection is superseded.
   * A successful point mutation publishes locally; any required complete-list recovery runs independently.
   * @returns created Console snapshot after local publication.
   */
  create(request: ConsoleRemoteCreateRequest, signal?: AbortSignal): Promise<ConsoleRemoteSnapshot> {
    return this.enqueueMutation(
      () => unwrap(this.remote.create(request, signal)),
      (value) => { this.upsert(value, true) },
    )
  }

  /**
   * Rename one durable Console.
   * @param consoleId - Console identity.
   * @param title - replacement title.
   * Mutations run in invocation order and reject without publishing if their connection is superseded.
   * A successful point mutation publishes locally; any required complete-list recovery runs independently.
   * @returns updated snapshot after local publication.
   */
  rename(consoleId: string, title: string): Promise<ConsoleRemoteSnapshot> {
    return this.enqueueMutation(
      () => unwrap(this.remote.rename({ consoleId, title })),
      (value) => { this.upsertPoint(value, current => ({ ...current, title: value.title })) },
    )
  }

  /**
   * Archive or restore one Console without terminating it.
   * @param consoleId - Console identity.
   * @param archived - desired catalog visibility state.
   * Mutations run in invocation order and reject without publishing if their connection is superseded.
   * A successful point mutation publishes locally; any required complete-list recovery runs independently.
   * @returns updated snapshot after local publication.
   */
  setArchived(consoleId: string, archived: boolean): Promise<ConsoleRemoteSnapshot> {
    return this.enqueueMutation(
      () => unwrap(this.remote.setArchived({ consoleId, archived })),
      (value) => { this.upsertPoint(value, current => ({ ...current, archived: value.archived })) },
    )
  }

  /**
   * Start one independent Web tmux Client attachment.
   * @param consoleId - running Console identity.
   * @param size - initial terminal dimensions.
   * @param signal - optional carrier cancellation.
   * @returns attachment state and in-memory bearer capability.
   */
  async attach(consoleId: string, size: ConsoleRemoteSize, signal?: AbortSignal): Promise<ConsoleRemoteAttachmentOpenResult> {
    this.assertLive()
    const connectionSignal = signal === undefined
      ? this.connectionAbort.signal
      : AbortSignal.any([signal, this.connectionAbort.signal])
    const opened = await this.attachmentAwait(unwrap(this.remote.attach({ consoleId, size }, connectionSignal)), connectionSignal)
    connectionSignal.throwIfAborted()
    this.attachments.set(opened.access.attachmentId, opened.access)
    this.detached.delete(opened.access.attachmentId)
    this.ioLanes.set(opened.access.attachmentId, this.newIoLane())
    return opened
  }

  /**
   * Long-poll terminal output for one attachment cursor.
   * @param access - attachment authorization.
   * @param fromByte - raw-byte cursor.
   * @param waitMs - maximum requested wait.
   * @param signal - cancellation for pane teardown or a superseded read.
   * @returns output observation.
   */
  read(access: ConsoleRemoteAttachmentAccess, fromByte: number, waitMs: number, signal?: AbortSignal): Promise<ConsoleRemoteObservation> {
    this.assertLive()
    const connectionSignal = signal === undefined
      ? this.connectionAbort.signal
      : AbortSignal.any([signal, this.connectionAbort.signal])
    return this.attachmentAwait(unwrap(this.remote.read({ access, fromByte, waitMs }, connectionSignal)), connectionSignal)
  }

  /**
   * Write raw terminal input.
   * @param access - attachment authorization.
   * @param data - xterm input string.
   */
  async write(access: ConsoleRemoteAttachmentAccess, data: string): Promise<void> {
    this.assertLive()
    if (this.detached.has(access.attachmentId)) throw new Error('Console attachment is closing')
    const lane = this.ioLane(access)
    if (lane.closing) throw new Error('Console attachment is closing')
    if (lane.writeFailure !== undefined) throw lane.writeFailure
    const operation = lane.writeTail.then(async () => {
      if (lane.closing) throw new Error('Console attachment is closing')
      if (lane.writeFailure !== undefined) throw lane.writeFailure
      try {
        const signal = AbortSignal.any([lane.abort.signal, this.connectionAbort.signal])
        await this.attachmentAwait(unwrap(this.remote.write({ access, data }, signal)), signal)
      } catch (error) {
        const failure = normalizedError(error)
        if (acceptsWriteFailure(lane)) lane.writeFailure = failure
        throw failure
      }
    })
    lane.writeTail = operation.then(() => {}, () => {})
    await operation
  }

  /**
   * Resize one Web tmux Client.
   * @param access - attachment authorization.
   * @param size - terminal dimensions.
   */
  async resize(access: ConsoleRemoteAttachmentAccess, size: ConsoleRemoteSize): Promise<void> {
    this.assertLive()
    if (this.detached.has(access.attachmentId)) throw new Error('Console attachment is closing')
    const lane = this.ioLane(access)
    if (lane.closing) throw new Error('Console attachment is closing')
    const completion = new Promise<void>((resolve, reject) => {
      if (lane.pendingResize === undefined) lane.pendingResize = { size, waiters: [{ resolve, reject }] }
      else {
        lane.pendingResize.size = size
        lane.pendingResize.waiters.push({ resolve, reject })
      }
    })
    this.ensureResizePump(access, lane)
    await completion
  }

  /**
   * Detach one Web tmux Client without changing its workload.
   * Calls after disposal may only join an existing detach or observe an already detached attachment.
   * @param access - attachment authorization.
   */
  detach(access: ConsoleRemoteAttachmentAccess): Promise<void> {
    if (this.detached.has(access.attachmentId)) return Promise.resolve()
    const existing = this.ioLanes.get(access.attachmentId)
    if (existing?.detachPromise !== undefined) return existing.detachPromise
    if (this.disposed) return Promise.reject(new DOMException('Console client is disposed', 'AbortError'))
    return this.startDetach(access, existing ?? this.ioLane(access))
  }

  private startDetach(access: ConsoleRemoteAttachmentAccess, lane: AttachmentIoLane): Promise<void> {
    if (lane.detachPromise !== undefined) return lane.detachPromise
    lane.closing = true
    lane.abort.abort(new DOMException('Console attachment detached', 'AbortError'))
    this.activeDetachLanes.add(lane)
    const detaching = (async () => {
      await Promise.allSettled([lane.writeTail, lane.resizePump])
      lane.detachStarted.resolve(undefined)
      await this.attachmentAwait(unwrap(this.remote.detach({ access })), lane.detachAbort.signal)
    })().finally(() => {
      this.activeDetachLanes.delete(lane)
      this.attachments.delete(access.attachmentId)
      this.ioLanes.delete(access.attachmentId)
      this.detached.add(access.attachmentId)
    })
    lane.detachPromise = detaching
    return detaching
  }

  /**
   * Explicitly terminate one tmux workload and remove it from the catalog.
   * @param consoleId - Console identity confirmed by the user.
   * @returns completion after serialized local removal; complete-list recovery, when required, runs independently.
   */
  terminate(consoleId: string): Promise<void> {
    return this.enqueueMutation(
      () => unwrap(this.remote.terminate({ consoleId })),
      () => { this.patchCatalog((draft) => { draft.items = draft.items.filter(item => item.id !== consoleId) }) },
    ).then(() => {})
  }

  /**
   * Abort browser waits and detach every Web Client owned by this plugin.
   * @returns Completion after catalog, mutation, and attachment work reaches local quiescence.
   */
  dispose(): Promise<void> {
    this.disposePromise ??= this.disposeOwned()
    return this.disposePromise
  }

  private async disposeOwned(): Promise<void> {
    this.disposed = true
    this.authorityEpoch += 1
    this.mutationConnectionEpoch += 1
    this.catalogMutationAbort.abort(new DOMException('Console client disposed', 'AbortError'))
    this.rejectQueuedRefresh(abortError(this.catalogMutationAbort.signal))
    const detachments = [...this.attachments.values()].map((access) => {
      const lane = this.ioLanes.get(access.attachmentId)
      if (lane === undefined) throw new Error(`Owned Console attachment has no I/O lane: ${access.attachmentId}`)
      return this.startDetach(access, lane)
    })
    this.connectionAbort.abort(new DOMException('Console client disposed', 'AbortError'))
    const detachLanes = [...this.activeDetachLanes]
    await Promise.all(detachLanes.map(lane => lane.detachStarted.promise))
    await Promise.resolve()
    for (const lane of detachLanes) lane.detachAbort.abort(new DOMException('Console client disposed', 'AbortError'))
    const refreshInFlight = this.refreshInFlight
    const results = await Promise.allSettled([
      this.mutationTail,
      refreshInFlight,
      ...detachments,
      ...this.attachmentWork,
    ])
    const failures = results.filter((result): result is PromiseRejectedResult => (
      result.status === 'rejected' && normalizedError(result.reason).name !== 'AbortError'
    ))
    if (failures.length > 0) {
      throw new AggregateError(failures.map(result => normalizedError(result.reason)), 'Console attachment teardown failed')
    }
  }

  /** Invalidate old-connection capabilities and browser waits without sending detach over the dead carrier. */
  resetConnection(): void {
    this.assertLive()
    this.authorityEpoch += 1
    this.mutationConnectionEpoch += 1
    this.catalogMutationAbort.abort(new DOMException('Console connection changed', 'AbortError'))
    this.catalogMutationAbort = new AbortController()
    this.connectionAbort.abort(new DOMException('Console connection reset', 'AbortError'))
    this.connectionAbort = new AbortController()
    for (const lane of this.ioLanes.values()) {
      lane.abort.abort(new DOMException('Console connection reset', 'AbortError'))
      lane.detachAbort.abort(new DOMException('Console connection reset', 'AbortError'))
    }
    for (const attachmentId of this.attachments.keys()) this.detached.add(attachmentId)
    this.attachments.clear()
    this.ioLanes.clear()
    this.catalog.update((draft) => {
      draft.connectionEpoch += 1
      draft.phase = 'loading'
      delete draft.error
    })
    this.hasCompleteCatalog = false
  }

  private upsert(value: ConsoleRemoteSnapshot, first = false): void {
    this.patchCatalog((draft) => {
      const without = draft.items.filter(item => item.id !== value.id)
      draft.items = first ? [value, ...without] : without.concat(value)
    })
  }

  private upsertPoint(
    value: ConsoleRemoteSnapshot,
    merge: (current: ConsoleRemoteSnapshot) => ConsoleRemoteSnapshot,
  ): void {
    this.patchCatalog((draft) => {
      const current = draft.items.find(item => item.id === value.id)
      const next = current === undefined ? value : merge(current)
      draft.items = draft.items.filter(item => item.id !== value.id).concat(next)
    })
  }

  private patchCatalog(patch: (draft: ConsoleCatalogState) => void): void {
    const complete = this.hasCompleteCatalog
    this.catalog.update((draft) => {
      patch(draft)
      if (complete) {
        draft.phase = 'ready'
        delete draft.error
      }
    })
    if (!complete) {
      void this.refresh().catch((error: unknown) => {
        console.warn('Console catalog recovery after mutation failed:', error)
      })
    }
  }

  private enqueueMutation<T>(
    run: () => Promise<T>,
    publish: (value: T) => void,
  ): Promise<T> {
    this.assertLive()
    const queuedConnection = this.mutationConnectionEpoch
    const operation = this.mutationTail.then(async () => {
      this.assertMutationAuthority(queuedConnection)
      const signal = this.catalogMutationAbort.signal
      const value = await abortableAwait(run(), signal)
      this.assertMutationAuthority(queuedConnection)
      this.authorityEpoch += 1
      publish(value)
      return value
    })
    this.mutationTail = operation.then(() => {}, () => {})
    return operation
  }

  private startRefreshRequest(): Promise<void> {
    const request = this.runRefreshRequest()
    this.refreshInFlight = request
    const advance = (): void => { this.advanceRefreshQueue(request) }
    void request.then(advance, advance)
    return request
  }

  private async runRefreshRequest(): Promise<void> {
    const authority = this.authorityEpoch
    const signal = this.catalogMutationAbort.signal
    if (!this.hasCompleteCatalog) {
      this.catalog.update((draft) => { draft.phase = 'loading'; delete draft.error })
    }
    try {
      const items = await abortableAwait(unwrap(this.remote.list()), signal)
      if (!this.acceptsCatalogAuthority(authority)) return
      this.catalog.set({ phase: 'ready', items, connectionEpoch: this.catalog.getSnapshot().connectionEpoch })
      this.hasCompleteCatalog = true
    } catch (error) {
      if (signal.aborted) throw abortError(signal)
      if (!this.acceptsCatalogAuthority(authority)) return
      const current = this.catalog.getSnapshot()
      this.catalog.set({ phase: 'error', items: current.items, connectionEpoch: current.connectionEpoch, error: String(error) })
      throw error
    }
  }

  private advanceRefreshQueue(request: Promise<void>): void {
    if (this.refreshInFlight !== request) return
    delete this.refreshInFlight
    if (this.disposed) {
      this.rejectQueuedRefresh(new DOMException('Console client disposed', 'AbortError'))
      return
    }
    const queued = this.queuedRefresh
    if (queued === undefined) return
    delete this.queuedRefresh
    const next = this.startRefreshRequest()
    void next.then(queued.resolve, queued.reject)
  }

  private rejectQueuedRefresh(error: Error): void {
    const queued = this.queuedRefresh
    if (queued === undefined) return
    delete this.queuedRefresh
    queued.reject(error)
  }

  private assertMutationAuthority(connection: number): void {
    if (this.disposed) throw new DOMException('Console client is disposed', 'AbortError')
    if (connection !== this.mutationConnectionEpoch) throw new DOMException('Console connection changed', 'AbortError')
  }

  private acceptsCatalogAuthority(authority: number): boolean {
    return !this.disposed && authority === this.authorityEpoch
  }

  private ioLane(access: ConsoleRemoteAttachmentAccess): AttachmentIoLane {
    let lane = this.ioLanes.get(access.attachmentId)
    if (lane === undefined) {
      lane = this.newIoLane()
      this.ioLanes.set(access.attachmentId, lane)
    }
    return lane
  }

  private async pumpResizes(access: ConsoleRemoteAttachmentAccess, lane: AttachmentIoLane): Promise<void> {
    while (lane.pendingResize !== undefined) {
      const pending = lane.pendingResize
      delete lane.pendingResize
      if (lane.closing) {
        const error = new Error('Console attachment is closing')
        for (const waiter of pending.waiters) waiter.reject(error)
        continue
      }
      try {
        const signal = AbortSignal.any([lane.abort.signal, this.connectionAbort.signal])
        await this.attachmentAwait(unwrap(this.remote.resize({ access, size: pending.size }, signal)), signal)
        for (const waiter of pending.waiters) waiter.resolve()
      } catch (error) {
        for (const waiter of pending.waiters) waiter.reject(error)
      }
    }
  }

  private ensureResizePump(access: ConsoleRemoteAttachmentAccess, lane: AttachmentIoLane): void {
    if (lane.resizePump !== undefined) return
    const pump = this.pumpResizes(access, lane)
    lane.resizePump = pump
    void pump.finally(() => {
      delete lane.resizePump
      if (lane.pendingResize !== undefined) this.ensureResizePump(access, lane)
    })
  }

  private newIoLane(): AttachmentIoLane {
    return {
      writeTail: Promise.resolve(), abort: new AbortController(), detachAbort: new AbortController(),
      detachStarted: deferred<void>(), closing: false,
    }
  }

  private attachmentAwait<T>(operation: Promise<T>, signal: AbortSignal): Promise<T> {
    const pending = abortableAwait(operation, signal)
    const settlement = pending.then(() => {}, () => {})
    this.attachmentWork.add(settlement)
    void settlement.finally(() => { this.attachmentWork.delete(settlement) })
    return pending
  }

  private assertLive(): void {
    if (this.disposed) throw new Error('Console client is disposed')
  }
}
