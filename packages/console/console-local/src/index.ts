/** Process-local provider for host-owned console sessions. @module @deepseek-ai/dsh-console-local */

import { randomUUID } from 'node:crypto'
import { Context, Service } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import {
  ConsoleError, ConsoleRuntime,
} from '@deepseek-ai/dsh-console'
import type {
  ConsoleAccess, ConsoleCapability, ConsoleId, ConsoleOpenResult, ConsoleOutputObservation, ConsoleOutputRead,
  ConsoleSignal, ConsoleSignalResult, ConsoleSize, ConsoleSnapshot, ConsoleStatus,
  HumanShellOpenRequest,
} from '@deepseek-ai/dsh-console'
import type { SubprocessTerminalHandle } from '@deepseek-ai/dsh-subprocess'
import type {} from '@deepseek-ai/dsh-workspace'
import { validateConfig } from './config.ts'
import type { Config } from './config.ts'
import { OutputWindow } from './output-window.ts'

export type { Config } from './config.ts'

interface ConsoleRecord {
  readonly id: ConsoleId
  readonly capability: ConsoleCapability
  readonly workspaceId: HumanShellOpenRequest['workspaceId']
  readonly cwd: string
  readonly handle: SubprocessTerminalHandle
  readonly output: OutputWindow
  size: ConsoleSize
  status: ConsoleStatus
  closing: boolean
  stopPromise: Promise<void> | undefined
  quiesced: Promise<void>
  readonly waiters: Set<ConsoleWaiter>
}

interface ConsoleWaiter {
  readonly fromByte: number
  readonly resolve: (observation: ConsoleOutputObservation) => void
  readonly reject: (error: unknown) => void
  abort: () => void
  readonly signal: AbortSignal
}

interface PendingOpen {
  readonly controller: AbortController
  readonly settled: Promise<void>
  readonly settle: () => void
}

function brandId(value: string): ConsoleId { return value as ConsoleId }
function brandCapability(value: string): ConsoleCapability { return value as ConsoleCapability }

function validateSize(size: ConsoleSize): void {
  if (!Number.isSafeInteger(size.rows) || size.rows <= 0 || !Number.isSafeInteger(size.cols) || size.cols <= 0) {
    throw new Error('console size rows and cols must be positive safe integers')
  }
}

/** Process-local console registry backed by `ctx.subprocess.spawnTerminal()`. */
export class LocalConsoleRuntime extends ConsoleRuntime {
  static inject = ['workspaceRegistry', 'subprocess']
  static Config: z<Config> = z.object({
    shellPath: z.string().min(1).required(),
    shellArgs: z.array(z.string()).required(),
    term: z.string().min(1).required(),
    disposeGraceMs: z.number().step(1).min(1).max(Number.MAX_SAFE_INTEGER).required(),
    outputRetentionBytes: z.number().step(1).min(1).max(Number.MAX_SAFE_INTEGER).required(),
    maxReadBytes: z.number().step(1).min(1).max(Number.MAX_SAFE_INTEGER).required(),
    maxOutputWaitersPerConsole: z.number().step(1).min(1).max(Number.MAX_SAFE_INTEGER).required(),
  })

  private readonly records = new Map<ConsoleId, ConsoleRecord>()
  /** Unpublished allocations whose rollback has not reached quiescence. */
  private readonly rollbackRecords = new Set<ConsoleRecord>()
  private readonly pending = new Set<PendingOpen>()
  private resolvedShellPath?: string
  private disposing = false

  constructor(ctx: Context, private readonly config: Config) {
    super(ctx)
    validateConfig(config)
    ctx.effect(() => () => this.disposeAll(), 'console-local teardown')
  }

  /** Resolve the configured executable before the service becomes active. */
  protected async [Service.init](): Promise<void> {
    this.resolvedShellPath = await this.ctx.subprocess.resolveExecutable(this.config.shellPath)
  }

