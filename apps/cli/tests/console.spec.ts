import { existsSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { vi } from 'vitest'
import { encodeConsoleMetadata } from '@deepseek-ai/dsh-console-tmux'
import { runConsole } from '../src/console.ts'

describe('native Console command', () => {
  it('has an isolated command module', () => {
    expect(existsSync(fileURLToPath(new URL('../src/console.ts', import.meta.url)))).toBe(true)
  })

  it('lists only sessions with matching DSH names and metadata', () => {
    const id = '01234567-89ab-4def-8123-456789abcdef'
    const metadata = encodeConsoleMetadata({
      version: 1, consoleId: id, workspaceId: 'workspace', cwd: '/workspace', title: 'Research shell',
      createdAt: '2026-08-26T09:00:00.000Z', archived: false,
    })
    const spawnSync = vi.fn(() => ({
      status: 0,
      stdout: Buffer.from(`dsh-${id}\t${metadata}\nordinary\tgarbage\n`),
      stderr: Buffer.alloc(0),
    }))
    const stdout: string[] = []
    expect(runConsole(
      { action: 'list', tmuxPath: '/usr/bin/tmux', serverName: 'dsh' },
      { spawnSync: spawnSync as never, env: {}, stdout: value => stdout.push(value), stderr: vi.fn() },
    )).toBe(0)
    expect(spawnSync).toHaveBeenCalledExactlyOnceWith('/usr/bin/tmux', [
      '-L', 'dsh', 'list-sessions', '-F', '#{session_name}\t#{@dsh-console}',
    ], expect.objectContaining({ encoding: 'buffer' }))
    expect(stdout.join('')).toContain(`${id}\tactive\tResearch shell\t/workspace`)
    expect(stdout.join('')).not.toContain('ordinary')
  })

  it('refuses an implicit nested tmux Client', () => {
    const spawnSync = vi.fn()
    const stderr: string[] = []
    expect(runConsole(
      { action: 'attach', consoleId: '01234567-89ab-4def-8123-456789abcdef', tmuxPath: 'tmux', serverName: 'dsh' },
      { spawnSync: spawnSync as never, env: { TMUX: '/tmp/tmux,1,0' }, stdout: vi.fn(), stderr: value => stderr.push(value) },
    )).toBe(1)
    expect(spawnSync).not.toHaveBeenCalled()
    expect(stderr.join('')).toContain('already inside tmux')
  })

  it('verifies metadata before attaching the current terminal to the native tmux Client', () => {
    const id = '01234567-89ab-4def-8123-456789abcdef'
    const metadata = encodeConsoleMetadata({
      version: 1, consoleId: id, workspaceId: 'workspace', cwd: '/workspace', title: 'Research shell',
      createdAt: '2026-08-26T09:00:00.000Z', archived: false,
    })
    const spawnSync = vi.fn()
      .mockReturnValueOnce({ status: 0, stdout: Buffer.from(`${metadata}\n`), stderr: Buffer.alloc(0) })
      .mockReturnValueOnce({ status: 0, stdout: null, stderr: null })
    expect(runConsole(
      { action: 'attach', consoleId: id, tmuxPath: '/usr/bin/tmux', serverName: 'dsh' },
      { spawnSync: spawnSync as never, env: {}, stdout: vi.fn(), stderr: vi.fn() },
    )).toBe(0)
    expect(spawnSync).toHaveBeenNthCalledWith(1, '/usr/bin/tmux', [
      '-L', 'dsh', 'show-options', '-v', '-t', `dsh-${id}`, '@dsh-console',
    ], { encoding: 'buffer' })
    expect(spawnSync).toHaveBeenNthCalledWith(2, '/usr/bin/tmux', [
      '-L', 'dsh', 'attach-session', '-E', '-t', `dsh-${id}`,
    ], { stdio: 'inherit' })
  })
})
