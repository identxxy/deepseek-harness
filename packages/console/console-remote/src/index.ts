/** Authorized JSON Remote consumer for durable Consoles and ephemeral attachments. @module @deepseek-ai/dsh-console-remote */

import { Buffer } from 'node:buffer'
import { Context } from '@deepseek-ai/cordis'
import s from '@deepseek-ai/schemastery'
import {
  ConsoleAttachmentCapability, ConsoleAttachmentId, ConsoleError, ConsoleId,
} from '@deepseek-ai/dsh-console'
import type {
  ConsoleAttachmentAccess, ConsoleAttachmentOpenResult, ConsoleAttachmentSnapshot,
  ConsoleOutputObservation, ConsoleOutputRead, ConsoleSnapshot,
} from '@deepseek-ai/dsh-console'
import { WorkspaceId } from '@deepseek-ai/dsh-workspace'
import { Remote, TypertRemoteService } from '@deepseek-ai/dsh-typert-protocol'
import type {
  ConsoleRemoteArchiveRequest, ConsoleRemoteAttachRequest, ConsoleRemoteAttachmentAccess,
  ConsoleRemoteAttachmentAccessRequest, ConsoleRemoteAttachmentOpenResult, ConsoleRemoteAttachmentSnapshot,
  ConsoleRemoteCreateRequest, ConsoleRemoteIdRequest, ConsoleRemoteObservation, ConsoleRemoteOutput,
  ConsoleRemoteReadRequest, ConsoleRemoteRenameRequest, ConsoleRemoteResizeRequest, ConsoleRemoteResult,
  ConsoleRemoteSnapshot, ConsoleRemoteWriteRequest,
} from './types.ts'

export type * from './types.ts'

/** Required Remote polling and input limits. */
export interface Config {
  /** Maximum duration accepted for one long-poll read. */
  readonly maxPollWaitMs: number
  /** Maximum UTF-8 byte length accepted for one write. */
  readonly maxWriteBytes: number
  /** Maximum UTF-8 byte length accepted for one Console title. */
  readonly maxTitleBytes: number
}

declare module '@deepseek-ai/cordis' {
  interface Context { consoleRemote: ConsoleRemoteService }
}

function success<T>(value: T): ConsoleRemoteResult<T> { return { ok: true, value } }
function failure(error: ConsoleError): ConsoleRemoteResult<never> { return { ok: false, error: { code: error.code } } }
function attachmentAccess(value: ConsoleRemoteAttachmentAccess): ConsoleAttachmentAccess {
  return { attachmentId: ConsoleAttachmentId(value.attachmentId), capability: ConsoleAttachmentCapability(value.capability) }
}
function consoleSnapshot(value: ConsoleSnapshot): ConsoleRemoteSnapshot {
  return {
    id: value.id,
    workspaceId: value.workspaceId,
    cwd: value.cwd,
    title: value.title,
    createdAt: value.createdAt,
    archived: value.archived,
    status: value.status,
  }
}
function attachmentSnapshot(value: ConsoleAttachmentSnapshot): ConsoleRemoteAttachmentSnapshot {
  return {
    id: value.id,
    consoleId: value.consoleId,
    size: value.size,
    status: value.status.kind === 'failed' ? { kind: 'failed' } : value.status,
    oldestOutputByte: value.oldestOutputByte,
    nextOutputByte: value.nextOutputByte,
  }
}
function attachmentOpen(value: ConsoleAttachmentOpenResult): ConsoleRemoteAttachmentOpenResult {
  return {
    access: { attachmentId: value.access.attachmentId, capability: value.access.capability },
    attachment: attachmentSnapshot(value.attachment),
  }
}
function output(value: ConsoleOutputRead): ConsoleRemoteOutput {
  return value.kind === 'gap'
    ? value
    : {
      kind: 'data',
      dataBase64: Buffer.from(value.data).toString('base64'),
      fromByte: value.fromByte,
      nextByte: value.nextByte,
      availableThroughByte: value.availableThroughByte,
    }
}
function observation(value: ConsoleOutputObservation, timedOut: boolean): ConsoleRemoteObservation {
  return { attachment: attachmentSnapshot(value.attachment), output: output(value.output), timedOut }
}
function validSize(size: { readonly rows: number; readonly cols: number }): boolean {
  return Number.isSafeInteger(size.rows) && size.rows > 0 && Number.isSafeInteger(size.cols) && size.cols > 0
}

/** Remote Console catalog, lifecycle, attachment, and terminal I/O operations under the `consoles` wire namespace. */
export class ConsoleRemoteService extends TypertRemoteService {
  static inject = ['consoles']
  static Config: s<Config> = s.object({
    maxPollWaitMs: s.number().step(1).min(1).required(),
    maxWriteBytes: s.number().step(1).min(1).required(),
    maxTitleBytes: s.number().step(1).min(1).required(),
  })

