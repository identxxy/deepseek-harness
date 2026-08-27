import { describe, expect, it } from 'vitest'
import { decodeConsoleMetadata, encodeConsoleMetadata } from '../src/metadata.ts'

describe('tmux console metadata codec', () => {
  it('publishes one encode/decode pair', async () => {
    const provider = await import('../src/index.ts')
    expect(provider).toHaveProperty('encodeConsoleMetadata')
    expect(provider).toHaveProperty('decodeConsoleMetadata')
  })

  it('round-trips one versioned record without exposing raw fields', () => {
    const metadata = {
      version: 1 as const,
      consoleId: 'console-1',
      workspaceId: 'workspace-1',
      cwd: '/private/workspace',
      title: 'Research shell',
      createdAt: '2026-08-26T09:00:00.000Z',
      archived: false,
    }
    const encoded = encodeConsoleMetadata(metadata)
    expect(encoded).toMatch(/^dsh-console:v1:[A-Za-z0-9_-]+$/)
    expect(encoded).not.toContain(metadata.cwd)
    expect(encoded).not.toContain(metadata.title)
    expect(decodeConsoleMetadata(encoded)).toEqual(metadata)
  })

  it('rejects non-owned and malformed option values', () => {
    expect(decodeConsoleMetadata('ordinary tmux option')).toBeUndefined()
    expect(decodeConsoleMetadata('dsh-console:v1:not-json')).toBeUndefined()
    const array = `dsh-console:v1:${Buffer.from('[]').toString('base64url')}`
    expect(decodeConsoleMetadata(array)).toBeUndefined()
  })

  it.each([
    { version: 2, consoleId: 'c', workspaceId: 'w', cwd: '/w', title: 't', createdAt: '2026-08-26T09:00:00.000Z', archived: false },
    { version: 1, workspaceId: 'w', cwd: '/w', title: 't', createdAt: '2026-08-26T09:00:00.000Z', archived: false },
    { version: 1, consoleId: 'c', workspaceId: 'w', cwd: '/w', title: 't', createdAt: 'not-a-date', archived: false },
    { version: 1, consoleId: 'c', workspaceId: 'w', cwd: '/w', title: 't', createdAt: '2026-08-26T09:00:00Z', archived: false },
    { version: 1, consoleId: 'c', workspaceId: 'w', cwd: '/w', title: 't', createdAt: '2026-08-26T09:00:00.000Z', archived: 'false' },
  ])('rejects an invalid decoded record %#', (value) => {
    const encoded = `dsh-console:v1:${Buffer.from(JSON.stringify(value)).toString('base64url')}`
    expect(decodeConsoleMetadata(encoded)).toBeUndefined()
  })
})
