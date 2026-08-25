import { afterEach, describe, expect, it, vi } from 'vitest'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import Storage from '@deepseek-ai/dsh-storage'
import type { StorageBackend } from '@deepseek-ai/dsh-storage'
import { DomainFacility } from '@deepseek-ai/dsh-storage-domain'
import { JsonStorageBackend } from '@deepseek-ai/dsh-storage-json'
import { canonicalDevicePrincipal, DeviceAuthError } from '@deepseek-ai/dsh-device-auth'
import DeviceAuthDomain, { deviceAuthRecord, resolveConfig } from '../src/index.ts'

const config = { sessionIdleMs: 1_000, sessionRenewBeforeMs: 200, maxLabelBytes: 20 }
const principal = { issuer: 'https://issuer.example', subject: 'stable-subject', email: 'display@example.com' }
const roots: string[] = []

async function harness(root: string, suppliedBackend?: StorageBackend) {
  const ctx = new Context()
  await ctx.plugin(Storage)
  const backend = suppliedBackend ?? new JsonStorageBackend(root)
  ctx.storage.backend.register('json', backend)
  const facility = new DomainFacility(ctx, { backend: 'json', routes: {} })
  ctx.storage.mount('domain', facility)
  ctx.provide('storageDomain', facility)
  const fiber = await ctx.plugin(DeviceAuthDomain, config)
  await fiber.await()
  return { ctx, fiber, backend, facility, auth: ctx.deviceAuth }
}

function failingBackend(root: string, state: { fail: boolean }): StorageBackend {
  const inner = new JsonStorageBackend(root)
  return {
    kv: {
      open: async (descriptor) => {
        const unit = await inner.kv.open(descriptor)
        return {
          loadAll: () => unit.loadAll(),
          putRecord: async (table, key, value) => {
            if (state.fail) throw new Error('selected durability failure')
            await unit.putRecord(table, key, value)
          },
          deleteRecord: (table, key) => unit.deleteRecord(table, key),
          setGlobal: value => unit.setGlobal(value),
          close: () => unit.close(),
        }
      },
    },
    close: () => inner.close(),
  }
}

function holdingBackend(root: string, control: { hold: boolean; started?: () => void; release?: Promise<void> }): StorageBackend {
  const inner = new JsonStorageBackend(root)
  return {
    kv: {
      open: async (descriptor) => {
        const unit = await inner.kv.open(descriptor)
        return {
          loadAll: () => unit.loadAll(),
          putRecord: async (table, key, value) => {
            if (control.hold) {
              control.started?.()
              await control.release
            }
            await unit.putRecord(table, key, value)
          },
          deleteRecord: (table, key) => unit.deleteRecord(table, key),
          setGlobal: value => unit.setGlobal(value),
          close: () => unit.close(),
        }
      },
    },
    close: () => inner.close(),
  }
}

async function closeHarness(value: Awaited<ReturnType<typeof harness>>) {
  await value.fiber.dispose()
  await value.facility.closeAll()
  await value.backend.close()
}

afterEach(async () => {
  vi.useRealTimers()
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true })
})

