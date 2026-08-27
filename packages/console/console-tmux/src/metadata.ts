/** Durable DSH fields stored on one tmux session. */
export interface ConsoleMetadata {
  readonly version: 1
  readonly consoleId: string
  readonly workspaceId: string
  readonly cwd: string
  readonly title: string
  readonly createdAt: string
  readonly archived: boolean
}

const METADATA_PREFIX = 'dsh-console:v1:'

function nonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0
}

function decodeRecord(value: unknown): ConsoleMetadata | undefined {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return undefined
  const record = value as Record<string, unknown>
  if (record['version'] !== 1
    || !nonEmptyString(record['consoleId'])
    || !nonEmptyString(record['workspaceId'])
    || !nonEmptyString(record['cwd'])
    || !nonEmptyString(record['title'])
    || !nonEmptyString(record['createdAt'])
    || typeof record['archived'] !== 'boolean') return undefined
  try {
    if (new Date(record['createdAt']).toISOString() !== record['createdAt']) return undefined
  } catch {
    return undefined
  }
  return {
    version: 1,
    consoleId: record['consoleId'],
    workspaceId: record['workspaceId'],
    cwd: record['cwd'],
    title: record['title'],
    createdAt: record['createdAt'],
    archived: record['archived'],
  }
}

/**
 * Encode one validated metadata record for a tmux user option.
 * @param metadata - Durable Console metadata.
 * @returns The encoded option value.
 */
export function encodeConsoleMetadata(metadata: ConsoleMetadata): string {
  return `${METADATA_PREFIX}${Buffer.from(JSON.stringify(metadata)).toString('base64url')}`
}

/**
 * Decode one tmux user option value.
 * @param encoded - Encoded option value.
 * @returns The metadata, or undefined when the value is not owned by this version.
 */
export function decodeConsoleMetadata(encoded: string): ConsoleMetadata | undefined {
  if (!encoded.startsWith(METADATA_PREFIX)) return undefined
  try {
    return decodeRecord(JSON.parse(Buffer.from(encoded.slice(METADATA_PREFIX.length), 'base64url').toString('utf8')))
  } catch {
    return undefined
  }
}
