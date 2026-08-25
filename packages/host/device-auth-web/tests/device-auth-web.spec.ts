import { generateKeyPair, exportJWK, SignJWT } from 'jose'
import { request as httpRequest } from 'node:http'
import { connect } from 'node:net'
import { PassThrough } from 'node:stream'
import { readFileSync } from 'node:fs'
import type { IncomingMessage } from 'node:http'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { Context } from '@deepseek-ai/cordis'
import Loader from '@deepseek-ai/cordis-plugin-loader'
import Include, { entryListSchema } from '@deepseek-ai/cordis-plugin-include'
import DeviceAuthService, { DeviceAuthError, DeviceId, DevicePrincipalId, DeviceSessionId } from '@deepseek-ai/dsh-device-auth'
import type {
  DeviceAuthenticateOptions, DeviceAuthIssueResult, DeviceAuthentication, DeviceLoginResult, DeviceSessionCredential,
  DeviceTokenRotationResult, DeviceView, VerifiedDevicePrincipal,
} from '@deepseek-ai/dsh-device-auth'
import WebServer from '@deepseek-ai/dsh-host-webserver'
import { afterEach, describe, expect, it, vi } from 'vitest'
import * as yaml from 'js-yaml'
import * as DeviceAuthWebModule from '../src/index.ts'
import { createAccessVerifier, DeviceAuthWeb, isLocalBypass, parseSessionCookie, resolveConfig } from '../src/index.ts'

const secret = (character: string): string => Buffer.alloc(32, character).toString('base64url')
const deviceId = DeviceId(secret('d'))
const sessionId = DeviceSessionId(secret('s'))
const sessionSecret = secret('x')
const MAX_TIMER_MS = 2_147_483_647
const principal: VerifiedDevicePrincipal = {
  id: DevicePrincipalId(secret('p')), issuer: 'https://access.example', subject: 'owner', email: 'owner@example.com',
}
const device: DeviceView = { id: deviceId, principal, label: 'phone', createdAt: 1, updatedAt: 1 }
const credential: DeviceSessionCredential = { deviceId, id: sessionId, secret: sessionSecret, expiresAt: 1_900_000_000_000 }
const config = {
  publicOrigin: 'https://dsh.example', accessIssuer: 'https://access.example', accessAudience: 'audience',
  accessEmail: 'owner@example.com', accessClockToleranceSeconds: 2, maxFormBytes: 256,
}

describe('device auth Profile Bundle', () => {
  it('declares exactly the provider and Consumer rows without deployment values', () => {
    const root = fileURLToPath(new URL('..', import.meta.url))
    const manifest = JSON.parse(readFileSync(resolve(root, 'package.json'), 'utf8')) as {
      dependencies?: Record<string, string>
      peerDependencies?: Record<string, string>
      dsh?: { bundle?: { patch?: string } }
      exports?: Record<string, unknown>
      files?: string[]
    }
    expect(manifest.dsh?.bundle?.patch).toBe('./cordis.patch.yml')
    expect(manifest.exports).toHaveProperty('./cordis.patch.yml')
    expect(manifest.exports).toHaveProperty('./provider')
    expect(manifest.files).toContain('cordis.patch.yml')
    expect(manifest.files).toContain('lib/provider.js')
    expect(manifest.dependencies).toHaveProperty('@deepseek-ai/dsh-device-auth')
    expect(manifest.dependencies).toHaveProperty('@deepseek-ai/dsh-device-auth-domain')
    for (const peer of [
      '@deepseek-ai/cordis', '@deepseek-ai/dsh-host-webserver',
      '@deepseek-ai/dsh-invariants', '@deepseek-ai/dsh-storage-domain',
    ]) expect(manifest.peerDependencies).toHaveProperty(peer)

    const patchSource = readFileSync(resolve(root, manifest.dsh!.bundle!.patch!), 'utf8')
    const parsed = yaml.load(patchSource, { schema: entryListSchema })
    if (!Array.isArray(parsed)) throw new TypeError('device-auth-web patch must parse to a patch list')
    const rows = parsed.flatMap((patch): Record<string, unknown>[] =>
      typeof patch === 'object' && patch !== null
        ? (patch as { insert?: Record<string, unknown>[] }).insert ?? []
        : [],
    )
    expect(rows).toEqual([
      {
        id: 'device-auth-domain',
        name: '@deepseek-ai/dsh-host-device-auth-web/provider',
        config: {
          sessionIdleMs: 31_536_000_000,
          sessionRenewBeforeMs: 2_592_000_000,
          maxLabelBytes: 256,
        },
      },
      { id: 'device-auth-web', name: '@deepseek-ai/dsh-host-device-auth-web' },
    ])
    for (const privateKey of [
      'publicOrigin', 'accessIssuer', 'accessAudience', 'accessEmail',
      'accessClockToleranceSeconds', 'maxFormBytes',
    ]) expect(patchSource).not.toContain(privateKey)
  })
})

class HeldCloseDuplex extends PassThrough {
  private closeCallback: ((error?: Error | null) => void) | undefined
  override _destroy(_error: Error | null, callback: (error?: Error | null) => void): void {
    this.closeCallback = callback
  }
  releaseClose(): void { this.closeCallback?.() }
}

