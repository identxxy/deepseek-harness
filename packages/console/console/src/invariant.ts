/** Package-owned invariant companion for the console seam. @module @deepseek-ai/dsh-console/invariant */
import type { Context } from '@deepseek-ai/cordis'
import type { InvariantInstaller } from '@deepseek-ai/dsh-invariants'

const PACKAGE_NAME = '@deepseek-ai/dsh-console'
export const name = 'console-invariant'
export const inject = ['invariants']
/** No runtime invariant: the Service Definition publishes types while providers own records. */
const install: InvariantInstaller = () => {}
/** @param ctx - Context carrying invariant registration. @returns registration disposer. */
export const apply = (ctx: Context): Promise<() => void> => Promise.resolve(ctx.invariants.register(PACKAGE_NAME, install))
