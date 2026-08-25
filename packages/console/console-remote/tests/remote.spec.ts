import { Context } from '@deepseek-ai/cordis'
import { describe, expect, expectTypeOf, it, vi } from 'vitest'
import { ConsoleError, ConsoleRuntime } from '@deepseek-ai/dsh-console'
import type { ConsoleAccess, ConsoleOpenResult, ConsoleOutputObservation, ConsoleOutputRead, ConsoleSignal, ConsoleSignalResult, ConsoleSize, ConsoleSnapshot, HumanShellOpenRequest } from '@deepseek-ai/dsh-console'
import { remoteMethods } from '@deepseek-ai/dsh-typert-protocol'
import ConsoleRemoteService from '../src/index.ts'
import type { ConsoleRemoteSignal } from '../src/types.ts'

const access = { consoleId: 'console' as ConsoleAccess['consoleId'], capability: 'capability' as ConsoleAccess['capability'] }
const state: ConsoleSnapshot = { id: access.consoleId, workspaceId: 'workspace' as never, cwd: '/workspace', pid: 123, size: { rows: 24, cols: 80 }, status: { kind: 'running' }, oldestOutputByte: 0, nextOutputByte: 2 }

class StubConsole extends ConsoleRuntime {
  readonly writeCall = vi.fn(async (_data: string) => {})
  current = state
  currentOutput: ConsoleOutputRead = { kind: 'data', data: Uint8Array.from([0, 255]), fromByte: 0, nextByte: 2, availableThroughByte: 2 }
  openHumanShell(_request: HumanShellOpenRequest): Promise<ConsoleOpenResult> { throw new Error('not exposed') }
  snapshot(value: ConsoleAccess): ConsoleSnapshot { if (value.capability !== access.capability) throw new ConsoleError('ACCESS_DENIED', 'secret'); return this.current }
  readOutput(): ConsoleOutputRead { return this.currentOutput }
  waitOutput(_access: ConsoleAccess, _fromByte: number, signal: AbortSignal): Promise<ConsoleOutputObservation> {
    signal.throwIfAborted()
    return new Promise((_resolve, reject) => {
      signal.addEventListener('abort', () => {
        reject(signal.reason instanceof Error ? signal.reason : new Error('aborted'))
      }, { once: true })
    })
  }
  write(_access: ConsoleAccess, data: string): Promise<void> { return this.writeCall(data) }
  resize(_access: ConsoleAccess, _size: ConsoleSize): Promise<void> { return Promise.resolve() }
  signal(_access: ConsoleAccess, _signal: ConsoleSignal): Promise<ConsoleSignalResult> {
    return Promise.resolve({ delivered: true, targetPgid: 7 })
  }
  stop(_access: ConsoleAccess): Promise<void> { return Promise.resolve() }
}

async function setup(): Promise<{ remote: ConsoleRemoteService; console: StubConsole }> {
  const ctx = new Context(); await ctx.plugin(StubConsole); await ctx.plugin(ConsoleRemoteService, { maxPollWaitMs: 100, maxWriteBytes: 4 })
  return { remote: ctx.get('consoleRemote') as ConsoleRemoteService, console: ctx.consoles as StubConsole }
}

