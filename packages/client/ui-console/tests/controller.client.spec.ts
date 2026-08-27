import { describe, expect, it, vi } from 'vitest'
import type { ConsoleRemoteSnapshot } from '@deepseek-ai/dsh-api-remotes/client'
import { ConsoleClient, ConsoleClientError } from '../src/client/controller.ts'

const snapshot = (id: string, archived = false): ConsoleRemoteSnapshot => ({
  id,
  workspaceId: 'workspace-1',
  cwd: '/workspace',
  title: `Terminal ${id}`,
  createdAt: '2026-08-26T00:00:00.000Z',
  archived,
  status: { kind: 'running' },
})

const ok = <T>(value: T) => Promise.resolve({ ok: true as const, value: { ok: true as const, value } })

function deferred<T>() {
  let resolve!: (value: T) => void
  let reject!: (error: unknown) => void
  const promise = new Promise<T>((res, rej) => { resolve = res; reject = rej })
  return { promise, resolve, reject }
}

function abortReason(signal: AbortSignal): Error {
  return signal.reason instanceof Error ? signal.reason : new Error(String(signal.reason))
}

function expectError(value: unknown): Error {
  expect(value).toBeInstanceOf(Error)
  if (!(value instanceof Error)) throw new Error('Expected Error')
  return value
}

async function settlementWithin<T>(promise: Promise<T>): Promise<T | Error | 'timeout'> {
  return Promise.race([
    promise.then(value => value, (error: unknown) => normalizedTestError(error)),
    new Promise<'timeout'>((resolve) => { setTimeout(() => { resolve('timeout') }, 25) }),
  ])
}

function normalizedTestError(error: unknown): Error {
  return error instanceof Error ? error : new Error(String(error))
}

function remote() {
  return {
    list: vi.fn(() => ok([snapshot('c1')])),
    create: vi.fn(() => ok(snapshot('c2'))),
    snapshot: vi.fn(() => ok(snapshot('c1'))),
    rename: vi.fn(() => ok({ ...snapshot('c1'), title: 'Renamed' })),
    setArchived: vi.fn((request: { archived: boolean }) => ok(snapshot('c1', request.archived))),
    attach: vi.fn(() => ok({
      access: { attachmentId: 'attachment-1', capability: 'secret-capability' },
      attachment: {
        id: 'attachment-1', consoleId: 'c1', size: { rows: 24, cols: 80 },
        status: { kind: 'running' as const }, oldestOutputByte: 0, nextOutputByte: 0,
      },
    })),
    attachmentSnapshot: vi.fn(),
    read: vi.fn(),
    write: vi.fn((_request: { access: unknown; data: string }, _signal?: AbortSignal) => ok(null)),
    resize: vi.fn((_request: { access: unknown; size: { rows: number; cols: number } }, _signal?: AbortSignal) => ok(null)),
    detach: vi.fn(() => ok(null)),
    terminate: vi.fn(() => ok(null)),
  }
}

