import z from '@deepseek-ai/schemastery'

/** Deployment configuration shared by the Host bootstrap and browser plugin. */
export interface Config {
  /** Bounded interval between durable Console catalog refreshes. */
  readonly catalogRefreshIntervalMs: number
}

/** Required deployment tunables. */
export const Config: z<Config> = z.object({
  catalogRefreshIntervalMs: z.number().step(1).min(1).required(),
})

/** Browser bootstrap global populated by the Host plugin. */
export const CONSOLE_CONFIG_GLOBAL = '__DSH_CONSOLE_CONFIG__'
