/** Durable Human Terminal Service Definition. @module @deepseek-ai/dsh-console */

import { Context, Service } from '@deepseek-ai/cordis'
import type {
  ConsoleAttachRequest, ConsoleAttachmentAccess, ConsoleAttachmentOpenResult, ConsoleAttachmentSnapshot,
  ConsoleCreateRequest, ConsoleErrorCode, ConsoleId, ConsoleOutputObservation, ConsoleOutputRead,
  ConsoleSize, ConsoleSnapshot,
} from './types.ts'

export { ConsoleAttachmentCapability, ConsoleAttachmentId, ConsoleId } from './types.ts'
export type {
  ConsoleAttachRequest, ConsoleAttachmentAccess, ConsoleAttachmentOpenResult, ConsoleAttachmentSnapshot,
  ConsoleAttachmentStatus, ConsoleCreateRequest, ConsoleErrorCode, ConsoleOutputObservation,
  ConsoleOutputRead, ConsoleSize, ConsoleSnapshot,
  ConsoleStatus,
} from './types.ts'

/** Stable Console runtime failure. */
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

/** Abstract runtime for durable Human Terminals and their ephemeral terminal Clients. */
export abstract class ConsoleRuntime extends Service {
  constructor(ctx: Context) {
    if (new.target === ConsoleRuntime) {
      throw new Error('@deepseek-ai/dsh-console is the abstract console runtime seam; load an implementation such as @deepseek-ai/dsh-console-tmux instead')
    }
    super(ctx, 'consoles')
  }

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
}

export default ConsoleRuntime
