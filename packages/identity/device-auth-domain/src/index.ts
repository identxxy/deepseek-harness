/** Storage-domain durable device-authentication provider. @module @deepseek-ai/dsh-device-auth-domain */
import { randomBytes, scrypt as scryptCallback, timingSafeEqual, createHash } from 'node:crypto'
import { Context, Service } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import DeviceAuthService, { canonicalDevicePrincipal, DeviceAuthError, DeviceId, DeviceSessionId } from '@deepseek-ai/dsh-device-auth'
import type { DeviceAuthenticateOptions, DeviceAuthentication, DeviceAuthIssueResult, DeviceLoginResult, DeviceSessionCredential, DeviceSessionId as SessionId, DeviceTokenRotationResult, DeviceView, VerifiedDevicePrincipal } from '@deepseek-ai/dsh-device-auth'
import { DomainError } from '@deepseek-ai/dsh-storage-domain'
import type { KvTable } from '@deepseek-ai/dsh-storage-domain'
import { deviceAuthDomainSpec } from './spec.ts'
import type { DeviceAuthRecord } from './spec.ts'

export { deviceAuthDomainSpec, deviceAuthRecord } from './spec.ts'
export type { DeviceAuthRecord } from './spec.ts'

const TOKEN_VERSION = 'dshd1'
const SECRET_BYTES = 32
const SALT_BYTES = 16
const SCRYPT_KEY_BYTES = 32
const SCRYPT_OPTIONS = Object.freeze({ N: 16384, r: 8, p: 1, maxmem: 64 * 1024 * 1024 })
const SECRET_PATTERN = /^[A-Za-z0-9_-]{43}$/
const isSecret32 = (value: string): boolean => {
  if (!SECRET_PATTERN.test(value)) return false
  const decoded = Buffer.from(value, 'base64url')
  return decoded.length === SECRET_BYTES && decoded.toString('base64url') === value
}

/** Deployment-varying browser-session and label limits. */
export interface Config {
  /** Browser-session idle lifetime in milliseconds. */
  sessionIdleMs: number
  /** Remaining lifetime at or below which authentication extends the same session. */
  sessionRenewBeforeMs: number
  /** Maximum UTF-8 byte length accepted for a device label. */
  maxLabelBytes: number
}
/** Plugin config schema. */
export const Config: z<Config> = z.object({
  sessionIdleMs: z.number().step(1).min(1).default(30 * 24 * 60 * 60 * 1000),
  sessionRenewBeforeMs: z.number().step(1).min(1).default(7 * 24 * 60 * 60 * 1000),
  maxLabelBytes: z.number().step(1).min(1).default(256),
})

interface RuntimeDependencies { now(): number; randomBytes(size: number): Buffer }
const productionDependencies: RuntimeDependencies = { now: () => Date.now(), randomBytes }

/**
 * Validate deployment tunables including the cross-field renewal interval rule.
 * @param config - Parsed plugin configuration.
 * @returns the validated configuration.
 */
export function resolveConfig(config: Config): Config {
  if (!Number.isSafeInteger(config.sessionIdleMs) || !Number.isSafeInteger(config.sessionRenewBeforeMs)
    || !Number.isSafeInteger(config.maxLabelBytes) || config.sessionRenewBeforeMs <= 0
    || config.sessionIdleMs <= config.sessionRenewBeforeMs || config.maxLabelBytes <= 0) {
    throw new DeviceAuthError('invalid-config', 'device-auth config requires positive integers and sessionRenewBeforeMs < sessionIdleMs')
  }
  return config
}

/** Durable provider; one DSH home permits only one live writer for this domain. */
export class DeviceAuthDomain extends DeviceAuthService {
  static inject = ['storageDomain']
  private table: KvTable<DeviceId, DeviceAuthRecord> | undefined
  private tail: Promise<void> = Promise.resolve()
  private closing = false
  private readonly config: Config

  constructor(ctx: Context, config: Config, private readonly dependencies: RuntimeDependencies = productionDependencies) {
    super(ctx)
    this.config = resolveConfig(config)
  }

  protected async [Service.init](): Promise<void> {
    const domain = await this.ctx.storageDomain.open(deviceAuthDomainSpec)
    try {
      this.table = domain.table('devices')
      for (const [id, record] of this.table.entries()) {
        if (!isSecret32(id) || Buffer.byteLength(record.label) > this.config.maxLabelBytes) {
          throw new DomainError('invalid-record', `domain 'device_auth': stored record '${id}' has an invalid key or label`, {
            detail: { table: 'devices', key: id },
          })
        }
      }
    } catch (error) {
      this.table = undefined
      await domain.close()
      throw error
    }
    this.ctx.effect(() => async () => {
      this.closing = true
      await this.tail
      this.table = undefined
      await domain.close()
    }, 'deviceAuth.domainClose')
  }

