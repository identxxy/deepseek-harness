import { Context } from '@deepseek-ai/cordis'
import InvariantRegistry from '@deepseek-ai/dsh-invariants'
import { describe, expect, it } from 'vitest'
import DeviceAuthService, { canonicalDevicePrincipal, DeviceAuthError } from '../src/index.ts'
import * as DeviceAuthInvariant from '../src/invariant.ts'

const principal = { issuer: 'https://issuer.example', subject: 'subject', email: ' owner@example.com ' }

describe('device-auth service definition', () => {
  it('canonicalizes verified principals and keeps the stable identity independent of email', () => {
    const first = canonicalDevicePrincipal(principal)
    const second = canonicalDevicePrincipal({ ...principal, email: 'other@example.com' })
    expect(first).toMatchObject({ issuer: principal.issuer, subject: principal.subject, email: 'owner@example.com' })
    expect(first.id).toBe(second.id)
  })

  it.each([
    [{ ...principal, issuer: '' }, 'absolute issuer URL'],
    [{ ...principal, issuer: ' https://issuer.example' }, 'absolute issuer URL'],
    [{ ...principal, issuer: 'issuer.example' }, 'absolute issuer URL'],
    [{ ...principal, issuer: 'https://issuer.example?tenant=one' }, 'absolute issuer URL'],
    [{ ...principal, issuer: 'https://issuer.example#fragment' }, 'absolute issuer URL'],
    [{ ...principal, subject: ' ' }, 'non-empty subject and email'],
    [{ ...principal, email: ' ' }, 'non-empty subject and email'],
    [{ ...principal, email: 'owner.example.com' }, 'non-empty subject and email'],
  ])('rejects a non-canonical verified principal', (value, message) => {
    let thrown: unknown
    try { canonicalDevicePrincipal(value) } catch (error) { thrown = error }
    expect(thrown).toBeInstanceOf(DeviceAuthError)
    expect((thrown as DeviceAuthError).code).toBe('invalid-principal')
    expect((thrown as DeviceAuthError).message).toContain(message)
  })

  it('rejects direct construction without a provider', () => {
    const Concrete = DeviceAuthService as unknown as new (ctx: Context) => DeviceAuthService
    expect(() => new Concrete(new Context())).toThrow('@deepseek-ai/dsh-device-auth requires a provider')
  })
})

describe('device-auth invariant companion', () => {
  it('registers the stateless seam under its package name', async () => {
    const ctx = new Context()
    await ctx.plugin(InvariantRegistry, { enabled: true })
    await expect(ctx.plugin(DeviceAuthInvariant).await()).resolves.toBeDefined()
  })
})
