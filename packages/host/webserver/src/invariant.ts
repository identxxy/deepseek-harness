/**
 * Package-owned invariant companion for `@deepseek-ai/dsh-host-webserver`.
 * @module @deepseek-ai/dsh-host-webserver/invariant
 */

/* jscpd:ignore-start */
import type { Context } from '@deepseek-ai/cordis'
import type { InvariantInstaller } from '@deepseek-ai/dsh-invariants'

const PACKAGE_NAME = '@deepseek-ai/dsh-host-webserver'

/** Cordis companion plugin name. */
export const name = 'host-webserver-invariant'
/** Service required before the companion can register. */
export const inject = ['invariants']

/**
 * Owned relation: HTTP and upgrade routes must be registrable again after
 * their disposer runs. Otherwise an unloaded plugin leaves a handler active
 * or prevents its replacement from loading. Checked on every fiber teardown
 * (`internal/plugin`) with reserved-path register/dispose probes.
 */
const install: InvariantInstaller = (ctx, fail) => {
  ctx.on('internal/plugin', () => {
    const server = ctx.get('webServer') as
      | {
        register(route: { kind: 'exact'; path: string; handler: () => void }): () => void
        registerUpgrade(route: { path: string; handler: () => void }): () => void
      }
      | undefined
    if (server === undefined) return // no webserver row in this composition
    // Register/dispose probe on a reserved path: if dispose leaves the route
    // behind, a second register throws the duplicate error — the asymmetry.
    // Each register(probe)() is one register+dispose cycle, so the probe never
    // leaves residue; a leftover from the first cycle makes the second throw.
    const probe = { kind: 'exact' as const, path: '/__dsh_invariant_probe__', handler: () => {} }
    try {
      server.register(probe)()
      server.register(probe)()
      const upgradeProbe = { path: '/__dsh_invariant_upgrade_probe__', handler: () => {} }
      server.registerUpgrade(upgradeProbe)()
      server.registerUpgrade(upgradeProbe)()
    } catch {
      fail('webServer route disposer left a route registered after its lifecycle ended')
    }
  }, { global: true })
}

/**
 * Register this package's invariant companion.
 * @param ctx - Cordis context carrying the invariant service.
 * @returns the installed registration's disposer after setup succeeds.
 */
export const apply = (ctx: Context): Promise<() => void> =>
  Promise.resolve(ctx.invariants.register(PACKAGE_NAME, install))
/* jscpd:ignore-end */