  override async openHumanShell(request: HumanShellOpenRequest, signal?: AbortSignal): Promise<ConsoleOpenResult> {
    this.assertServing()
    validateSize(request.size)
    const controller = new AbortController()
    let settle!: () => void
    const settled = new Promise<void>((resolve) => { settle = resolve })
    const pending: PendingOpen = { controller, settled, settle }
    this.pending.add(pending)
    const combined = signal === undefined
      ? controller.signal
      : AbortSignal.any([controller.signal, signal])
    try {
      combined.throwIfAborted()
      const workspace = this.ctx.workspaceRegistry.get(request.workspaceId)
      if (workspace === undefined) throw new ConsoleError('UNKNOWN_WORKSPACE', 'unknown workspace')
      if (await workspace.status() !== 'ok') throw new ConsoleError('WORKSPACE_UNAVAILABLE', 'workspace directory is unavailable')
      this.assertServing()
      combined.throwIfAborted()
      const handle = await this.ctx.subprocess.spawnTerminal({
        argv: [this.requireShellPath(), ...this.config.shellArgs],
        cwd: workspace.path,
        term: this.config.term,
        rows: request.size.rows,
        cols: request.size.cols,
        graceMs: this.config.disposeGraceMs,
        signal: combined,
      })
      const record = this.createRecord(request, workspace.path, handle)
      record.quiesced = this.observe(record)
      if (combined.aborted || this.disposing) {
        this.rollbackRecords.add(record)
        await this.cleanupRollback(record)
        if (this.disposing) throw new ConsoleError('SERVICE_DISPOSING', 'console service is disposing')
        /* v8 ignore next -- an aborted native AbortSignal always has a DOMException reason when none was supplied. */
        throw combined.reason ?? new DOMException('The operation was aborted', 'AbortError')
      }
      this.records.set(record.id, record)
      return { access: { consoleId: record.id, capability: record.capability }, console: this.toSnapshot(record) }
    } finally {
      this.pending.delete(pending)
      pending.settle()
    }
  }

  override snapshot(access: ConsoleAccess): ConsoleSnapshot {
    return this.toSnapshot(this.expectAccess(access))
  }

  override readOutput(access: ConsoleAccess, fromByte: number): ConsoleOutputRead {
    return this.expectAccess(access).output.read(fromByte)
  }

  override waitOutput(access: ConsoleAccess, fromByte: number, signal: AbortSignal): Promise<ConsoleOutputObservation> {
    const record = this.expectAccess(access)
    const output = record.output.read(fromByte)
    if (output.kind === 'gap' || output.nextByte > fromByte || record.status.kind !== 'running') {
      return Promise.resolve({ console: this.toSnapshot(record), output })
    }
    if (record.closing) return Promise.reject(new ConsoleError('CONSOLE_CLOSING', 'console is closing'))
    this.assertServing()
    if (record.waiters.size >= this.config.maxOutputWaitersPerConsole) {
      return Promise.reject(new ConsoleError('OUTPUT_WAITER_LIMIT', 'console output waiter limit reached'))
    }
    return new Promise<ConsoleOutputObservation>((resolve, reject) => {
      const waiter: ConsoleWaiter = {
        fromByte,
        resolve,
        reject,
        signal,
        abort: () => {
          record.waiters.delete(waiter)
          signal.removeEventListener('abort', waiter.abort)
          const reason: unknown = signal.reason
          reject(reason instanceof Error ? reason : new DOMException('The operation was aborted', 'AbortError'))
        },
      }
      record.waiters.add(waiter)
      signal.addEventListener('abort', waiter.abort, { once: true })
      if (signal.aborted) waiter.abort()
    })
  }

  override async write(access: ConsoleAccess, data: string): Promise<void> {
    const record = this.expectMutable(access)
    await record.handle.write(data)
  }

  override async resize(access: ConsoleAccess, size: ConsoleSize): Promise<void> {
    const record = this.expectMutable(access)
    validateSize(size)
    await record.handle.resize(size)
    record.size = { ...size }
  }

  override async signal(access: ConsoleAccess, signal: ConsoleSignal): Promise<ConsoleSignalResult> {
    const record = this.expectMutable(access)
    const targetPgid = await record.handle.signalForeground(signal)
    return { delivered: true, targetPgid }
  }

  override stop(access: ConsoleAccess): Promise<void> {
    let record: ConsoleRecord
    try {
      record = this.expectAccess(access)
    } catch (error: unknown) {
      /* v8 ignore next -- expectAccess only throws ConsoleError; normalization preserves the unknown-safe public promise contract. */
      return Promise.reject(error instanceof Error ? error : new Error(String(error)))
    }
    if (record.stopPromise !== undefined) return record.stopPromise
    record.closing = true
    this.rejectWaiters(record, new ConsoleError('CONSOLE_CLOSING', 'console is closing'))
    const stop = record.handle.terminate().then(
      async () => {
        await record.quiesced
        this.records.delete(record.id)
      },
      (error: unknown) => {
        record.closing = false
        record.stopPromise = undefined
        throw error
      },
    )
    record.stopPromise = stop
    return stop
  }

  private createRecord(request: HumanShellOpenRequest, cwd: string, handle: SubprocessTerminalHandle): ConsoleRecord {
    return {
      id: brandId(randomUUID()), capability: brandCapability(randomUUID()),
      workspaceId: request.workspaceId, cwd, handle,
      output: new OutputWindow(this.config.outputRetentionBytes, this.config.maxReadBytes),
      size: { ...request.size }, status: { kind: 'running' }, closing: false,
      stopPromise: undefined, quiesced: Promise.resolve(), waiters: new Set(),
    }
  }