class FakeAuth extends DeviceAuthService {
  sessions = new Map<string, DeviceSessionCredential>([[sessionId, credential]])
  devices: DeviceView[] = [device]
  revoked: typeof deviceId[] = []
  rotated: typeof deviceId[] = []
  renewCalls: boolean[] = []
  authGate?: Promise<void>
  expiresAt = credential.expiresAt
  renewTo?: number
  enroll(identity: Omit<VerifiedDevicePrincipal, 'id'>, label: string): Promise<DeviceAuthIssueResult> {
    return Promise.resolve({
      device: { ...device, label, principal: { ...principal, ...identity } },
      deviceToken: `dshd1.${deviceId}.${secret('t')}`, session: credential,
    })
  }
  login(token: string): Promise<DeviceLoginResult> {
    if (!token.startsWith('dshd1.')) return Promise.reject(new DeviceAuthError('invalid-token', 'device token is invalid'))
    return Promise.resolve({ device, session: credential })
  }
  async authenticate(
    id: typeof deviceId, sid: typeof sessionId, supplied: string, options: DeviceAuthenticateOptions,
  ): Promise<DeviceAuthentication> {
    this.renewCalls.push(options.renew)
    await this.authGate
    if (id !== deviceId || sid !== sessionId || supplied !== sessionSecret || !this.sessions.has(sid)) return Promise.reject(new DeviceAuthError('invalid-session', 'browser session is invalid'))
    if (Date.now() >= this.expiresAt) throw new DeviceAuthError('invalid-session', 'browser session is invalid')
    if (options.renew && this.renewTo !== undefined) this.expiresAt = this.renewTo
    return { device, renewSession: options.renew, expiresAt: this.expiresAt }
  }
  logout(_id: typeof deviceId, sid: typeof sessionId): Promise<void> { this.sessions.delete(sid); this.ctx.emit('device-auth/session-invalidated', deviceId, sid); return Promise.resolve() }
  listDevices(): readonly DeviceView[] { return this.devices }
  revokeDevice(id: typeof deviceId): Promise<void> { this.revoked.push(id); return Promise.resolve() }
  async rotateDeviceToken(id: typeof deviceId): Promise<DeviceTokenRotationResult> {
    this.rotated.push(id)
    const issued = await this.enroll(principal, device.label)
    return { device: issued.device, deviceToken: issued.deviceToken }
  }
}

const contexts: Context[] = []
const roots: string[] = []
afterEach(async () => {
  vi.useRealTimers()
  for (const ctx of contexts.splice(0)) await ctx.fiber.dispose()
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true })
  vi.restoreAllMocks()
})

function cookie(): string { return `__Host-dsh_device_session=dshs1.${deviceId}.${sessionId}.${sessionSecret}` }

async function baseHarness() {
  const ctx = new Context(); contexts.push(ctx)
  const webFiber = await ctx.plugin(WebServer, { host: '127.0.0.1', port: 0 })
  await webFiber.await()
  const authFiber = await ctx.plugin(FakeAuth)
  await authFiber.await()
  const auth = ctx.deviceAuth as FakeAuth
  return { ctx, auth, port: ctx.webServer.port }
}

async function harness() {
  const { ctx, auth, port } = await baseHarness()
  const runtime = new DeviceAuthWeb(ctx, config)
  const dispose = await runtime.start()
  ctx.effect(() => dispose)
  return { ctx, auth, port }
}

async function loaderHarness() {
  const root = await mkdtemp(join(tmpdir(), 'dsh-device-auth-web-')); roots.push(root)
  const configPath = join(root, 'cordis.yml')
  await writeFile(configPath, [
    '- name: \'@deepseek-ai/dsh-host-webserver\'', '  config: { host: \'127.0.0.1\', port: 0 }',
    '- id: auth', '  name: \'fixture-device-auth\'',
    '- id: gate', '  name: \'@deepseek-ai/dsh-host-device-auth-web\'', '  config:',
    `    publicOrigin: '${config.publicOrigin}'`, `    accessIssuer: '${config.accessIssuer}'`,
    `    accessAudience: '${config.accessAudience}'`, `    accessEmail: '${config.accessEmail}'`,
    `    accessClockToleranceSeconds: ${String(config.accessClockToleranceSeconds)}`,
    `    maxFormBytes: ${String(config.maxFormBytes)}`, '',
  ].join('\n'))
  const ctx = new Context(); contexts.push(ctx); ctx.baseUrl = pathToFileURL(root).href + '/'
  await ctx.plugin(Loader); ctx.loader.builtins.include = Include
  const modules = new Map<string, unknown>([
    ['@deepseek-ai/dsh-host-webserver', WebServer], ['fixture-device-auth', FakeAuth],
    ['@deepseek-ai/dsh-host-device-auth-web', DeviceAuthWebModule],
  ])
  ctx.loader.internal = {
    version: 'v2',
    async import(specifier: string) {
      const module = modules.get(specifier)
      if (module === undefined) throw new Error(`unexpected Loader import: ${specifier}`)
      return module
    },
  } as unknown as NonNullable<typeof ctx.loader.internal>
  await ctx.loader.create({ name: 'cordis:include', config: { path: pathToFileURL(configPath).href } })
  await ctx.loader.await()
  return ctx
}

function upgradeRequest(): IncomingMessage {
  return {
    url: '/matched', headers: { host: 'dsh.example', origin: config.publicOrigin, cookie: cookie() },
    socket: { remoteAddress: '127.0.0.1' },
  } as unknown as IncomingMessage
}

function fakeRequest(options: {
  method?: string
  url?: string | undefined
  headers?: Record<string, string>
  remoteAddress?: string
  body?: string
} = {}): IncomingMessage {
  const stream = new PassThrough()
  Object.assign(stream, {
    method: options.method ?? 'GET', url: options.url,
    headers: options.headers ?? { host: 'dsh.example' },
    socket: { remoteAddress: options.remoteAddress ?? '127.0.0.1' },
  })
  stream.end(options.body)
  return stream as unknown as IncomingMessage
}

function fakeResponse(): {
  res: import('node:http').ServerResponse
  state: { status: number | undefined; body: string; headers: Map<string, unknown> }
} {
  const state = { status: undefined as number | undefined, body: '', headers: new Map<string, unknown>() }
  const res = {
    setHeader: (key: string, value: unknown) => state.headers.set(key, value),
    writeHead: (status: number, headers: Record<string, unknown>) => {
      state.status = status
      for (const [key, value] of Object.entries(headers)) state.headers.set(key, value)
    },
    end: (body = '') => { state.body = body },
  } as unknown as import('node:http').ServerResponse
  return { res, state }
}

