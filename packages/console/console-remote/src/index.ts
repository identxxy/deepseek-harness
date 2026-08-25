/** Authorized JSON Remote consumer for host-owned consoles. @module @deepseek-ai/dsh-console-remote */
import { Buffer } from 'node:buffer'
import { Context } from '@deepseek-ai/cordis'
import s from '@deepseek-ai/schemastery'
import { ConsoleError } from '@deepseek-ai/dsh-console'
import type { ConsoleAccess, ConsoleOutputObservation, ConsoleOutputRead, ConsoleSnapshot } from '@deepseek-ai/dsh-console'
import { Remote, TypertRemoteService } from '@deepseek-ai/dsh-typert-protocol'
import type {
  ConsoleRemoteAccess, ConsoleRemoteAccessRequest, ConsoleRemoteObservation,
  ConsoleRemoteOutput, ConsoleRemoteReadRequest, ConsoleRemoteResizeRequest,
  ConsoleRemoteResult, ConsoleRemoteSignalRequest, ConsoleRemoteSnapshot,
  ConsoleRemoteWriteRequest,
} from './types.ts'

export type * from './types.ts'

/** Required Remote polling and input limits. */
export interface Config {
  /** Maximum duration accepted for one long-poll read. */
  readonly maxPollWaitMs: number
  /** Maximum UTF-8 byte length accepted for one write. */
  readonly maxWriteBytes: number
}

declare module '@deepseek-ai/cordis' {
  interface Context { consoleRemote: ConsoleRemoteService }
}

function success<T>(value: T): ConsoleRemoteResult<T> { return { ok: true, value } }
function failure(error: ConsoleError): ConsoleRemoteResult<never> {
  return { ok: false, error: { code: error.code } }
}
function access(value: ConsoleRemoteAccess): ConsoleAccess { return value as ConsoleAccess }
function snapshot(value: ConsoleSnapshot): ConsoleRemoteSnapshot {
  const status = value.status.kind === 'failed' ? { kind: 'failed' as const } : value.status
  return {
    id: value.id, workspaceId: value.workspaceId, cwd: value.cwd,
    size: value.size, status, oldestOutputByte: value.oldestOutputByte,
    nextOutputByte: value.nextOutputByte,
  }
}
function output(value: ConsoleOutputRead): ConsoleRemoteOutput {
  return value.kind === 'gap' ? value : { kind: 'data', dataBase64: Buffer.from(value.data).toString('base64'), fromByte: value.fromByte, nextByte: value.nextByte, availableThroughByte: value.availableThroughByte }
}
function observation(value: ConsoleOutputObservation, timedOut: boolean): ConsoleRemoteObservation {
  return { console: snapshot(value.console), output: output(value.output), timedOut }
}

/** Remote-only authorized console operations under the `consoles` wire namespace. */
export class ConsoleRemoteService extends TypertRemoteService {
  static inject = ['consoles']
  static Config: s<Config> = s.object({
    maxPollWaitMs: s.number().step(1).min(1).required(),
    maxWriteBytes: s.number().step(1).min(1).required(),
  })
  constructor(ctx: Context, private readonly config: Config) { super(ctx, 'consoleRemote', { namespace: 'consoles' }) }

  /**
   * Project one authorized snapshot without host process coordinates.
   * @param request - Authorized console reference.
   * @returns JSON-safe snapshot or business failure.
   */
  @Remote('snapshot')
  snapshot(request: ConsoleRemoteAccessRequest): ConsoleRemoteResult<ConsoleRemoteSnapshot> {
    try {
      return success(snapshot(this.ctx.consoles.snapshot(access(request.access))))
    } catch (error) {
      if (error instanceof ConsoleError) return failure(error)
      throw error
    }
  }

