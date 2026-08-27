import type { SubprocessRuntime } from '@deepseek-ai/dsh-subprocess'
import { ConsoleError } from '@deepseek-ai/dsh-console'

/** Result of one settled tmux command. */
export interface TmuxCommandResult {
  readonly stdout: string
  readonly stderr: string
  readonly exitCode: number | null
  readonly signal: NodeJS.Signals | null
}

/** Resolved execution settings for one dedicated tmux server. */
export interface TmuxCommandOptions {
  readonly executable: string
  readonly serverName: string
  readonly cwd: string
  readonly commandTimeoutMs: number
  readonly commandGraceMs: number
  readonly commandOutputBytes: number
  readonly env?: NodeJS.ProcessEnv | undefined
}

/** argv-only adapter for commands sent to one dedicated tmux server. */
export class TmuxCommandRunner {
  /** @param subprocess - Process-tree provider. @param options - Resolved tmux execution settings. */
  constructor(
    private readonly subprocess: Pick<SubprocessRuntime, 'spawn'>,
    private readonly options: TmuxCommandOptions,
  ) {}

  /**
   * Run one argv-only command against the configured dedicated tmux server.
   * @param args - tmux command and arguments after the dedicated-server selector.
   * @param signal - Caller cancellation.
   * @returns Settled command output and exit facts.
   */
  async run(args: readonly string[], signal?: AbortSignal): Promise<TmuxCommandResult> {
    const timeout = AbortSignal.timeout(this.options.commandTimeoutMs)
    const combined = signal === undefined ? timeout : AbortSignal.any([signal, timeout])
    combined.throwIfAborted()
    const handle = this.subprocess.spawn({
      argv: [this.options.executable, '-L', this.options.serverName, ...args],
      cwd: this.options.cwd,
      stdio: {
        stdin: 'ignore',
        stdout: { maxBytes: this.options.commandOutputBytes },
        stderr: { maxBytes: this.options.commandOutputBytes },
      },
      graceMs: this.options.commandGraceMs,
      signal: combined,
      env: this.options.env,
    })
    const outcome = await handle.done
    combined.throwIfAborted()
    const stdout = handle.collected.stdout?.readFrom(0)
    const stderr = handle.collected.stderr?.readFrom(0)
    if (stdout?.lossy === true || stderr?.lossy === true) {
      throw new ConsoleError('PROVIDER_FAILURE', 'tmux command output exceeded the configured retention limit')
    }
    return {
      stdout: stdout?.text ?? '',
      stderr: stderr?.text ?? '',
      exitCode: outcome.exitCode,
      signal: outcome.signal,
    }
  }
}
