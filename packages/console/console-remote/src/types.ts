/** JSON wire vocabulary for durable Consoles and ephemeral attachments. @module @deepseek-ai/dsh-console-remote/types */

/** Opaque attachment authorization carried over JSON. */
export interface ConsoleRemoteAttachmentAccess { readonly attachmentId: string; readonly capability: string }
/** Terminal dimensions carried over JSON. */
export interface ConsoleRemoteSize { readonly rows: number; readonly cols: number }
/** Stable Console business errors exposed without provider diagnostics. */
export type ConsoleRemoteErrorCode =
  | 'ACCESS_DENIED' | 'UNKNOWN_CONSOLE' | 'UNKNOWN_WORKSPACE' | 'WORKSPACE_UNAVAILABLE'
  | 'CONSOLE_ARCHIVED' | 'CONSOLE_ENDED' | 'CONSOLE_TERMINATING'
  | 'ATTACHMENT_CLOSING' | 'ATTACHMENT_EXITED' | 'SERVICE_DISPOSING'
  | 'INVALID_CURSOR' | 'OUTPUT_WAITER_LIMIT' | 'RESOURCE_LIMIT' | 'PROVIDER_FAILURE'
/** Business failure projected without provider diagnostics. */
export interface ConsoleRemoteFailure {
  readonly code: ConsoleRemoteErrorCode | 'INVALID_SIZE' | 'INVALID_WAIT_MS' | 'INVALID_TITLE' | 'TITLE_TOO_LARGE' | 'WRITE_TOO_LARGE'
}
/** Explicit JSON business result. */
export type ConsoleRemoteResult<T> = { readonly ok: true; readonly value: T } | { readonly ok: false; readonly error: ConsoleRemoteFailure }
/** JSON-safe durable Console state. */
export interface ConsoleRemoteSnapshot {
  readonly id: string
  readonly workspaceId: string
  readonly cwd: string
  readonly title: string
  readonly createdAt: string
  readonly archived: boolean
  readonly status: { readonly kind: 'running' } | { readonly kind: 'ended'; readonly reason: 'external' }
}
/** JSON-safe attachment process state. */
export type ConsoleRemoteAttachmentStatus =
  | { readonly kind: 'running' }
  | { readonly kind: 'exited'; readonly exitCode: number | null; readonly signal: string | null }
  | { readonly kind: 'failed' }
/** Public attachment state without its bearer capability. */
export interface ConsoleRemoteAttachmentSnapshot {
  readonly id: string
  readonly consoleId: string
  readonly size: ConsoleRemoteSize
  readonly status: ConsoleRemoteAttachmentStatus
  readonly oldestOutputByte: number
  readonly nextOutputByte: number
}
/** Newly published attachment and its authorization. */
export interface ConsoleRemoteAttachmentOpenResult {
  readonly access: ConsoleRemoteAttachmentAccess
  readonly attachment: ConsoleRemoteAttachmentSnapshot
}
/** Base64 output page or explicit retention gap. */
export type ConsoleRemoteOutput =
  | {
    readonly kind: 'data'
    readonly dataBase64: string
    readonly fromByte: number
    readonly nextByte: number
    readonly availableThroughByte: number
  }
  | { readonly kind: 'gap'; readonly oldestByte: number; readonly nextByte: number }
/** Atomic long-poll response. */
export interface ConsoleRemoteObservation {
  readonly attachment: ConsoleRemoteAttachmentSnapshot
  readonly output: ConsoleRemoteOutput
  readonly timedOut: boolean
}
/** Create request. */
export interface ConsoleRemoteCreateRequest {
  readonly workspaceId: string
  readonly title: string
  readonly initialSize: ConsoleRemoteSize
}
/** Durable Console identity request. */
export interface ConsoleRemoteIdRequest { readonly consoleId: string }
/** Rename request. */
export interface ConsoleRemoteRenameRequest { readonly consoleId: string; readonly title: string }
/** Archive or restore request. */
export interface ConsoleRemoteArchiveRequest { readonly consoleId: string; readonly archived: boolean }
/** Attach request. */
export interface ConsoleRemoteAttachRequest { readonly consoleId: string; readonly size: ConsoleRemoteSize }
/** Long-poll request. */
export interface ConsoleRemoteReadRequest {
  readonly access: ConsoleRemoteAttachmentAccess
  readonly fromByte: number
  readonly waitMs: number
}
/** Write request. */
export interface ConsoleRemoteWriteRequest { readonly access: ConsoleRemoteAttachmentAccess; readonly data: string }
/** Resize request. */
export interface ConsoleRemoteResizeRequest { readonly access: ConsoleRemoteAttachmentAccess; readonly size: ConsoleRemoteSize }
/** Access-only request used by attachment snapshot and detach. */
export interface ConsoleRemoteAttachmentAccessRequest { readonly access: ConsoleRemoteAttachmentAccess }
