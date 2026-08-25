/** Durable device-auth domain declaration. @module @deepseek-ai/dsh-device-auth-domain/spec */
import { z } from 'zod'
import { defineDomain, domainTable } from '@deepseek-ai/dsh-storage-domain'
import { canonicalDevicePrincipal, DeviceId, DevicePrincipalId, DeviceSessionId } from '@deepseek-ai/dsh-device-auth'

const encodedBytes = (bytes: number, length: number) => z.string().regex(new RegExp(`^[A-Za-z0-9_-]{${length}}$`))
  .refine((value) => {
    const decoded = Buffer.from(value, 'base64url')
    return decoded.length === bytes && decoded.toString('base64url') === value
  })
const secret32 = encodedBytes(32, 43)
const salt16 = encodedBytes(16, 22)
const timestamp = z.number().int().nonnegative()
const nonBlank = z.string().refine(value => value.trim() !== '')

/** Durable validator for one complete device record. */
export const deviceAuthRecord = z.object({
  principal: z.object({ id: secret32.transform(DevicePrincipalId), issuer: nonBlank, subject: nonBlank, email: nonBlank }),
  label: z.string().min(1), credentialSalt: salt16, credentialHash: secret32,
  session: z.object({ id: secret32.transform(DeviceSessionId), hash: secret32, expiresAt: timestamp }).optional(),
  createdAt: timestamp, updatedAt: timestamp, revokedAt: timestamp.optional(),
}).superRefine((record, context) => {
  if (record.updatedAt < record.createdAt || (record.revokedAt !== undefined
    && (record.revokedAt < record.createdAt || record.revokedAt > record.updatedAt))) {
    context.addIssue({ code: 'custom', message: 'record timestamps are inconsistent' })
  }
  if (record.session !== undefined && record.session.expiresAt < record.createdAt) {
    context.addIssue({ code: 'custom', message: 'session expiry precedes device creation' })
  }
  try {
    const canonical = canonicalDevicePrincipal(record.principal)
    if (canonical.id !== record.principal.id || canonical.issuer !== record.principal.issuer
      || canonical.subject !== record.principal.subject || canonical.email !== record.principal.email) {
      context.addIssue({ code: 'custom', message: 'principal is not canonical' })
    }
  } catch {
    context.addIssue({ code: 'custom', message: 'principal is invalid' })
  }
})
/** Durable device record inferred from its read-boundary validator. */
export type DeviceAuthRecord = z.infer<typeof deviceAuthRecord>

/** Versioned storage unit with exactly one complete record per device. */
export const deviceAuthDomainSpec = defineDomain({
  name: 'device_auth', version: 1,
  tables: { devices: domainTable<ReturnType<typeof DeviceId>, DeviceAuthRecord>(deviceAuthRecord) },
})
