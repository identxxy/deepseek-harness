/** Package-owned invariant companion for the Human Terminal browser plugin. */

import type { Context } from '@deepseek-ai/cordis'
import type { InvariantInstaller } from '@deepseek-ai/dsh-invariants'

const PACKAGE_NAME = '@deepseek-ai/dsh-client-ui-console'

/** Cordis companion plugin name. */
export const name = 'client-ui-console-invariant'
/** Service required before package ownership registration. */
export const inject = ['invariants']
const install: InvariantInstaller = () => {
  // No runtime invariant: the browser plugin owns no Host-side relationship.
}

/**
 * Register package ownership with the invariant registry.
 * @param ctx - Cordis context carrying the invariant service.
 * @returns registration disposer.
 */
export const apply = (ctx: Context): Promise<() => void> =>
  Promise.resolve(ctx.invariants.register(PACKAGE_NAME, install))
