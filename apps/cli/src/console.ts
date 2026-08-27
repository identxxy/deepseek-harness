import { spawnSync } from 'node:child_process'
import {
  CONSOLE_TMUX_METADATA_OPTION, consoleTmuxSessionName, decodeConsoleMetadata, parseConsoleTmuxSessionName,
} from '@deepseek-ai/dsh-console-tmux'
import { ConsoleId } from '@deepseek-ai/dsh-console'

/** Native tmux Console command options. */
export interface ConsoleCommandOptions {
  readonly action: 'list' | 'attach'
  readonly tmuxPath: string
  readonly serverName: string
  readonly consoleId?: string
}

/** Injectable process and stream functions used by unit tests. */
export interface ConsoleCommandInternals {
  readonly spawnSync: typeof spawnSync
  readonly env: NodeJS.ProcessEnv
  readonly stdout: (value: string) => void
  readonly stderr: (value: string) => void
}

const DEFAULT_INTERNALS: ConsoleCommandInternals = {
  spawnSync,
  env: process.env,
  stdout: value => process.stdout.write(value),
  stderr: value => process.stderr.write(value),
}

function printable(value: string): string {
  return value.replaceAll(/[\u0000-\u001f\u007f]+/g, ' ')
}

function noServer(stderr: string): boolean {
  const diagnostic = stderr.trim()
  return diagnostic.toLowerCase().includes('no server running')
    || /^error connecting to .+ \(No such file or directory\)$/.test(diagnostic)
}

function list(options: ConsoleCommandOptions, internals: ConsoleCommandInternals): number {
  const result = internals.spawnSync(options.tmuxPath, [
    '-L', options.serverName, 'list-sessions', '-F', `#{session_name}\t#{${CONSOLE_TMUX_METADATA_OPTION}}`,
  ], { encoding: 'buffer' })
  if (result.error !== undefined) {
    internals.stderr(`dsh console list: ${result.error.message}\n`)
    return 1
  }
  const stderr = result.stderr.toString('utf8')
  if (result.status !== 0) {
    if (result.status === 1 && noServer(stderr)) return 0
    internals.stderr(`dsh console list: ${stderr.trim() || `tmux exited ${String(result.status)}`}\n`)
    return result.status ?? 1
  }
  const stdout = result.stdout.toString('utf8')
  for (const line of stdout.split('\n')) {
    const separator = line.indexOf('\t')
    if (separator < 0) continue
    const sessionName = line.slice(0, separator)
    const id = parseConsoleTmuxSessionName(sessionName)
    const metadata = decodeConsoleMetadata(line.slice(separator + 1))
    if (id === undefined || metadata === undefined || metadata.consoleId !== id) continue
    internals.stdout(
      `${id}\t${metadata.archived ? 'archived' : 'active'}\t${printable(metadata.title)}\t${printable(metadata.cwd)}\n`,
    )
  }
  return 0
}

function attach(options: ConsoleCommandOptions, internals: ConsoleCommandInternals): number {
  if (internals.env['TMUX'] !== undefined && internals.env['TMUX'] !== '') {
    internals.stderr('dsh console attach: already inside tmux; detach first or run the command from a plain Kitty split\n')
    return 1
  }
  let sessionName: string
  try {
    sessionName = consoleTmuxSessionName(ConsoleId(options.consoleId ?? ''))
  } catch (error) {
    internals.stderr(`dsh console attach: ${error instanceof Error ? error.message : String(error)}\n`)
    return 1
  }
  const inspected = internals.spawnSync(options.tmuxPath, [
    '-L', options.serverName, 'show-options', '-v', '-t', sessionName, CONSOLE_TMUX_METADATA_OPTION,
  ], { encoding: 'buffer' })
  if (inspected.error !== undefined) {
    internals.stderr(`dsh console attach: ${inspected.error.message}\n`)
    return 1
  }
  if (inspected.status !== 0) {
    const diagnostic = inspected.stderr.toString('utf8').trim()
    internals.stderr(`dsh console attach: ${diagnostic || 'Console not found'}\n`)
    return inspected.status ?? 1
  }
  const metadata = decodeConsoleMetadata(inspected.stdout.toString('utf8').trim())
  if (metadata === undefined || metadata.consoleId !== options.consoleId) {
    internals.stderr('dsh console attach: tmux session metadata does not match the requested Console\n')
    return 1
  }
  const attached = internals.spawnSync(options.tmuxPath, [
    '-L', options.serverName, 'attach-session', '-E', '-t', sessionName,
  ], { stdio: 'inherit' })
  if (attached.error !== undefined) {
    internals.stderr(`dsh console attach: ${attached.error.message}\n`)
    return 1
  }
  return attached.status ?? 1
}

/**
 * @param options - Resolved native Console command.
 * @param internals - Optional process adapters for testing.
 * @returns Process exit code.
 */
export function runConsole(options: ConsoleCommandOptions, internals: ConsoleCommandInternals = DEFAULT_INTERNALS): number {
  if (!/^[A-Za-z0-9_.-]+$/.test(options.serverName)) {
    internals.stderr('dsh console: --server-name contains unsupported characters\n')
    return 1
  }
  if (options.action === 'list') return list(options, internals)
  return attach(options, internals)
}
