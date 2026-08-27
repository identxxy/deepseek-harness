import { describe, expect, it, vi } from 'vitest'
import { TmuxCommandRunner } from '../src/tmux-command.ts'

describe('tmux command adapter', () => {
  it('publishes the argv-only command adapter', async () => {
    const provider = await import('../src/index.ts')
    expect(provider).toHaveProperty('TmuxCommandRunner')
  })

  it('publishes one run operation', () => {
    expect(TmuxCommandRunner.prototype).toHaveProperty('run')
  })

  it('spawns exact dedicated-server argv and returns bounded outputs', async () => {
    const spawn = vi.fn(() => ({
      pid: 1,
      stdin: undefined,
      stdout: undefined,
      stderr: undefined,
      collected: {
        stdout: { readFrom: () => ({ text: 'tmux out', nextOffset: 8, lossy: false }) },
        stderr: { readFrom: () => ({ text: 'tmux err', nextOffset: 8, lossy: false }) },
      },
      done: Promise.resolve({ exitCode: 0, signal: null }),
      terminate: vi.fn(),
      waitForExit: vi.fn(async () => true),
    }))
    const runner = new TmuxCommandRunner({ spawn }, {
      executable: '/resolved/tmux', serverName: 'dsh-test', cwd: '/host',
      commandTimeoutMs: 5_000, commandGraceMs: 100, commandOutputBytes: 4_096,
    })
    await expect(runner.run(['display-message', '-p', 'ok'])).resolves.toEqual({
      stdout: 'tmux out', stderr: 'tmux err', exitCode: 0, signal: null,
    })
    expect(spawn).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({
      argv: ['/resolved/tmux', '-L', 'dsh-test', 'display-message', '-p', 'ok'],
      cwd: '/host',
      stdio: {
        stdin: 'ignore',
        stdout: { maxBytes: 4_096 },
        stderr: { maxBytes: 4_096 },
      },
      graceMs: 100,
    }))
  })

  it('combines caller cancellation and tolerates absent collected streams', async () => {
    const spawn = vi.fn(() => ({
      collected: {},
      done: Promise.resolve({ exitCode: null, signal: 'SIGTERM' }),
    }))
    const runner = new TmuxCommandRunner({ spawn } as never, {
      executable: 'tmux', serverName: 'test', cwd: '/host', commandTimeoutMs: 5_000,
      commandGraceMs: 100, commandOutputBytes: 100,
    })
    const signal = new AbortController().signal
    await expect(runner.run(['list-sessions'], signal)).resolves.toEqual({
      stdout: '', stderr: '', exitCode: null, signal: 'SIGTERM',
    })
    expect(spawn).toHaveBeenCalledWith(expect.objectContaining({
      signal: expect.any(AbortSignal) as unknown as AbortSignal,
    }))
  })

  it.each(['stdout', 'stderr'] as const)('fails loudly when collected %s is lossy', async (stream) => {
    const read = (name: 'stdout' | 'stderr') => ({ readFrom: () => ({ text: name, nextOffset: 1, lossy: name === stream }) })
    const spawn = vi.fn(() => ({
      collected: { stdout: read('stdout'), stderr: read('stderr') },
      done: Promise.resolve({ exitCode: 0, signal: null }),
    }))
    const runner = new TmuxCommandRunner({ spawn } as never, {
      executable: 'tmux', serverName: 'test', cwd: '/host', commandTimeoutMs: 5_000,
      commandGraceMs: 100, commandOutputBytes: 100,
    })
    await expect(runner.run(['list-sessions'])).rejects.toMatchObject({ code: 'PROVIDER_FAILURE' })
  })

  it('preserves caller cancellation after a process reports successful exit', async () => {
    let finish!: (value: { exitCode: number; signal: null }) => void
    const done = new Promise<{ exitCode: number; signal: null }>((resolve) => { finish = resolve })
    const spawn = vi.fn(() => ({ collected: {}, done }))
    const runner = new TmuxCommandRunner({ spawn } as never, {
      executable: 'tmux', serverName: 'test', cwd: '/host', commandTimeoutMs: 5_000,
      commandGraceMs: 100, commandOutputBytes: 100,
    })
    const controller = new AbortController()
    const running = runner.run(['list-sessions'], controller.signal)
    controller.abort(new Error('caller cancelled'))
    finish({ exitCode: 0, signal: null })
    await expect(running).rejects.toThrow('caller cancelled')
  })

  it('preserves command timeout after a process reports successful exit', async () => {
    let finish!: (value: { exitCode: number; signal: null }) => void
    const done = new Promise<{ exitCode: number; signal: null }>((resolve) => { finish = resolve })
    const runner = new TmuxCommandRunner({ spawn: () => ({ collected: {}, done }) } as never, {
      executable: 'tmux', serverName: 'test', cwd: '/host', commandTimeoutMs: 1,
      commandGraceMs: 100, commandOutputBytes: 100,
    })
    const running = runner.run(['list-sessions'])
    await new Promise(resolve => setTimeout(resolve, 10))
    finish({ exitCode: 0, signal: null })
    await expect(running).rejects.toMatchObject({ name: 'TimeoutError' })
  })
})
