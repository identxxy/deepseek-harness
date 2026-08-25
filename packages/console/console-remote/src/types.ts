/** JSON wire vocabulary for authorized console Remote operations. @module @deepseek-ai/dsh-console-remote/types */
/** Opaque authorized console reference carried over JSON. */
export interface ConsoleRemoteAccess { readonly consoleId: string; readonly capability: string }
/** Terminal dimensions carried over JSON. */
export interface ConsoleRemoteSize { readonly rows: number; readonly cols: number }
/** Closed terminal signal vocabulary carried over JSON. */
export type ConsoleRemoteSignal = 'SIGINT' | 'SIGTERM' | 'SIGKILL' | 'SIGTSTP' | 'SIGHUP'
/** Stable console business errors exposed without provider diagnostics. */
export type ConsoleRemoteErrorCode =
  | 'ACCESS_DENIED' | 'UNKNOWN_WORKSPACE' | 'WORKSPACE_UNAVAILABLE'
  | 'CONSOLE_CLOSING' | 'CONSOLE_EXITED' | 'SERVICE_DISPOSING'
  | 'INVALID_CURSOR' | 'OUTPUT_WAITER_LIMIT'

/** Business failure projected without provider diagnostics. */
export interface ConsoleRemoteFailure { readonly code: ConsoleRemoteErrorCode | 'INVALID_SIZE' | 'INVALID_WAIT_MS' | 'WRITE_TOO_LARGE' }
/** Explicit JSON business result. */
export type ConsoleRemoteResult<T> = { readonly ok: true; readonly value: T } | { readonly ok: false; readonly error: ConsoleRemoteFailure }
/** JSON-safe console status. */
export type ConsoleRemoteStatus = { readonly kind: 'running' } | { readonly kind: 'exited'; readonly exitCode: number | null; readonly signal: string | null } | { readonly kind: 'failed' }
/** Authorized public console state without a host process id. */
export interface ConsoleRemoteSnapshot {
  readonly id: string
  readonly workspaceId: string
  readonly cwd: string
  readonly size: ConsoleRemoteSize
  readonly status: ConsoleRemoteStatus
  readonly oldestOutputByte: number
  readonly nextOutputByte: number
}
/** Base64 output page or explicit retention gap. */
export type ConsoleRemoteOutput = { readonly kind: 'data'; readonly dataBase64: string; readonly fromByte: number; readonly nextByte: number; readonly availableThroughByte: number } | { readonly kind: 'gap'; readonly oldestByte: number; readonly nextByte: number }
/** Atomic long-poll response. */
export interface ConsoleRemoteObservation {
  readonly console: ConsoleRemoteSnapshot
  readonly output: ConsoleRemoteOutput
  readonly timedOut: boolean
}
/** Long-poll request. */
export interface ConsoleRemoteReadRequest { readonly access: ConsoleRemoteAccess; readonly fromByte: number; readonly waitMs: number }
/** Write request. */
export interface ConsoleRemoteWriteRequest { readonly access: ConsoleRemoteAccess; readonly data: string }
/** Resize request. */
export interface ConsoleRemoteResizeRequest { readonly access: ConsoleRemoteAccess; readonly size: ConsoleRemoteSize }
/** Signal request. */
export interface ConsoleRemoteSignalRequest { readonly access: ConsoleRemoteAccess; readonly signal: ConsoleRemoteSignal }
/** Access-only request used by snapshot and stop. */
export interface ConsoleRemoteAccessRequest { readonly access: ConsoleRemoteAccess }
