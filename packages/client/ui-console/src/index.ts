/** Host bootstrap for browser Human Terminal configuration. */

import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-host-webserver'
import { CONSOLE_CONFIG_GLOBAL, Config } from './config.ts'

export { Config } from './config.ts'

/** Host services required to inject browser configuration. */
export const inject = ['webServer']

/** Inject validated Console browser configuration into every served index. */
export function apply(ctx: Context, config: Config): void {
  ctx.on('webserver/index-inject', (table) => {
    table.push({ kind: 'global', name: CONSOLE_CONFIG_GLOBAL, value: config })
  })
}
