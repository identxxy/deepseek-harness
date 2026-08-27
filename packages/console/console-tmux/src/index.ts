/** tmux-backed durable Human Terminal provider. @module @deepseek-ai/dsh-console-tmux */

import { randomUUID } from 'node:crypto'
import { Context, Service } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import {
  ConsoleAttachmentCapability, ConsoleAttachmentId, ConsoleError, ConsoleId, ConsoleRuntime,
} from '@deepseek-ai/dsh-console'
import type {
  ConsoleAttachRequest, ConsoleAttachmentAccess, ConsoleAttachmentOpenResult, ConsoleAttachmentSnapshot,
  ConsoleAttachmentStatus, ConsoleCreateRequest, ConsoleOutputObservation, ConsoleOutputRead, ConsoleSize, ConsoleSnapshot, ConsoleStatus,
} from '@deepseek-ai/dsh-console'
import type { SubprocessTerminalHandle } from '@deepseek-ai/dsh-subprocess'
import type {} from '@deepseek-ai/dsh-workspace'
import { validateConfig } from './config.ts'
import type { Config } from './config.ts'
import { decodeConsoleMetadata, encodeConsoleMetadata } from './metadata.ts'
import type { ConsoleMetadata } from './metadata.ts'
import { TmuxCommandRunner } from './tmux-command.ts'
import type { TmuxCommandResult } from './tmux-command.ts'
import { CONSOLE_TMUX_METADATA_OPTION, consoleTmuxSessionName, parseConsoleTmuxSessionName } from './tmux-protocol.ts'
import { OutputWindow } from './output-window.ts'

export type { Config, WindowSizePolicy } from './config.ts'
export { decodeConsoleMetadata, encodeConsoleMetadata } from './metadata.ts'
export type { ConsoleMetadata } from './metadata.ts'
export { CONSOLE_TMUX_METADATA_OPTION, consoleTmuxSessionName, parseConsoleTmuxSessionName } from './tmux-protocol.ts'
export { TmuxCommandRunner } from './tmux-command.ts'
export type { TmuxCommandOptions, TmuxCommandResult } from './tmux-command.ts'

interface ConsoleRecord {
  readonly sessionName: string
  metadata: ConsoleMetadata
  status: ConsoleStatus
}

interface AttachmentRecord {
  readonly id: ReturnType<typeof ConsoleAttachmentId>
  readonly capability: ReturnType<typeof ConsoleAttachmentCapability>
  readonly consoleId: ConsoleId
  readonly handle: SubprocessTerminalHandle
  readonly output: OutputWindow
  size: ConsoleSize
  status: ConsoleAttachmentStatus
  closing: boolean
  closePromise: Promise<void> | undefined
  quiesced: Promise<void>
  idleTimer?: ReturnType<typeof setTimeout>
  readonly waiters: Set<AttachmentWaiter>
}

interface AttachmentWaiter {
  readonly fromByte: number
  readonly resolve: (observation: ConsoleOutputObservation) => void
  readonly reject: (error: unknown) => void
  readonly signal: AbortSignal
  abort: () => void
}

function validateSize(size: ConsoleSize): void {
  if (!Number.isSafeInteger(size.rows) || size.rows <= 0 || !Number.isSafeInteger(size.cols) || size.cols <= 0) {
    throw new Error('console size rows and cols must be positive safe integers')
  }
}

function isNoServer(result: TmuxCommandResult): boolean {
  if (result.exitCode !== 1) return false
  const diagnostic = result.stderr.trim()
  return diagnostic.toLowerCase().includes('no server running')
    || /^error connecting to .+ \(No such file or directory\)$/.test(diagnostic)
}

function snapshot(record: ConsoleRecord): ConsoleSnapshot {
  return {
    id: ConsoleId(record.metadata.consoleId),
    workspaceId: record.metadata.workspaceId as ConsoleSnapshot['workspaceId'],
    cwd: record.metadata.cwd,
    title: record.metadata.title,
    createdAt: record.metadata.createdAt,
    archived: record.metadata.archived,
    status: record.status,
  }
}