  /**
   * Read immediately or wait once for output or terminal state.
   * @param request - Authorized cursor and requested wait.
   * @param signal - Carrier cancellation.
   * @returns bounded observation, timeout observation, or business failure.
   */
  @Remote('read')
  async read(request: ConsoleRemoteReadRequest, signal: AbortSignal): Promise<ConsoleRemoteResult<ConsoleRemoteObservation>> {
    try {
      const authorized = access(request.access)
      const current = this.ctx.consoles.snapshot(authorized)
      if (!Number.isSafeInteger(request.waitMs) || request.waitMs < 1) return { ok: false, error: { code: 'INVALID_WAIT_MS' } }
      const waitMs = Math.min(request.waitMs, this.config.maxPollWaitMs)
      const existing = this.ctx.consoles.readOutput(authorized, request.fromByte)
      if (existing.kind === 'gap' || existing.nextByte > request.fromByte || current.status.kind !== 'running') return success(observation({ console: current, output: existing }, false))
      const timeout = AbortSignal.timeout(waitMs)
      try {
        const waited = await this.ctx.consoles.waitOutput(
          authorized, request.fromByte, AbortSignal.any([signal, timeout]),
        )
        return success(observation(waited, false))
      }
      catch (error) {
        if (timeout.aborted && !signal.aborted) {
          return success(observation({
            console: this.ctx.consoles.snapshot(authorized),
            output: this.ctx.consoles.readOutput(authorized, request.fromByte),
          }, true))
        }
        throw error
      }
    } catch (error) { if (error instanceof ConsoleError) return failure(error); throw error }
  }

  /**
   * Write bounded UTF-8 input after capability authorization.
   * @param request - Authorized UTF-8 terminal input.
   * @returns completion or business failure.
   */
  @Remote('write')
  async write(request: ConsoleRemoteWriteRequest): Promise<ConsoleRemoteResult<null>> {
    try {
      const authorized = access(request.access)
      this.ctx.consoles.snapshot(authorized)
      if (Buffer.byteLength(request.data, 'utf8') > this.config.maxWriteBytes) return { ok: false, error: { code: 'WRITE_TOO_LARGE' } }
      await this.ctx.consoles.write(authorized, request.data)
      return success(null)
    } catch (error) { if (error instanceof ConsoleError) return failure(error); throw error }
  }

  /**
   * Resize one authorized console.
   * @param request - Authorized terminal dimensions.
   * @returns completion or business failure.
   */
  @Remote('resize')
  async resize(request: ConsoleRemoteResizeRequest): Promise<ConsoleRemoteResult<null>> {
    try {
      const authorized = access(request.access)
      this.ctx.consoles.snapshot(authorized)
      if (!Number.isSafeInteger(request.size.rows) || request.size.rows < 1 || !Number.isSafeInteger(request.size.cols) || request.size.cols < 1) return { ok: false, error: { code: 'INVALID_SIZE' } }
      await this.ctx.consoles.resize(authorized, request.size)
      return success(null)
    } catch (error) { if (error instanceof ConsoleError) return failure(error); throw error }
  }

  /**
   * Signal one authorized console's foreground process group.
   * @param request - Authorized foreground signal.
   * @returns delivery facts or business failure.
   */
  @Remote('signal')
  async signal(request: ConsoleRemoteSignalRequest): Promise<ConsoleRemoteResult<{ delivered: true; targetPgid: number }>> {
    try {
      return success(await this.ctx.consoles.signal(access(request.access), request.signal))
    } catch (error) {
      if (error instanceof ConsoleError) return failure(error)
      throw error
    }
  }

  /**
   * Stop and remove one authorized console.
   * @param request - Authorized console reference.
   * @returns completion or business failure.
   */
  @Remote('stop')
  async stop(request: ConsoleRemoteAccessRequest): Promise<ConsoleRemoteResult<null>> {
    try {
      await this.ctx.consoles.stop(access(request.access))
      return success(null)
    } catch (error) {
      if (error instanceof ConsoleError) return failure(error)
      throw error
    }
  }
}

export default ConsoleRemoteService
