/** Public type vocabulary for durable Human Terminals and ephemeral attachments. @module @deepseek-ai/dsh-console/src/types */

import type { Branded } from '@deepseek-ai/dsh-brand'
import type { WorkspaceId } from '@deepseek-ai/dsh-workspace/types'

/** Opaque identity of one durable Human Terminal workload. */
export type ConsoleId = Branded<'ConsoleId'>
/**
 * Brand one serialized Console identity.
 * @param value - Serialized Console identity.
 * @returns The branded identity.
 */
export const ConsoleId = (value: string): ConsoleId => value as ConsoleId

/** Opaque identity of one ephemeral Console attachment. */
export type ConsoleAttachmentId = Branded<'ConsoleAttachmentId'>
/**
 * Brand one serialized Console attachment identity.
 * @param value - Serialized attachment identity.
 * @returns The branded identity.
 */
export const ConsoleAttachmentId = (value: string): ConsoleAttachmentId => value as ConsoleAttachmentId

/** Unforgeable bearer capability authorizing one ephemeral Console attachment. */
export type ConsoleAttachmentCapability = Branded<'ConsoleAttachmentCapability'>
/**
 * Brand one serialized Console attachment capability.
 * @param value - Serialized attachment capability.
 * @returns The branded capability.
 */
export const ConsoleAttachmentCapability = (value: string): ConsoleAttachmentCapability => value as ConsoleAttachmentCapability

/** Authorized reference to one ephemeral attachment; the Console identity alone grants no terminal I/O. */
export interface ConsoleAttachmentAccess {
  readonly attachmentId: ConsoleAttachmentId
  readonly capability: ConsoleAttachmentCapability
}

/** Positive terminal dimensions. */
export interface ConsoleSize {
  readonly rows: number
  readonly cols: number
}

/** Durable workload availability observed by the current Host process. */
export type ConsoleStatus =
  | { readonly kind: 'running' }
  | { readonly kind: 'ended'; readonly reason: 'external' }

/** Public durable Console state; provider coordinates and attachment capabilities are excluded. */
export interface ConsoleSnapshot {
  readonly id: ConsoleId
  readonly workspaceId: WorkspaceId
  readonly cwd: string
  readonly title: string
  readonly createdAt: string
  readonly archived: boolean
  readonly status: ConsoleStatus
}

/** Create one durable Human Terminal in a registered Workspace. */
export interface ConsoleCreateRequest {
  readonly workspaceId: WorkspaceId
  readonly title: string
  readonly initialSize: ConsoleSize
}

/** Attach one new Web terminal Client to a running Console. */
export interface ConsoleAttachRequest {
  readonly consoleId: ConsoleId
  readonly size: ConsoleSize
}

/** Current ephemeral attachment process state. */
export type ConsoleAttachmentStatus =
  | { readonly kind: 'running' }
  | { readonly kind: 'exited'; readonly exitCode: number | null; readonly signal: NodeJS.Signals | null }
  | { readonly kind: 'failed'; readonly message: string }

/** Public attachment state; the bearer capability is never projected here. */
export interface ConsoleAttachmentSnapshot {
  readonly id: ConsoleAttachmentId
  readonly consoleId: ConsoleId
  readonly size: ConsoleSize
  readonly status: ConsoleAttachmentStatus
  readonly oldestOutputByte: number
  readonly nextOutputByte: number
}

/** Newly published attachment and its in-memory authorization. */
export interface ConsoleAttachmentOpenResult {
  readonly access: ConsoleAttachmentAccess
  readonly attachment: ConsoleAttachmentSnapshot
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

/** Atomic attachment state and output observation returned by a long-poll wait. */
export interface ConsoleOutputObservation {
  readonly attachment: ConsoleAttachmentSnapshot
  readonly output: ConsoleOutputRead
}

/** Stable programmatic Console failure codes. */
export type ConsoleErrorCode =
  | 'ACCESS_DENIED'
  | 'UNKNOWN_CONSOLE'
  | 'UNKNOWN_WORKSPACE'
  | 'WORKSPACE_UNAVAILABLE'
  | 'CONSOLE_ARCHIVED'
  | 'CONSOLE_ENDED'
  | 'CONSOLE_TERMINATING'
  | 'ATTACHMENT_CLOSING'
  | 'ATTACHMENT_EXITED'
  | 'SERVICE_DISPOSING'
  | 'INVALID_CURSOR'
  | 'OUTPUT_WAITER_LIMIT'
  | 'RESOURCE_LIMIT'
  | 'PROVIDER_FAILURE'