  enroll(principal: Omit<VerifiedDevicePrincipal, 'id'>, label: string): Promise<DeviceAuthIssueResult> {
    return this.enqueue(async () => {
      this.validateLabel(label)
      const canonicalPrincipal = canonicalDevicePrincipal(principal)
      const id = DeviceId(this.randomSecret())
      const credential = this.randomSecret()
      const salt = this.dependencies.randomBytes(SALT_BYTES)
      const now = this.dependencies.now()
      const session = this.newSession(id, now)
      const record: DeviceAuthRecord = {
        principal: canonicalPrincipal, label, credentialSalt: salt.toString('base64url'),
        credentialHash: await this.deriveCredential(credential, salt),
        session: this.storedSession(session), createdAt: now, updatedAt: now,
      }
      await this.requireTable().put(id, record)
      return this.issue(id, record, credential, session)
    })
  }

  login(deviceToken: string): Promise<DeviceLoginResult> {
    return this.enqueue(async () => {
      const { id, secret } = this.parseToken(deviceToken)
      const record = this.activeRecord(id)
      if (!await this.matchesCredential(record, secret)) throw this.invalidToken()
      const now = this.dependencies.now()
      const session = this.newSession(id, now)
      const next = { ...record, session: this.storedSession(session), updatedAt: now }
      await this.requireTable().put(id, next)
      this.emitInvalidated(id, record.session?.id)
      return { device: this.view(id, next), session }
    })
  }

  authenticate(
    deviceId: DeviceId, sessionId: SessionId, secret: string, options: DeviceAuthenticateOptions,
  ): Promise<DeviceAuthentication> {
    return this.enqueue(async () => {
      const found = this.findSession(deviceId, sessionId, secret)
      const now = this.dependencies.now()
      if (found.session.expiresAt <= now) throw new DeviceAuthError('invalid-session', 'browser session is invalid')
      const renewSession = options.renew && found.session.expiresAt - now <= this.config.sessionRenewBeforeMs
      let record = found.record
      if (renewSession) {
        record = { ...record, session: { ...found.session, expiresAt: now + this.config.sessionIdleMs }, updatedAt: now }
        await this.requireTable().put(found.id, record)
      }
      const expiresAt = renewSession ? now + this.config.sessionIdleMs : found.session.expiresAt
      return { device: this.view(found.id, record), renewSession, expiresAt }
    })
  }

  logout(deviceId: DeviceId, sessionId: SessionId, secret: string): Promise<void> {
    return this.enqueue(async () => {
      const found = this.findSession(deviceId, sessionId, secret)
      const old = found.session.id
      const { session: _session, ...withoutSession } = found.record
      await this.requireTable().put(found.id, { ...withoutSession, updatedAt: this.dependencies.now() })
      this.emitInvalidated(found.id, old)
    })
  }

  listDevices(): readonly DeviceView[] {
    return [...this.requireTable().entries()].map(([id, record]) => this.view(id, record))
  }

  revokeDevice(deviceId: DeviceId): Promise<void> {
    return this.enqueue(async () => {
      const record = this.requireTable().get(deviceId)
      if (record === undefined) throw new DeviceAuthError('device-not-found', 'device was not found')
      if (record.revokedAt !== undefined) return
      const now = this.dependencies.now()
      const next = { ...record, revokedAt: now, updatedAt: now, session: undefined }
      await this.requireTable().put(deviceId, next)
      this.emitInvalidated(deviceId, record.session?.id)
    })
  }

  rotateDeviceToken(deviceId: DeviceId): Promise<DeviceTokenRotationResult> {
    return this.enqueue(async () => {
      const record = this.activeRecord(deviceId)
      const credential = this.randomSecret()
      const salt = this.dependencies.randomBytes(SALT_BYTES)
      const now = this.dependencies.now()
      const { session: _session, ...withoutSession } = record
      const next = { ...withoutSession, credentialSalt: salt.toString('base64url'), credentialHash: await this.deriveCredential(credential, salt), updatedAt: now }
      await this.requireTable().put(deviceId, next)
      this.emitInvalidated(deviceId, record.session?.id)
      return { device: this.view(deviceId, next), deviceToken: `${TOKEN_VERSION}.${deviceId}.${credential}` }
    })
  }

