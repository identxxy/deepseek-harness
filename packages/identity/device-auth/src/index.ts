/** Long-lived device authentication Service Definition. @module @deepseek-ai/dsh-device-auth */

import { Context, Service } from '@deepseek-ai/cordis'
import { createHash } from 'node:crypto'
import { DevicePrincipalId } from './types.ts'
import type { DeviceAuthenticateOptions, DeviceAuthIssueResult, DeviceAuthentication, DeviceId, DeviceLoginResult, DeviceSessionId, DeviceTokenRotationResult, DeviceView, VerifiedDevicePrincipal } from './types.ts'

export * from './types.ts'

/**
 * Canonicalize a verified identity and derive its stable id from issuer plus subject.
 * @param principal - Identity assertion fields before canonicalization.
 * @returns canonical identity whose id excludes email.
 */
export function canonicalDevicePrincipal(principal: Omit<VerifiedDevicePrincipal, 'id'>): VerifiedDevicePrincipal {
  const subject = principal.subject
  const email = principal.email.trim()
  const issuer = principal.issuer
  try {
    if (issuer.trim() !== issuer || issuer === '') throw new Error('issuer whitespace is not identity')
    const url = new URL(issuer)
    if (url.search !== '' || url.hash !== '') throw new Error('query and fragment are not identity')
  } catch {
    throw new DeviceAuthError('invalid-principal', 'verified principal requires an absolute issuer URL')
  }
  if (subject.trim() === '' || email === '' || !email.includes('@')) {
    throw new DeviceAuthError('invalid-principal', 'verified principal requires non-empty subject and email')
  }
  const identityTuple = JSON.stringify([issuer, subject])
  const id = DevicePrincipalId(createHash('sha256').update(identityTuple).digest('base64url'))
  return { id, issuer, subject, email }
}

/** Stable device-authentication failure without credential-bearing diagnostics. */
export class DeviceAuthError extends Error {
  /** @param code - Stable machine-readable code. @param message - Secret-free diagnostic. */
  constructor(readonly code: import('./types.ts').DeviceAuthErrorCode, message: string) {
    super(message)
    this.name = 'DeviceAuthError'
  }
}

declare module '@deepseek-ai/cordis' {
  interface Context { deviceAuth: DeviceAuthService }
  interface Events {
    /**
     * A durably removed or replaced active browser session.
     * @param deviceId - Owning device.
     * @param sessionId - Session that can no longer authenticate.
     * @mode emit
     */
    'device-auth/session-invalidated'(deviceId: DeviceId, sessionId: DeviceSessionId): void
  }
}

/** Abstract durable device-authentication service. */
export abstract class DeviceAuthService extends Service {
  constructor(ctx: Context) {
    if (new.target === DeviceAuthService) throw new Error('@deepseek-ai/dsh-device-auth requires a provider')
    super(ctx, 'deviceAuth')
  }

  /**
   * Enroll a new device under an identity already verified by the caller.
   * @param principal - Verified enrollment identity.
   * @param label - Human device label.
   * @returns newly issued permanent token and browser session.
   */
  abstract enroll(principal: Omit<VerifiedDevicePrincipal, 'id'>, label: string): Promise<DeviceAuthIssueResult>
  /**
   * Exchange a permanent recovery credential for a fresh browser session.
   * @param deviceToken - Permanent recovery credential.
   * @returns a fresh browser session replacing any active session.
   */
  abstract login(deviceToken: string): Promise<DeviceLoginResult>
  /**
   * Authenticate one active browser session and optionally apply rolling renewal when due.
   * @param deviceId - Owning device id.
   * @param sessionId - Browser session id.
   * @param secret - Browser session secret.
   * @param options - Explicit carrier renewal policy.
   * @returns authentication and rolling-renewal decision.
   */
  abstract authenticate(
    deviceId: DeviceId, sessionId: DeviceSessionId, secret: string, options: DeviceAuthenticateOptions,
  ): Promise<DeviceAuthentication>
  /**
   * Durably remove an authenticated browser session.
   * @param deviceId - Owning device id.
   * @param sessionId - Browser session id.
   * @param secret - Browser session secret.
   * @returns after durable invalidation.
   */
  abstract logout(deviceId: DeviceId, sessionId: DeviceSessionId, secret: string): Promise<void>
  /**
   * List the durable device registry without credential material.
   * @returns every device as a secret-free projection.
   */
  abstract listDevices(): readonly DeviceView[]
  /**
   * Revoke a device credential and its active browser session.
   * @param deviceId - Device to revoke.
   * @returns after durable revocation.
   */
  abstract revokeDevice(deviceId: DeviceId): Promise<void>
  /**
   * Replace a device's permanent credential and remove its active browser session.
   * @param deviceId - Device whose permanent token is replaced.
   * @returns the secret-free device view and newly issued one-time-visible token.
   */
  abstract rotateDeviceToken(deviceId: DeviceId): Promise<DeviceTokenRotationResult>
}

export default DeviceAuthService