describe('DeviceAuthDomain', () => {
  it('enrolls, persists tokens across restart, replaces sessions, rotates, revokes, and never lists secrets', async () => {
    const root = await mkdtemp(join(tmpdir(), 'dsh-device-auth-'))
    roots.push(root)
    const first = await harness(root)
    const invalidated: string[] = []
    first.ctx.on('device-auth/session-invalidated', (_deviceId, sessionId) => invalidated.push(sessionId))
    const enrolled = await first.auth.enroll(principal, 'phone')
    expect(enrolled.device.principal).toMatchObject(principal)
    expect(enrolled.session.deviceId).toBe(enrolled.device.id)
    expect(JSON.stringify(first.auth.listDevices())).not.toMatch(/deviceToken|secret|credential|hash|salt/i)
    await closeHarness(first)

    const second = await harness(root)
    const loggedIn = await second.auth.login(enrolled.deviceToken)
    expect(loggedIn.device.id).toBe(enrolled.device.id)
    await expect(second.auth.authenticate(enrolled.device.id, enrolled.session.id, enrolled.session.secret, { renew: true }))
      .rejects.toMatchObject({ code: 'invalid-session' })
    expect(await second.auth.authenticate(loggedIn.device.id, loggedIn.session.id, loggedIn.session.secret, { renew: true }))
      .toMatchObject({ renewSession: false })
    expect('deviceToken' in loggedIn).toBe(false)
    const rotated = await second.auth.rotateDeviceToken(enrolled.device.id)
    expect('session' in rotated).toBe(false)
    expect(rotated.device.session).toBeUndefined()
    await expect(second.auth.authenticate(loggedIn.device.id, loggedIn.session.id, loggedIn.session.secret, { renew: true }))
      .rejects.toMatchObject({ code: 'invalid-session' })
    await expect(second.auth.login(enrolled.deviceToken)).rejects.toMatchObject({ code: 'invalid-token' })
    await closeHarness(second)

    const third = await harness(root)
    await expect(third.auth.login(enrolled.deviceToken)).rejects.toMatchObject({ code: 'invalid-token' })
    const afterRotation = await third.auth.login(rotated.deviceToken)
    expect(afterRotation.device.session?.id).toBe(afterRotation.session.id)
    await third.auth.revokeDevice(enrolled.device.id)
    await expect(third.auth.login(rotated.deviceToken)).rejects.toMatchObject({ code: 'device-revoked' })
    await closeHarness(third)
  })

  it('renews the same session at the boundary, expires it, logs out, and serializes concurrent logins', async () => {
    vi.useFakeTimers({ now: 10_000 })
    const root = await mkdtemp(join(tmpdir(), 'dsh-device-auth-'))
    roots.push(root)
    const value = await harness(root)
    const invalidated: Array<[string, string]> = []
    value.ctx.on('device-auth/session-invalidated', (deviceId, sessionId) => invalidated.push([deviceId, sessionId]))
    const enrolled = await value.auth.enroll(principal, 'browser')
    vi.setSystemTime(10_800)
    const noRenewal = await value.auth.authenticate(enrolled.device.id, enrolled.session.id, enrolled.session.secret, { renew: false })
    expect(noRenewal.renewSession).toBe(false)
    expect(noRenewal.expiresAt).toBe(11_000)
    const renewal = await value.auth.authenticate(enrolled.device.id, enrolled.session.id, enrolled.session.secret, { renew: true })
    expect(renewal).toMatchObject({ renewSession: true, expiresAt: 11_800 })
    expect(renewal.device.session?.id).toBe(enrolled.session.id)
    vi.setSystemTime(11_800)
    await expect(value.auth.authenticate(enrolled.device.id, enrolled.session.id, enrolled.session.secret, { renew: true }))
      .rejects.toMatchObject({ code: 'invalid-session' })

    const [left, right] = await Promise.all([value.auth.login(enrolled.deviceToken), value.auth.login(enrolled.deviceToken)])
    await expect(value.auth.authenticate(left.device.id, left.session.id, left.session.secret, { renew: true }))
      .rejects.toMatchObject({ code: 'invalid-session' })
    await value.auth.logout(right.device.id, right.session.id, right.session.secret)
    await expect(value.auth.authenticate(right.device.id, right.session.id, right.session.secret, { renew: true }))
      .rejects.toMatchObject({ code: 'invalid-session' })
    expect(invalidated).toEqual([
      [enrolled.device.id, enrolled.session.id],
      [enrolled.device.id, left.session.id],
      [enrolled.device.id, right.session.id],
    ])
    await closeHarness(value)
  })

  it('does not change authoritative state or emit invalidation when durability fails', async () => {
    const root = await mkdtemp(join(tmpdir(), 'dsh-device-auth-'))
    roots.push(root)
    const state = { fail: false }
    const value = await harness(root, failingBackend(root, state))
    const enrolled = await value.auth.enroll(principal, 'phone')
    const before = value.auth.listDevices()
    const invalidated = vi.fn()
    value.ctx.on('device-auth/session-invalidated', invalidated)
    state.fail = true
    await expect(value.auth.rotateDeviceToken(enrolled.device.id)).rejects.toThrow('selected durability failure')
    expect(value.auth.listDevices()).toEqual(before)
    expect(invalidated).not.toHaveBeenCalled()
    state.fail = false
    await expect(value.auth.authenticate(enrolled.device.id, enrolled.session.id, enrolled.session.secret, { renew: false }))
      .resolves.toMatchObject({ device: { id: enrolled.device.id } })
    await expect(value.auth.login(enrolled.deviceToken)).resolves.toMatchObject({ device: { id: enrolled.device.id } })
    await closeHarness(value)
  })

  it('fails invalid config and credential errors without echoing supplied secrets', async () => {
    for (const invalid of [
      { ...config, sessionIdleMs: 1.5 },
      { ...config, sessionRenewBeforeMs: 1.5 },
      { ...config, maxLabelBytes: 1.5 },
      { ...config, sessionRenewBeforeMs: 0 },
      { ...config, sessionRenewBeforeMs: 1_000 },
      { ...config, maxLabelBytes: 0 },
    ]) expect(() => resolveConfig(invalid)).toThrow(DeviceAuthError)
    expect(resolveConfig(config)).toBe(config)
    const root = await mkdtemp(join(tmpdir(), 'dsh-device-auth-'))
    roots.push(root)
    const value = await harness(root)
    const secret = 'do-not-echo-this-secret'
    const error: unknown = await value.auth.login(`dshd1.missing.${secret}`).catch((value: unknown) => value)
    expect(error).toBeInstanceOf(Error)
    expect((error as Error).message).not.toContain(secret)
    await expect(value.auth.enroll(principal, '')).rejects.toMatchObject({ code: 'invalid-label' })
    await expect(value.auth.enroll(principal, 'x'.repeat(21))).rejects.toMatchObject({ code: 'invalid-label' })
    const unknown = `dshd1.${Buffer.alloc(32, 7).toString('base64url')}.${Buffer.alloc(32, 8).toString('base64url')}`
    await expect(value.auth.login(unknown)).rejects.toMatchObject({ code: 'invalid-token' })
    await expect(value.auth.revokeDevice(Buffer.alloc(32, 9).toString('base64url') as never))
      .rejects.toMatchObject({ code: 'device-not-found' })
    await closeHarness(value)
  })

  it('derives a stable principal id without email and rejects malformed credentials before lookup', async () => {
    const root = await mkdtemp(join(tmpdir(), 'dsh-device-auth-'))
    roots.push(root)
    const value = await harness(root)
    const first = await value.auth.enroll(principal, 'first')
    const second = await value.auth.enroll({ ...principal, email: 'changed@example.com' }, 'second')
    expect(first.device.principal.id).toBe(second.device.principal.id)
    const nulSubject = canonicalDevicePrincipal({ ...principal, subject: 'subject\0suffix' })
    const plainSubject = canonicalDevicePrincipal({ ...principal, subject: 'subject' })
    expect(nulSubject.id).not.toBe(plainSubject.id)
    expect(canonicalDevicePrincipal({ ...principal, issuer: 'https://issuer.example/' }).id)
      .not.toBe(plainSubject.id)
    await expect(value.auth.login(`dshd1.${first.device.id}.short`)).rejects.toMatchObject({ code: 'invalid-token' })
    await expect(value.auth.login(`dshd1.${first.device.id}.${'x'.repeat(10_000)}`))
      .rejects.toMatchObject({ code: 'invalid-token' })
    await expect(value.auth.authenticate(first.device.id, first.session.id, 'short', { renew: true }))
      .rejects.toMatchObject({ code: 'invalid-session' })
    await expect(value.auth.authenticate(first.device.id, first.session.id, 'x'.repeat(10_000), { renew: true }))
      .rejects.toMatchObject({ code: 'invalid-session' })
    await expect(value.auth.authenticate(first.device.id, first.session.id, Buffer.alloc(32, 4).toString('base64url'), { renew: true }))
      .rejects.toMatchObject({ code: 'invalid-session' })
    await expect(value.auth.authenticate('short' as never, first.session.id, first.session.secret, { renew: true }))
      .rejects.toMatchObject({ code: 'invalid-session' })
    await expect(value.auth.authenticate(first.device.id, 'short' as never, first.session.secret, { renew: true }))
      .rejects.toMatchObject({ code: 'invalid-session' })
    await expect(value.auth.authenticate(Buffer.alloc(32, 6).toString('base64url') as never, first.session.id, first.session.secret, { renew: true }))
      .rejects.toMatchObject({ code: 'invalid-session' })
    await expect(value.auth.authenticate(first.device.id, Buffer.alloc(32, 5).toString('base64url') as never, first.session.secret, { renew: true }))
      .rejects.toMatchObject({ code: 'invalid-session' })
    await closeHarness(value)
  })

  it('preserves exact whitespace-bearing subjects across close, reopen, and token login', async () => {
    const root = await mkdtemp(join(tmpdir(), 'dsh-device-auth-'))
    roots.push(root)
    const exactSubject = '  stable-subject  '
    const first = await harness(root)
    const enrolled = await first.auth.enroll({ ...principal, subject: exactSubject }, 'phone')
    expect(enrolled.device.principal.subject).toBe(exactSubject)
    await closeHarness(first)

    const second = await harness(root)
    const loggedIn = await second.auth.login(enrolled.deviceToken)
    expect(loggedIn.device.principal.subject).toBe(exactSubject)
    expect(loggedIn.device.principal.id).toBe(enrolled.device.principal.id)
    await closeHarness(second)
  })

  it('drains an admitted mutation during disposal and rejects calls through a held service reference', async () => {
    const root = await mkdtemp(join(tmpdir(), 'dsh-device-auth-'))
    roots.push(root)
    let markStarted!: () => void
    const started = new Promise<void>((resolve) => { markStarted = resolve })
    let release!: () => void
    const released = new Promise<void>((resolve) => { release = resolve })
    const control = { hold: false, started: markStarted, release: released }
    const value = await harness(root, holdingBackend(root, control))
    const enrolled = await value.auth.enroll(principal, 'phone')
    control.hold = true
    const login = value.auth.login(enrolled.deviceToken)
    await started
    const disposal = value.fiber.dispose()
    await Promise.resolve()
    await expect(value.auth.login(enrolled.deviceToken)).rejects.toMatchObject({ code: 'service-closing' })
    let disposed = false
    void disposal.then(() => { disposed = true })
    await Promise.resolve()
    expect(disposed).toBe(false)
    release()
    await expect(login).resolves.toMatchObject({ device: { id: enrolled.device.id } })
    await disposal
    await value.facility.closeAll()
    await value.backend.close()
  })

  it('fails loud when a durable record contains malformed security fields', async () => {
    const root = await mkdtemp(join(tmpdir(), 'dsh-device-auth-'))
    roots.push(root)
    const storedPrincipal = canonicalDevicePrincipal(principal)
    await writeFile(join(root, 'device_auth.json'), JSON.stringify({
      unit: { name: 'device_auth', version: 1 }, global: null,
      tables: { devices: { bad: {
        principal: storedPrincipal,
        label: 'bad', credentialSalt: Buffer.alloc(16, 1).toString('base64url'),
        credentialHash: Buffer.alloc(32, 2).toString('base64url'), createdAt: 1, updatedAt: 1,
      } } },
    }))
    const ctx = new Context()
    await ctx.plugin(Storage)
    const backend = new JsonStorageBackend(root)
    ctx.storage.backend.register('json', backend)
    const facility = new DomainFacility(ctx, { backend: 'json', routes: {} })
    ctx.storage.mount('domain', facility)
    ctx.provide('storageDomain', facility)
    await expect(ctx.plugin(DeviceAuthDomain, config).then(fiber => fiber.await()))
      .rejects.toMatchObject({ code: 'invalid-record' })
    await writeFile(join(root, 'device_auth.json'), JSON.stringify({
      unit: { name: 'device_auth', version: 1 }, global: null, tables: { devices: {} },
    }))
    const recovered = await ctx.plugin(DeviceAuthDomain, config)
    await recovered.await()
    expect(ctx.deviceAuth.listDevices()).toEqual([])
    await recovered.dispose()
    await facility.closeAll()
    await backend.close()
  })

  it('contains invalidation listener failures after the durable commit', async () => {
    const root = await mkdtemp(join(tmpdir(), 'dsh-device-auth-'))
    roots.push(root)
    const value = await harness(root)
    const enrolled = await value.auth.enroll(principal, 'phone')
    value.ctx.on('device-auth/session-invalidated', () => { throw new Error('observer failed') })
    await expect(value.auth.login(enrolled.deviceToken)).resolves.toMatchObject({ device: { id: enrolled.device.id } })
    await closeHarness(value)
  })

  it('keeps repeated revocation idempotent and exposes the revoked projection without a session', async () => {
    const root = await mkdtemp(join(tmpdir(), 'dsh-device-auth-'))
    roots.push(root)
    const value = await harness(root)
    const enrolled = await value.auth.enroll(principal, 'phone')
    await value.auth.revokeDevice(enrolled.device.id)
    await expect(value.auth.revokeDevice(enrolled.device.id)).resolves.toBeUndefined()
    const [revoked] = value.auth.listDevices()
    expect(revoked?.id).toBe(enrolled.device.id)
    expect(typeof revoked?.revokedAt).toBe('number')
    expect(revoked).not.toHaveProperty('session')
    await closeHarness(value)
    expect(() => value.auth.listDevices()).toThrow('device-auth domain is not initialized')
  })

  it('rejects inconsistent and non-canonical durable records', () => {
    const canonical = canonicalDevicePrincipal(principal)
    const base = {
      principal: canonical,
      label: 'phone',
      credentialSalt: Buffer.alloc(16, 1).toString('base64url'),
      credentialHash: Buffer.alloc(32, 2).toString('base64url'),
      createdAt: 10,
      updatedAt: 20,
    }
    expect(deviceAuthRecord.safeParse({ ...base, updatedAt: 9 }).success).toBe(false)
    expect(deviceAuthRecord.safeParse({ ...base, revokedAt: 9 }).success).toBe(false)
    expect(deviceAuthRecord.safeParse({ ...base, revokedAt: 21 }).success).toBe(false)
    expect(deviceAuthRecord.safeParse({
      ...base,
      session: { id: Buffer.alloc(32, 3).toString('base64url'), hash: Buffer.alloc(32, 4).toString('base64url'), expiresAt: 9 },
    }).success).toBe(false)
    expect(deviceAuthRecord.safeParse({
      ...base, principal: { ...canonical, id: Buffer.alloc(32, 5).toString('base64url') },
    }).success).toBe(false)
    expect(deviceAuthRecord.safeParse({ ...base, principal: { ...canonical, issuer: 'not-a-url' } }).success).toBe(false)
  })
})