  private enqueue<T>(operation: () => Promise<T>): Promise<T> {
    if (this.closing) return Promise.reject(new DeviceAuthError('service-closing', 'device-auth service is closing'))
    const result = this.tail.then(operation)
    this.tail = result.then(() => {}, () => {})
    return result
  }
  private requireTable(): KvTable<DeviceId, DeviceAuthRecord> {
    if (this.table === undefined) throw new Error('device-auth domain is not initialized')
    return this.table
  }
  private activeRecord(id: DeviceId): DeviceAuthRecord {
    const record = this.requireTable().get(id)
    if (record === undefined) throw this.invalidToken()
    if (record.revokedAt !== undefined) throw new DeviceAuthError('device-revoked', 'device is revoked')
    return record
  }
  private validateLabel(label: string): void {
    if (label.length === 0 || Buffer.byteLength(label) > this.config.maxLabelBytes) throw new DeviceAuthError('invalid-label', 'device label is empty or too long')
  }
  private randomSecret(): string { return this.dependencies.randomBytes(SECRET_BYTES).toString('base64url') }
  private newSession(deviceId: DeviceId, now: number): DeviceSessionCredential {
    return { deviceId, id: DeviceSessionId(this.randomSecret()), secret: this.randomSecret(), expiresAt: now + this.config.sessionIdleMs }
  }
  private storedSession(session: DeviceSessionCredential): NonNullable<DeviceAuthRecord['session']> {
    return { id: session.id, hash: this.fastHash(session.secret), expiresAt: session.expiresAt }
  }
  private issue(id: DeviceId, record: DeviceAuthRecord, secret: string, session: DeviceSessionCredential): DeviceAuthIssueResult {
    return { device: this.view(id, record), deviceToken: `${TOKEN_VERSION}.${id}.${secret}`, session }
  }
  private view(id: DeviceId, record: DeviceAuthRecord): DeviceView {
    return { id, principal: { ...record.principal }, label: record.label, createdAt: record.createdAt, updatedAt: record.updatedAt,
      ...(record.revokedAt === undefined ? {} : { revokedAt: record.revokedAt }),
      ...(record.session === undefined ? {} : { session: { id: record.session.id, expiresAt: record.session.expiresAt } }) }
  }
  private parseToken(token: string): { id: DeviceId; secret: string } {
    const [version, rawId, secret, extra] = token.split('.')
    if (version !== TOKEN_VERSION || rawId === undefined || !isSecret32(rawId)
      || secret === undefined || !isSecret32(secret) || extra !== undefined) throw this.invalidToken()
    return { id: DeviceId(rawId), secret }
  }
  private invalidToken(): DeviceAuthError { return new DeviceAuthError('invalid-token', 'device token is invalid') }
  private async deriveCredential(secret: string, salt: Buffer): Promise<string> {
    const key = await new Promise<Buffer>((resolve, reject) => {
      scryptCallback(secret, salt, SCRYPT_KEY_BYTES, SCRYPT_OPTIONS, (error, derived) => {
        /* v8 ignore next -- fixed valid scrypt parameters only fail for an unrecoverable Node runtime allocation fault. */
        if (error !== null) reject(error)
        else resolve(derived)
      })
    })
    return key.toString('base64url')
  }
  private async matchesCredential(record: DeviceAuthRecord, secret: string): Promise<boolean> {
    const actual = Buffer.from(await this.deriveCredential(secret, Buffer.from(record.credentialSalt, 'base64url')), 'base64url')
    const expected = Buffer.from(record.credentialHash, 'base64url')
    return actual.length === expected.length && timingSafeEqual(actual, expected)
  }
  private fastHash(secret: string): string { return createHash('sha256').update(secret).digest('base64url') }
  private findSession(deviceId: DeviceId, sessionId: SessionId, secret: string): {
    id: DeviceId
    record: DeviceAuthRecord
    session: NonNullable<DeviceAuthRecord['session']>
  } {
    if (!isSecret32(deviceId) || !isSecret32(sessionId) || !isSecret32(secret)) {
      throw new DeviceAuthError('invalid-session', 'browser session is invalid')
    }
    const record = this.requireTable().get(deviceId)
    if (record === undefined || record.revokedAt !== undefined || record.session?.id !== sessionId) {
      throw new DeviceAuthError('invalid-session', 'browser session is invalid')
    }
    const actual = Buffer.from(this.fastHash(secret), 'base64url')
    const expected = Buffer.from(record.session.hash, 'base64url')
    if (actual.length === expected.length && timingSafeEqual(actual, expected)) {
      return { id: deviceId, record, session: record.session }
    }
    throw new DeviceAuthError('invalid-session', 'browser session is invalid')
  }
  private emitInvalidated(deviceId: DeviceId, sessionId: DeviceSessionId | undefined): void {
    if (sessionId === undefined) return
    try { this.ctx.emit('device-auth/session-invalidated', deviceId, sessionId) }
    catch (error) { this.ctx.logger.warn(`device-auth invalidation observer failed: ${String(error)}`) }
  }
}

export default DeviceAuthDomain
