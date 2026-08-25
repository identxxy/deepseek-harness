/** Host-owned console runtime Service Definition. @module @deepseek-ai/dsh-console */

import { Context, Service } from '@deepseek-ai/cordis'
import type {
  ConsoleAccess, ConsoleErrorCode, ConsoleOpenResult, ConsoleOutputObservation, ConsoleOutputRead, ConsoleSignal,
  ConsoleSignalResult, ConsoleSize, ConsoleSnapshot, HumanShellOpenRequest,
} from './types.ts'

export type {
  ConsoleAccess, ConsoleCapability, ConsoleErrorCode, ConsoleId, ConsoleOpenResult,
  ConsoleOutputObservation, ConsoleOutputRead, ConsoleSignal, ConsoleSignalResult, ConsoleSize, ConsoleSnapshot,
  ConsoleStatus, HumanShellOpenRequest,
} from './types.ts'

/** Stable console runtime failure. */
export class ConsoleError extends Error {
  /** @param code - Stable machine-readable failure code. @param message - Human-readable diagnostic. */
  constructor(readonly code: ConsoleErrorCode, message: string) {
    super(message)
    this.name = 'ConsoleError'
  }
}

declare module '@deepseek-ai/cordis' {
  interface Context { consoles: ConsoleRuntime }
}

/** Abstract host-owned console runtime. */
export abstract class ConsoleRuntime extends Service {
  constructor(ctx: Context) {
    if (new.target === ConsoleRuntime) {
      throw new Error('@deepseek-ai/dsh-console is the abstract console runtime seam; load an implementation such as @deepseek-ai/dsh-console-local instead')
    }
    super(ctx, 'consoles')
  }

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
}

export default ConsoleRuntime