interface TestDeviceAuthWeb {
  closing: boolean
  verifyAccess: (assertion: string | undefined) => Promise<Omit<VerifiedDevicePrincipal, 'id'>>
  enroll(req: IncomingMessage, res: import('node:http').ServerResponse): Promise<void>
  login(req: IncomingMessage, res: import('node:http').ServerResponse): Promise<void>
  logout(req: IncomingMessage, res: import('node:http').ServerResponse): Promise<void>
  admin(req: IncomingMessage, res: import('node:http').ServerResponse): Promise<void>
  tracked: Set<{ socket: PassThrough; credential: DeviceSessionCredential; expiresAt: number; timer?: NodeJS.Timeout }>
  scheduleExpiry(tracked: { socket: PassThrough; credential: DeviceSessionCredential; expiresAt: number }): void
  start(): Promise<() => Promise<void>>
  handleHttp(req: IncomingMessage, res: import('node:http').ServerResponse): Promise<import('@deepseek-ai/dsh-host-webserver').WebIngressDecision>
  handleUpgrade(req: IncomingMessage, socket: PassThrough): Promise<import('@deepseek-ai/dsh-host-webserver').WebIngressDecision>
}

function request(port: number, path: string, options: { method?: string; headers?: Record<string, string>; body?: string } = {}): Promise<{ status: number; headers: import('node:http').IncomingHttpHeaders; body: string }> {
  return new Promise((resolve, reject) => {
    const req = httpRequest({ host: '127.0.0.1', port, path, method: options.method, headers: { host: 'dsh.example', ...options.headers } }, (res) => {
      const chunks: Buffer[] = []
      res.on('data', (chunk: Buffer) => { chunks.push(Buffer.from(chunk)) })
      res.on('end', () => { resolve({ status: res.statusCode!, headers: res.headers, body: Buffer.concat(chunks).toString() }) })
    })
    req.on('error', reject); req.end(options.body)
  })
}

function upgrade(port: number, path: string, headers: Record<string, string>): Promise<{ firstLine: string; closed: Promise<void> }> {
  return new Promise((resolve, reject) => {
    const socket = connect(port, '127.0.0.1')
    let settled = false
    socket.once('error', reject)
    socket.once('connect', () => {
      socket.write([
        `GET ${path} HTTP/1.1`, 'Host: dsh.example', 'Connection: Upgrade', 'Upgrade: fixture',
        ...Object.entries(headers).map(([key, value]) => `${key}: ${value}`), '', '',
      ].join('\r\n'))
    })
    socket.once('data', (data) => {
      settled = true
      const closed = new Promise<void>(done => socket.once('close', () => { done() }))
      resolve({ firstLine: data.toString().split('\r\n')[0] ?? '', closed })
    })
    socket.once('close', () => {
      if (!settled) resolve({ firstLine: '', closed: Promise.resolve() })
    })
  })
}

