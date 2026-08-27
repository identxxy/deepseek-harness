import { Context } from '@deepseek-ai/cordis'
import {
  ConsoleAttachmentCapability, ConsoleAttachmentId, ConsoleError, ConsoleId, ConsoleRuntime,
} from '@deepseek-ai/dsh-console'
import type {
  ConsoleAttachRequest, ConsoleAttachmentAccess, ConsoleAttachmentOpenResult, ConsoleAttachmentSnapshot,
  ConsoleCreateRequest, ConsoleOutputObservation, ConsoleOutputRead, ConsoleSize, ConsoleSnapshot,
} from '@deepseek-ai/dsh-console'
import { remoteMethods } from '@deepseek-ai/dsh-typert-protocol'
import { describe, expect, it, vi } from 'vitest'
import ConsoleRemoteService from '../src/index.ts'

const consoleId = ConsoleId('console')
const state: ConsoleSnapshot = {
  id: consoleId, workspaceId: 'workspace' as never, cwd: '/workspace', title: 'Shell',
  createdAt: '2026-08-26T09:00:00.000Z', archived: false, status: { kind: 'running' },
}
const attachmentId = ConsoleAttachmentId('attachment')
const access: ConsoleAttachmentAccess = { attachmentId, capability: ConsoleAttachmentCapability('capability') }
const wireAccess = { attachmentId: 'attachment', capability: 'capability' }
const attachment: ConsoleAttachmentSnapshot = {
  id: attachmentId, consoleId, size: { rows: 24, cols: 80 }, status: { kind: 'running' },
  oldestOutputByte: 0, nextOutputByte: 2,
}

class StubConsole extends ConsoleRuntime {
  readonly writeCall = vi.fn(async (_data: string) => {})
  readonly resizeCall = vi.fn(async (_size: ConsoleSize) => {})
  readonly createCall = vi.fn(async (_request: ConsoleCreateRequest) => state)
  current = state
  currentAttachment = attachment
  currentOutput: ConsoleOutputRead = { kind: 'data', data: Uint8Array.from([0, 255]), fromByte: 0, nextByte: 2, availableThroughByte: 2 }
  list(): Promise<readonly ConsoleSnapshot[]> { return Promise.resolve([this.current]) }
  snapshot(id: ReturnType<typeof ConsoleId>): ConsoleSnapshot {
    if (id !== consoleId) throw new ConsoleError('UNKNOWN_CONSOLE', 'private')
    return this.current
  }
  create(request: ConsoleCreateRequest): Promise<ConsoleSnapshot> { return this.createCall(request) }
  rename(_id: ReturnType<typeof ConsoleId>, title: string): Promise<ConsoleSnapshot> {
    this.current = { ...this.current, title }
    return Promise.resolve(this.current)
  }
  setArchived(_id: ReturnType<typeof ConsoleId>, archived: boolean): Promise<ConsoleSnapshot> {
    this.current = { ...this.current, archived }
    return Promise.resolve(this.current)
  }
  attach(_request: ConsoleAttachRequest): Promise<ConsoleAttachmentOpenResult> {
    return Promise.resolve({ access, attachment: this.currentAttachment })
  }
  attachmentSnapshot(value: ConsoleAttachmentAccess): ConsoleAttachmentSnapshot {
    if (value.capability !== access.capability) throw new ConsoleError('ACCESS_DENIED', 'private')
    return this.currentAttachment
  }
  readOutput(): ConsoleOutputRead { return this.currentOutput }
  waitOutput(_access: ConsoleAttachmentAccess, _fromByte: number, signal: AbortSignal): Promise<ConsoleOutputObservation> {
    signal.throwIfAborted()
    return new Promise((_resolve, reject) => {
      signal.addEventListener('abort', () => {
        reject(signal.reason instanceof Error ? signal.reason : new Error('aborted'))
      }, { once: true })
    })
  }
  write(_access: ConsoleAttachmentAccess, data: string): Promise<void> { return this.writeCall(data) }
  resize(_access: ConsoleAttachmentAccess, size: ConsoleSize): Promise<void> { return this.resizeCall(size) }
  detach(): Promise<void> { return Promise.resolve() }
  terminate(): Promise<void> { return Promise.resolve() }
}

async function setup(): Promise<{ remote: ConsoleRemoteService; console: StubConsole }> {
  const ctx = new Context()
  await ctx.plugin(StubConsole)
  await ctx.plugin(ConsoleRemoteService, { maxPollWaitMs: 100, maxWriteBytes: 4, maxTitleBytes: 16 })
  return { remote: ctx.get('consoleRemote') as ConsoleRemoteService, console: ctx.consoles as StubConsole }
}

