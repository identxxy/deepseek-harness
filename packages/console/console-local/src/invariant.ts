/** Package-owned invariant companion for the local console provider. @module @deepseek-ai/dsh-console-local/invariant */
import type { Context } from '@deepseek-ai/cordis'
import type { InvariantInstaller } from '@deepseek-ai/dsh-invariants'
const PACKAGE_NAME = '@deepseek-ai/dsh-console-local'
export const name = 'console-local-invariant'
export const inject = ['invariants']
/** No runtime invariant: authorization and publication state are private and enforced by every operation. */
const install: InvariantInstaller = () => {}
/** @param ctx - Context carrying invariant registration. @returns registration disposer. */
export const apply = (ctx: Context): Promise<() => void> => Promise.resolve(ctx.invariants.register(PACKAGE_NAME, install))
