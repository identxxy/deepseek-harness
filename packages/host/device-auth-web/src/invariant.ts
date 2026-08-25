/** Package invariant companion. @module @deepseek-ai/dsh-host-device-auth-web/invariant */
import type { Context } from '@deepseek-ai/cordis'
import type { InvariantInstaller } from '@deepseek-ai/dsh-invariants'

export const name = 'host-device-auth-web-invariant'
export const inject = ['invariants']

// No runtime invariant: ingress and route ownership is asserted by
// real-composition disposal coverage because those private seats cannot be
// observed authoritatively after their owning effects unwind.
const install: InvariantInstaller = () => {}

/** Register the package invariant companion. */
export const apply = (ctx: Context): Promise<() => void> =>
  Promise.resolve(ctx.invariants.register('@deepseek-ai/dsh-host-device-auth-web', install))