  private observe(record: ConsoleRecord): Promise<void> {
    let outputEnded = false
    let finishOutput!: () => void
    const outputDone = new Promise<void>((resolve) => { finishOutput = resolve })
    const finish = (): void => {
      if (!outputEnded) {
        outputEnded = true
        finishOutput()
        this.resolveWaiters(record)
      }
    }
    record.handle.output.on('data', (chunk: Buffer | Uint8Array | string) => {
      const bytes = typeof chunk === 'string' ? Buffer.from(chunk) : new Uint8Array(chunk)
      record.output.append(bytes)
      this.resolveWaiters(record)
    })
    record.handle.output.once('end', finish)
    record.handle.output.once('error', (error: unknown) => {
      this.fail(record, error)
      finish()
    })
    const doneObserved = record.handle.done.then(
      async (outcome) => {
        await outputDone
        if (record.status.kind === 'running') {
          record.status = { kind: 'exited', exitCode: outcome.exitCode, signal: outcome.signal }
          this.resolveWaiters(record)
        }
      },
      (error: unknown) => { this.fail(record, error) },
    )
    return Promise.all([outputDone, doneObserved]).then(() => {})
  }

  private fail(record: ConsoleRecord, error: unknown): void {
    if (record.status.kind !== 'running') return
    record.status = { kind: 'failed', message: String(error) }
    this.resolveWaiters(record)
    void record.handle.terminate().catch((cleanupError: unknown) => {
      this.ctx.logger.warn(`console-local: failed console cleanup rejected: ${String(cleanupError)}`)
    })
  }

  private expectAccess(access: ConsoleAccess): ConsoleRecord {
    const record = this.records.get(access.consoleId)
    if (record === undefined || record.capability !== access.capability) {
      throw new ConsoleError('ACCESS_DENIED', 'console access denied')
    }
    return record
  }

  private expectMutable(access: ConsoleAccess): ConsoleRecord {
    const record = this.expectAccess(access)
    this.assertServing()
    if (record.closing) throw new ConsoleError('CONSOLE_CLOSING', 'console is closing')
    if (record.status.kind !== 'running') throw new ConsoleError('CONSOLE_EXITED', 'console is not running')
    return record
  }

  private assertServing(): void {
    if (this.disposing) throw new ConsoleError('SERVICE_DISPOSING', 'console service is disposing')
  }

  private requireShellPath(): string {
    /* v8 ignore next -- Cordis completes Service.init before publishing this service. */
    if (this.resolvedShellPath === undefined) throw new Error('console-local executable was not initialized')
    return this.resolvedShellPath
  }

  private toSnapshot(record: ConsoleRecord): ConsoleSnapshot {
    return {
      id: record.id, workspaceId: record.workspaceId, cwd: record.cwd, pid: record.handle.pid,
      size: { ...record.size }, status: { ...record.status },
      oldestOutputByte: record.output.oldestByte, nextOutputByte: record.output.nextByte,
    }
  }

  private observation(record: ConsoleRecord, fromByte: number): ConsoleOutputObservation {
    return { console: this.toSnapshot(record), output: record.output.read(fromByte) }
  }

  private resolveWaiters(record: ConsoleRecord): void {
    for (const waiter of [...record.waiters]) {
      record.waiters.delete(waiter)
      waiter.signal.removeEventListener('abort', waiter.abort)
      waiter.resolve(this.observation(record, waiter.fromByte))
    }
  }

  private rejectWaiters(record: ConsoleRecord, error: ConsoleError): void {
    for (const waiter of [...record.waiters]) {
      record.waiters.delete(waiter)
      waiter.signal.removeEventListener('abort', waiter.abort)
      waiter.reject(error)
    }
  }

  private async cleanupRollback(record: ConsoleRecord): Promise<void> {
    await record.handle.terminate()
    await record.quiesced
    this.rollbackRecords.delete(record)
  }

  private async disposeAll(): Promise<void> {
    this.disposing = true
    for (const record of this.records.values()) {
      this.rejectWaiters(record, new ConsoleError('SERVICE_DISPOSING', 'console service is disposing'))
    }
    for (const open of this.pending) open.controller.abort(new ConsoleError('SERVICE_DISPOSING', 'console service is disposing'))
    await Promise.allSettled([...this.pending].map(open => open.settled))
    const results = await Promise.allSettled([
      ...[...this.records.values()].map(record =>
        this.stop({ consoleId: record.id, capability: record.capability })),
      ...[...this.rollbackRecords].map(record => this.cleanupRollback(record)),
    ])
    const failures = results.filter((result): result is PromiseRejectedResult => result.status === 'rejected')
    if (failures.length > 0) {
      throw new AggregateError(
        failures.map(result => result.reason instanceof Error ? result.reason : new Error(String(result.reason))),
        'console-local teardown failed',
      )
    }
  }
}

export default LocalConsoleRuntime
