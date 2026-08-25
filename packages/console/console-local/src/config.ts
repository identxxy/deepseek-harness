/** Fully explicit local console provider configuration. */
export interface Config {
  /** Interactive shell executable resolved at service initialization. */
  shellPath: string
  /** Arguments appended to the resolved shell executable. */
  shellArgs: string[]
  /** `TERM` value supplied as the only explicit child environment entry. */
  term: string
  /** Positive terminal-session termination grace in milliseconds. */
  disposeGraceMs: number
  /** Maximum number of raw terminal output bytes retained in memory. */
  outputRetentionBytes: number
  /** Maximum number of retained bytes returned by one output read. */
  maxReadBytes: number
  /** Maximum simultaneous output waiters admitted for one console. */
  maxOutputWaitersPerConsole: number
}

/**
 * Enforce relationships not expressible in the field schemas.
 * @param config - Parsed configuration.
 */
export function validateConfig(config: Config): void {
  if (config.shellArgs.some(arg => arg.length === 0)) throw new Error('console-local: shellArgs entries must be non-empty')
  if (config.maxReadBytes > config.outputRetentionBytes) {
    throw new Error('console-local: maxReadBytes must not exceed outputRetentionBytes')
  }
}