/** tmux-backed runtime for durable Human Terminals and ephemeral terminal Clients. */
export class TmuxConsoleRuntime extends ConsoleRuntime {
  static inject = ['workspaceRegistry', 'subprocess']
  static Config: z<Config> = z.object({
    tmuxPath: z.string().min(1).required(),
    serverName: z.string().min(1).required(),
    shellPath: z.string().min(1).required(),
    shellArgs: z.array(z.string()).required(),
    term: z.string().min(1).required(),
    windowSizePolicy: z.union(['largest', 'smallest', 'latest']).required(),
    commandTimeoutMs: z.number().step(1).min(1).max(Number.MAX_SAFE_INTEGER).required(),
    commandGraceMs: z.number().step(1).min(1).max(Number.MAX_SAFE_INTEGER).required(),
    commandOutputBytes: z.number().step(1).min(1).max(Number.MAX_SAFE_INTEGER).required(),
    attachmentGraceMs: z.number().step(1).min(1).max(Number.MAX_SAFE_INTEGER).required(),
    attachmentIdleTtlMs: z.number().step(1).min(1).max(Number.MAX_SAFE_INTEGER).required(),
    reconcileIntervalMs: z.number().step(1).min(1).max(Number.MAX_SAFE_INTEGER).required(),
    outputRetentionBytes: z.number().step(1).min(1).max(Number.MAX_SAFE_INTEGER).required(),
    maxReadBytes: z.number().step(1).min(1).max(Number.MAX_SAFE_INTEGER).required(),
    maxOutputWaitersPerAttachment: z.number().step(1).min(1).max(Number.MAX_SAFE_INTEGER).required(),
    maxConsoles: z.number().step(1).min(1).max(Number.MAX_SAFE_INTEGER).required(),
    maxAttachmentsPerConsole: z.number().step(1).min(1).max(Number.MAX_SAFE_INTEGER).required(),
  })

  private readonly records = new Map<ConsoleId, ConsoleRecord>()
  private readonly attachments = new Map<ReturnType<typeof ConsoleAttachmentId>, AttachmentRecord>()
  private runner?: TmuxCommandRunner
  private resolvedTmuxPath?: string
  private disposing = false
  private readonly terminations = new Map<ConsoleId, Promise<void>>()
  private readonly terminatedConsoleIds = new Set<ConsoleId>()
  private readonly metadataMutations = new Map<ConsoleId, Promise<void>>()
  private pendingCreates = 0
  private readonly pendingAttachments = new Map<ConsoleId, number>()
  private readonly lifecycleAbort = new AbortController()
  private activeOperations = 0
  private operationDrain?: Promise<void>
  private finishOperationDrain?: () => void
  private reconcilePromise: Promise<boolean> | undefined
  private readonly hostCwd = process.cwd()

  constructor(ctx: Context, private readonly config: Config) {
    super(ctx)
    validateConfig(config)
    ctx.effect(() => () => this.disposeAll(), 'console-tmux teardown')
  }

