/** Public type vocabulary for host-owned console sessions. @module @deepseek-ai/dsh-console/src/types */

import type { Branded } from '@deepseek-ai/dsh-brand'
import type { WorkspaceId } from '@deepseek-ai/dsh-workspace/types'

/** Opaque identity of one console session. */
export type ConsoleId = Branded<'ConsoleId'>
/** Unforgeable bearer capability authorizing one console session. */
export type ConsoleCapability = Branded<'ConsoleCapability'>

/** Authorized reference to one console session. */
export interface ConsoleAccess {
  readonly consoleId: ConsoleId
  readonly capability: ConsoleCapability
}

/** Positive terminal dimensions. */
export interface ConsoleSize {
  readonly rows: number
  readonly cols: number
}

/** Closed signal set accepted by the subprocess terminal primitive. */
export type ConsoleSignal = 'SIGINT' | 'SIGTERM' | 'SIGKILL' | 'SIGTSTP' | 'SIGHUP'

/** Current console process state. */
export type ConsoleStatus =
  | { readonly kind: 'running' }
  | { readonly kind: 'exited'; readonly exitCode: number | null; readonly signal: NodeJS.Signals | null }
  | { readonly kind: 'failed'; readonly message: string }

/** Request to open the configured human shell in one workspace. */
export interface HumanShellOpenRequest {
  readonly workspaceId: WorkspaceId
  readonly size: ConsoleSize
}

/** Public console state; bearer capabilities are never projected here. */
export interface ConsoleSnapshot {
  readonly id: ConsoleId
  readonly workspaceId: WorkspaceId
  readonly cwd: string
  readonly pid: number
  readonly size: ConsoleSize
  readonly status: ConsoleStatus
  readonly oldestOutputByte: number
  readonly nextOutputByte: number
}

/** Result of opening a console. */
export interface ConsoleOpenResult {
  readonly access: ConsoleAccess
  readonly console: ConsoleSnapshot
}

/** Offset-based bounded output read. */
export type ConsoleOutputRead =
  | {
    readonly kind: 'data'
    readonly data: Uint8Array
    readonly fromByte: number
    readonly nextByte: number
    readonly availableThroughByte: number
  }
  | { readonly kind: 'gap'; readonly oldestByte: number; readonly nextByte: number }

/** Atomic console state and output observation returned by a long-poll wait. */
export interface ConsoleOutputObservation {
  readonly console: ConsoleSnapshot
  readonly output: ConsoleOutputRead
}

/** Successful foreground-process-group signal delivery. */
export interface ConsoleSignalResult {
  readonly delivered: true
  readonly targetPgid: number
}

/** Stable programmatic console failure codes. */
export type ConsoleErrorCode =
  | 'ACCESS_DENIED'
  | 'UNKNOWN_WORKSPACE'
  | 'WORKSPACE_UNAVAILABLE'
  | 'CONSOLE_CLOSING'
  | 'CONSOLE_EXITED'
  | 'SERVICE_DISPOSING'
  | 'INVALID_CURSOR'
  | 'OUTPUT_WAITER_LIMIT'
