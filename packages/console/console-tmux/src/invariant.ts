/** Package-owned invariant companion for the tmux Console provider. @module @deepseek-ai/dsh-console-tmux/invariant */
import type { Context } from '@deepseek-ai/cordis'
import type { InvariantInstaller } from '@deepseek-ai/dsh-invariants'
const PACKAGE_NAME = '@deepseek-ai/dsh-console-tmux'
export const name = 'console-tmux-invariant'
export const inject = ['invariants']
/** No runtime invariant: tmux discovery, attachment authorization, and publication state are provider-private. */
const install: InvariantInstaller = () => {}
/** @param ctx - Context carrying invariant registration. @returns registration disposer. */
export const apply = (ctx: Context): Promise<() => void> => Promise.resolve(ctx.invariants.register(PACKAGE_NAME, install))
