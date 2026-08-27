import { ConsoleId } from '@deepseek-ai/dsh-console'

/** tmux user option holding the versioned Console metadata value. */
export const CONSOLE_TMUX_METADATA_OPTION = '@dsh-console'

const SESSION_NAME_PREFIX = 'dsh-'
const UUID_V4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/

/**
 * Derive the provider-owned tmux session name for one Console.
 * @param consoleId - Durable Console identity.
 * @returns Its tmux session name.
 */
export function consoleTmuxSessionName(consoleId: ConsoleId): string {
  if (!UUID_V4.test(consoleId)) throw new Error('ConsoleId must be a lowercase UUID v4')
  return `${SESSION_NAME_PREFIX}${consoleId}`
}

/**
 * Parse a provider-owned tmux session name.
 * @param sessionName - tmux session name.
 * @returns The embedded Console identity when DSH owns the name.
 */
export function parseConsoleTmuxSessionName(sessionName: string): ConsoleId | undefined {
  if (!sessionName.startsWith(SESSION_NAME_PREFIX)) return undefined
  const value = sessionName.slice(SESSION_NAME_PREFIX.length)
  return UUID_V4.test(value) ? ConsoleId(value) : undefined
}