  /** Resolve provider executables, check the tmux protocol floor, and recover durable records. */
  protected async [Service.init](): Promise<void> {
    const [tmuxPath, shellPath] = await Promise.all([
      this.ctx.subprocess.resolveExecutable(this.config.tmuxPath),
      this.ctx.subprocess.resolveExecutable(this.config.shellPath),
    ])
    this.resolvedTmuxPath = tmuxPath
    this.runner = new TmuxCommandRunner(this.ctx.subprocess, {
      executable: tmuxPath,
      serverName: this.config.serverName,
      cwd: this.hostCwd,
      commandTimeoutMs: this.config.commandTimeoutMs,
      commandGraceMs: this.config.commandGraceMs,
      commandOutputBytes: this.config.commandOutputBytes,
      env: { SHELL: shellPath },
    })
    const version = await this.command(['-V'], 'read tmux version')
    const parsed = /^tmux (\d+)\.(\d+)/.exec(version.stdout.trim())
    if (parsed === null || Number(parsed[1]) < 3 || (Number(parsed[1]) === 3 && Number(parsed[2]) < 2)) {
      throw new Error(`console-tmux requires tmux >= 3.2, received ${JSON.stringify(version.stdout.trim())}`)
    }
    const serverExists = await this.reconcile()
    if (serverExists) {
      await this.command(['set-option', '-g', 'default-shell', shellPath], 'configure tmux default shell')
      await this.command(['set-window-option', '-g', 'window-size', this.config.windowSizePolicy], 'configure tmux default window size')
      for (const record of this.records.values()) await this.configureSessionWindows(record)
    }
    this.ctx.effect(() => {
      const timer = setInterval(() => {
        void this.reconcile().catch((error: unknown) => {
          console.error('console-tmux periodic reconciliation failed:', error)
        })
      }, this.config.reconcileIntervalMs)
      timer.unref()
      return () => { clearInterval(timer) }
    }, 'console-tmux catalog reconciliation')
  }

  override async list(): Promise<readonly ConsoleSnapshot[]> {
    this.assertServing()
    await this.reconcile()
    return [...this.records.values()].map(snapshot).sort((a, b) => b.createdAt.localeCompare(a.createdAt))
  }

  override snapshot(consoleId: ConsoleId): ConsoleSnapshot {
    const record = this.records.get(consoleId)
    if (record === undefined) throw new ConsoleError('UNKNOWN_CONSOLE', 'unknown Console')
    return snapshot(record)
  }

  override async create(request: ConsoleCreateRequest, signal?: AbortSignal): Promise<ConsoleSnapshot> {
    this.assertServing()
    const release = this.admitOperation()
    const operationSignal = signal === undefined
      ? this.lifecycleAbort.signal
      : AbortSignal.any([signal, this.lifecycleAbort.signal])
    try {
      validateSize(request.initialSize)
      operationSignal.throwIfAborted()
      await this.reconcile()
      if ([...this.records.values()].filter(record => record.status.kind === 'running').length + this.pendingCreates >= this.config.maxConsoles) {
        throw new ConsoleError('RESOURCE_LIMIT', 'Console limit reached')
      }
      this.pendingCreates += 1
      try {
        const workspace = this.ctx.workspaceRegistry.get(request.workspaceId)
        if (workspace === undefined) throw new ConsoleError('UNKNOWN_WORKSPACE', 'unknown workspace')
        if (await workspace.status() !== 'ok') throw new ConsoleError('WORKSPACE_UNAVAILABLE', 'workspace directory is unavailable')
        this.assertServing()
        operationSignal.throwIfAborted()
        if (request.title.length === 0) throw new Error('Console title must not be empty')

        const id = ConsoleId(randomUUID())
        const sessionName = consoleTmuxSessionName(id)
        const metadata: ConsoleMetadata = {
          version: 1,
          consoleId: id,
          workspaceId: request.workspaceId,
          cwd: workspace.path,
          title: request.title,
          createdAt: new Date().toISOString(),
          archived: false,
        }
        try {
          await this.command([
            'new-session', '-d', '-s', sessionName, '-c', workspace.path,
            '-x', String(request.initialSize.cols), '-y', String(request.initialSize.rows),
          ], 'create tmux session')
          operationSignal.throwIfAborted()
          await this.command(['set-window-option', '-g', 'window-size', this.config.windowSizePolicy], 'configure tmux default window size')
          operationSignal.throwIfAborted()
          await this.command(['set-window-option', '-t', `${sessionName}:`, 'window-size', this.config.windowSizePolicy], 'configure tmux window size')
          operationSignal.throwIfAborted()
          const encoded = encodeConsoleMetadata(metadata)
          await this.command(['set-option', '-t', sessionName, CONSOLE_TMUX_METADATA_OPTION, encoded], 'write Console metadata')
          operationSignal.throwIfAborted()
          const readBack = await this.command(['show-options', '-v', '-t', sessionName, CONSOLE_TMUX_METADATA_OPTION], 'read Console metadata')
          operationSignal.throwIfAborted()
          const decoded = decodeConsoleMetadata(readBack.stdout.trim())
          if (decoded === undefined || decoded.consoleId !== id) throw new ConsoleError('PROVIDER_FAILURE', 'tmux metadata read-back failed')
          const record: ConsoleRecord = { sessionName, metadata: decoded, status: { kind: 'running' } }
          this.records.set(id, record)
          return snapshot(record)
        } catch (error) {
          try {
            await this.rollbackSession(sessionName)
          } catch (rollbackError) {
            throw new AggregateError([error, rollbackError], 'Console creation and rollback both failed')
          }
          throw error
        }
      } finally {
        this.pendingCreates -= 1
      }
    } finally {
      release()
    }
  }

