/** Package-owned invariant companion. @module @deepseek-ai/dsh-device-auth/invariant */
import type { Context } from '@deepseek-ai/cordis'
import type { InvariantInstaller } from '@deepseek-ai/dsh-invariants'

// No runtime invariant: the abstract service owns no independently observable mutable relationship.
const install: InvariantInstaller = () => {}
export const name = 'device-auth-invariant'
export const inject = ['invariants']
/** The abstract service owns no mutable relationship that an independent observer can check. */
export const apply = (ctx: Context): Promise<() => void> =>
  Promise.resolve(ctx.invariants.register('@deepseek-ai/dsh-device-auth', install))
