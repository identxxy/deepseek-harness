/** Package-owned invariant companion for console Remote. @module @deepseek-ai/dsh-console-remote/invariant */
import type { Context } from '@deepseek-ai/cordis'
import type { InvariantInstaller } from '@deepseek-ai/dsh-invariants'
const PACKAGE_NAME = '@deepseek-ai/dsh-console-remote'
export const name = 'console-remote-invariant'
export const inject = ['invariants']
/** No runtime invariant: generated Typert artifacts verify the declared Remote methods. */
const install: InvariantInstaller = () => {}
/** @param ctx - Context carrying invariant registration. @returns registration disposer. */
export const apply = (ctx: Context): Promise<() => void> => Promise.resolve(ctx.invariants.register(PACKAGE_NAME, install))