  override async rename(consoleId: ConsoleId, title: string): Promise<ConsoleSnapshot> {
    this.assertServing()
    if (title.length === 0) throw new Error('Console title must not be empty')
    const release = this.admitOperation()
    try { return await this.mutateMetadata(consoleId, metadata => ({ ...metadata, title })) }
    finally { release() }
  }

  override async setArchived(consoleId: ConsoleId, archived: boolean): Promise<ConsoleSnapshot> {
    this.assertServing()
    const release = this.admitOperation()
    try { return await this.mutateMetadata(consoleId, metadata => ({ ...metadata, archived })) }
    finally { release() }
  }
  override async attach(request: ConsoleAttachRequest, signal?: AbortSignal): Promise<ConsoleAttachmentOpenResult> {
    this.assertServing()
    const release = this.admitOperation()
    const operationSignal = signal === undefined ? this.lifecycleAbort.signal : AbortSignal.any([signal, this.lifecycleAbort.signal])
    try {
      validateSize(request.size)
      operationSignal.throwIfAborted()
      const consoleRecord = this.expectMutable(request.consoleId)
      if (consoleRecord.metadata.archived) throw new ConsoleError('CONSOLE_ARCHIVED', 'Console is archived')
      const liveCount = [...this.attachments.values()].filter(
        attachment => attachment.consoleId === request.consoleId && !attachment.closing,
      ).length
      const count = liveCount + (this.pendingAttachments.get(request.consoleId) ?? 0)
      if (count >= this.config.maxAttachmentsPerConsole) throw new ConsoleError('RESOURCE_LIMIT', 'Console attachment limit reached')
      this.pendingAttachments.set(request.consoleId, (this.pendingAttachments.get(request.consoleId) ?? 0) + 1)
      try {
        const handle = await this.ctx.subprocess.spawnTerminal({
          argv: [this.requireTmuxPath(), '-L', this.config.serverName, 'attach-session', '-E', '-t', consoleRecord.sessionName],
          cwd: this.hostCwd,
          term: this.config.term,
          rows: request.size.rows,
          cols: request.size.cols,
          graceMs: this.config.attachmentGraceMs,
          signal: operationSignal,
        })
        const record: AttachmentRecord = {
          id: ConsoleAttachmentId(randomUUID()),
          capability: ConsoleAttachmentCapability(randomUUID()),
          consoleId: request.consoleId,
          handle,
          output: new OutputWindow(this.config.outputRetentionBytes, this.config.maxReadBytes),
          size: { ...request.size },
          status: { kind: 'running' },
          closing: false,
          closePromise: undefined,
          quiesced: Promise.resolve(),
          waiters: new Set(),
        }
        record.quiesced = this.observeAttachment(record)
        const current = this.records.get(request.consoleId)
        if (signal?.aborted === true || this.disposing || this.terminatedConsoleIds.has(request.consoleId)
      || current !== consoleRecord || current.status.kind !== 'running') {
          await this.closeAttachment(record)
          if (this.disposing) throw new ConsoleError('SERVICE_DISPOSING', 'Console service is disposing')
          if (this.terminatedConsoleIds.has(request.consoleId)) throw new ConsoleError('CONSOLE_TERMINATING', 'Console is terminating')
          if (current === undefined || current !== consoleRecord) throw new ConsoleError('UNKNOWN_CONSOLE', 'unknown Console')
          if (current.status.kind === 'ended') throw new ConsoleError('CONSOLE_ENDED', 'Console ended externally')
          /* v8 ignore next -- an aborted native AbortSignal has a DOMException reason when none was supplied. */
          throw signal?.reason ?? new DOMException('The operation was aborted', 'AbortError')
        }
        this.attachments.set(record.id, record)
        this.touch(record)
        return {
          access: { attachmentId: record.id, capability: record.capability },
          attachment: this.toAttachmentSnapshot(record),
        }
      } finally {
        const reserved = this.pendingAttachments.get(request.consoleId)
        if (reserved === undefined) throw new Error('missing pending attachment reservation')
        const pending = reserved - 1
        if (pending === 0) this.pendingAttachments.delete(request.consoleId)
        else this.pendingAttachments.set(request.consoleId, pending)
      }
    } finally {
      release()
    }
  }