describe('ConsoleRemoteService', () => {
  it('binds only authorized operations to the consoles namespace', async () => {
    const { remote } = await setup()
    expect(remote.typertRemote).toMatchObject({ serviceKey: 'consoleRemote', namespace: 'consoles' })
    expect(remoteMethods(remote).map(method => method.method)).toEqual(['snapshot', 'read', 'write', 'resize', 'signal', 'stop'])
    expect(remote).not.toHaveProperty('openHumanShell')
    expect(remote).not.toHaveProperty('list')
  })

  it('projects base64 bytes without pid and hides ConsoleError diagnostics', async () => {
    const { remote, console } = await setup()
    const read = await remote.read({ access, fromByte: 0, waitMs: 10 }, new AbortController().signal)
    expect(read).toMatchObject({ ok: true, value: { output: { dataBase64: 'AP8=', nextByte: 2 }, timedOut: false } })
    expect(read.ok && read.value.console).not.toHaveProperty('pid')
    const denied = await remote.read(
      { access: { ...access, capability: 'wrong' }, fromByte: 0, waitMs: 10 },
      new AbortController().signal,
    )
    expect(denied).toEqual({ ok: false, error: { code: 'ACCESS_DENIED' } })
    expect(remote.snapshot({ access: { ...access, capability: 'wrong' } }))
      .toEqual({ ok: false, error: { code: 'ACCESS_DENIED' } })
    console.current = { ...state, status: { kind: 'failed', message: 'private diagnostic' } }
    console.currentOutput = { kind: 'gap', oldestByte: 1, nextByte: 2 }
    const projected = remote.snapshot({ access })
    expect(projected).toMatchObject({ ok: true, value: { status: { kind: 'failed' } } })
    if (!projected.ok) throw new Error('expected successful snapshot')
    expect(projected.value.status).toEqual({ kind: 'failed' })
    await expect(remote.read({ access, fromByte: 0, waitMs: 10 }, new AbortController().signal))
      .resolves.toMatchObject({ ok: true, value: { output: { kind: 'gap' }, timedOut: false } })
  })

  it('authorizes writes before enforcing decoded UTF-8 size', async () => {
    const { remote, console } = await setup()
    await expect(remote.write({ access: { ...access, capability: 'wrong' }, data: 'oversized' }))
      .resolves.toEqual({ ok: false, error: { code: 'ACCESS_DENIED' } })
    await expect(remote.write({ access, data: '你好' })).resolves.toEqual({ ok: false, error: { code: 'WRITE_TOO_LARGE' } })
    await expect(remote.write({ access, data: 'ok' })).resolves.toEqual({ ok: true, value: null })
    expect(console.writeCall).toHaveBeenCalledExactlyOnceWith('ok')
  })

  it('returns a current observation on timeout and propagates caller abort', async () => {
    const { remote, console } = await setup()
    console.current = { ...state, nextOutputByte: 0 }
    console.currentOutput = { kind: 'data', data: new Uint8Array(), fromByte: 0, nextByte: 0, availableThroughByte: 0 }
    await expect(remote.read({ access, fromByte: 0, waitMs: 1 }, new AbortController().signal))
      .resolves.toMatchObject({ ok: true, value: { timedOut: true } })
    const caller = new AbortController(); caller.abort(new Error('caller abort'))
    await expect(remote.read({ access, fromByte: 0, waitMs: 100 }, caller.signal)).rejects.toThrow('caller abort')
    await expect(remote.read({ access, fromByte: 0, waitMs: 0 }, new AbortController().signal))
      .resolves.toEqual({ ok: false, error: { code: 'INVALID_WAIT_MS' } })
    await expect(remote.read({ access, fromByte: 0, waitMs: 1.5 }, new AbortController().signal))
      .resolves.toEqual({ ok: false, error: { code: 'INVALID_WAIT_MS' } })
  })

  it('returns a newly observed output page before the poll timeout', async () => {
    const { remote, console } = await setup()
    console.current = { ...state, nextOutputByte: 0 }
    console.currentOutput = { kind: 'data', data: new Uint8Array(), fromByte: 0, nextByte: 0, availableThroughByte: 0 }
    console.waitOutput = async () => ({
      console: state,
      output: { kind: 'data', data: Uint8Array.of(65), fromByte: 0, nextByte: 1, availableThroughByte: 1 },
    })
    await expect(remote.read({ access, fromByte: 0, waitMs: 100 }, new AbortController().signal))
      .resolves.toMatchObject({ ok: true, value: { output: { dataBase64: 'QQ==' }, timedOut: false } })
  })

  it('rethrows non-business failures and projects remaining mutations', async () => {
    const { remote, console } = await setup()
    const original = console.snapshot.bind(console)
    console.snapshot = () => { throw new Error('internal') }
    expect(() => remote.snapshot({ access })).toThrow('internal')
    console.snapshot = original
    await expect(remote.resize({ access, size: { rows: 0, cols: 80 } })).resolves.toEqual({ ok: false, error: { code: 'INVALID_SIZE' } })
    await expect(remote.resize({ access, size: { rows: 1.5, cols: 80 } })).resolves.toEqual({ ok: false, error: { code: 'INVALID_SIZE' } })
    await expect(remote.resize({ access, size: { rows: 24, cols: 0 } })).resolves.toEqual({ ok: false, error: { code: 'INVALID_SIZE' } })
    await expect(remote.resize({ access, size: { rows: 24, cols: 1.5 } })).resolves.toEqual({ ok: false, error: { code: 'INVALID_SIZE' } })
    await expect(remote.resize({ access, size: { rows: 30, cols: 100 } })).resolves.toEqual({ ok: true, value: null })
    await expect(remote.signal({ access, signal: 'SIGINT' })).resolves.toEqual({ ok: true, value: { delivered: true, targetPgid: 7 } })
    await expect(remote.stop({ access })).resolves.toEqual({ ok: true, value: null })
  })

  it('translates mutation ConsoleErrors and rethrows internal failures', async () => {
    const { remote, console } = await setup()
    const methods = console as unknown as Record<string, (...args: never[]) => Promise<unknown>>
    for (const method of ['resize', 'signal', 'stop'] as const) {
      const original = methods[method]!.bind(console)
      methods[method] = () => Promise.reject(new ConsoleError('ACCESS_DENIED', 'private'))
      const request = method === 'resize' ? { access, size: { rows: 24, cols: 80 } }
        : method === 'signal' ? { access, signal: 'SIGINT' as const } : { access }
      await expect((remote[method] as (value: typeof request) => Promise<unknown>).call(remote, request))
        .resolves.toEqual({ ok: false, error: { code: 'ACCESS_DENIED' } })
      methods[method] = () => Promise.reject(new Error('internal'))
      await expect((remote[method] as (value: typeof request) => Promise<unknown>).call(remote, request))
        .rejects.toThrow('internal')
      methods[method] = original
    }
    console.snapshot = () => { throw new Error('internal') }
    await expect(remote.write({ access, data: 'ok' })).rejects.toThrow('internal')
    await expect(remote.resize({ access, size: { rows: 24, cols: 80 } })).rejects.toThrow('internal')
  })

  it('keeps the Remote signal type identical to the core console signal set', () => {
    expectTypeOf<ConsoleRemoteSignal>().toEqualTypeOf<ConsoleSignal>()
  })
})
