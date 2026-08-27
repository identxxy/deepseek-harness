/** tmux policy used when attached Clients report different terminal sizes. */
export type WindowSizePolicy = 'largest' | 'smallest' | 'latest'

/** Fully explicit tmux Console provider configuration. */
export interface Config {
  /** tmux executable resolved at service initialization. */
  tmuxPath: string
  /** Dedicated tmux socket name; the default user server is never used. */
  serverName: string
  /** Interactive shell executable resolved at service initialization. */
  shellPath: string
  /** Must be empty: tmux accepts one shell-command string rather than an argv vector. */
  shellArgs: string[]
  /** TERM value advertised by Web attachment PTYs. */
  term: string
  /** tmux window-size policy for concurrent Clients. */
  windowSizePolicy: WindowSizePolicy
  /** Maximum wall time for one non-interactive tmux command. */
  commandTimeoutMs: number
  /** Termination and output-drain grace for one non-interactive tmux command. */
  commandGraceMs: number
  /** Maximum stdout or stderr bytes retained for one non-interactive tmux command. */
  commandOutputBytes: number
  /** Termination grace for one Web attachment tmux Client. */
  attachmentGraceMs: number
  /** Idle lifetime of a disconnected Web attachment. */
  attachmentIdleTtlMs: number
  /** Interval between bounded catalog reconciliations. */
  reconcileIntervalMs: number
  /** Maximum terminal output bytes retained for one attachment. */
  outputRetentionBytes: number
  /** Maximum retained bytes returned by one output read. */
  maxReadBytes: number
  /** Maximum simultaneous output waiters for one attachment. */
  maxOutputWaitersPerAttachment: number
  /** Maximum durable Consoles admitted by this provider. */
  maxConsoles: number
  /** Maximum concurrent Web attachments admitted for one Console. */
  maxAttachmentsPerConsole: number
}

/**
 * Enforce relationships and argv-safe values not expressible in field schemas.
 * @param config - Parsed configuration.
 */
export function validateConfig(config: Config): void {
  if (!/^[A-Za-z0-9_.-]+$/.test(config.serverName)) {
    throw new Error('console-tmux: serverName must contain only letters, digits, dot, underscore, or hyphen')
  }
  if (config.shellArgs.length !== 0) throw new Error('console-tmux: shellArgs must be empty because tmux cannot preserve an argv vector')
  if (config.maxReadBytes > config.outputRetentionBytes) {
    throw new Error('console-tmux: maxReadBytes must not exceed outputRetentionBytes')
  }
}
