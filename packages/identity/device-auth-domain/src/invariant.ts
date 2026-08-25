/** Package-owned invariant companion. @module @deepseek-ai/dsh-device-auth-domain/invariant */
import type { Context } from '@deepseek-ai/cordis'
import type { InvariantInstaller } from '@deepseek-ai/dsh-invariants'

// No runtime invariant: the complete domain record is the provider's sole authoritative state.
const install: InvariantInstaller = () => {}
export const name = 'device-auth-domain-invariant'
export const inject = ['invariants']
/** No independent mutable companion exists beyond the provider's authoritative domain record. */
export const apply = (ctx: Context): Promise<() => void> =>
  Promise.resolve(ctx.invariants.register('@deepseek-ai/dsh-device-auth-domain', install))