  override attachmentSnapshot(access: ConsoleAttachmentAccess): ConsoleAttachmentSnapshot {
    const record = this.expectAttachment(access)
    this.touch(record)
    return this.toAttachmentSnapshot(record)
  }

  override readOutput(access: ConsoleAttachmentAccess, fromByte: number): ConsoleOutputRead {
    const record = this.expectAttachment(access)
    this.touch(record)
    return record.output.read(fromByte)
  }
  override waitOutput(access: ConsoleAttachmentAccess, fromByte: number, signal: AbortSignal): Promise<ConsoleOutputObservation> {
    const record = this.expectAttachment(access)
    this.touch(record)
    const output = record.output.read(fromByte)
    if (output.kind === 'gap' || output.nextByte > fromByte || record.status.kind !== 'running') {
      return Promise.resolve({ attachment: this.toAttachmentSnapshot(record), output })
    }
    if (record.closing) return Promise.reject(new ConsoleError('ATTACHMENT_CLOSING', 'attachment is closing'))
    if (this.disposing) return Promise.reject(new ConsoleError('SERVICE_DISPOSING', 'Console service is disposing'))
    if (record.waiters.size >= this.config.maxOutputWaitersPerAttachment) {
      return Promise.reject(new ConsoleError('OUTPUT_WAITER_LIMIT', 'attachment output waiter limit reached'))
    }
    return new Promise<ConsoleOutputObservation>((resolve, reject) => {
      const waiter: AttachmentWaiter = {
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
  override async write(access: ConsoleAttachmentAccess, data: string): Promise<void> {
    const record = this.expectLiveAttachment(access)
    this.touch(record)
    await record.handle.write(data)
  }

  override async resize(access: ConsoleAttachmentAccess, size: ConsoleSize): Promise<void> {
    const record = this.expectLiveAttachment(access)
    validateSize(size)
    this.touch(record)
    await record.handle.resize(size)
    record.size = { ...size }
  }

  override detach(access: ConsoleAttachmentAccess): Promise<void> {
    return this.closeAttachment(this.expectAttachment(access))
  }
  override terminate(consoleId: ConsoleId): Promise<void> {
    const existing = this.terminations.get(consoleId)
    if (existing !== undefined) return existing
    this.assertServing()
    const record = this.records.get(consoleId)
    if (record === undefined) throw new ConsoleError('UNKNOWN_CONSOLE', 'unknown Console')
    const release = this.admitOperation()
    this.terminatedConsoleIds.add(consoleId)
    const stop = record.status.kind === 'ended'
      ? Promise.resolve()
      : this.command(['kill-session', '-t', record.sessionName], 'terminate tmux session').then(() => {})
    const termination = stop.then(async () => {
      const attached = [...this.attachments.values()].filter(attachment => attachment.consoleId === consoleId)
      const results = await Promise.allSettled(attached.map(attachment => this.closeAttachment(attachment)))
      this.records.delete(consoleId)
      const failures = results.filter((result): result is PromiseRejectedResult => result.status === 'rejected')
      if (failures.length > 0) {
        throw new AggregateError(
          failures.map((result): unknown => result.reason),
          'Console terminated but attachment teardown failed',
        )
      }
    }, (error: unknown) => {
      this.terminatedConsoleIds.delete(consoleId)
      throw error
    }).finally(() => {
      this.terminations.delete(consoleId)
      release()
    })
    this.terminations.set(consoleId, termination)
    return termination
  }

  private async reconcile(): Promise<boolean> {
    if (this.reconcilePromise !== undefined) return this.reconcilePromise
    const pending = this.reconcileNow()
    this.reconcilePromise = pending
    try {
      return await pending
    } finally {
      if (this.reconcilePromise === pending) this.reconcilePromise = undefined
    }
  }

  private async reconcileNow(): Promise<boolean> {
    const result = await this.requireRunner().run([
      'list-sessions', '-F', `#{session_name}\t#{${CONSOLE_TMUX_METADATA_OPTION}}`,
    ])
    if (isNoServer(result)) {
      for (const record of this.records.values()) record.status = { kind: 'ended', reason: 'external' }
      return false
    }
    this.ensureSuccess(result, 'list tmux sessions')
    const seen = new Set<ConsoleId>()
    for (const line of result.stdout.split('\n')) {
      if (line.length === 0) continue
      const separator = line.indexOf('\t')
      if (separator < 0) continue
      const sessionName = line.slice(0, separator)
      const id = parseConsoleTmuxSessionName(sessionName)
      const metadata = decodeConsoleMetadata(line.slice(separator + 1))
      if (id === undefined || metadata === undefined || metadata.consoleId !== id) continue
      if (this.terminatedConsoleIds.has(id)) continue
      seen.add(id)
      const existing = this.records.get(id)
      if (existing === undefined) this.records.set(id, { sessionName, metadata, status: { kind: 'running' } })
      else {
        existing.metadata = metadata
        existing.status = { kind: 'running' }
      }
    }
    for (const [id, record] of this.records) {
      if (!seen.has(id) && record.status.kind === 'running') record.status = { kind: 'ended', reason: 'external' }
    }
    return true
  }

  private async persistMetadata(record: ConsoleRecord, metadata: ConsoleMetadata): Promise<ConsoleRecord> {
    const encoded = encodeConsoleMetadata(metadata)
    await this.command(['set-option', '-t', record.sessionName, CONSOLE_TMUX_METADATA_OPTION, encoded], 'write Console metadata')
    const readBack = await this.command(['show-options', '-v', '-t', record.sessionName, CONSOLE_TMUX_METADATA_OPTION], 'read Console metadata')
    const decoded = decodeConsoleMetadata(readBack.stdout.trim())
    if (decoded === undefined || encodeConsoleMetadata(decoded) !== encoded) {
      throw new ConsoleError('PROVIDER_FAILURE', 'tmux metadata read-back failed')
    }
    record.metadata = decoded
    return record
  }

  private async rollbackSession(sessionName: string): Promise<void> {
    const result = await this.requireRunner().run(['kill-session', '-t', sessionName])
    if (result.exitCode === 0 || isNoServer(result)) return
    const diagnostic = result.stderr.trim().toLowerCase()
    if (diagnostic.startsWith("can't find session:")) return
    this.ensureSuccess(result, 'roll back tmux session')
  }

  private async configureSessionWindows(record: ConsoleRecord): Promise<void> {
    const listed = await this.command(['list-windows', '-t', record.sessionName, '-F', '#{window_index}'], 'list Console tmux windows')
    for (const index of listed.stdout.trim().split('\n')) {
      if (!/^\d+$/.test(index)) throw new ConsoleError('PROVIDER_FAILURE', 'tmux returned an invalid window index')
      await this.command(
        ['set-window-option', '-t', `${record.sessionName}:${index}`, 'window-size', this.config.windowSizePolicy],
        'configure tmux window size',
      )
    }
  }

  private mutateMetadata(consoleId: ConsoleId, update: (metadata: ConsoleMetadata) => ConsoleMetadata): Promise<ConsoleSnapshot> {
    const previous = this.metadataMutations.get(consoleId) ?? Promise.resolve()
    const operation = previous.then(async () => {
      this.assertServing()
      const record = this.expectMutable(consoleId)
      return snapshot(await this.persistMetadata(record, update(record.metadata)))
    })
    const settled = operation.then(() => {}, () => {})
    this.metadataMutations.set(consoleId, settled)
    void settled.finally(() => {
      if (this.metadataMutations.get(consoleId) === settled) this.metadataMutations.delete(consoleId)
    })
    return operation
  }

  private observeAttachment(record: AttachmentRecord): Promise<void> {
    let finishOutput!: () => void
    let outputSettled = false
    const outputDone = new Promise<void>((resolve) => { finishOutput = resolve })
    const finish = (): void => {
      if (outputSettled) return
      outputSettled = true
      finishOutput()
    }
    record.handle.output.on('data', (chunk: Buffer | Uint8Array | string) => {
      record.output.append(typeof chunk === 'string' ? Buffer.from(chunk) : new Uint8Array(chunk))
      this.resolveWaiters(record)
    })
    record.handle.output.once('end', () => {
      finish()
      this.resolveWaiters(record)
    })
    record.handle.output.once('error', (error: unknown) => {
      record.status = { kind: 'failed', message: String(error) }
      finish()
      this.resolveWaiters(record)
    })
    const done = record.handle.done.then(
      async (outcome) => {
        await outputDone
        if (record.status.kind === 'running') record.status = { kind: 'exited', exitCode: outcome.exitCode, signal: outcome.signal }
        this.resolveWaiters(record)
      },
      (error: unknown) => {
        record.status = { kind: 'failed', message: String(error) }
        finish()
        this.resolveWaiters(record)
      },
    )
    return Promise.all([outputDone, done]).then(() => {})
  }

  private closeAttachment(record: AttachmentRecord): Promise<void> {
    if (record.closePromise !== undefined) return record.closePromise
    record.closing = true
    if (record.idleTimer !== undefined) clearTimeout(record.idleTimer)
    this.rejectWaiters(record, new ConsoleError('ATTACHMENT_CLOSING', 'attachment is closing'))
    const closing = record.handle.terminate().then(async () => {
      await record.quiesced
      this.attachments.delete(record.id)
    }, (error: unknown) => {
      record.closing = false
      record.closePromise = undefined
      this.touch(record)
      throw error
    })
    record.closePromise = closing
    return closing
  }

  private touch(record: AttachmentRecord): void {
    if (record.closing) return
    if (record.idleTimer !== undefined) clearTimeout(record.idleTimer)
    record.idleTimer = setTimeout(() => { void this.closeAttachment(record).catch(() => {}) }, this.config.attachmentIdleTtlMs)
    record.idleTimer.unref()
  }

  private expectAttachment(access: ConsoleAttachmentAccess): AttachmentRecord {
    const record = this.attachments.get(access.attachmentId)
    if (record === undefined || record.capability !== access.capability) {
      throw new ConsoleError('ACCESS_DENIED', 'attachment access denied')
    }
    return record
  }

  private expectLiveAttachment(access: ConsoleAttachmentAccess): AttachmentRecord {
    const record = this.expectAttachment(access)
    if (this.disposing) throw new ConsoleError('SERVICE_DISPOSING', 'Console service is disposing')
    if (record.closing) throw new ConsoleError('ATTACHMENT_CLOSING', 'attachment is closing')
    if (record.status.kind !== 'running') throw new ConsoleError('ATTACHMENT_EXITED', 'attachment has exited')
    return record
  }

  private toAttachmentSnapshot(record: AttachmentRecord): ConsoleAttachmentSnapshot {
    return {
      id: record.id,
      consoleId: record.consoleId,
      size: { ...record.size },
      status: record.status,
      oldestOutputByte: record.output.oldestByte,
      nextOutputByte: record.output.nextByte,
    }
  }

  private resolveWaiters(record: AttachmentRecord): void {
    for (const waiter of [...record.waiters]) {
      record.waiters.delete(waiter)
      waiter.signal.removeEventListener('abort', waiter.abort)
      waiter.resolve({ attachment: this.toAttachmentSnapshot(record), output: record.output.read(waiter.fromByte) })
    }
  }

  private rejectWaiters(record: AttachmentRecord, error: ConsoleError): void {
    for (const waiter of [...record.waiters]) {
      record.waiters.delete(waiter)
      waiter.signal.removeEventListener('abort', waiter.abort)
      waiter.reject(error)
    }
  }

  private expectMutable(consoleId: ConsoleId): ConsoleRecord {
    const record = this.records.get(consoleId)
    if (record === undefined) throw new ConsoleError('UNKNOWN_CONSOLE', 'unknown Console')
    if (this.terminations.has(consoleId)) throw new ConsoleError('CONSOLE_TERMINATING', 'Console is terminating')
    if (record.status.kind === 'ended') throw new ConsoleError('CONSOLE_ENDED', 'Console ended externally')
    return record
  }

  private async command(args: readonly string[], operation: string, signal?: AbortSignal): Promise<TmuxCommandResult> {
    const result = await this.requireRunner().run(args, signal)
    this.ensureSuccess(result, operation)
    return result
  }

  private ensureSuccess(result: TmuxCommandResult, operation: string): void {
    if (result.exitCode === 0) return
    const diagnostic = result.stderr.trim() || result.stdout.trim() || `signal ${result.signal ?? 'unknown'}`
    throw new ConsoleError('PROVIDER_FAILURE', `${operation} failed: ${diagnostic}`)
  }

  private requireRunner(): TmuxCommandRunner {
    if (this.runner === undefined) throw new ConsoleError('PROVIDER_FAILURE', 'tmux provider is not initialized')
    return this.runner
  }

  private requireTmuxPath(): string {
    if (this.resolvedTmuxPath === undefined) throw new ConsoleError('PROVIDER_FAILURE', 'tmux provider is not initialized')
    return this.resolvedTmuxPath
  }

  private async disposeAll(): Promise<void> {
    this.disposing = true
    this.lifecycleAbort.abort(new ConsoleError('SERVICE_DISPOSING', 'Console service is disposing'))
    await this.drainOperations()
    await this.reconcilePromise
    for (const record of this.attachments.values()) {
      this.rejectWaiters(record, new ConsoleError('SERVICE_DISPOSING', 'Console service is disposing'))
    }
    const results = await Promise.allSettled([...this.attachments.values()].map(record => this.closeAttachment(record)))
    const failures = results.filter((result): result is PromiseRejectedResult => result.status === 'rejected')
    if (failures.length > 0) {
      throw new AggregateError(failures.map((result): unknown => result.reason), 'console-tmux teardown failed')
    }
  }

  private assertServing(): void {
    if (this.disposing) throw new ConsoleError('SERVICE_DISPOSING', 'Console service is disposing')
  }

  private admitOperation(): () => void {
    this.assertServing()
    this.activeOperations += 1
    return () => {
      this.activeOperations -= 1
      if (this.activeOperations === 0) {
        this.finishOperationDrain?.()
        delete this.operationDrain
        delete this.finishOperationDrain
      }
    }
  }

  private drainOperations(): Promise<void> {
    if (this.activeOperations === 0) return Promise.resolve()
    if (this.operationDrain === undefined) {
      this.operationDrain = new Promise((resolve) => { this.finishOperationDrain = resolve })
    }
    return this.operationDrain
  }
}

export default TmuxConsoleRuntime