describe('device auth web ingress', () => {
  it('validates every public origin and scalar configuration requirement', () => {
    const resolved = resolveConfig(config)
    expect(resolved.public).toBeInstanceOf(URL)
    expect(resolved.issuer).toBeInstanceOf(URL)
    for (const invalid of [
      { ...config, publicOrigin: 'not-a-url' },
      { ...config, publicOrigin: 'http://dsh.example' },
      { ...config, publicOrigin: 'https://dsh.example/' },
      { ...config, publicOrigin: 'https://user:pass@dsh.example' },
      { ...config, accessIssuer: 'not-a-url' },
      { ...config, accessIssuer: 'https://access.example/path' },
      { ...config, accessAudience: ' ' },
      { ...config, accessEmail: ' owner@example.com' },
      { ...config, accessEmail: 'owner.example.com' },
      { ...config, accessClockToleranceSeconds: 1.5 },
      { ...config, maxFormBytes: 1.5 },
      { ...config, accessClockToleranceSeconds: -1 },
      { ...config, maxFormBytes: 0 },
    ]) expect(() => resolveConfig(invalid)).toThrow(/device-auth-web/)
  })

  it('boots through Loader and releases gate plus routes with the plugin fiber', async () => {
    const ctx = await loaderHarness()
    expect((await request(ctx.webServer.port, '/missing')).status).toBe(401)
    const gate = [...ctx.loader.entries()].find(entry => entry.options.id === 'gate')
    expect(gate?.fiber).toBeDefined()
    await gate!.fiber!.dispose()
    expect((await request(ctx.webServer.port, '/missing')).status).toBe(404)
    const releaseGate = ctx.webServer.registerIngressGate({
      handleHttp: () => ({ kind: 'allow' }), handleUpgrade: () => ({ kind: 'allow' }),
    })
    const releases = ['/auth/device/enroll', '/auth/device/login', '/auth/device/logout', '/auth/device/admin'].map(path =>
      ctx.webServer.register({ kind: 'exact', path, handler: () => {} }))
    for (const release of releases) release()
    releaseGate()
  })

  it('requires both peer and Host loopback for local bypass', () => {
    expect(isLocalBypass('127.0.0.1', 'localhost:3000')).toBe(true)
    expect(isLocalBypass('127.0.0.1', '127.0.0.1:3000')).toBe(true)
    expect(isLocalBypass('::ffff:127.0.0.1', '[::1]:3000')).toBe(true)
    expect(isLocalBypass('10.0.0.2', '127.0.0.1:3000')).toBe(false)
    expect(isLocalBypass('::1', 'localhost')).toBe(true)
    expect(isLocalBypass('127.0.0.1', undefined)).toBe(false)
    expect(isLocalBypass('127.0.0.1', ']')).toBe(false)
    expect(isLocalBypass('127.0.0.1', 'public.example')).toBe(false)
  })

  it('strictly parses one canonical session cookie', () => {
    expect(parseSessionCookie(cookie())).toMatchObject({ deviceId, id: sessionId, secret: sessionSecret })
    expect(parseSessionCookie(`${cookie()}; ${cookie()}`)).toBeUndefined()
    expect(parseSessionCookie('__Host-dsh_device_session=dshs1.short.short.short')).toBeUndefined()
    for (const header of [
      undefined,
      'other=value',
      '__Host-dsh_device_session',
      `__Host-dsh_device_session=wrong.${deviceId}.${sessionId}.${sessionSecret}`,
      `__Host-dsh_device_session=dshs1.${deviceId}.${sessionId}.${sessionSecret}.extra`,
      `__Host-dsh_device_session=dshs1.short.${sessionId}.${sessionSecret}`,
      `__Host-dsh_device_session=dshs1.${deviceId}.short.${sessionSecret}`,
      `__Host-dsh_device_session=dshs1.${deviceId}.${sessionId}.short`,
    ]) expect(parseSessionCookie(header)).toBeUndefined()
  })

  it('rejects a missing Cloudflare assertion before any JWKS request', async () => {
    const fetcher = vi.fn<typeof fetch>()
    const verifier = createAccessVerifier(resolveConfig(config), { fetch: fetcher })
    await expect(verifier(undefined)).rejects.toThrow('enrollment assertion is missing')
    await expect(verifier('')).rejects.toThrow('enrollment assertion is missing')
    expect(fetcher).not.toHaveBeenCalled()
  })

  it('gates unmatched and named routes before dispatch and rolls only HTTP sessions', async () => {
    const { ctx, auth, port } = await harness()
    ctx.webServer.register({ kind: 'exact', path: '/exact', handler: (_req, res) => { res.end('exact') } })
    ctx.webServer.register({ kind: 'prefix', path: '/prefix', handler: (_req, res) => { res.end('prefix') } })
    ctx.webServer.registerFallback((_req, res) => { res.end('fallback') })
    expect((await request(port, '/exact')).status).toBe(401)
    expect((await request(port, '/', { headers: { accept: 'text/html' } })).status).toBe(302)
    for (const path of ['/exact', '/prefix/child', '/unmatched']) {
      const response = await request(port, path, { headers: { cookie: cookie() } })
      expect(response.status).toBe(200)
      expect(response.headers['set-cookie']?.[0]).toMatch(/HttpOnly; Secure; SameSite=Strict/)
    }
    expect(auth.renewCalls).toEqual([true, true, true])
  })

  it('rejects hostile Host, unsafe Origin, form types, bounds, and duplicate fields', async () => {
    const { port } = await harness()
    expect((await request(port, '/auth/device/login', { headers: { host: 'evil.example' } })).status).toBe(403)
    expect((await request(port, '/auth/device/login', { method: 'POST', body: 'token=x' })).status).toBe(403)
    const token = `dshd1.${deviceId}.${secret('t')}`
    const contentType = { 'content-type': 'application/x-www-form-urlencoded' }
    const sameOriginReferer = `${config.publicOrigin}/auth/device/login`
    expect((await request(port, '/auth/device/login', { method: 'POST', headers: { ...contentType, referer: sameOriginReferer }, body: `token=${token}` })).status).toBe(303)
    expect((await request(port, '/auth/device/login', { method: 'POST', headers: { ...contentType, origin: 'https://evil.example', referer: sameOriginReferer }, body: `token=${token}` })).status).toBe(403)
    const headers = { origin: config.publicOrigin, 'content-type': 'application/x-www-form-urlencoded' }
    expect((await request(port, '/auth/device/login', { method: 'POST', headers, body: 'token=a&token=b' })).status).toBe(401)
    expect((await request(port, '/auth/device/login', { method: 'POST', headers, body: `token=${'x'.repeat(300)}` })).status).toBe(401)
    expect((await request(port, '/auth/device/login', { method: 'POST', headers: { origin: config.publicOrigin }, body: 'token=x' })).status).toBe(401)
    expect((await request(port, '/auth/device/login', { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded', referer: ']' }, body: 'token=x' })).status).toBe(403)
    expect((await request(port, '/auth/device/login', { method: 'PUT' })).status).toBe(405)
    expect((await request(port, '/missing', { method: 'POST' })).status).toBe(403)
  })

  it('gates and serves enrollment without trusting form fields or verifier failures', async () => {
    const { ctx, auth, port } = await baseHarness()
    const runtime = new DeviceAuthWeb(ctx, config) as unknown as TestDeviceAuthWeb
    runtime.verifyAccess = async () => principal
    const dispose = await runtime.start(); ctx.effect(() => dispose)
    const assertion = { 'cf-access-jwt-assertion': 'verified' }
    expect((await request(port, '/auth/device/enroll')).status).toBe(403)
    expect((await request(port, '/auth/device/enroll', {
      method: 'POST', headers: { ...assertion, origin: 'https://evil.example' }, body: 'label=phone',
    })).status).toBe(403)
    expect((await request(port, '/auth/device/enroll', { headers: assertion })).status).toBe(200)
    expect((await request(port, '/auth/device/enroll', { method: 'PUT', headers: assertion })).status).toBe(405)
    const headers = { ...assertion, origin: config.publicOrigin, 'content-type': 'application/x-www-form-urlencoded' }
    expect((await request(port, '/auth/device/enroll', { method: 'POST', headers: { ...assertion, origin: config.publicOrigin }, body: 'label=phone' })).status).toBe(400)
    expect((await request(port, '/auth/device/enroll', { method: 'POST', headers, body: 'label=phone&extra=x' })).status).toBe(400)
    expect((await request(port, '/auth/device/enroll', { method: 'POST', headers, body: 'label=' })).status).toBe(400)
    const enrolled = await request(port, '/auth/device/enroll', { method: 'POST', headers, body: 'label=tablet' })
    expect(enrolled.status).toBe(200)
    expect(enrolled.body).toContain(`dshd1.${deviceId}.${secret('t')}`)
    expect(enrolled.headers['set-cookie']).toBeDefined()
    runtime.verifyAccess = async () => { throw new Error('invalid assertion') }
    expect((await request(port, '/auth/device/enroll', { headers: assertion })).status).toBe(403)
    expect(auth.listDevices()).toEqual([device])
  })

  it('permits same-origin referrer fallback only on browser form pages', async () => {
    const { port } = await harness()
    const login = await request(port, '/auth/device/login')
    expect(login.status).toBe(200)
    expect(login.headers['referrer-policy']).toBe('same-origin')
    expect((await request(port, '/missing')).headers['referrer-policy']).toBe('no-referrer')
  })

  it('covers public-gate close, cookie failure, no-renewal, and absent URL behavior', async () => {
    const { ctx, auth } = await baseHarness()
    const runtime = new DeviceAuthWeb(ctx, config) as unknown as TestDeviceAuthWeb
    const response = fakeResponse()
    runtime.closing = true
    await expect(runtime.handleHttp(upgradeRequest(), response.res)).resolves.toEqual({ kind: 'handled' })
    expect(response.state.status).toBe(503)
    runtime.closing = false

    auth.sessions.clear()
    const denied = fakeResponse()
    await expect(runtime.handleHttp(upgradeRequest(), denied.res)).resolves.toEqual({ kind: 'handled' })
    expect(denied.state.status).toBe(401)

    auth.sessions.set(sessionId, credential)
    const originalAuthenticate = auth.authenticate.bind(auth)
    auth.authenticate = async (...args) => ({ ...(await originalAuthenticate(...args)), renewSession: false })
    const allowed = fakeResponse()
    await expect(runtime.handleHttp(fakeRequest({
      url: undefined, headers: { host: 'dsh.example', origin: config.publicOrigin, cookie: cookie() }, remoteAddress: '10.0.0.2',
    }), allowed.res)).resolves.toEqual({ kind: 'allow' })
    expect(allowed.state.headers.has('set-cookie')).toBe(false)

    auth.authenticate = async () => { throw new Error('internal authentication failure') }
    await expect(runtime.handleHttp(upgradeRequest(), fakeResponse().res)).rejects.toThrow('internal authentication failure')
  })

  it('never reflects a permanent login token and clears logout cookie', async () => {
    const { port } = await harness()
    const token = `dshd1.${deviceId}.${secret('t')}`
    const headers = { origin: config.publicOrigin, 'content-type': 'application/x-www-form-urlencoded' }
    const login = await request(port, '/auth/device/login', { method: 'POST', headers, body: `token=${encodeURIComponent(token)}` })
    expect(login.status).toBe(303); expect(login.body).not.toContain(token)
    expect(login.headers['set-cookie']?.[0]).toMatch(/^__Host-dsh_device_session=.*Path=\/.*HttpOnly; Secure; SameSite=Strict/)
    const logout = await request(port, '/auth/device/logout', { method: 'POST', headers: { origin: config.publicOrigin, cookie: cookie() } })
    expect(logout.status).toBe(303); expect(logout.headers['set-cookie']?.[0]).toContain('Max-Age=0')
  })

  it('keeps route wrappers and completed mutations closed during teardown', async () => {
    const { ctx, auth } = await baseHarness()
    const runtime = new DeviceAuthWeb(ctx, config) as unknown as TestDeviceAuthWeb
    runtime.verifyAccess = async () => principal
    const assertion = { 'cf-access-jwt-assertion': 'verified' }
    const formHeaders = { origin: config.publicOrigin, 'content-type': 'application/x-www-form-urlencoded' }
    const cases: Array<{
      method: 'enroll' | 'login' | 'logout' | 'admin'
      request: () => IncomingMessage
    }> = [
      { method: 'enroll', request: () => fakeRequest({ method: 'POST', url: '/auth/device/enroll', headers: { ...assertion, ...formHeaders }, body: 'label=phone' }) },
      { method: 'login', request: () => fakeRequest({ method: 'POST', url: '/auth/device/login', headers: formHeaders, body: `token=dshd1.${deviceId}.${secret('t')}` }) },
      { method: 'logout', request: () => fakeRequest({ method: 'POST', url: '/auth/device/logout', headers: { ...formHeaders, cookie: cookie() } }) },
      { method: 'admin', request: () => fakeRequest({ method: 'POST', url: '/auth/device/admin', headers: { host: 'localhost', origin: 'http://localhost', 'content-type': 'application/x-www-form-urlencoded' }, body: `action=revoke&deviceId=${deviceId}` }) },
    ]
    for (const value of cases) {
      runtime.closing = true
      const response = fakeResponse()
      await runtime[value.method](value.request(), response.res)
      expect(response.state.status).toBe(503)
    }

    runtime.closing = false
    auth.enroll = async (...args) => { runtime.closing = true; return await FakeAuth.prototype.enroll.apply(auth, args) }
    let response = fakeResponse()
    await runtime.enroll(cases[0]!.request(), response.res)
    expect(response.state.status).toBe(503)

    runtime.closing = false
    auth.login = async (...args) => { runtime.closing = true; return await FakeAuth.prototype.login.apply(auth, args) }
    response = fakeResponse()
    await runtime.login(cases[1]!.request(), response.res)
    expect(response.state.status).toBe(503)

    runtime.closing = false
    auth.logout = async (...args) => { await FakeAuth.prototype.logout.apply(auth, args); runtime.closing = true }
    response = fakeResponse()
    await runtime.logout(cases[2]!.request(), response.res)
    expect(response.state.status).toBe(503)

    runtime.closing = false
    auth.revokeDevice = async (...args) => { await FakeAuth.prototype.revokeDevice.apply(auth, args); runtime.closing = true }
    response = fakeResponse()
    await runtime.admin(cases[3]!.request(), response.res)
    expect(response.state.status).toBe(503)

    runtime.closing = false
    auth.rotateDeviceToken = async (...args) => {
      const result = await FakeAuth.prototype.rotateDeviceToken.apply(auth, args)
      runtime.closing = true
      return result
    }
    response = fakeResponse()
    await runtime.admin(fakeRequest({
      method: 'POST', url: '/auth/device/admin',
      headers: { host: 'localhost', origin: 'http://localhost', 'content-type': 'application/x-www-form-urlencoded' },
      body: `action=rotate&deviceId=${deviceId}`,
    }), response.res)
    expect(response.state.status).toBe(503)
  })

  it('rejects unsupported logout and malformed administration requests', async () => {
    const { ctx, auth } = await baseHarness()
    const runtime = new DeviceAuthWeb(ctx, config) as unknown as TestDeviceAuthWeb
    let response = fakeResponse()
    await runtime.logout(fakeRequest({ method: 'GET', headers: { cookie: cookie() } }), response.res)
    expect(response.state.status).toBe(405)
    response = fakeResponse()
    await runtime.logout(fakeRequest({ method: 'POST' }), response.res)
    expect(response.state.status).toBe(401)

    const base = { host: 'localhost', origin: 'http://localhost', 'content-type': 'application/x-www-form-urlencoded' }
    response = fakeResponse(); await runtime.admin(fakeRequest({ method: 'PUT', headers: base }), response.res)
    expect(response.state.status).toBe(405)
    for (const body of [
      `action=revoke&deviceId=${deviceId}&extra=x`,
      'action=revoke&deviceId=short',
      `action=unknown&deviceId=${deviceId}`,
    ]) {
      response = fakeResponse()
      await runtime.admin(fakeRequest({ method: 'POST', headers: base, body }), response.res)
      expect(response.state.status).toBe(400)
    }
    auth.devices = [{ ...device, revokedAt: 2 }]
    response = fakeResponse(); await runtime.admin(fakeRequest({ method: 'GET', headers: { host: 'localhost' } }), response.res)
    expect(response.state.body).toContain('revoked')
    expect(response.state.body).not.toContain('Rotate token')
  })

  it('rejects login forms with unknown fields', async () => {
    const { port } = await harness()
    const headers = { origin: config.publicOrigin, 'content-type': 'application/x-www-form-urlencoded' }
    expect((await request(port, '/auth/device/login', { method: 'POST', headers, body: 'token=x&extra=y' })).status).toBe(401)
  })

  it('exposes secret-free escaped device administration only on loopback authority', async () => {
    const { auth, port } = await harness()
    auth.devices = [{ ...device, label: '<script>alert(1)</script>', principal: { ...principal, email: 'owner&admin@example.com' } }]
    expect((await request(port, '/auth/device/admin', { headers: { cookie: cookie() } })).status).toBe(403)
    const local = await request(port, '/auth/device/admin', { headers: { host: `localhost:${String(port)}` } })
    expect(local.status).toBe(200)
    expect(local.body).toContain('&lt;script&gt;alert(1)&lt;/script&gt;')
    expect(local.body).toContain('owner&amp;admin@example.com')
    expect(local.body).not.toContain(sessionSecret)
    expect(local.body).not.toContain(secret('t'))
  })

  it('requires the current loopback Origin for administration POSTs and handles revoke', async () => {
    const { auth, port } = await harness()
    const body = `deviceId=${encodeURIComponent(deviceId)}&action=revoke`
    const base = { method: 'POST', headers: { host: `localhost:${String(port)}`, 'content-type': 'application/x-www-form-urlencoded' }, body }
    expect((await request(port, '/auth/device/admin', base)).status).toBe(403)
    expect((await request(port, '/auth/device/admin', { ...base, headers: { ...base.headers, origin: 'http://localhost.evil' } })).status).toBe(403)
    const response = await request(port, '/auth/device/admin', { ...base, headers: { ...base.headers, origin: `http://localhost:${String(port)}` } })
    expect(response.status).toBe(200)
    expect(auth.revoked).toEqual([deviceId])
  })

  it('rotates a device token for one-time display without changing the browser session', async () => {
    const { auth, port } = await harness()
    const body = `deviceId=${encodeURIComponent(deviceId)}&action=rotate`
    const response = await request(port, '/auth/device/admin', {
      method: 'POST', headers: { host: `127.0.0.1:${String(port)}`, origin: `http://127.0.0.1:${String(port)}`, 'content-type': 'application/x-www-form-urlencoded' }, body,
    })
    expect(response.status).toBe(200)
    expect(response.body).toContain(`dshd1.${deviceId}.${secret('t')}`)
    expect(response.headers['set-cookie']).toBeUndefined()
    expect(auth.rotated).toEqual([deviceId])
  })

  it('gates matched and unmatched upgrades without renewal and closes invalidated sessions', async () => {
    const { ctx, auth, port } = await harness()
    let downstreamCalls = 0
    ctx.webServer.registerUpgrade({ path: '/matched', handler: (_req, socket) => {
      downstreamCalls += 1
      socket.write('HTTP/1.1 101 Switching Protocols\r\nConnection: Upgrade\r\nUpgrade: fixture\r\n\r\n')
    } })
    const denied = await upgrade(port, '/matched', { Origin: config.publicOrigin })
    expect(denied.firstLine).toBe('HTTP/1.1 401 Unauthorized')
    await denied.closed
    expect(downstreamCalls).toBe(0)
    const unmatched = await upgrade(port, '/missing', { Origin: config.publicOrigin, Cookie: cookie() })
    await unmatched.closed
    const admitted = await upgrade(port, '/matched', { Origin: config.publicOrigin, Cookie: cookie() })
    expect(admitted.firstLine).toBe('HTTP/1.1 101 Switching Protocols')
    expect(downstreamCalls).toBe(1)
    expect(auth.renewCalls).toEqual([false, false])
    ctx.emit('device-auth/session-invalidated', deviceId, DeviceSessionId(secret('o')))
    expect(await Promise.race([
      admitted.closed.then(() => true), new Promise<false>(resolve => setTimeout(() => { resolve(false) }, 20)),
    ])).toBe(false)
    ctx.emit('device-auth/session-invalidated', deviceId, sessionId)
    await admitted.closed
  })

  it('rejects invalid, closing, and destroyed upgrades while allowing loopback upgrades', async () => {
    const { ctx, auth } = await baseHarness()
    const runtime = new DeviceAuthWeb(ctx, config) as unknown as TestDeviceAuthWeb

    const invalidHost = new PassThrough(); invalidHost.resume()
    await expect(runtime.handleUpgrade(fakeRequest({
      url: '/matched', headers: { host: 'evil.example', origin: config.publicOrigin }, remoteAddress: '10.0.0.2',
    }), invalidHost)).resolves.toEqual({ kind: 'handled' })
    await new Promise(resolve => setImmediate(resolve))
    expect(invalidHost.destroyed).toBe(true)
    const invalidOrigin = new PassThrough(); invalidOrigin.resume()
    await expect(runtime.handleUpgrade(fakeRequest({
      url: '/matched', headers: { host: 'dsh.example', origin: 'https://evil.example' }, remoteAddress: '10.0.0.2',
    }), invalidOrigin)).resolves.toEqual({ kind: 'handled' })
    await new Promise(resolve => setImmediate(resolve))
    expect(invalidOrigin.destroyed).toBe(true)

    const local = new PassThrough()
    await expect(runtime.handleUpgrade(fakeRequest({
      url: '/matched', headers: { host: 'localhost' }, remoteAddress: '127.0.0.1',
    }), local)).resolves.toEqual({ kind: 'allow' })

    let releaseAuth!: () => void
    auth.authGate = new Promise<void>((resolve) => { releaseAuth = resolve })
    const destroyed = new PassThrough()
    const admission = runtime.handleUpgrade(upgradeRequest(), destroyed)
    await Promise.resolve()
    destroyed.destroy()
    releaseAuth()
    await expect(admission).resolves.toEqual({ kind: 'handled' })

    runtime.closing = true
    const closing = new PassThrough(); closing.resume()
    await expect(runtime.handleUpgrade(upgradeRequest(), closing)).resolves.toEqual({ kind: 'handled' })
    await new Promise(resolve => setImmediate(resolve))
    expect(closing.destroyed).toBe(true)
  })

  it('does not schedule expiry for closed runtime state and disposes a timerless tracked socket', async () => {
    const { ctx } = await baseHarness()
    const setTimer = vi.fn((callback: () => void, delay: number) => setTimeout(callback, delay))
    const runtime = new DeviceAuthWeb(ctx, config, { now: Date.now, setTimer, clearTimer: clearTimeout }) as unknown as TestDeviceAuthWeb
    const destroyed = new PassThrough(); destroyed.destroy()
    runtime.scheduleExpiry({ socket: destroyed, credential, expiresAt: Date.now() + 1_000 })
    expect(setTimer).not.toHaveBeenCalled()
    runtime.closing = true
    runtime.scheduleExpiry({ socket: new PassThrough(), credential, expiresAt: Date.now() + 1_000 })
    expect(setTimer).not.toHaveBeenCalled()
    runtime.closing = false
    const dispose = await runtime.start()
    const timerless = new PassThrough()
    runtime.tracked.add({ socket: timerless, credential, expiresAt: Date.now() + 1_000 })
    await dispose()
    expect(timerless.destroyed).toBe(true)
  })

  it('removes a tracked socket even when a timer implementation returns no handle', async () => {
    const { ctx } = await baseHarness()
    const clearTimer = vi.fn()
    const runtime = new DeviceAuthWeb(ctx, config, {
      now: Date.now, setTimer: () => undefined as never, clearTimer,
    }) as unknown as TestDeviceAuthWeb
    const socket = new PassThrough()
    await expect(runtime.handleUpgrade(upgradeRequest(), socket)).resolves.toEqual({ kind: 'allow' })
    expect(runtime.tracked.size).toBe(1)
    socket.destroy()
    await new Promise(resolve => setImmediate(resolve))
    expect(runtime.tracked.size).toBe(0)
    expect(clearTimer).not.toHaveBeenCalled()
  })

  it('rolls back partial publication and releases the single ingress seat on disposal', async () => {
    const { ctx } = await baseHarness()
    const releaseCollision = ctx.webServer.register({ kind: 'exact', path: '/auth/device/login', handler: () => {} })
    const failed = new DeviceAuthWeb(ctx, config)
    await expect(failed.start()).rejects.toThrow('duplicate exact route')
    const releaseProbeGate = ctx.webServer.registerIngressGate({
      handleHttp: () => ({ kind: 'allow' }), handleUpgrade: () => ({ kind: 'allow' }),
    })
    const releaseEnroll = ctx.webServer.register({ kind: 'exact', path: '/auth/device/enroll', handler: () => {} })
    const releaseLogout = ctx.webServer.register({ kind: 'exact', path: '/auth/device/logout', handler: () => {} })
    releaseLogout(); releaseEnroll(); releaseProbeGate(); releaseCollision()

    const first = new DeviceAuthWeb(ctx, config); const disposeFirst = await first.start()
    await expect(new DeviceAuthWeb(ctx, config).start()).rejects.toThrow('ingress gate already registered')
    await disposeFirst()
    const disposeReplacement = await new DeviceAuthWeb(ctx, config).start()
    await disposeReplacement()
  })

  it('closes at idle expiry, observes HTTP extension, and chunks long timers without early authentication', async () => {
    vi.useFakeTimers({ now: 1_000 })
    const { ctx, auth } = await baseHarness()
    const dependencies = { now: Date.now, setTimer: setTimeout, clearTimer: clearTimeout }
    const runtime = new DeviceAuthWeb(ctx, config, dependencies)
    const dispose = await runtime.start()

    auth.expiresAt = 5_000
    const extendedSocket = new PassThrough()
    await runtime.handleUpgrade(upgradeRequest(), extendedSocket)
    auth.renewTo = 10_000
    vi.setSystemTime(3_000)
    const responseHeaders = new Map<string, string | number | readonly string[]>()
    const response = { setHeader: (key: string, value: string) => responseHeaders.set(key, value) } as unknown as import('node:http').ServerResponse
    await expect(runtime.handleHttp(upgradeRequest(), response)).resolves.toEqual({ kind: 'allow' })
    expect(String(responseHeaders.get('set-cookie'))).toContain('Expires=Thu, 01 Jan 1970 00:00:10 GMT')
    await vi.advanceTimersByTimeAsync(2_000)
    expect(extendedSocket.destroyed).toBe(false)
    await vi.advanceTimersByTimeAsync(5_000)
    expect(extendedSocket.destroyed).toBe(true)

    auth.sessions.set(sessionId, credential); auth.expiresAt = Date.now() + MAX_TIMER_MS + 1_000; delete auth.renewTo
    const longSocket = new PassThrough()
    await runtime.handleUpgrade(upgradeRequest(), longSocket)
    const calls = auth.renewCalls.length
    await vi.advanceTimersByTimeAsync(MAX_TIMER_MS)
    expect(auth.renewCalls).toHaveLength(calls)
    expect(longSocket.destroyed).toBe(false)
    await vi.advanceTimersByTimeAsync(1_000)
    expect(auth.renewCalls).toHaveLength(calls + 1)
    expect(longSocket.destroyed).toBe(true)
    await dispose()
  })

  it('fails closed and drains a pending upgrade authentication during disposal', async () => {
    const { ctx, auth } = await baseHarness()
    let releaseAuth!: () => void
    auth.authGate = new Promise<void>((resolve) => { releaseAuth = resolve })
    const runtime = new DeviceAuthWeb(ctx, config)
    const dispose = await runtime.start()
    const socket = new HeldCloseDuplex()
    const destroy = vi.spyOn(socket, 'destroy')
    const admission = runtime.handleUpgrade(upgradeRequest(), socket)
    let httpStatus: number | undefined
    const httpResponse = {
      setHeader: () => {}, writeHead: (status: number) => { httpStatus = status }, end: () => {},
    } as unknown as import('node:http').ServerResponse
    const httpAdmission = runtime.handleHttp(upgradeRequest(), httpResponse)
    await Promise.resolve()
    let disposed = false
    const disposal = dispose().then(() => { disposed = true })
    await new Promise<void>((resolve) => { setImmediate(resolve) })
    expect(destroy).toHaveBeenCalled()
    expect(disposed).toBe(false)
    releaseAuth()
    await expect(Promise.race([
      admission,
      new Promise<never>((_resolve, reject) => setTimeout(() => { reject(new Error('admission did not drain')) }, 250)),
    ])).resolves.toEqual({ kind: 'handled' })
    await expect(httpAdmission).resolves.toEqual({ kind: 'handled' })
    expect(httpStatus).toBe(401)
    expect(disposed).toBe(false)
    socket.releaseClose()
    await expect(Promise.race([
      disposal,
      new Promise<never>((_resolve, reject) => setTimeout(() => { reject(new Error('disposal did not drain')) }, 250)),
    ])).resolves.toBeUndefined()
    expect(socket.destroyed).toBe(true)
    let releaseProbe: (() => void) | undefined
    expect(() => { releaseProbe = ctx.webServer.registerIngressGate({
      handleHttp: () => ({ kind: 'allow' }), handleUpgrade: () => ({ kind: 'allow' }),
    }) }).not.toThrow()
    releaseProbe?.()
  })

  it('waits for a tracked upgrade socket to emit close during disposal', async () => {
    const { ctx } = await baseHarness()
    const runtime = new DeviceAuthWeb(ctx, config)
    const dispose = await runtime.start()
    const socket = new HeldCloseDuplex()
    await expect(runtime.handleUpgrade(upgradeRequest(), socket)).resolves.toEqual({ kind: 'allow' })
    let disposed = false
    const disposal = dispose().then(() => { disposed = true })
    await new Promise<void>((resolve) => { setImmediate(resolve) })
    expect(socket.destroyed).toBe(true)
    expect(disposed).toBe(false)
    socket.releaseClose()
    await disposal
    expect(disposed).toBe(true)
  })
})

describe('Cloudflare assertion verification', () => {
  it('validates RS256 issuer, audience, time, subject, email, signature, and JWKS failures', async () => {
    const { publicKey, privateKey } = await generateKeyPair('RS256')
    const { privateKey: otherPrivateKey } = await generateKeyPair('RS256')
    const jwk = await exportJWK(publicKey); jwk.kid = 'primary'; jwk.use = 'sig'; jwk.alg = 'RS256'
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(new Response(JSON.stringify({ keys: [jwk] }), { headers: { 'content-type': 'application/json' } }))
    const verifier = createAccessVerifier(resolveConfig(config), { fetch: fetcher })
    const sign = (claims: Record<string, unknown> = {}) => new SignJWT({ email: config.accessEmail, ...claims }).setProtectedHeader({ alg: 'RS256', kid: 'primary' })
      .setIssuer(config.accessIssuer).setAudience(config.accessAudience).setSubject('owner').setIssuedAt().setExpirationTime('5m').sign(privateKey)
    await expect(verifier(await sign())).resolves.toEqual({ issuer: config.accessIssuer, subject: 'owner', email: config.accessEmail })
    await expect(verifier(await sign({ email: 'other@example.com' }))).rejects.toThrow('assertion is invalid')
    await expect(verifier(await new SignJWT({ email: config.accessEmail }).setProtectedHeader({ alg: 'RS256', kid: 'primary' }).setIssuer(config.accessIssuer).setAudience('wrong').setSubject('owner').setExpirationTime('5m').sign(privateKey))).rejects.toThrow('assertion is invalid')
    await expect(verifier(await new SignJWT({ email: config.accessEmail }).setProtectedHeader({ alg: 'RS256', kid: 'primary' }).setIssuer('https://wrong.example').setAudience(config.accessAudience).setSubject('owner').setExpirationTime('5m').sign(privateKey))).rejects.toThrow('assertion is invalid')
    await expect(verifier(await new SignJWT({ email: config.accessEmail }).setProtectedHeader({ alg: 'RS256', kid: 'primary' }).setIssuer(config.accessIssuer).setAudience(config.accessAudience).setExpirationTime('5m').sign(privateKey))).rejects.toThrow('assertion is invalid')
    await expect(verifier(await new SignJWT({ email: config.accessEmail }).setProtectedHeader({ alg: 'RS256', kid: 'missing' }).setIssuer(config.accessIssuer).setAudience(config.accessAudience).setSubject('owner').setExpirationTime('5m').sign(privateKey))).rejects.toThrow('assertion is invalid')
    await expect(verifier(await new SignJWT({ email: config.accessEmail }).setProtectedHeader({ alg: 'RS256', kid: 'primary' }).setIssuer(config.accessIssuer).setAudience(config.accessAudience).setSubject('owner').setExpirationTime('5m').sign(otherPrivateKey))).rejects.toThrow('assertion is invalid')
    await expect(verifier(await new SignJWT({ email: config.accessEmail }).setProtectedHeader({ alg: 'RS256', kid: 'primary' }).setIssuer(config.accessIssuer).setAudience(config.accessAudience).setSubject('owner').sign(privateKey))).rejects.toThrow('assertion is invalid')
    await expect(verifier(await new SignJWT({ email: config.accessEmail }).setProtectedHeader({ alg: 'RS256', kid: 'primary' }).setIssuer(config.accessIssuer).setAudience(config.accessAudience).setSubject('owner').setExpirationTime(1).sign(privateKey))).rejects.toThrow('assertion is invalid')
    await expect(verifier(await new SignJWT({ email: config.accessEmail }).setProtectedHeader({ alg: 'RS256', kid: 'primary' }).setIssuer(config.accessIssuer).setAudience(config.accessAudience).setSubject('owner').setNotBefore('5m').setExpirationTime('10m').sign(privateKey))).rejects.toThrow('assertion is invalid')
    const failed = createAccessVerifier(resolveConfig(config), { fetch: vi.fn<typeof fetch>().mockRejectedValue(new Error('contains-sensitive-network-detail')) })
    await expect(failed(await sign())).rejects.toThrow('enrollment assertion is invalid')
  })
})