  constructor(ctx: Context, private readonly config: Config) { super(ctx, 'consoleRemote', { namespace: 'consoles' }) }

  /**
   * List the complete durable Console catalog.
   * @returns The catalog or a provider business failure.
   */
  @Remote('list')
  async list(): Promise<ConsoleRemoteResult<readonly ConsoleRemoteSnapshot[]>> {
    try { return success((await this.ctx.consoles.list()).map(consoleSnapshot)) }
    catch (error) { if (error instanceof ConsoleError) return failure(error); throw error }
  }

  /**
   * Create one durable Console through the authorized carrier.
   * @param request - Workspace, title, and initial dimensions.
   * @param signal - Carrier cancellation.
   * @returns The durable Console or a business failure.
   */
  @Remote('create')
  async create(request: ConsoleRemoteCreateRequest, signal: AbortSignal): Promise<ConsoleRemoteResult<ConsoleRemoteSnapshot>> {
    if (!validSize(request.initialSize)) return { ok: false, error: { code: 'INVALID_SIZE' } }
    if (request.title.length === 0) return { ok: false, error: { code: 'INVALID_TITLE' } }
    if (Buffer.byteLength(request.title, 'utf8') > this.config.maxTitleBytes) return { ok: false, error: { code: 'TITLE_TOO_LARGE' } }
    try {
      return success(consoleSnapshot(await this.ctx.consoles.create({
        workspaceId: WorkspaceId(request.workspaceId), title: request.title, initialSize: request.initialSize,
      }, signal)))
    } catch (error) { if (error instanceof ConsoleError) return failure(error); throw error }
  }

  /**
   * Read the current public state of one Console.
   * @param request - Durable Console identity.
   * @returns Its current state or a business failure.
   */
  @Remote('snapshot')
  snapshot(request: ConsoleRemoteIdRequest): ConsoleRemoteResult<ConsoleRemoteSnapshot> {
    try { return success(consoleSnapshot(this.ctx.consoles.snapshot(ConsoleId(request.consoleId)))) }
    catch (error) { if (error instanceof ConsoleError) return failure(error); throw error }
  }

  /**
   * Replace one Console's display title.
   * @param request - Console identity and replacement title.
   * @returns State after metadata durability or a business failure.
   */
  @Remote('rename')
  async rename(request: ConsoleRemoteRenameRequest): Promise<ConsoleRemoteResult<ConsoleRemoteSnapshot>> {
    if (request.title.length === 0) return { ok: false, error: { code: 'INVALID_TITLE' } }
    if (Buffer.byteLength(request.title, 'utf8') > this.config.maxTitleBytes) return { ok: false, error: { code: 'TITLE_TOO_LARGE' } }
    try { return success(consoleSnapshot(await this.ctx.consoles.rename(ConsoleId(request.consoleId), request.title))) }
    catch (error) { if (error instanceof ConsoleError) return failure(error); throw error }
  }

  /**
   * Archive or restore one durable Console.
   * @param request - Console identity and desired archive state.
   * @returns State after metadata durability or a business failure.
   */
  @Remote('setArchived')
  async setArchived(request: ConsoleRemoteArchiveRequest): Promise<ConsoleRemoteResult<ConsoleRemoteSnapshot>> {
    try { return success(consoleSnapshot(await this.ctx.consoles.setArchived(ConsoleId(request.consoleId), request.archived))) }
    catch (error) { if (error instanceof ConsoleError) return failure(error); throw error }
  }

  /**
   * Start one ephemeral terminal Client for a running Console.
   * @param request - Running Console and initial attachment dimensions.
   * @param signal - Carrier cancellation.
   * @returns A new authorized attachment or a business failure.
   */
  @Remote('attach')
  async attach(
    request: ConsoleRemoteAttachRequest,
    signal: AbortSignal,
  ): Promise<ConsoleRemoteResult<ConsoleRemoteAttachmentOpenResult>> {
    if (!validSize(request.size)) return { ok: false, error: { code: 'INVALID_SIZE' } }
    try {
      return success(attachmentOpen(await this.ctx.consoles.attach({
        consoleId: ConsoleId(request.consoleId), size: request.size,
      }, signal)))
    }
    catch (error) { if (error instanceof ConsoleError) return failure(error); throw error }
  }