describe('ConsoleRemoteService', () => {
  it('binds catalog, lifecycle, and attachment operations to the consoles namespace', async () => {
    const { remote } = await setup()
    expect(remote.typertRemote).toMatchObject({ serviceKey: 'consoleRemote', namespace: 'consoles' })
    expect(remoteMethods(remote).map(method => method.method)).toEqual([
      'list', 'create', 'snapshot', 'rename', 'setArchived', 'attach', 'attachmentSnapshot',
      'read', 'write', 'resize', 'detach', 'terminate',
    ])
  })

  it('projects the durable catalog and validates creation payloads', async () => {
    const { remote, console } = await setup()
    await expect(remote.list()).resolves.toEqual({ ok: true, value: [state] })
    await expect(remote.create({ workspaceId: 'workspace', title: '', initialSize: { rows: 24, cols: 80 } }, new AbortController().signal))
      .resolves.toEqual({ ok: false, error: { code: 'INVALID_TITLE' } })
    await expect(remote.create({ workspaceId: 'workspace', title: '12345678901234567', initialSize: { rows: 24, cols: 80 } }, new AbortController().signal))
      .resolves.toEqual({ ok: false, error: { code: 'TITLE_TOO_LARGE' } })
    await expect(remote.create({ workspaceId: 'workspace', title: 'Shell', initialSize: { rows: 0, cols: 80 } }, new AbortController().signal))
      .resolves.toEqual({ ok: false, error: { code: 'INVALID_SIZE' } })
    await expect(remote.create({ workspaceId: 'workspace', title: 'Shell', initialSize: { rows: 24, cols: 80 } }, new AbortController().signal))
      .resolves.toEqual({ ok: true, value: state })
    expect(console.createCall).toHaveBeenCalledExactlyOnceWith({ workspaceId: 'workspace', title: 'Shell', initialSize: { rows: 24, cols: 80 } })
  })

  it('projects base64 attachment output and hides failed diagnostics', async () => {
    const { remote, console } = await setup()
    await expect(remote.attach({ consoleId: 'console', size: { rows: 24, cols: 80 } }, new AbortController().signal))
      .resolves.toMatchObject({ ok: true, value: { access: wireAccess, attachment } })
    const read = await remote.read({ access: wireAccess, fromByte: 0, waitMs: 10 }, new AbortController().signal)
    expect(read).toMatchObject({ ok: true, value: { output: { dataBase64: 'AP8=', nextByte: 2 }, timedOut: false } })
    console.currentAttachment = { ...attachment, status: { kind: 'failed', message: 'private diagnostic' } }
    const projected = remote.attachmentSnapshot({ access: wireAccess })
    expect(projected).toMatchObject({ ok: true, value: { status: { kind: 'failed' } } })
    if (!projected.ok) throw new Error('expected successful attachment snapshot')
    expect(projected.value.status).toEqual({ kind: 'failed' })
  })

  it('authorizes attachment mutations before enforcing decoded payload limits', async () => {
    const { remote, console } = await setup()
    await expect(remote.write({ access: { ...wireAccess, capability: 'wrong' }, data: 'oversized' }))
      .resolves.toEqual({ ok: false, error: { code: 'ACCESS_DENIED' } })
    await expect(remote.write({ access: wireAccess, data: '你好' }))
      .resolves.toEqual({ ok: false, error: { code: 'WRITE_TOO_LARGE' } })
    await expect(remote.write({ access: wireAccess, data: 'ok' })).resolves.toEqual({ ok: true, value: null })
    expect(console.writeCall).toHaveBeenCalledExactlyOnceWith('ok')
    await expect(remote.resize({ access: wireAccess, size: { rows: 0, cols: 80 } }))
      .resolves.toEqual({ ok: false, error: { code: 'INVALID_SIZE' } })
    await expect(remote.resize({ access: wireAccess, size: { rows: 30, cols: 100 } })).resolves.toEqual({ ok: true, value: null })
    expect(console.resizeCall).toHaveBeenCalledExactlyOnceWith({ rows: 30, cols: 100 })
    const aborted = AbortSignal.abort(new Error('carrier cancelled'))
    await expect(remote.write({ access: wireAccess, data: 'ok' }, aborted)).rejects.toThrow('carrier cancelled')
    await expect(remote.resize({ access: wireAccess, size: { rows: 30, cols: 100 } }, aborted)).rejects.toThrow('carrier cancelled')
  })

  it('returns a current observation on timeout and propagates caller abort', async () => {
    const { remote, console } = await setup()
    console.currentAttachment = { ...attachment, nextOutputByte: 0 }
    console.currentOutput = { kind: 'data', data: new Uint8Array(), fromByte: 0, nextByte: 0, availableThroughByte: 0 }
    await expect(remote.read({ access: wireAccess, fromByte: 0, waitMs: 1 }, new AbortController().signal))
      .resolves.toMatchObject({ ok: true, value: { timedOut: true } })
    const caller = new AbortController()
    caller.abort(new Error('caller abort'))
    await expect(remote.read({ access: wireAccess, fromByte: 0, waitMs: 100 }, caller.signal)).rejects.toThrow('caller abort')
    await expect(remote.read({ access: wireAccess, fromByte: 0, waitMs: 0 }, new AbortController().signal))
      .resolves.toEqual({ ok: false, error: { code: 'INVALID_WAIT_MS' } })
  })

  it('projects lifecycle mutations and redacts provider business diagnostics', async () => {
    const { remote, console } = await setup()
    await expect(remote.rename({ consoleId: 'console', title: 'Renamed' })).resolves.toMatchObject({ ok: true, value: { title: 'Renamed' } })
    await expect(remote.setArchived({ consoleId: 'console', archived: true })).resolves.toMatchObject({ ok: true, value: { archived: true } })
    await expect(remote.detach({ access: wireAccess })).resolves.toEqual({ ok: true, value: null })
    await expect(remote.terminate({ consoleId: 'console' })).resolves.toEqual({ ok: true, value: null })
    console.snapshot = () => { throw new ConsoleError('UNKNOWN_CONSOLE', 'private diagnostic') }
    expect(remote.snapshot({ consoleId: 'missing' })).toEqual({ ok: false, error: { code: 'UNKNOWN_CONSOLE' } })
  })

  it('validates rename and attach payloads', async () => {
    const { remote } = await setup()
    await expect(remote.rename({ consoleId: 'console', title: '' })).resolves.toEqual({ ok: false, error: { code: 'INVALID_TITLE' } })
    await expect(remote.rename({ consoleId: 'console', title: '12345678901234567' })).resolves.toEqual({ ok: false, error: { code: 'TITLE_TOO_LARGE' } })
    await expect(remote.attach({ consoleId: 'console', size: { rows: 24, cols: 0 } }, new AbortController().signal))
      .resolves.toEqual({ ok: false, error: { code: 'INVALID_SIZE' } })
  })

  it('returns immediate gaps, buffered data, and terminal attachment states', async () => {
    const { remote, console } = await setup()
    console.currentOutput = { kind: 'gap', oldestByte: 2, nextByte: 4 }
    await expect(remote.read({ access: wireAccess, fromByte: 0, waitMs: 10 }, new AbortController().signal))
      .resolves.toMatchObject({ ok: true, value: { output: { kind: 'gap' }, timedOut: false } })
    console.currentOutput = { kind: 'data', data: Uint8Array.of(1), fromByte: 0, nextByte: 1, availableThroughByte: 1 }
    await expect(remote.read({ access: wireAccess, fromByte: 0, waitMs: 10 }, new AbortController().signal))
      .resolves.toMatchObject({ ok: true, value: { output: { dataBase64: 'AQ==' }, timedOut: false } })
    console.currentOutput = { kind: 'data', data: new Uint8Array(), fromByte: 0, nextByte: 0, availableThroughByte: 0 }
    console.currentAttachment = { ...attachment, status: { kind: 'exited', exitCode: 0, signal: null } }
    await expect(remote.read({ access: wireAccess, fromByte: 0, waitMs: 10 }, new AbortController().signal))
      .resolves.toMatchObject({ ok: true, value: { attachment: { status: { kind: 'exited' } }, timedOut: false } })
  })

  it('redacts provider errors from every remote operation and rethrows programming errors', async () => {
    const operations = [
      ['list', (remote: ConsoleRemoteService) => remote.list()],
      ['create', (remote: ConsoleRemoteService) => remote.create({ workspaceId: 'workspace', title: 'Shell', initialSize: { rows: 24, cols: 80 } }, new AbortController().signal)],
      ['snapshot', (remote: ConsoleRemoteService) => Promise.resolve(remote.snapshot({ consoleId: 'console' }))],
      ['rename', (remote: ConsoleRemoteService) => remote.rename({ consoleId: 'console', title: 'Shell' })],
      ['setArchived', (remote: ConsoleRemoteService) => remote.setArchived({ consoleId: 'console', archived: true })],
      ['attach', (remote: ConsoleRemoteService) => remote.attach({ consoleId: 'console', size: { rows: 24, cols: 80 } }, new AbortController().signal)],
      ['attachmentSnapshot', (remote: ConsoleRemoteService) => Promise.resolve(remote.attachmentSnapshot({ access: wireAccess }))],
      ['readOutput', (remote: ConsoleRemoteService) => remote.read({ access: wireAccess, fromByte: 0, waitMs: 10 }, new AbortController().signal)],
      ['write', (remote: ConsoleRemoteService) => remote.write({ access: wireAccess, data: 'ok' })],
      ['resize', (remote: ConsoleRemoteService) => remote.resize({ access: wireAccess, size: { rows: 24, cols: 80 } })],
      ['detach', (remote: ConsoleRemoteService) => remote.detach({ access: wireAccess })],
      ['terminate', (remote: ConsoleRemoteService) => remote.terminate({ consoleId: 'console' })],
    ] as const
    for (const [method, invoke] of operations) {
      const { remote, console } = await setup()
      ;(console as unknown as Record<string, unknown>)[method] = () => { throw new ConsoleError('UNKNOWN_CONSOLE', 'private') }
      await expect(invoke(remote)).resolves.toEqual({ ok: false, error: { code: 'UNKNOWN_CONSOLE' } })
      ;(console as unknown as Record<string, unknown>)[method] = () => { throw new TypeError('programming error') }
      await expect(async () => { await invoke(remote) }).rejects.toThrow('programming error')
    }
  })
})
