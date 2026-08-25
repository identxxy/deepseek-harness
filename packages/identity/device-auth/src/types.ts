/** Device authentication public value types. @module @deepseek-ai/dsh-device-auth/types */

import type { Branded } from '@deepseek-ai/dsh-brand'

/** Durable device record identity. */
export type DeviceId = Branded<'DeviceId'>
/** Browser-session identity. */
export type DeviceSessionId = Branded<'DeviceSessionId'>
/** Canonical issuer-and-subject identity; email never participates. */
export type DevicePrincipalId = Branded<'DevicePrincipalId'>

/**
 * Brand one device id.
 * @param value - Raw id.
 * @returns the same string branded as a device id.
 */
export const DeviceId = (value: string): DeviceId => value as DeviceId
/**
 * Brand one device-session id.
 * @param value - Raw id.
 * @returns the same string branded as a device-session id.
 */
export const DeviceSessionId = (value: string): DeviceSessionId => value as DeviceSessionId
/**
 * Brand one canonical principal id.
 * @param value - Raw id.
 * @returns the same string branded as a principal id.
 */
export const DevicePrincipalId = (value: string): DevicePrincipalId => value as DevicePrincipalId

/** Stable identity asserted and verified by an enrollment provider. */
export interface VerifiedDevicePrincipal {
  readonly id: DevicePrincipalId
  readonly issuer: string
  readonly subject: string
  readonly email: string
}

/** Secret-free device projection safe for diagnostics and list APIs. */
export interface DeviceView {
  readonly id: DeviceId
  readonly principal: VerifiedDevicePrincipal
  readonly label: string
  readonly createdAt: number
  readonly updatedAt: number
  readonly revokedAt?: number
  readonly session?: { readonly id: DeviceSessionId; readonly expiresAt: number }
}

/** Credentials returned only at issuance. */
export interface DeviceAuthIssueResult {
  readonly device: DeviceView
  readonly deviceToken: string
  readonly session: DeviceSessionCredential
}

/** Permanent credential returned only when a device token is rotated. */
export interface DeviceTokenRotationResult {
  readonly device: DeviceView
  readonly deviceToken: string
}

/** Fresh login result; the supplied permanent token is never reflected. */
export interface DeviceLoginResult {
  readonly device: DeviceView
  readonly session: DeviceSessionCredential
}

/** Browser-session secret returned only on enrollment or login. */
export interface DeviceSessionCredential {
  readonly deviceId: DeviceId
  readonly id: DeviceSessionId
  readonly secret: string
  readonly expiresAt: number
}

/** Successful browser-session authentication and renewal state. */
export interface DeviceAuthentication {
  readonly device: DeviceView
  readonly renewSession: boolean
  readonly expiresAt: number
}

/** Authentication behavior selected explicitly by each carrier. */
export interface DeviceAuthenticateOptions {
  /** Whether this request may extend the durable idle deadline. */
  readonly renew: boolean
}

/** Stable machine-readable failure codes. */
export type DeviceAuthErrorCode =
  | 'invalid-config' | 'invalid-label' | 'invalid-token' | 'invalid-session'
  | 'device-revoked' | 'device-not-found' | 'service-closing' | 'invalid-principal'