describe('ConsoleClient', () => {
  it('mirrors list and lifecycle mutations in one observable catalog', async () => {
    const api = remote()
    const client = new ConsoleClient(api)
    await client.refresh()
    expect(client.getSnapshot()).toMatchObject({ phase: 'ready', items: [{ id: 'c1' }] })

    await client.create({ workspaceId: 'workspace-1', title: 'New terminal', initialSize: { rows: 24, cols: 80 } })
    expect(client.getSnapshot().items.map(item => item.id)).toEqual(['c2', 'c1'])
    await client.setArchived('c1', true)
    expect(client.getSnapshot().items.find(item => item.id === 'c1')?.archived).toBe(true)
    await client.terminate('c1')
    expect(client.getSnapshot()).toMatchObject({ phase: 'ready', items: [{ id: 'c2' }] })
  })

  it('keeps attachment capabilities in memory and detaches them on dispose', async () => {
    const api = remote()
    const client = new ConsoleClient(api)
    const opened = await client.attach('c1', { rows: 24, cols: 80 })
    expect(opened.access.capability).toBe('secret-capability')
    await client.dispose()
    expect(api.detach).toHaveBeenCalledExactlyOnceWith({ access: opened.access })
  })

  it('aborts and joins a never-settling attach during dispose', async () => {
    const api = remote()
    const attach = deferred<never>()
    api.attach.mockReturnValueOnce(attach.promise)
    const client = new ConsoleClient(api)
    const attaching = client.attach('c1', { rows: 24, cols: 80 })

    await vi.waitFor(() => { expect(api.attach).toHaveBeenCalledOnce() })
    const disposing = client.dispose()
    await expect(settlementWithin(disposing)).resolves.toBeUndefined()
    await expect(settlementWithin(attaching)).resolves.toMatchObject({ name: 'AbortError' })
    attach.reject(new Error('late attach rejection'))
    await Promise.resolve()
  })

  it('aborts a never-settling read on reset and consumes its late carrier rejection', async () => {
    const api = remote()
    const read = deferred<never>()
    api.read.mockReturnValueOnce(read.promise)
    const client = new ConsoleClient(api)
    const opened = await client.attach('c1', { rows: 24, cols: 80 })
    const reading = client.read(opened.access, 0, 20_000)

    await vi.waitFor(() => { expect(api.read).toHaveBeenCalledOnce() })
    client.resetConnection()
    await expect(settlementWithin(reading)).resolves.toMatchObject({ name: 'AbortError' })
    read.reject(new Error('late read rejection'))
    await Promise.resolve()
  })

  it('aborts entered never-settling write and resize work before detach during dispose', async () => {
    const api = remote()
    const write = deferred<never>()
    const resize = deferred<never>()
    api.write.mockReturnValueOnce(write.promise)
    api.resize.mockReturnValueOnce(resize.promise)
    const client = new ConsoleClient(api)
    const opened = await client.attach('c1', { rows: 24, cols: 80 })
    const writing = client.write(opened.access, 'hung')
    const resizing = client.resize(opened.access, { rows: 40, cols: 120 })
    await vi.waitFor(() => {
      expect(api.write).toHaveBeenCalledOnce()
      expect(api.resize).toHaveBeenCalledOnce()
    })

    const disposing = client.dispose()
    await expect(settlementWithin(disposing)).resolves.toBeUndefined()
    await expect(settlementWithin(writing)).resolves.toMatchObject({ name: 'AbortError' })
    await expect(settlementWithin(resizing)).resolves.toMatchObject({ name: 'AbortError' })
    expect(api.detach).toHaveBeenCalledExactlyOnceWith({ access: opened.access })
    write.reject(new Error('late write rejection'))
    resize.reject(new Error('late resize rejection'))
    await Promise.resolve()
  })

  it('aborts an entered never-settling detach and joins concurrent dispose calls', async () => {
    const api = remote()
    const detach = deferred<never>()
    api.detach.mockReturnValueOnce(detach.promise)
    const client = new ConsoleClient(api)
    const opened = await client.attach('c1', { rows: 24, cols: 80 })
    const detaching = client.detach(opened.access)
    await vi.waitFor(() => { expect(api.detach).toHaveBeenCalledOnce() })

    const first = client.dispose()
    const second = client.dispose()
    expect(second).toBe(first)
    await expect(settlementWithin(first)).resolves.toBeUndefined()
    await expect(settlementWithin(detaching)).resolves.toMatchObject({ name: 'AbortError' })
    expect(api.detach).toHaveBeenCalledOnce()
    detach.reject(new Error('late detach rejection'))
    await Promise.resolve()
  })

  it('rejects a same-tick unknown detach after disposal snapshots owned attachments', async () => {
    const api = remote()
    api.detach.mockReturnValue(new Promise(() => {}))
    const client = new ConsoleClient(api)
    await client.attach('c1', { rows: 24, cols: 80 })

    const disposing = client.dispose()
    const late = client.detach({ attachmentId: 'unknown', capability: 'unknown' })

    await expect(settlementWithin(disposing)).resolves.toBeUndefined()
    await expect(settlementWithin(late)).resolves.toMatchObject({ name: 'AbortError' })
    expect(api.detach).toHaveBeenCalledOnce()
  })

  it.each(['resolve', 'reject'] as const)('cancels an in-flight catalog refresh during dispose before list can %s', async (settlement) => {
    const api = remote()
    const list = deferred<Awaited<ReturnType<typeof ok<ConsoleRemoteSnapshot[]>>>>()
    api.list.mockReturnValueOnce(list.promise)
    const client = new ConsoleClient(api)
    const publications = vi.fn()
    client.subscribe(publications)
    const refreshing = client.refresh().then(() => undefined, (error: unknown) => error)
    await vi.waitFor(() => { expect(api.list).toHaveBeenCalledOnce() })
    publications.mockClear()

    await expect(client.dispose()).resolves.toBeUndefined()
    await expect(refreshing).resolves.toMatchObject({ name: 'AbortError' })

    if (settlement === 'resolve') list.resolve(await ok([snapshot('late')]))
    else list.reject(new Error('late list failure'))
    await Promise.resolve()
    expect(publications).not.toHaveBeenCalled()
  })

  it('aborts a never-settling list and every queued refresh caller during dispose', async () => {
    const api = remote()
    api.list.mockReturnValueOnce(new Promise(() => {}))
    const client = new ConsoleClient(api)
    const first = client.refresh()
    const queued = client.refresh()
    await vi.waitFor(() => { expect(api.list).toHaveBeenCalledOnce() })
    const publications = vi.fn()
    client.subscribe(publications)

    await expect(client.dispose()).resolves.toBeUndefined()
    await expect(first).rejects.toMatchObject({ name: 'AbortError' })
    await expect(queued).rejects.toMatchObject({ name: 'AbortError' })
    expect(api.list).toHaveBeenCalledOnce()
    expect(publications).not.toHaveBeenCalled()
  })

  it('aborts a never-settling running mutation and skips its queued mutation during dispose', async () => {
    const api = remote()
    api.rename.mockReturnValueOnce(new Promise(() => {}))
    const client = new ConsoleClient(api)
    await client.refresh()
    const publications = vi.fn()
    client.subscribe(publications)
    const renaming = client.rename('c1', 'Never')
    await vi.waitFor(() => { expect(api.rename).toHaveBeenCalledOnce() })
    const terminating = client.terminate('c1')

    await expect(client.dispose()).resolves.toBeUndefined()
    await expect(renaming).rejects.toMatchObject({ name: 'AbortError' })
    await expect(terminating).rejects.toMatchObject({ name: 'AbortError' })
    expect(api.terminate).not.toHaveBeenCalled()
    expect(publications).not.toHaveBeenCalled()
  })

  it('aborts an old list on reset and permits a fresh authoritative refresh', async () => {
    const api = remote()
    api.list.mockReturnValueOnce(new Promise(() => {})).mockReturnValueOnce(ok([snapshot('fresh')]))
    const client = new ConsoleClient(api)
    const stale = client.refresh()
    await vi.waitFor(() => { expect(api.list).toHaveBeenCalledOnce() })

    client.resetConnection()
    await expect(stale).rejects.toMatchObject({ name: 'AbortError' })
    await expect(client.refresh()).resolves.toBeUndefined()
    expect(client.getSnapshot()).toMatchObject({ phase: 'ready', items: [{ id: 'fresh' }], connectionEpoch: 1 })
  })

  it('projects stable Host business failures as ConsoleClientError', async () => {
    const api = remote()
    api.list.mockResolvedValueOnce({
      ok: true,
      value: { ok: false, error: { code: 'PROVIDER_FAILURE' } },
    } as never)
    const client = new ConsoleClient(api)
    await expect(client.refresh()).rejects.toEqual(expect.objectContaining<Partial<ConsoleClientError>>({ code: 'PROVIDER_FAILURE' }))
    expect(client.getSnapshot().phase).toBe('error')
  })

  it('forwards catalog and attachment operations and notifies subscribers', async () => {
    const api = remote()
    api.read.mockReturnValue(ok({
      attachment: { id: 'attachment-1', consoleId: 'c1', size: { rows: 24, cols: 80 }, status: { kind: 'running' }, oldestOutputByte: 0, nextOutputByte: 0 },
      output: { kind: 'data', dataBase64: '', fromByte: 0, nextByte: 0, availableThroughByte: 0 },
      timedOut: true,
    }))
    const client = new ConsoleClient(api)
    const listener = vi.fn()
    const unsubscribe = client.subscribe(listener)
    await client.refresh()
    await client.rename('c1', 'Renamed')
    expect(client.getSnapshot().items[0]?.title).toBe('Renamed')
    const signal = new AbortController().signal
    const opened = await client.attach('c1', { rows: 24, cols: 80 }, signal)
    await client.read(opened.access, 0, 10, signal)
    await client.write(opened.access, 'pwd\n')
    await client.resize(opened.access, { rows: 40, cols: 120 })
    await client.detach(opened.access)
    await expect(client.write(opened.access, 'after detach')).rejects.toThrow('closing')
    await expect(client.resize(opened.access, { rows: 41, cols: 121 })).rejects.toThrow('closing')
    expect(api.read).toHaveBeenCalledWith({ access: opened.access, fromByte: 0, waitMs: 10 }, expect.any(AbortSignal))
    expect(api.write).toHaveBeenCalledWith({ access: opened.access, data: 'pwd\n' }, expect.any(AbortSignal))
    expect(api.resize).toHaveBeenCalledWith({ access: opened.access, size: { rows: 40, cols: 120 } }, expect.any(AbortSignal))
    expect(listener).toHaveBeenCalled()
    unsubscribe()
  })

  it('reports carrier failures and preserves the previous catalog during failed refresh', async () => {
    const api = remote()
    const client = new ConsoleClient(api)
    await client.refresh()
    api.list.mockResolvedValueOnce({ ok: false, error: { code: 'OFFLINE', message: 'disconnected' } } as never)
    await expect(client.refresh()).rejects.toThrow('Console transport failed: OFFLINE: disconnected')
    expect(client.getSnapshot()).toMatchObject({ phase: 'error', items: [{ id: 'c1' }] })
  })

  it('removes failed detaches from ownership and aggregates dispose failures', async () => {
    const api = remote()
    const client = new ConsoleClient(api)
    const first = await client.attach('c1', { rows: 24, cols: 80 })
    api.attach.mockReturnValueOnce(ok({
      access: { attachmentId: 'attachment-2', capability: 'second' },
      attachment: { id: 'attachment-2', consoleId: 'c1', size: { rows: 24, cols: 80 }, status: { kind: 'running' }, oldestOutputByte: 0, nextOutputByte: 0 },
    }))
    await client.attach('c1', { rows: 24, cols: 80 })
    api.detach.mockRejectedValue(new Error('detach failed'))
    await expect(client.detach(first.access)).rejects.toThrow('detach failed')
    await expect(client.dispose()).rejects.toThrow('Console attachment teardown failed')
    await expect(client.dispose()).rejects.toThrow('Console attachment teardown failed')
    await expect(client.refresh()).rejects.toThrow('Console client is disposed')
  })

  it('sends writes for one attachment in strict FIFO order', async () => {
    const api = remote()
    const first = deferred<Awaited<ReturnType<typeof ok<null>>>>()
    const second = deferred<Awaited<ReturnType<typeof ok<null>>>>()
    api.write.mockReturnValueOnce(first.promise).mockReturnValueOnce(second.promise).mockReturnValueOnce(ok(null))
    const client = new ConsoleClient(api)
    const opened = await client.attach('c1', { rows: 24, cols: 80 })
    const writes = [
      client.write(opened.access, 'first'),
      client.write(opened.access, 'second'),
      client.write(opened.access, 'third'),
    ]
    await vi.waitFor(() => { expect(api.write).toHaveBeenCalledTimes(1) })
    expect(api.write.mock.calls[0]?.[0]).toMatchObject({ data: 'first' })
    first.resolve(await ok(null))
    await vi.waitFor(() => { expect(api.write).toHaveBeenCalledTimes(2) })
    expect(api.write.mock.calls[1]?.[0]).toMatchObject({ data: 'second' })
    second.resolve(await ok(null))
    await Promise.all(writes)
    expect(api.write.mock.calls.map(call => call[0].data)).toEqual(['first', 'second', 'third'])
  })

  it('poisons the write FIFO after one transport failure', async () => {
    const api = remote()
    const first = deferred<Awaited<ReturnType<typeof ok<null>>>>()
    api.write.mockReturnValueOnce(first.promise)
    const client = new ConsoleClient(api)
    const opened = await client.attach('c1', { rows: 24, cols: 80 })
    const failed = client.write(opened.access, 'failed')
    const next = client.write(opened.access, 'next')
    first.reject(new Error('offline'))
    await expect(failed).rejects.toThrow('offline')
    await expect(next).rejects.toThrow('offline')
    await expect(client.write(opened.access, 'new')).rejects.toThrow('offline')
    expect(api.write.mock.calls.map(call => call[0].data)).toEqual(['failed'])
  })

  it('serializes resize RPCs and coalesces queued dimensions to the newest size', async () => {
    const api = remote()
    const first = deferred<Awaited<ReturnType<typeof ok<null>>>>()
    const latest = deferred<Awaited<ReturnType<typeof ok<null>>>>()
    api.resize.mockReturnValueOnce(first.promise).mockReturnValueOnce(latest.promise)
    const client = new ConsoleClient(api)
    const opened = await client.attach('c1', { rows: 24, cols: 80 })
    const resizeFirst = client.resize(opened.access, { rows: 30, cols: 90 })
    const resizeSuperseded = client.resize(opened.access, { rows: 40, cols: 100 })
    const resizeLatest = client.resize(opened.access, { rows: 50, cols: 120 })
    expect(api.resize).toHaveBeenCalledTimes(1)
    first.resolve(await ok(null))
    await vi.waitFor(() => { expect(api.resize).toHaveBeenCalledTimes(2) })
    expect(api.resize.mock.calls.map(call => call[0].size)).toEqual([
      { rows: 30, cols: 90 }, { rows: 50, cols: 120 },
    ])
    latest.resolve(await ok(null))
    await expect(Promise.all([resizeFirst, resizeSuperseded, resizeLatest])).resolves.toEqual([undefined, undefined, undefined])
  })

  it('settles every coalesced resize caller on failure and allows the next resize', async () => {
    const api = remote()
    const first = deferred<Awaited<ReturnType<typeof ok<null>>>>()
    const queued = deferred<Awaited<ReturnType<typeof ok<null>>>>()
    api.resize.mockReturnValueOnce(first.promise).mockReturnValueOnce(queued.promise).mockReturnValueOnce(ok(null))
    const client = new ConsoleClient(api)
    const opened = await client.attach('c1', { rows: 24, cols: 80 })
    const active = client.resize(opened.access, { rows: 30, cols: 90 })
    const second = client.resize(opened.access, { rows: 40, cols: 100 })
    const third = client.resize(opened.access, { rows: 50, cols: 120 })
    first.resolve(await ok(null))
    await active
    queued.reject(new Error('resize offline'))
    await expect(second).rejects.toThrow('resize offline')
    await expect(third).rejects.toThrow('resize offline')
    await expect(client.resize(opened.access, { rows: 60, cols: 140 })).resolves.toBeUndefined()
  })

  it('supports detached authorization calls and restarts a resize pump when work appears during settlement', async () => {
    const api = remote()
    const client = new ConsoleClient(api)
    const access = { attachmentId: 'independent', capability: 'capability' }
    await client.write(access, 'input')
    await client.detach({ attachmentId: 'unknown', capability: 'capability' })

    const gate = deferred<undefined>()
    const lane: {
      writeTail: Promise<void>
      abort: AbortController
      closing: boolean
      pendingResize?: { size: { rows: number; cols: number }; waiters: [] }
      resizePump?: Promise<void>
    } = {
      writeTail: Promise.resolve(), abort: new AbortController(), closing: false,
    }
    let pumps = 0
    const internals = client as unknown as {
      pumpResizes: (_access: typeof access, value: typeof lane) => Promise<void>
      ensureResizePump: (_access: typeof access, value: typeof lane) => void
    }
    internals.pumpResizes = async (_value, current) => {
      pumps += 1
      if (pumps === 1) await gate.promise
      else delete current.pendingResize
    }
    internals.ensureResizePump(access, lane)
    lane.pendingResize = { size: { rows: 40, cols: 100 }, waiters: [] }
    gate.resolve(undefined)
    await vi.waitFor(() => { expect(pumps).toBe(2) })
  })

  it('single-flights detach and aborts hung write and resize transports', async () => {
    const api = remote()
    api.write.mockImplementationOnce((_request, signal) => new Promise((_resolve, reject) => {
      signal?.addEventListener('abort', () => { reject(abortReason(signal)) }, { once: true })
    }))
    api.resize.mockImplementationOnce((_request, signal) => new Promise((_resolve, reject) => {
      signal?.addEventListener('abort', () => { reject(abortReason(signal)) }, { once: true })
    }))
    const client = new ConsoleClient(api)
    const opened = await client.attach('c1', { rows: 24, cols: 80 })
    const writing = client.write(opened.access, 'hung')
    const resizing = client.resize(opened.access, { rows: 40, cols: 100 })
    const writeResult = writing.then(() => undefined, (error: unknown) => error)
    const resizeResult = resizing.then(() => undefined, (error: unknown) => error)
    await vi.waitFor(() => {
      expect(api.write).toHaveBeenCalledOnce()
      expect(api.resize).toHaveBeenCalledOnce()
    })
    const detached = client.detach(opened.access)
    const detachedAgain = client.detach(opened.access)
    await expect(client.write(opened.access, 'late')).rejects.toThrow('closing')
    await expect(client.resize(opened.access, { rows: 50, cols: 120 })).rejects.toThrow('closing')
    const disposed = client.dispose()
    await expect(writeResult).resolves.toMatchObject({ name: 'AbortError' })
    await expect(resizeResult).resolves.toMatchObject({ name: 'AbortError' })
    await expect(Promise.all([detached, detachedAgain, disposed])).resolves.toEqual([undefined, undefined, undefined])
    expect(api.detach).toHaveBeenCalledExactlyOnceWith({ access: opened.access })
    await expect(client.detach(opened.access)).resolves.toBeUndefined()
    expect(api.detach).toHaveBeenCalledOnce()
    await expect(client.write(opened.access, 'after dispose')).rejects.toThrow('disposed')
    await expect(client.resize(opened.access, { rows: 60, cols: 140 })).rejects.toThrow('disposed')
  })

  it('rejects queued writes and resizes when detach closes their attachment lane', async () => {
    const api = remote()
    const write = deferred<Awaited<ReturnType<typeof ok<null>>>>()
    const resize = deferred<Awaited<ReturnType<typeof ok<null>>>>()
    api.write.mockReturnValueOnce(write.promise)
    api.resize.mockReturnValueOnce(resize.promise)
    const client = new ConsoleClient(api)
    const opened = await client.attach('c1', { rows: 24, cols: 80 })
    const activeWrite = client.write(opened.access, 'active')
    const queuedWrite = client.write(opened.access, 'queued')
    const activeResize = client.resize(opened.access, { rows: 30, cols: 90 })
    const queuedResize = client.resize(opened.access, { rows: 50, cols: 120 })
    const activeWriteResult = activeWrite.then(() => undefined, (error: unknown) => error)
    const queuedWriteResult = queuedWrite.then(() => undefined, (error: unknown) => error)
    const activeResizeResult = activeResize.then(() => undefined, (error: unknown) => error)
    const queuedResizeResult = queuedResize.then(() => undefined, (error: unknown) => error)
    await vi.waitFor(() => {
      expect(api.write).toHaveBeenCalledOnce()
      expect(api.resize).toHaveBeenCalledOnce()
    })
    const detaching = client.detach(opened.access)
    write.reject(new DOMException('detached', 'AbortError'))
    resize.reject(new DOMException('detached', 'AbortError'))
    await expect(activeWriteResult).resolves.toMatchObject({ name: 'AbortError' })
    expect(expectError(await queuedWriteResult).message).toContain('closing')
    await expect(activeResizeResult).resolves.toMatchObject({ name: 'AbortError' })
    expect(expectError(await queuedResizeResult).message).toContain('closing')
    await detaching
    expect(api.write).toHaveBeenCalledOnce()
    expect(api.resize).toHaveBeenCalledOnce()
  })

  it('invalidates in-flight old-connection work and attaches fresh after reset', async () => {
    const api = remote()
    const client = new ConsoleClient(api)
    const opened = await client.attach('c1', { rows: 24, cols: 80 })
    const aborting = (_request: unknown, signal?: AbortSignal) => new Promise<never>((_resolve, reject) => {
      signal?.addEventListener('abort', () => { reject(abortReason(signal)) }, { once: true })
    })
    api.attach.mockImplementationOnce(aborting as never)
    api.read.mockImplementationOnce(aborting as never)
    api.write.mockImplementationOnce(aborting)
    api.resize.mockImplementationOnce(aborting)
    const attaching = client.attach('c1', { rows: 30, cols: 100 }).then(() => undefined, (error: unknown) => error)
    const reading = client.read(opened.access, 0, 20_000).then(() => undefined, (error: unknown) => error)
    const writing = client.write(opened.access, 'input').then(() => undefined, (error: unknown) => error)
    const resizing = client.resize(opened.access, { rows: 30, cols: 100 }).then(() => undefined, (error: unknown) => error)
    await vi.waitFor(() => {
      expect(api.attach).toHaveBeenCalledTimes(2)
      expect(api.read).toHaveBeenCalledOnce()
      expect(api.write).toHaveBeenCalledOnce()
      expect(api.resize).toHaveBeenCalledOnce()
    })
    client.resetConnection()
    await expect(Promise.all([attaching, reading, writing, resizing])).resolves.toEqual([
      expect.objectContaining({ name: 'AbortError' }),
      expect.objectContaining({ name: 'AbortError' }),
      expect.objectContaining({ name: 'AbortError' }),
      expect.objectContaining({ name: 'AbortError' }),
    ])
    expect(api.detach).not.toHaveBeenCalled()
    expect(client.getSnapshot().connectionEpoch).toBe(1)
    api.attach.mockReturnValueOnce(ok({ ...opened, access: { attachmentId: 'fresh', capability: 'fresh' } }) as never)
    await expect(client.attach('c1', { rows: 24, cols: 80 })).resolves.toMatchObject({ access: { attachmentId: 'fresh' } })
  })

  it('projects an externally ended Console on the next catalog refresh', async () => {
    const api = remote()
    const client = new ConsoleClient(api)
    await client.refresh()
    api.list.mockReturnValueOnce(ok([{ ...snapshot('c1'), status: { kind: 'ended' as const, reason: 'external' as const } }]))
    await client.refresh()
    expect(client.getSnapshot()).toMatchObject({
      phase: 'ready', items: [{ id: 'c1', status: { kind: 'ended', reason: 'external' } }],
    })
  })

  it('keeps an incomplete catalog non-ready and recovers it after a point mutation', async () => {
    const api = remote()
    const oldList = deferred<Awaited<ReturnType<typeof ok<ConsoleRemoteSnapshot[]>>>>()
    const recovery = deferred<Awaited<ReturnType<typeof ok<ConsoleRemoteSnapshot[]>>>>()
    api.list.mockReturnValueOnce(oldList.promise).mockReturnValueOnce(recovery.promise)
    const client = new ConsoleClient(api)
    const initial = client.refresh()
    await client.create({ workspaceId: 'workspace-1', title: 'New terminal', initialSize: { rows: 24, cols: 80 } })
    expect(client.getSnapshot()).toMatchObject({ phase: 'loading', items: [{ id: 'c2' }] })
    expect(api.list).toHaveBeenCalledOnce()

    oldList.resolve(await ok([snapshot('c1')]))
    await vi.waitFor(() => { expect(api.list).toHaveBeenCalledTimes(2) })
    expect(client.getSnapshot()).toMatchObject({ phase: 'loading', items: [{ id: 'c2' }] })
    recovery.resolve(await ok([snapshot('c2'), snapshot('c1')]))
    await initial
    await vi.waitFor(() => {
      expect(client.getSnapshot()).toMatchObject({ phase: 'ready', items: [{ id: 'c2' }, { id: 'c1' }] })
    })
  })

  it('reports recovery failure without rejecting a successful point mutation', async () => {
    const warning = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const api = remote()
    const oldList = deferred<Awaited<ReturnType<typeof ok<ConsoleRemoteSnapshot[]>>>>()
    api.list.mockReturnValueOnce(oldList.promise).mockRejectedValueOnce(new Error('recovery offline'))
    const client = new ConsoleClient(api)
    const initial = client.refresh().catch(() => {})
    await expect(client.rename('c1', 'Renamed')).resolves.toMatchObject({ title: 'Renamed' })
    oldList.resolve(await ok([snapshot('c1')]))
    await vi.waitFor(() => {
      expect(warning).toHaveBeenCalledWith('Console catalog recovery after mutation failed:', expect.any(Error))
    })
    expect(client.getSnapshot()).toMatchObject({ phase: 'error', items: [{ id: 'c1', title: 'Renamed' }] })
    await initial
    warning.mockRestore()
  })

  it('does not promote an incomplete catalog after an archive point result', async () => {
    const api = remote()
    api.list.mockReturnValueOnce(new Promise(() => {})).mockReturnValueOnce(new Promise(() => {}))
    const client = new ConsoleClient(api)
    void client.refresh()
    await client.setArchived('c1', true)
    expect(client.getSnapshot()).toMatchObject({ phase: 'loading', items: [{ id: 'c1', archived: true }] })
    expect(api.list).toHaveBeenCalledOnce()
  })

  it('discards an old list after terminate while preserving the locally complete catalog', async () => {
    const api = remote()
    const oldList = deferred<Awaited<ReturnType<typeof ok<ConsoleRemoteSnapshot[]>>>>()
    api.list.mockReturnValueOnce(ok([snapshot('c1')])).mockReturnValueOnce(oldList.promise)
    const client = new ConsoleClient(api)
    await client.refresh()
    const stale = client.refresh()
    await client.terminate('c1')
    expect(client.getSnapshot()).toMatchObject({ phase: 'ready', items: [] })
    oldList.resolve(await ok([snapshot('c1')]))
    await stale
    expect(api.list).toHaveBeenCalledTimes(2)
    expect(client.getSnapshot()).toMatchObject({ phase: 'ready', items: [] })
  })

  it('allows only the newest refresh generation to publish catalog state', async () => {
    const api = remote()
    const oldList = deferred<Awaited<ReturnType<typeof ok<ConsoleRemoteSnapshot[]>>>>()
    const latestList = deferred<Awaited<ReturnType<typeof ok<ConsoleRemoteSnapshot[]>>>>()
    api.list.mockReturnValueOnce(oldList.promise).mockReturnValueOnce(latestList.promise)
    const client = new ConsoleClient(api)
    const oldRefresh = client.refresh()
    const latestRefresh = client.refresh()
    oldList.resolve(await ok([snapshot('old')]))
    await vi.waitFor(() => { expect(api.list).toHaveBeenCalledTimes(2) })
    latestList.resolve(await ok([snapshot('latest')]))
    await Promise.all([oldRefresh, latestRefresh])
    expect(client.getSnapshot()).toMatchObject({ phase: 'ready', items: [{ id: 'latest' }] })
  })

  it('bounds a failed refresh independently from the queued successful request', async () => {
    const api = remote()
    const oldList = deferred<Awaited<ReturnType<typeof ok<ConsoleRemoteSnapshot[]>>>>()
    api.list.mockReturnValueOnce(oldList.promise).mockReturnValueOnce(ok([snapshot('latest')]))
    const client = new ConsoleClient(api)
    const oldRefresh = client.refresh()
    const latestRefresh = client.refresh()
    oldList.reject(new Error('stale offline'))
    await expect(oldRefresh).rejects.toThrow('stale offline')
    await latestRefresh
    expect(client.getSnapshot()).toMatchObject({ phase: 'ready', items: [{ id: 'latest' }] })
  })

  it('publishes a point mutation from a complete baseline after a background refresh error', async () => {
    const api = remote()
    const recovery = deferred<Awaited<ReturnType<typeof ok<ConsoleRemoteSnapshot[]>>>>()
    api.list.mockReturnValueOnce(ok([snapshot('c1')])).mockRejectedValueOnce(new Error('background offline')).mockReturnValueOnce(recovery.promise)
    const client = new ConsoleClient(api)
    await client.refresh()
    await expect(client.refresh()).rejects.toThrow('background offline')
    const staleRecovery = client.refresh()
    await vi.waitFor(() => { expect(api.list).toHaveBeenCalledTimes(3) })

    await client.terminate('c1')
    expect(client.getSnapshot()).toMatchObject({ phase: 'ready', items: [] })
    recovery.reject(new Error('recovery offline'))
    await staleRecovery
    expect(client.getSnapshot()).toMatchObject({ phase: 'ready', items: [] })
  })

  it('does not promote a point mutation after reset removes catalog completeness', async () => {
    const warning = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const api = remote()
    const recovery = deferred<Awaited<ReturnType<typeof ok<ConsoleRemoteSnapshot[]>>>>()
    api.list.mockReturnValueOnce(ok([snapshot('c1')])).mockRejectedValueOnce(new Error('reset offline')).mockReturnValueOnce(recovery.promise)
    const client = new ConsoleClient(api)
    await client.refresh()
    client.resetConnection()
    await expect(client.refresh()).rejects.toThrow('reset offline')

    await client.terminate('c1')
    expect(client.getSnapshot()).toMatchObject({ phase: 'loading', items: [] })
    await vi.waitFor(() => { expect(api.list).toHaveBeenCalledTimes(3) })
    recovery.reject(new Error('recovery offline'))
    await vi.waitFor(() => {
      expect(warning).toHaveBeenCalledWith('Console catalog recovery after mutation failed:', expect.any(Error))
    })
    expect(client.getSnapshot()).toMatchObject({ phase: 'error', items: [] })
    warning.mockRestore()
  })

  it('invalidates pending catalog writes on connection reset and dispose', async () => {
    const api = remote()
    const resetList = deferred<Awaited<ReturnType<typeof ok<ConsoleRemoteSnapshot[]>>>>()
    api.list.mockReturnValueOnce(resetList.promise)
    const resetClient = new ConsoleClient(api)
    const resetRefresh = resetClient.refresh()
    resetClient.resetConnection()
    resetList.resolve(await ok([snapshot('stale-reset')]))
    await expect(resetRefresh).rejects.toMatchObject({ name: 'AbortError' })
    expect(resetClient.getSnapshot()).toMatchObject({ phase: 'loading', items: [], connectionEpoch: 1 })

    const disposeList = deferred<Awaited<ReturnType<typeof ok<ConsoleRemoteSnapshot[]>>>>()
    api.list.mockReturnValueOnce(disposeList.promise)
    const disposedClient = new ConsoleClient(api)
    const disposedRefresh = disposedClient.refresh().then(() => undefined, (error: unknown) => error)
    await disposedClient.dispose()
    disposeList.resolve(await ok([snapshot('stale-dispose')]))
    await expect(disposedRefresh).resolves.toMatchObject({ name: 'AbortError' })
    expect(disposedClient.getSnapshot()).toMatchObject({ phase: 'loading', items: [] })
  })

  it('coalesces slow periodic refresh demand while still publishing ready catalogs', async () => {
    vi.useFakeTimers()
    try {
      const api = remote()
      let lists = 0
      api.list.mockImplementation(() => new Promise((resolve) => {
        const id = `list-${++lists}`
        setTimeout(() => { resolve({ ok: true, value: { ok: true, value: [snapshot(id)] } }) }, 15)
      }))
      const client = new ConsoleClient(api)
      const phases: string[] = []
      client.subscribe(() => { phases.push(client.getSnapshot().phase) })
      void client.refresh()
      const timer = setInterval(() => { void client.refresh() }, 10)
      await vi.advanceTimersByTimeAsync(55)
      clearInterval(timer)
      expect(phases).toContain('ready')
      expect(api.list.mock.calls.length).toBeLessThanOrEqual(4)
    } finally {
      vi.useRealTimers()
    }
  })

  it('serializes catalog mutations so a late rename cannot race a later archive', async () => {
    const api = remote()
    const rename = deferred<Awaited<ReturnType<typeof ok<ConsoleRemoteSnapshot>>>>()
    api.rename.mockReturnValueOnce(rename.promise)
    const client = new ConsoleClient(api)
    await client.refresh()
    const renaming = client.rename('c1', 'Renamed')
    const archiving = client.setArchived('c1', true)
    expect(api.setArchived).not.toHaveBeenCalled()
    rename.resolve(await ok({ ...snapshot('c1'), title: 'Renamed' }))
    await renaming
    await archiving
    expect(client.getSnapshot()).toMatchObject({ phase: 'ready', items: [{ id: 'c1', title: 'Renamed', archived: true }] })
  })

  it('invalidates pending mutation publication and skips queued RPCs during dispose', async () => {
    const api = remote()
    const create = deferred<Awaited<ReturnType<typeof ok<ConsoleRemoteSnapshot>>>>()
    api.create.mockReturnValueOnce(create.promise)
    const client = new ConsoleClient(api)
    const creating = client.create({ workspaceId: 'workspace-1', title: 'New terminal', initialSize: { rows: 24, cols: 80 } })
    await vi.waitFor(() => { expect(api.create).toHaveBeenCalledOnce() })
    const queuedRename = client.rename('c1', 'Queued')
    const disposing = client.dispose()
    let disposed = false
    void disposing.then(() => { disposed = true })
    await Promise.resolve()
    expect(disposed).toBe(false)
    create.resolve(await ok(snapshot('c2')))
    await expect(creating).rejects.toThrow('disposed')
    await expect(queuedRename).rejects.toThrow('disposed')
    await disposing
    expect(api.rename).not.toHaveBeenCalled()
    expect(client.getSnapshot().items).toEqual([])
  })

  it('rejects an old-connection mutation result after reset without publishing it', async () => {
    const api = remote()
    const rename = deferred<Awaited<ReturnType<typeof ok<ConsoleRemoteSnapshot>>>>()
    api.rename.mockReturnValueOnce(rename.promise)
    const client = new ConsoleClient(api)
    await client.refresh()
    const renaming = client.rename('c1', 'Old connection')
    client.resetConnection()
    rename.resolve(await ok({ ...snapshot('c1'), title: 'Old connection' }))
    await expect(renaming).rejects.toThrow('connection')
    expect(client.getSnapshot()).toMatchObject({ phase: 'loading', items: [{ id: 'c1', title: 'Terminal c1' }] })
  })
})
