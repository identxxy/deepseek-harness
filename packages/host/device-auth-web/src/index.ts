/** Device-authenticated HTTP ingress, enrollment, and login. @module @deepseek-ai/dsh-host-device-auth-web */
import type { IncomingMessage, ServerResponse } from 'node:http'
import type { Duplex } from 'node:stream'
import type { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import { parse as parseCookies, serialize as serializeCookie } from 'cookie'
import { createRemoteJWKSet, customFetch, jwtVerify } from 'jose'
import { DeviceAuthError, DeviceId, DeviceSessionId } from '@deepseek-ai/dsh-device-auth'
import type { DeviceAuthentication, DeviceSessionCredential, VerifiedDevicePrincipal } from '@deepseek-ai/dsh-device-auth'
import type { WebIngressDecision } from '@deepseek-ai/dsh-host-webserver'

export const name = 'device-auth-web'
export const inject = ['webServer', 'deviceAuth']

const COOKIE = '__Host-dsh_device_session'
const COOKIE_VERSION = 'dshs1'
const SECRET = /^[A-Za-z0-9_-]{43}$/
const MAX_TIMER_MS = 2_147_483_647
const SECURITY_HEADERS = Object.freeze({
  'cache-control': 'no-store',
  'content-security-policy': "default-src 'none'; form-action 'self'; base-uri 'none'; frame-ancestors 'none'",
  'referrer-policy': 'no-referrer',
  'x-content-type-options': 'nosniff',
})
const FORM_HEADERS = Object.freeze({ 'referrer-policy': 'same-origin' })

/** Deployment-specific public origin, enrollment identity, and request limits. */
export interface Config {
  /** Exact public HTTPS origin protected by this plugin. */
  publicOrigin: string
  /** Exact Cloudflare Access HTTPS issuer origin. */
  accessIssuer: string
  /** Cloudflare Access application audience claim. */
  accessAudience: string
  /** Exact email claim permitted to enroll devices. */
  accessEmail: string
  /** JWT timestamp tolerance in seconds. */
  accessClockToleranceSeconds: number
  /** Maximum URL-encoded form body size in bytes. */
  maxFormBytes: number
}

export const Config: z<Config> = z.object({
  publicOrigin: z.string().required(), accessIssuer: z.string().required(), accessAudience: z.string().required(),
  accessEmail: z.string().required(), accessClockToleranceSeconds: z.natural().required(), maxFormBytes: z.natural().required(),
})

interface Dependencies {
  fetch?: typeof fetch
  now(): number
  setTimer(callback: () => void, delay: number): NodeJS.Timeout
  clearTimer(timer: NodeJS.Timeout): void
}
const productionDependencies: Dependencies = {
  now: Date.now,
  setTimer: (callback, delay) => setTimeout(callback, delay),
  clearTimer: clearTimeout,
}

interface ResolvedConfig extends Config { public: URL; issuer: URL }

/**
 * Validate exact HTTPS origins and bounded scalar configuration.
 * @param config - Parsed plugin configuration.
 * @returns validated configuration with parsed origins.
 */
export function resolveConfig(config: Config): ResolvedConfig {
  const exactHttpsOrigin = (value: string, field: string): URL => {
    let url: URL
    try { url = new URL(value) } catch { throw new Error(`device-auth-web: ${field} must be an exact HTTPS origin`) }
    if (url.protocol !== 'https:' || url.origin !== value || url.pathname !== '/' || url.username !== '' || url.password !== '') {
      throw new Error(`device-auth-web: ${field} must be an exact HTTPS origin`)
    }
    return url
  }
  if (config.accessAudience.trim() === '' || config.accessEmail.trim() !== config.accessEmail || !config.accessEmail.includes('@')
    || !Number.isSafeInteger(config.accessClockToleranceSeconds) || !Number.isSafeInteger(config.maxFormBytes)
    || config.accessClockToleranceSeconds < 0 || config.maxFormBytes < 1) throw new Error('device-auth-web: invalid required scalar config')
  return {
    publicOrigin: config.publicOrigin,
    accessIssuer: config.accessIssuer,
    accessAudience: config.accessAudience,
    accessEmail: config.accessEmail,
    accessClockToleranceSeconds: config.accessClockToleranceSeconds,
    maxFormBytes: config.maxFormBytes,
    public: exactHttpsOrigin(config.publicOrigin, 'publicOrigin'),
    issuer: exactHttpsOrigin(config.accessIssuer, 'accessIssuer'),
  }
}

type AccessVerifier = (assertion: string | undefined) => Promise<Omit<VerifiedDevicePrincipal, 'id'>>

/**
 * Create a verifier for the only accepted Cloudflare Access assertion header.
 * @param config - Validated issuer and claim policy.
 * @param dependencies - Optional network implementation for deterministic tests.
 * @returns assertion verifier with secret-free errors.
 */
export function createAccessVerifier(
  config: ResolvedConfig, dependencies: Pick<Dependencies, 'fetch'> = {},
): AccessVerifier {
  const jwks = createRemoteJWKSet(new URL('/cdn-cgi/access/certs', config.issuer), dependencies.fetch === undefined ? {} : { [customFetch]: dependencies.fetch })
  return async (assertion: string | undefined): Promise<Omit<VerifiedDevicePrincipal, 'id'>> => {
    if (assertion === undefined || assertion === '') throw new Error('enrollment assertion is missing')
    try {
      const { payload } = await jwtVerify(assertion, jwks, {
        algorithms: ['RS256'], issuer: config.accessIssuer, audience: config.accessAudience,
        clockTolerance: config.accessClockToleranceSeconds, requiredClaims: ['exp'],
      })
      if (typeof payload.sub !== 'string' || payload.sub.trim() === '' || payload.email !== config.accessEmail) throw new Error('invalid claims')
      return { issuer: config.accessIssuer, subject: payload.sub, email: config.accessEmail }
    } catch { throw new Error('enrollment assertion is invalid') }
  }
}

/**
 * Classify the local bypass without trusting proxy headers.
 * @param remoteAddress - TCP peer address.
 * @param host - HTTP Host authority.
 * @returns true only when both values identify loopback.
 */
export function isLocalBypass(remoteAddress: string | undefined, host: string | undefined): boolean {
  const peer = remoteAddress === '127.0.0.1' || remoteAddress === '::1' || remoteAddress === '::ffff:127.0.0.1'
  if (!peer || host === undefined) return false
  let hostname: string
  try { hostname = new URL(`http://${host}`).hostname } catch { return false }
  return hostname === 'localhost' || hostname === '127.0.0.1' || hostname === '[::1]'
}

function canonicalSecret(value: string): boolean {
  return SECRET.test(value) && Buffer.from(value, 'base64url').length === 32 && Buffer.from(value, 'base64url').toString('base64url') === value
}

/**
 * Parse the strict versioned session cookie and reject duplicate cookie names.
 * @param header - Raw Cookie header.
 * @returns parsed credential or undefined for any noncanonical input.
 */
export function parseSessionCookie(header: string | undefined): DeviceSessionCredential | undefined {
  if (header === undefined) return undefined
  const occurrences = header.split(';').map(item => item.trim().split('=', 1)[0]).filter(key => key === COOKIE).length
  if (occurrences !== 1) return undefined
  const value = parseCookies(header)[COOKIE]
  if (value === undefined) return undefined
  const [version, deviceId, id, secret, extra] = value.split('.')
  if (version !== COOKIE_VERSION || deviceId === undefined || id === undefined || secret === undefined || extra !== undefined
    || !canonicalSecret(deviceId) || !canonicalSecret(id) || !canonicalSecret(secret)) return undefined
  return { deviceId: DeviceId(deviceId), id: DeviceSessionId(id), secret, expiresAt: 0 }
}

function sessionCookie(session: DeviceSessionCredential, now: number): string {
  const value = `${COOKIE_VERSION}.${session.deviceId}.${session.id}.${session.secret}`
  return serializeCookie(COOKIE, value, { secure: true, httpOnly: true, sameSite: 'strict', path: '/', expires: new Date(session.expiresAt), maxAge: Math.max(0, Math.floor((session.expiresAt - now) / 1000)) })
}

function clearCookie(): string {
  return serializeCookie(COOKIE, '', { secure: true, httpOnly: true, sameSite: 'strict', path: '/', expires: new Date(0), maxAge: 0 })
}

function send(res: ServerResponse, status: number, body = '', headers: Record<string, string> = {}): void {
  res.writeHead(status, { ...SECURITY_HEADERS, ...(body === '' ? {} : { 'content-type': 'text/html; charset=utf-8' }), ...headers })
  res.end(body)
}

function rejectUpgrade(socket: Duplex, status: 401 | 403): void {
  const response = `HTTP/1.1 ${String(status)} ${status === 401 ? 'Unauthorized' : 'Forbidden'}\r\nCache-Control: no-store\r\nConnection: close\r\nContent-Length: 0\r\n\r\n`
  socket.end(response, () => socket.destroy())
}

async function readForm(req: IncomingMessage, maxBytes: number): Promise<URLSearchParams> {
  if (req.headers['content-type'] !== 'application/x-www-form-urlencoded') throw new Error('invalid form content type')
  const chunks: Buffer[] = []; let bytes = 0
  for await (const chunk of req) {
    /* v8 ignore next -- node:http IncomingMessage delivers Buffer chunks when no text encoding is installed. */
    if (!Buffer.isBuffer(chunk)) throw new Error('form body contains a non-buffer chunk')
    const buffer = Buffer.from(chunk)
    bytes += buffer.length
    if (bytes > maxBytes) throw new Error('form body exceeds configured limit')
    chunks.push(buffer)
  }
  return new URLSearchParams(Buffer.concat(chunks).toString('utf8'))
}

function one(form: URLSearchParams, field: string): string {
  const values = form.getAll(field)
  const value = values[0]
  if (values.length !== 1 || value === undefined || value === '') throw new Error(`invalid ${field}`)
  return value
}

function page(title: string, content: string): string {
  return `<!doctype html><html><head><meta charset="utf-8"><title>${title}</title></head><body><main><h1>${title}</h1>${content}</main></body></html>`
}

function escapeHtml(value: string): string {
  return value.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;').replaceAll('"', '&quot;').replaceAll("'", '&#39;')
}

interface TrackedSocket { socket: Duplex; credential: DeviceSessionCredential; expiresAt: number; timer?: NodeJS.Timeout }

/** Runtime owning whole-application admission and the device authentication routes. */
export class DeviceAuthWeb {
  private readonly config: ResolvedConfig
  private readonly verifyAccess: ReturnType<typeof createAccessVerifier>
  private readonly tracked = new Set<TrackedSocket>()
  private readonly pendingSockets = new Set<Duplex>()
  private readonly pending = new Set<Promise<unknown>>()
  private closing = false

  constructor(private readonly ctx: Context, config: Config, private readonly dependencies: Dependencies = productionDependencies) {
    this.config = resolveConfig(config)
    this.verifyAccess = createAccessVerifier(this.config, dependencies)
  }

  /**
   * Claim ingress and route seats.
   * @returns asynchronous disposer that reaches socket and verifier quiescence.
   */
  start(): Promise<() => Promise<void>> {
    const releases: Array<() => void> = []
    try {
      releases.push(this.ctx.webServer.registerIngressGate({
        handleHttp: this.handleHttp.bind(this), handleUpgrade: this.handleUpgrade.bind(this),
      }))
      releases.push(this.ctx.webServer.register({
        kind: 'exact', path: '/auth/device/enroll', handler: this.enroll.bind(this),
      }))
      releases.push(this.ctx.webServer.register({
        kind: 'exact', path: '/auth/device/login', handler: this.login.bind(this),
      }))
      releases.push(this.ctx.webServer.register({
        kind: 'exact', path: '/auth/device/logout', handler: this.logout.bind(this),
      }))
      releases.push(this.ctx.webServer.register({
        kind: 'exact', path: '/auth/device/admin', handler: this.admin.bind(this),
      }))
    } catch (error) {
      for (const release of releases.reverse()) release()
      /* v8 ignore next -- WebServer registration rejects conflicts with Error instances. */
      return Promise.reject(error instanceof Error ? error : new Error(String(error)))
    }
    const off = this.ctx.on('device-auth/session-invalidated', (deviceId, sessionId) => {
      for (const tracked of this.tracked) {
        if (tracked.credential.deviceId === deviceId && tracked.credential.id === sessionId) tracked.socket.destroy()
      }
    })
    return Promise.resolve(async () => {
      this.closing = true
      for (const release of releases.reverse()) release()
      off()
      const sockets = new Set<Duplex>([
        ...[...this.tracked].map(tracked => tracked.socket), ...this.pendingSockets,
      ])
      const socketsClosed = [...sockets].map((socket) => {
        if (socket.closed) return Promise.resolve()
        return new Promise<void>((resolve) => { socket.once('close', resolve) })
      })
      for (const tracked of this.tracked) {
        if (tracked.timer !== undefined) this.dependencies.clearTimer(tracked.timer)
      }
      for (const socket of sockets) socket.destroy()
      await Promise.allSettled([...this.pending])
      await Promise.all(socketsClosed)
    })
  }

  private authority(req: IncomingMessage): 'local' | 'public' | 'invalid' {
    if (isLocalBypass(req.socket.remoteAddress, req.headers.host)) return 'local'
    return req.headers.host === this.config.public.host ? 'public' : 'invalid'
  }

  private exactOrigin(req: IncomingMessage): boolean { return req.headers.origin === this.config.publicOrigin }
  private exactFormSource(req: IncomingMessage): boolean {
    if (req.headers.origin !== undefined) return this.exactOrigin(req)
    if (req.headers.referer === undefined) return false
    try { return new URL(req.headers.referer).origin === this.config.publicOrigin } catch { return false }
  }
  private path(req: IncomingMessage): string { return new URL(req.url ?? '/', 'http://x').pathname }

  private async authenticate(
    req: IncomingMessage, renew: boolean,
  ): Promise<{ credential: DeviceSessionCredential; auth: DeviceAuthentication } | undefined> {
    const credential = parseSessionCookie(req.headers.cookie)
    if (credential === undefined) return undefined
    try {
      const auth = await this.ctx.deviceAuth.authenticate(credential.deviceId, credential.id, credential.secret, { renew })
      return this.closing ? undefined : { credential, auth }
    }
    catch (error) { if (error instanceof DeviceAuthError) return undefined; throw error }
  }

  /**
   * Authenticate one HTTP request before route matching.
   * @param req - Incoming request.
   * @param res - Response owned when the result is handled.
   * @returns ingress dispatch decision.
   */
  async handleHttp(req: IncomingMessage, res: ServerResponse): Promise<WebIngressDecision> {
    if (this.closing) { send(res, 503); return { kind: 'handled' } }
    return this.track(() => this.handleHttpActive(req, res))
  }

  private async handleHttpActive(req: IncomingMessage, res: ServerResponse): Promise<WebIngressDecision> {
    const authority = this.authority(req)
    if (authority === 'local') return { kind: 'allow' }
    if (authority === 'invalid') {
      send(res, 403)
      return { kind: 'handled' }
    }
    const pathname = this.path(req)
    if (pathname === '/auth/device/login') {
      if (req.method === 'POST' && !this.exactFormSource(req)) send(res, 403)
      else return { kind: 'allow' }
      return { kind: 'handled' }
    }
    if (pathname === '/auth/device/enroll') {
      if (req.method === 'POST' && !this.exactFormSource(req)) send(res, 403)
      else if (req.headers['cf-access-jwt-assertion'] === undefined) send(res, 403)
      else return { kind: 'allow' }
      return { kind: 'handled' }
    }
    if (req.method !== 'GET' && req.method !== 'HEAD' && !this.exactOrigin(req)) { send(res, 403); return { kind: 'handled' } }
    const authenticated = await this.authenticate(req, true)
    if (authenticated === undefined) {
      const acceptsHtml = req.method === 'GET' && req.headers.accept?.includes('text/html') === true
      if (acceptsHtml) send(res, 302, '', { location: '/auth/device/login' }); else send(res, 401)
      return { kind: 'handled' }
    }
    if (authenticated.auth.renewSession) {
      res.setHeader('set-cookie', sessionCookie({ ...authenticated.credential, expiresAt: authenticated.auth.expiresAt }, this.dependencies.now()))
    }
    return { kind: 'allow' }
  }

  /**
   * Authenticate and track one upgrade without renewing its session.
   * @param req - Incoming upgrade request.
   * @param socket - Socket to reject or track.
   * @returns ingress dispatch decision.
   */
  async handleUpgrade(req: IncomingMessage, socket: Duplex): Promise<WebIngressDecision> {
    if (this.closing) { rejectUpgrade(socket, 403); return { kind: 'handled' } }
    this.pendingSockets.add(socket)
    try { return await this.track(() => this.handleUpgradeActive(req, socket)) }
    finally { this.pendingSockets.delete(socket) }
  }

  private async handleUpgradeActive(req: IncomingMessage, socket: Duplex): Promise<WebIngressDecision> {
    const authority = this.authority(req)
    if (authority === 'local') return { kind: 'allow' }
    if (authority !== 'public' || !this.exactOrigin(req)) { rejectUpgrade(socket, 403); return { kind: 'handled' } }
    const authenticated = await this.authenticate(req, false)
    if (authenticated === undefined) {
      if (!socket.destroyed) rejectUpgrade(socket, 401)
      return { kind: 'handled' }
    }
    if (this.closing || socket.destroyed) { socket.destroy(); return { kind: 'handled' } }
    const tracked: TrackedSocket = { socket, credential: authenticated.credential, expiresAt: authenticated.auth.expiresAt }
    this.tracked.add(tracked)
    socket.once('close', () => { if (tracked.timer !== undefined) this.dependencies.clearTimer(tracked.timer); this.tracked.delete(tracked) })
    this.scheduleExpiry(tracked)
    return { kind: 'allow' }
  }

  private scheduleExpiry(tracked: TrackedSocket): void {
    if (this.closing || tracked.socket.destroyed) return
    const remaining = tracked.expiresAt - this.dependencies.now()
    tracked.timer = this.dependencies.setTimer(() => {
      if (this.dependencies.now() < tracked.expiresAt) this.scheduleExpiry(tracked)
      else void this.recheckExpiry(tracked)
    }, Math.max(0, Math.min(MAX_TIMER_MS, remaining)))
  }

  private async recheckExpiry(tracked: TrackedSocket): Promise<void> {
    const operation = this.ctx.deviceAuth.authenticate(
      tracked.credential.deviceId, tracked.credential.id, tracked.credential.secret, { renew: false },
    )
      .then((auth) => { tracked.expiresAt = auth.expiresAt; this.scheduleExpiry(tracked) })
      .catch(() => { tracked.socket.destroy() })
    this.pending.add(operation)
    await operation.finally(() => this.pending.delete(operation))
  }

  private track<T>(operation: () => Promise<T>): Promise<T> {
    const pending = operation()
    this.pending.add(pending)
    void pending.finally(() => this.pending.delete(pending)).catch(() => {})
    return pending
  }

  private async enroll(req: IncomingMessage, res: ServerResponse): Promise<void> {
    if (this.closing) { send(res, 503); return }
    await this.track(() => this.enrollActive(req, res))
  }

  private async enrollActive(req: IncomingMessage, res: ServerResponse): Promise<void> {
    let principal: Omit<VerifiedDevicePrincipal, 'id'>
    try { principal = await this.verifyAccess(req.headers['cf-access-jwt-assertion'] as string | undefined) }
    catch {
      send(res, 403)
      return
    }
    if (req.method === 'GET') { send(res, 200, page('Enroll device', '<form method="post"><label>Device label <input name="label" required></label><button>Enroll</button></form>'), FORM_HEADERS); return }
    if (req.method !== 'POST') { send(res, 405); return }
    try {
      const form = await readForm(req, this.config.maxFormBytes)
      if ([...form.keys()].some(key => key !== 'label')) throw new Error('unknown field')
      const issued = await this.ctx.deviceAuth.enroll(principal, one(form, 'label'))
      if (this.closing) { send(res, 503); return }
      res.setHeader('set-cookie', sessionCookie(issued.session, this.dependencies.now()))
      send(res, 200, page('Device enrolled', `<p>Save this token once:</p><pre>${issued.deviceToken}</pre>`))
    } catch { send(res, 400) }
  }

  private async login(req: IncomingMessage, res: ServerResponse): Promise<void> {
    if (this.closing) { send(res, 503); return }
    await this.track(() => this.loginActive(req, res))
  }

  private async loginActive(req: IncomingMessage, res: ServerResponse): Promise<void> {
    if (req.method === 'GET') { send(res, 200, page('Device login', '<form method="post"><label>Permanent token <input name="token" type="password" required></label><button>Log in</button></form>'), FORM_HEADERS); return }
    if (req.method !== 'POST') { send(res, 405); return }
    try {
      const form = await readForm(req, this.config.maxFormBytes)
      if ([...form.keys()].some(key => key !== 'token')) throw new Error('unknown field')
      const loggedIn = await this.ctx.deviceAuth.login(one(form, 'token'))
      if (this.closing) { send(res, 503); return }
      res.setHeader('set-cookie', sessionCookie(loggedIn.session, this.dependencies.now()))
      send(res, 303, '', { location: '/' })
    } catch { send(res, 401) }
  }

  private async logout(req: IncomingMessage, res: ServerResponse): Promise<void> {
    if (this.closing) { send(res, 503); return }
    await this.track(() => this.logoutActive(req, res))
  }

  private async logoutActive(req: IncomingMessage, res: ServerResponse): Promise<void> {
    if (req.method !== 'POST') { send(res, 405); return }
    const authenticated = await this.authenticate(req, false)
    if (authenticated === undefined) { send(res, 401); return }
    await this.ctx.deviceAuth.logout(authenticated.credential.deviceId, authenticated.credential.id, authenticated.credential.secret)
    if (this.closing) { send(res, 503); return }
    res.setHeader('set-cookie', clearCookie())
    send(res, 303, '', { location: '/auth/device/login' })
  }

  private async admin(req: IncomingMessage, res: ServerResponse): Promise<void> {
    if (this.closing) { send(res, 503); return }
    await this.track(() => this.adminActive(req, res))
  }

  private localFormOrigin(req: IncomingMessage): boolean {
    return req.headers.host !== undefined && req.headers.origin === `http://${req.headers.host}`
  }

  private async adminActive(req: IncomingMessage, res: ServerResponse): Promise<void> {
    if (this.authority(req) !== 'local') { send(res, 403); return }
    if (req.method === 'GET') { this.sendAdminPage(res); return }
    if (req.method !== 'POST') { send(res, 405); return }
    if (!this.localFormOrigin(req)) { send(res, 403); return }
    try {
      const form = await readForm(req, this.config.maxFormBytes)
      if ([...form.keys()].some(key => key !== 'action' && key !== 'deviceId')) throw new Error('unknown field')
      const action = one(form, 'action')
      const rawDeviceId = one(form, 'deviceId')
      if (!canonicalSecret(rawDeviceId)) throw new Error('invalid device id')
      const target = DeviceId(rawDeviceId)
      if (action === 'revoke') {
        await this.ctx.deviceAuth.revokeDevice(target)
        if (this.closing) { send(res, 503); return }
        this.sendAdminPage(res)
        return
      }
      if (action === 'rotate') {
        const issued = await this.ctx.deviceAuth.rotateDeviceToken(target)
        if (this.closing) { send(res, 503); return }
        send(res, 200, page('Device token rotated', `<p>Save this token once:</p><pre>${escapeHtml(issued.deviceToken)}</pre><p><a href="/auth/device/admin">Back to devices</a></p>`))
        return
      }
      throw new Error('invalid action')
    } catch { send(res, 400) }
  }

  private sendAdminPage(res: ServerResponse): void {
    const rows = this.ctx.deviceAuth.listDevices().map((device) => {
      const status = device.revokedAt === undefined ? 'active' : 'revoked'
      const actions = device.revokedAt === undefined
        ? `<form method="post"><input type="hidden" name="deviceId" value="${escapeHtml(device.id)}"><button name="action" value="rotate">Rotate token</button><button name="action" value="revoke">Revoke</button></form>`
        : ''
      return `<tr><td>${escapeHtml(device.label)}</td><td>${escapeHtml(device.principal.email)}</td><td>${escapeHtml(status)}</td><td>${actions}</td></tr>`
    }).join('')
    send(res, 200, page('Devices', `<table><thead><tr><th>Label</th><th>Owner</th><th>Status</th><th>Actions</th></tr></thead><tbody>${rows}</tbody></table>`))
  }
}

/** Register the sole ingress owner and the exact authentication and local administration routes. */
export async function apply(ctx: Context, config: Config): Promise<void> {
  const runtime = new DeviceAuthWeb(ctx, config)
  const dispose = await runtime.start()
  ctx.effect(() => dispose, 'deviceAuthWeb.runtime')
}