  /**
   * Read one authorized attachment's current state.
   * @param request - Authorized attachment reference.
   * @returns Its current state or a business failure.
   */
  @Remote('attachmentSnapshot')
  attachmentSnapshot(request: ConsoleRemoteAttachmentAccessRequest): ConsoleRemoteResult<ConsoleRemoteAttachmentSnapshot> {
    try { return success(attachmentSnapshot(this.ctx.consoles.attachmentSnapshot(attachmentAccess(request.access)))) }
    catch (error) { if (error instanceof ConsoleError) return failure(error); throw error }
  }

  /**
   * Read immediately or wait once for attachment output or state.
   * @param request - Authorized cursor and requested wait.
   * @param signal - Carrier cancellation.
   * @returns A bounded observation or business failure.
   */
  @Remote('read')
  async read(request: ConsoleRemoteReadRequest, signal: AbortSignal): Promise<ConsoleRemoteResult<ConsoleRemoteObservation>> {
    try {
      const authorized = attachmentAccess(request.access)
      const current = this.ctx.consoles.attachmentSnapshot(authorized)
      if (!Number.isSafeInteger(request.waitMs) || request.waitMs < 1) return { ok: false, error: { code: 'INVALID_WAIT_MS' } }
      const waitMs = Math.min(request.waitMs, this.config.maxPollWaitMs)
      const existing = this.ctx.consoles.readOutput(authorized, request.fromByte)
      if (existing.kind === 'gap' || existing.nextByte > request.fromByte || current.status.kind !== 'running') {
        return success(observation({ attachment: current, output: existing }, false))
      }
      const timeout = AbortSignal.timeout(waitMs)
      try {
        return success(observation(await this.ctx.consoles.waitOutput(
          authorized, request.fromByte, AbortSignal.any([signal, timeout]),
        ), false))
      } catch (error) {
        if (timeout.aborted && !signal.aborted) {
          return success(observation({
            attachment: this.ctx.consoles.attachmentSnapshot(authorized),
            output: this.ctx.consoles.readOutput(authorized, request.fromByte),
          }, true))
        }
        throw error
      }
    } catch (error) { if (error instanceof ConsoleError) return failure(error); throw error }
  }

  /**
   * Write bounded UTF-8 terminal input to one attachment.
   * @param request - Authorized terminal input.
   * @param signal - Carrier cancellation.
   * @returns Completion or a business failure.
   */
  @Remote('write')
  async write(request: ConsoleRemoteWriteRequest, signal?: AbortSignal): Promise<ConsoleRemoteResult<null>> {
    try {
      signal?.throwIfAborted()
      const authorized = attachmentAccess(request.access)
      this.ctx.consoles.attachmentSnapshot(authorized)
      if (Buffer.byteLength(request.data, 'utf8') > this.config.maxWriteBytes) return { ok: false, error: { code: 'WRITE_TOO_LARGE' } }
      await this.ctx.consoles.write(authorized, request.data)
      return success(null)
    } catch (error) { if (error instanceof ConsoleError) return failure(error); throw error }
  }

  /**
   * Resize one authorized terminal attachment.
   * @param request - Authorized attachment dimensions.
   * @param signal - Carrier cancellation.
   * @returns Completion or a business failure.
   */
  @Remote('resize')
  async resize(request: ConsoleRemoteResizeRequest, signal?: AbortSignal): Promise<ConsoleRemoteResult<null>> {
    try {
      signal?.throwIfAborted()
      const authorized = attachmentAccess(request.access)
      this.ctx.consoles.attachmentSnapshot(authorized)
      if (!validSize(request.size)) return { ok: false, error: { code: 'INVALID_SIZE' } }
      await this.ctx.consoles.resize(authorized, request.size)
      return success(null)
    } catch (error) { if (error instanceof ConsoleError) return failure(error); throw error }
  }

  /**
   * Detach one terminal Client without stopping its Console.
   * @param request - Authorized attachment reference.
   * @returns Completion after only the tmux Client exits, or a business failure.
   */
  @Remote('detach')
  async detach(request: ConsoleRemoteAttachmentAccessRequest): Promise<ConsoleRemoteResult<null>> {
    try { await this.ctx.consoles.detach(attachmentAccess(request.access)); return success(null) }
    catch (error) { if (error instanceof ConsoleError) return failure(error); throw error }
  }

  /**
   * Terminate one durable Console workload explicitly.
   * @param request - Durable Console identity.
   * @returns Completion after termination, or a business failure.
   */
  @Remote('terminate')
  async terminate(request: ConsoleRemoteIdRequest): Promise<ConsoleRemoteResult<null>> {
    try { await this.ctx.consoles.terminate(ConsoleId(request.consoleId)); return success(null) }
    catch (error) { if (error instanceof ConsoleError) return failure(error); throw error }
  }
}

export default ConsoleRemoteService
