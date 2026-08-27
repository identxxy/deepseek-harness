import { PassThrough } from 'node:stream'
import { Context } from '@deepseek-ai/cordis'
import { ConsoleAttachmentCapability } from '@deepseek-ai/dsh-console'
import type {
  ConsoleAttachmentSnapshot, ConsoleOutputObservation, ConsoleOutputRead,
} from '@deepseek-ai/dsh-console'
import { WorkspaceId } from '@deepseek-ai/dsh-workspace'
import { describe, expect, it, vi } from 'vitest'
import { TmuxConsoleRuntime } from '../src/index.ts'
import { CONSOLE_TMUX_METADATA_OPTION } from '../src/tmux-protocol.ts'
import { encodeConsoleMetadata } from '../src/metadata.ts'

const config = {
  tmuxPath: 'tmux', serverName: 'dsh-test', shellPath: 'bash', shellArgs: [], term: 'xterm-256color',
  windowSizePolicy: 'largest' as const,
  commandTimeoutMs: 5_000, commandGraceMs: 100, commandOutputBytes: 64_000,
  attachmentGraceMs: 100, attachmentIdleTtlMs: 60_000, reconcileIntervalMs: 5_000,
  outputRetentionBytes: 64_000, maxReadBytes: 16_000, maxOutputWaitersPerAttachment: 8,
  maxConsoles: 16, maxAttachmentsPerConsole: 4,
}

function outputReader(text: string) {
  return { readFrom: () => ({ text, nextOffset: Buffer.byteLength(text), lossy: false }) }
}

function commandHandle(stdout: string, stderr = '', exitCode = 0) {
  return {
    pid: 1,
    stdin: undefined,
    stdout: undefined,
    stderr: undefined,
    collected: { stdout: outputReader(stdout), stderr: outputReader(stderr) },
    done: Promise.resolve({ exitCode, signal: null }),
    terminate: vi.fn(),
    waitForExit: vi.fn(async () => true),
  }
}

function deferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((res) => { resolve = res })
  return { promise, resolve }
}

function createFakeTmux(noServerDiagnostic = 'no server running\n') {
  const sessions = new Map<string, string>()
  const spawn = vi.fn((spec: { argv: readonly string[] }) => {
    const args = spec.argv.slice(3)
    const command = args[0]
    if (command === '-V') return commandHandle('tmux 3.4\n')
    if (command === 'list-sessions') {
      if (sessions.size === 0) return commandHandle('', noServerDiagnostic, 1)
      return commandHandle([...sessions].map(([name, metadata]) => `${name}\t${metadata}`).join('\n') + '\n')
    }
    if (command === 'new-session') {
      const name = args[args.indexOf('-s') + 1]
      if (name === undefined) throw new Error('missing test session name')
      sessions.set(name, '')
      return commandHandle('')
    }
    if (command === 'set-option') {
      if (args.includes('-g')) return commandHandle('')
      const name = args[args.indexOf('-t') + 1]
      const option = args.at(-2)
      const value = args.at(-1)
      if (name === undefined || option !== CONSOLE_TMUX_METADATA_OPTION || value === undefined) throw new Error('invalid metadata command')
      sessions.set(name, value)
      return commandHandle('')
    }
    if (command === 'show-options') {
      const name = args[args.indexOf('-t') + 1]
      return sessions.has(name ?? '') ? commandHandle(`${sessions.get(name ?? '')}\n`) : commandHandle('', 'unknown session\n', 1)
    }
    if (command === 'list-windows') return commandHandle('0\n')
    if (command === 'set-window-option') return commandHandle('')
    if (command === 'kill-session') {
      const name = args[args.indexOf('-t') + 1]
      sessions.delete(name ?? '')
      return commandHandle('')
    }
    throw new Error(`unexpected tmux command: ${args.join(' ')}`)
  })
  return { sessions, spawn }
}

async function setup(tmux = createFakeTmux(), configOverride = config) {
  const ctx = new Context()
  const workspaceId = WorkspaceId('workspace-1')
  ctx.provide('workspaceRegistry', {
    get: (id: typeof workspaceId) => id === workspaceId
      ? { id: workspaceId, path: '/workspace', status: async () => 'ok' as const }
      : undefined,
  } as never)
  const terminalOutput = new PassThrough()
  const terminalOutcome = deferred<{ exitCode: number | null; signal: NodeJS.Signals | null }>()
  const terminal = {
    pid: 42,
    output: terminalOutput,
    done: terminalOutcome.promise,
    write: vi.fn(async () => {}),
    resize: vi.fn(async () => {}),
    inspectForeground: vi.fn(async () => undefined),
    signalForeground: vi.fn(async () => 42),
    terminate: vi.fn(async () => {
      terminalOutcome.resolve({ exitCode: 0, signal: null })
      terminalOutput.end()
    }),
  }
  const subprocess = {
    resolveExecutable: vi.fn(async (name: string) => `/resolved/${name}`),
    spawn: tmux.spawn,
    spawnTerminal: vi.fn(async () => terminal),
  }
  ctx.provide('subprocess', subprocess as never)
  const fiber = await ctx.plugin(TmuxConsoleRuntime, configOverride)
  return { ctx, runtime: ctx.consoles as TmuxConsoleRuntime, workspaceId, subprocess, tmux, terminal, terminalOutput, fiber }
}

describe('TmuxConsoleRuntime', () => {
  it('publishes the durable Console provider', async () => {
    const provider = await import('../src/index.ts')
    expect(provider).toHaveProperty('TmuxConsoleRuntime')
    expect(provider.default).toBe(provider.TmuxConsoleRuntime)
  })

  it.each(['list', 'create', 'rename', 'setArchived', 'attach', 'detach', 'terminate'])('implements %s', (method) => {
    expect(TmuxConsoleRuntime.prototype).toHaveProperty(method)
  })

  it('creates a detached tmux workload and publishes it only after metadata read-back', async () => {
    const { runtime, workspaceId, tmux } = await setup()
    const snapshot = await runtime.create({
      workspaceId, title: 'Research shell', initialSize: { rows: 31, cols: 101 },
    })
    expect(snapshot).toMatchObject({
      workspaceId: 'workspace-1', cwd: '/workspace', title: 'Research shell', archived: false,
      status: { kind: 'running' },
    })
    expect(snapshot.id).toMatch(/^[0-9a-f-]{36}$/)
    expect(tmux.sessions.size).toBe(1)
    expect(tmux.spawn).toHaveBeenCalledWith(expect.objectContaining({
      argv: expect.arrayContaining(['set-window-option', '-g', 'window-size', 'largest']) as unknown as string[],
    }))
    expect(tmux.spawn).toHaveBeenCalledWith(expect.objectContaining({
      argv: expect.arrayContaining([
        'set-window-option', '-t', expect.stringMatching(/:$/), 'window-size', 'largest',
      ]) as unknown as string[],
    }))
    await expect(runtime.list()).resolves.toEqual([snapshot])
  })

  it('treats a missing dedicated tmux socket as an empty catalog', async () => {
    const tmux = createFakeTmux('error connecting to /tmp/tmux-1000/dsh-test (No such file or directory)\n')
    const { runtime } = await setup(tmux)
    await expect(runtime.list()).resolves.toEqual([])
  })

  it('reconciles an externally killed tmux session on the configured cadence', async () => {
    const tmux = createFakeTmux()
    const { runtime, workspaceId, fiber } = await setup(tmux, { ...config, reconcileIntervalMs: 10 })
    const created = await runtime.create({ workspaceId, title: 'Shell', initialSize: { rows: 24, cols: 80 } })
    tmux.sessions.clear()

    await vi.waitFor(() => {
      expect(runtime.snapshot(created.id).status).toEqual({ kind: 'ended', reason: 'external' })
    }, { timeout: 1_000 })
    await fiber.dispose()
  })

  it('persists rename and archive state in tmux metadata before publishing it', async () => {
    const { runtime, workspaceId, tmux } = await setup()
    const created = await runtime.create({ workspaceId, title: 'Shell', initialSize: { rows: 24, cols: 80 } })
    await expect(runtime.rename(created.id, 'Long experiment')).resolves.toMatchObject({ title: 'Long experiment' })
    await expect(runtime.setArchived(created.id, true)).resolves.toMatchObject({ title: 'Long experiment', archived: true })
    const encoded = [...tmux.sessions.values()][0]
    expect(encoded).toContain('dsh-console:v1:')
    await expect(runtime.list()).resolves.toEqual([expect.objectContaining({ title: 'Long experiment', archived: true })])
  })

  it('terminates only the addressed tmux session and removes its catalog record', async () => {
    const { runtime, workspaceId, tmux } = await setup()
    const first = await runtime.create({ workspaceId, title: 'First', initialSize: { rows: 24, cols: 80 } })
    const second = await runtime.create({ workspaceId, title: 'Second', initialSize: { rows: 24, cols: 80 } })
    await runtime.terminate(first.id)
    expect(tmux.sessions.size).toBe(1)
    expect(() => runtime.snapshot(first.id)).toThrow(expect.objectContaining({ code: 'UNKNOWN_CONSOLE' }))
    expect(runtime.snapshot(second.id).title).toBe('Second')
  })

  it('cleans an externally ended Console without issuing another tmux kill', async () => {
    const tmux = createFakeTmux()
    const { runtime, workspaceId } = await setup(tmux)
    const created = await runtime.create({ workspaceId, title: 'Ended', initialSize: { rows: 24, cols: 80 } })
    tmux.sessions.clear()
    await runtime.list()
    expect(runtime.snapshot(created.id).status).toEqual({ kind: 'ended', reason: 'external' })
    const killsBefore = tmux.spawn.mock.calls.filter(call => (call[0].argv).includes('kill-session')).length
    await runtime.terminate(created.id)
    const killsAfter = tmux.spawn.mock.calls.filter(call => (call[0].argv).includes('kill-session')).length
    expect(killsAfter).toBe(killsBefore)
    expect(() => runtime.snapshot(created.id)).toThrow(expect.objectContaining({ code: 'UNKNOWN_CONSOLE' }))
    expect(() => runtime.terminate(created.id)).toThrow(expect.objectContaining({ code: 'UNKNOWN_CONSOLE' }))
  })

  it('authorizes one ephemeral attachment while detach leaves the tmux workload running', async () => {
    const { runtime, workspaceId, subprocess, tmux, terminal, terminalOutput } = await setup()
    const created = await runtime.create({ workspaceId, title: 'Shell', initialSize: { rows: 24, cols: 80 } })
    const opened = await runtime.attach({ consoleId: created.id, size: { rows: 31, cols: 101 } })
    expect(subprocess.spawnTerminal).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({
      argv: expect.arrayContaining(['-L', 'dsh-test', 'attach-session', '-E', '-t']) as unknown as string[],
      cwd: process.cwd(), term: 'xterm-256color', rows: 31, cols: 101, graceMs: 100,
    }))
    await runtime.write(opened.access, 'printf marker\n')
    await runtime.resize(opened.access, { rows: 32, cols: 102 })
    expect(terminal.write).toHaveBeenCalledWith('printf marker\n')
    expect(terminal.resize).toHaveBeenCalledWith({ rows: 32, cols: 102 })
    terminalOutput.write('screen')
    expect(runtime.readOutput(opened.access, 0)).toMatchObject({ kind: 'data', nextByte: 6 })

    const wrong = { ...opened.access, capability: ConsoleAttachmentCapability('wrong') }
    expect(() => runtime.attachmentSnapshot(wrong)).toThrow(expect.objectContaining({ code: 'ACCESS_DENIED' }))
    await runtime.detach(opened.access)
    expect(terminal.terminate).toHaveBeenCalledOnce()
    expect(tmux.sessions.size).toBe(1)
    expect(runtime.snapshot(created.id).status).toEqual({ kind: 'running' })
  })

  it('wakes independent attachment output observers without sharing cursors', async () => {
    const { runtime, workspaceId, terminalOutput } = await setup()
    const created = await runtime.create({ workspaceId, title: 'Shell', initialSize: { rows: 24, cols: 80 } })
    const opened = await runtime.attach({ consoleId: created.id, size: { rows: 24, cols: 80 } })
    const first = runtime.waitOutput(opened.access, 0, new AbortController().signal)
    const second = runtime.waitOutput(opened.access, 0, new AbortController().signal)
    terminalOutput.write('screen')
    const observation = expect.objectContaining({
      attachment: expect.objectContaining({ nextOutputByte: 6 }) as unknown as ConsoleAttachmentSnapshot,
      output: expect.objectContaining({ kind: 'data', nextByte: 6 }) as unknown as ConsoleOutputRead,
    }) as unknown as ConsoleOutputObservation
    await expect(Promise.all([first, second])).resolves.toEqual([observation, observation])
  })

  it('quiesces every Web attachment when the Console is explicitly terminated', async () => {
    const { runtime, workspaceId, terminal, tmux } = await setup()
    const created = await runtime.create({ workspaceId, title: 'Shell', initialSize: { rows: 24, cols: 80 } })
    const opened = await runtime.attach({ consoleId: created.id, size: { rows: 24, cols: 80 } })
    await runtime.terminate(created.id)
    expect(terminal.terminate).toHaveBeenCalledOnce()
    expect(tmux.sessions.size).toBe(0)
    expect(() => runtime.attachmentSnapshot(opened.access)).toThrow(expect.objectContaining({ code: 'ACCESS_DENIED' }))
  })

  it('drains an attachment allocated after caller cancellation without publishing it', async () => {
    const { runtime, workspaceId, subprocess, terminal } = await setup()
    const created = await runtime.create({ workspaceId, title: 'Shell', initialSize: { rows: 24, cols: 80 } })
    const controller = new AbortController()
    subprocess.spawnTerminal.mockImplementationOnce(async () => {
      controller.abort(new Error('caller cancelled'))
      return terminal
    })
    await expect(runtime.attach({ consoleId: created.id, size: { rows: 24, cols: 80 } }, controller.signal))
      .rejects.toThrow('caller cancelled')
    expect(terminal.terminate).toHaveBeenCalledOnce()
  })

  it.each([
    { rows: 0, cols: 80 }, { rows: 24, cols: 0 }, { rows: 1.5, cols: 80 }, { rows: 24, cols: Number.MAX_SAFE_INTEGER + 1 },
  ])('rejects invalid terminal dimensions %#', async (size) => {
    const { runtime, workspaceId } = await setup()
    await expect(runtime.create({ workspaceId, title: 'Shell', initialSize: size })).rejects.toThrow('positive safe integers')
  })

  it('rejects unsupported tmux versions and unexpected catalog failures', async () => {
    for (const version of ['not tmux\n', 'tmux 2.9\n', 'tmux 3.1\n']) {
      const tmux = createFakeTmux()
      tmux.spawn.mockImplementationOnce(() => commandHandle(version))
      await expect(setup(tmux)).rejects.toThrow('requires tmux >= 3.2')
    }
    const tmux = createFakeTmux('permission denied\n')
    await expect(setup(tmux)).rejects.toMatchObject({ code: 'PROVIDER_FAILURE' })
  })

  it('recovers only owned valid sessions and refreshes recovered metadata', async () => {
    const tmux = createFakeTmux()
    const id = '123e4567-e89b-42d3-a456-426614174000'
    const metadata = {
      version: 1 as const, consoleId: id, workspaceId: 'workspace-1', cwd: '/workspace', title: 'Recovered',
      createdAt: '2026-08-26T09:00:00.000Z', archived: false,
    }
    tmux.sessions.set(`dsh-${id}`, encodeConsoleMetadata(metadata))
    tmux.sessions.set('unowned', 'metadata')
    tmux.sessions.set('dsh-123e4567-e89b-42d3-a456-426614174001', 'malformed')
    const { runtime } = await setup(tmux)
    await expect(runtime.list()).resolves.toEqual([expect.objectContaining({ title: 'Recovered' })])
    tmux.sessions.set(`dsh-${id}`, encodeConsoleMetadata({ ...metadata, title: 'Refreshed' }))
    await expect(runtime.list()).resolves.toEqual([expect.objectContaining({ title: 'Refreshed' })])
  })

  it('applies the configured policy to every existing window during recovery', async () => {
    const tmux = createFakeTmux()
    const id = '123e4567-e89b-42d3-a456-426614174000'
    tmux.sessions.set(`dsh-${id}`, encodeConsoleMetadata({
      version: 1, consoleId: id, workspaceId: 'workspace-1', cwd: '/workspace', title: 'Recovered',
      createdAt: '2026-08-26T09:00:00.000Z', archived: false,
    }))
    const base = tmux.spawn.getMockImplementation()
    tmux.spawn.mockImplementation((spec: { argv: readonly string[] }) => {
      const args = spec.argv.slice(3)
      if (args[0] === 'list-windows') return commandHandle('0\n2\n')
      if (base === undefined) throw new Error('missing fake implementation')
      return base(spec)
    })
    await setup(tmux)
    const policies = tmux.spawn.mock.calls.map(call => call[0].argv).filter(argv => (
      argv.includes('set-window-option') && argv.includes('window-size') && !argv.includes('-g')
    ))
    expect(policies).toEqual([
      expect.arrayContaining(['-t', `dsh-${id}:0`, 'window-size', 'largest']),
      expect.arrayContaining(['-t', `dsh-${id}:2`, 'window-size', 'largest']),
    ])
  })

  it('rejects malformed window indexes during recovery', async () => {
    const tmux = createFakeTmux()
    const id = '123e4567-e89b-42d3-a456-426614174000'
    tmux.sessions.set(`dsh-${id}`, encodeConsoleMetadata({
      version: 1, consoleId: id, workspaceId: 'workspace-1', cwd: '/workspace', title: 'Recovered',
      createdAt: '2026-08-26T09:00:00.000Z', archived: false,
    }))
    const base = tmux.spawn.getMockImplementation()
    tmux.spawn.mockImplementation((spec: { argv: readonly string[] }) => {
      if (spec.argv.slice(3)[0] === 'list-windows') return commandHandle('invalid\n')
      if (base === undefined) throw new Error('missing fake implementation')
      return base(spec)
    })
    await expect(setup(tmux)).rejects.toMatchObject({ code: 'PROVIDER_FAILURE' })
  })

  it('enforces Console catalog, workspace, title, archive, and attachment limits', async () => {
    const tmux = createFakeTmux()
    const { runtime, workspaceId, ctx } = await setup(tmux, { ...config, maxConsoles: 1, maxAttachmentsPerConsole: 1 })
    const created = await runtime.create({ workspaceId, title: 'Shell', initialSize: { rows: 24, cols: 80 } })
    await expect(runtime.create({ workspaceId, title: 'Second', initialSize: { rows: 24, cols: 80 } }))
      .rejects.toMatchObject({ code: 'RESOURCE_LIMIT' })
    await expect(runtime.rename(created.id, '')).rejects.toThrow('must not be empty')
    tmux.sessions.clear()
    ;(runtime as unknown as { records: Map<unknown, unknown> }).records.clear()
    await expect(runtime.create({ workspaceId: WorkspaceId('missing'), title: 'Missing', initialSize: { rows: 24, cols: 80 } }))
      .rejects.toMatchObject({ code: 'UNKNOWN_WORKSPACE' })
    const registry = ctx.workspaceRegistry as unknown as { get: (id: typeof workspaceId) => unknown }
    registry.get = () => ({ id: workspaceId, path: '/workspace', status: async () => 'missing' })
    ;(runtime as unknown as { records: Map<unknown, unknown> }).records.clear()
    await expect(runtime.create({ workspaceId, title: 'Unavailable', initialSize: { rows: 24, cols: 80 } }))
      .rejects.toMatchObject({ code: 'WORKSPACE_UNAVAILABLE' })
    registry.get = () => ({ id: workspaceId, path: '/workspace', status: async () => 'ok' })
    ;(runtime as unknown as { records: Map<unknown, unknown> }).records.set(created.id, {
      sessionName: `dsh-${created.id}`,
      metadata: { version: 1, consoleId: created.id, workspaceId, cwd: '/workspace', title: 'Shell', createdAt: created.createdAt, archived: true },
      status: { kind: 'running' },
    })
    await expect(runtime.attach({ consoleId: created.id, size: { rows: 24, cols: 80 } })).rejects.toMatchObject({ code: 'CONSOLE_ARCHIVED' })
    await runtime.setArchived(created.id, false)
    const opened = await runtime.attach({ consoleId: created.id, size: { rows: 24, cols: 80 } })
    await expect(runtime.attach({ consoleId: created.id, size: { rows: 24, cols: 80 } })).rejects.toMatchObject({ code: 'RESOURCE_LIMIT' })
    await runtime.detach(opened.access)
  })

  it('rolls back a partially created session and aggregates rollback failure', async () => {
    for (const rollbackFails of [false, true]) {
      const tmux = createFakeTmux()
      const base = tmux.spawn.getMockImplementation()
      tmux.spawn.mockImplementation((spec: { argv: readonly string[] }) => {
        const args = spec.argv.slice(3)
        if (args[0] === 'set-window-option') return commandHandle('', 'configure failed', 1)
        if (rollbackFails && args[0] === 'kill-session') return commandHandle('', 'rollback failed', 1)
        if (base === undefined) throw new Error('missing fake implementation')
        return base(spec)
      })
      const { runtime, workspaceId } = await setup(tmux)
      const failure = runtime.create({ workspaceId, title: 'Shell', initialSize: { rows: 24, cols: 80 } })
      if (rollbackFails) await expect(failure).rejects.toBeInstanceOf(AggregateError)
      else await expect(failure).rejects.toMatchObject({ code: 'PROVIDER_FAILURE' })
    }
  })

  it('rejects metadata transactions whose read-back is absent or mismatched', async () => {
    const tmux = createFakeTmux()
    const { runtime, workspaceId } = await setup(tmux)
    const created = await runtime.create({ workspaceId, title: 'Shell', initialSize: { rows: 24, cols: 80 } })
    const base = tmux.spawn.getMockImplementation()
    tmux.spawn.mockImplementation((spec: { argv: readonly string[] }) => {
      const args = spec.argv.slice(3)
      if (args[0] === 'show-options') return commandHandle('malformed\n')
      if (base === undefined) throw new Error('missing fake implementation')
      return base(spec)
    })
    await expect(runtime.rename(created.id, 'Changed')).rejects.toMatchObject({ code: 'PROVIDER_FAILURE' })
  })

  it('handles output completion, failure, abort, waiter limits, and exited attachments', async () => {
    const { runtime, workspaceId, terminal, terminalOutput } = await setup(
      createFakeTmux(), { ...config, maxOutputWaitersPerAttachment: 1 },
    )
    const created = await runtime.create({ workspaceId, title: 'Shell', initialSize: { rows: 24, cols: 80 } })
    const opened = await runtime.attach({ consoleId: created.id, size: { rows: 24, cols: 80 } })
    const controller = new AbortController()
    const waiting = runtime.waitOutput(opened.access, 0, controller.signal)
    await expect(runtime.waitOutput(opened.access, 0, new AbortController().signal)).rejects.toMatchObject({ code: 'OUTPUT_WAITER_LIMIT' })
    controller.abort(new Error('cancel wait'))
    await expect(waiting).rejects.toThrow('cancel wait')
    const immediateController = new AbortController()
    immediateController.abort()
    await expect(runtime.waitOutput(opened.access, 0, immediateController.signal)).rejects.toThrow()
    terminalOutput.end()
    await vi.waitFor(() => { expect(runtime.attachmentSnapshot(opened.access).status.kind).toBe('running') })
    const outcome = (terminal as unknown as { terminate: () => Promise<void> }).terminate()
    await outcome
    await vi.waitFor(() =>{  expect(runtime.attachmentSnapshot(opened.access).status.kind).toBe('exited') })
    await expect(runtime.write(opened.access, 'x')).rejects.toMatchObject({ code: 'ATTACHMENT_EXITED' })
    await expect(runtime.waitOutput(opened.access, 0, new AbortController().signal)).resolves.toMatchObject({ attachment: { status: { kind: 'exited' } } })
  })

  it('marks an attachment failed when its output stream or outcome rejects', async () => {
    const first = await setup()
    const created = await first.runtime.create({ workspaceId: first.workspaceId, title: 'Shell', initialSize: { rows: 24, cols: 80 } })
    const opened = await first.runtime.attach({ consoleId: created.id, size: { rows: 24, cols: 80 } })
    first.terminalOutput.emit('error', new Error('stream failed'))
    await vi.waitFor(() =>{  expect(first.runtime.attachmentSnapshot(opened.access).status).toMatchObject({ kind: 'failed' }) })
    const second = await setup()
    second.subprocess.spawnTerminal.mockImplementationOnce(async () => ({
      ...second.terminal, done: Promise.reject(new Error('pty failed')),
    }))
    const createdSecond = await second.runtime.create({ workspaceId: second.workspaceId, title: 'Shell', initialSize: { rows: 24, cols: 80 } })
    const openedSecond = await second.runtime.attach({ consoleId: createdSecond.id, size: { rows: 24, cols: 80 } })
    await vi.waitFor(() =>{  expect(second.runtime.attachmentSnapshot(openedSecond.access).status).toMatchObject({ kind: 'failed' }) })
  })

  it('sorts the durable catalog newest first', async () => {
    const { runtime, workspaceId } = await setup()
    const first = await runtime.create({ workspaceId, title: 'First', initialSize: { rows: 24, cols: 80 } })
    await new Promise(resolve => setTimeout(resolve, 2))
    const second = await runtime.create({ workspaceId, title: 'Second', initialSize: { rows: 24, cols: 80 } })
    await expect(runtime.list()).resolves.toEqual([expect.objectContaining({ id: second.id }), expect.objectContaining({ id: first.id })])
  })

  it('exposes lifecycle guards for unknown, ending, terminating, and disposing state', async () => {
    const { runtime, workspaceId } = await setup()
    await expect(runtime.rename('missing' as never, 'Title')).rejects.toMatchObject({ code: 'UNKNOWN_CONSOLE' })
    const created = await runtime.create({ workspaceId, title: 'Shell', initialSize: { rows: 24, cols: 80 } })
    const internals = runtime as unknown as {
      records: Map<unknown, { status: { kind: string; reason?: string } }>
      terminations: Map<unknown, Promise<void>>
      disposing: boolean
      runner?: unknown
      resolvedTmuxPath?: string
    }
    internals.terminations.set(created.id, Promise.resolve())
    await expect(runtime.rename(created.id, 'Title')).rejects.toMatchObject({ code: 'CONSOLE_TERMINATING' })
    internals.terminations.clear()
    const record = internals.records.get(created.id)
    if (record === undefined) throw new Error('missing record')
    record.status = { kind: 'ended', reason: 'external' }
    await expect(runtime.rename(created.id, 'Title')).rejects.toMatchObject({ code: 'CONSOLE_ENDED' })
    internals.disposing = true
    await expect(runtime.list()).rejects.toMatchObject({ code: 'SERVICE_DISPOSING' })
    internals.disposing = false
    internals.runner = undefined
    await expect(runtime.list()).rejects.toMatchObject({ code: 'PROVIDER_FAILURE' })
    delete internals.resolvedTmuxPath
    record.status = { kind: 'running' }
    await expect(runtime.attach({ consoleId: created.id, size: { rows: 24, cols: 80 } })).rejects.toMatchObject({ code: 'PROVIDER_FAILURE' })
  })

  it('guards wait, write, resize, and close operations during attachment transitions', async () => {
    const { runtime, workspaceId, terminal } = await setup()
    const created = await runtime.create({ workspaceId, title: 'Shell', initialSize: { rows: 24, cols: 80 } })
    const opened = await runtime.attach({ consoleId: created.id, size: { rows: 24, cols: 80 } })
    const internals = runtime as unknown as {
      attachments: Map<unknown, {
        closing: boolean
        closePromise?: Promise<void>
        status: { kind: string }
        idleTimer?: ReturnType<typeof setTimeout>
      }>
      disposing: boolean
    }
    const record = internals.attachments.get(opened.access.attachmentId)
    if (record === undefined) throw new Error('missing attachment')
    const pending = runtime.waitOutput(opened.access, 0, new AbortController().signal)
    const closing = runtime.detach(opened.access)
    await expect(pending).rejects.toMatchObject({ code: 'ATTACHMENT_CLOSING' })
    expect(runtime.detach(opened.access)).toBe(closing)
    await closing

    const reopened = await runtime.attach({ consoleId: created.id, size: { rows: 24, cols: 80 } })
    const live = internals.attachments.get(reopened.access.attachmentId)
    if (live === undefined) throw new Error('missing live attachment')
    live.closing = true
    await expect(runtime.waitOutput(reopened.access, 0, new AbortController().signal)).rejects.toMatchObject({ code: 'ATTACHMENT_CLOSING' })
    await expect(runtime.write(reopened.access, 'x')).rejects.toMatchObject({ code: 'ATTACHMENT_CLOSING' })
    live.closing = false
    internals.disposing = true
    await expect(runtime.waitOutput(reopened.access, 0, new AbortController().signal)).rejects.toMatchObject({ code: 'SERVICE_DISPOSING' })
    await expect(runtime.resize(reopened.access, { rows: 24, cols: 80 })).rejects.toMatchObject({ code: 'SERVICE_DISPOSING' })
    internals.disposing = false
    expect(terminal.terminate).toHaveBeenCalled()
  })

  it('allows retry after attachment termination failure', async () => {
    const { runtime, workspaceId, terminal } = await setup()
    const created = await runtime.create({ workspaceId, title: 'Shell', initialSize: { rows: 24, cols: 80 } })
    const opened = await runtime.attach({ consoleId: created.id, size: { rows: 24, cols: 80 } })
    terminal.terminate.mockRejectedValueOnce(new Error('terminate failed'))
    await expect(runtime.detach(opened.access)).rejects.toThrow('terminate failed')
    await expect(runtime.detach(opened.access)).resolves.toBeUndefined()
  })

  it('deduplicates concurrent termination and aggregates attachment teardown failures', async () => {
    const { runtime, workspaceId, terminal } = await setup()
    const created = await runtime.create({ workspaceId, title: 'Shell', initialSize: { rows: 24, cols: 80 } })
    await runtime.attach({ consoleId: created.id, size: { rows: 24, cols: 80 } })
    terminal.terminate.mockRejectedValue(new Error('attachment teardown failed'))
    const first = runtime.terminate(created.id)
    const second = runtime.terminate(created.id)
    expect(second).toBe(first)
    await expect(first).rejects.toBeInstanceOf(AggregateError)
  })

  it('covers command diagnostics and private reconciliation serialization', async () => {
    const { runtime } = await setup()
    const internals = runtime as unknown as {
      ensureSuccess: (result: unknown, operation: string) => void
      reconcile: () => Promise<boolean>
      reconcilePromise?: Promise<boolean>
    }
    for (const result of [
      { stdout: 'stdout diagnostic', stderr: '', exitCode: 1, signal: null },
      { stdout: '', stderr: '', exitCode: null, signal: 'SIGKILL' },
      { stdout: '', stderr: '', exitCode: null, signal: null },
    ]) expect(() =>{  internals.ensureSuccess(result, 'operation') }).toThrow('operation failed')
    const pending = Promise.resolve(true)
    internals.reconcilePromise = pending
    await expect(internals.reconcile()).resolves.toBe(true)
    delete internals.reconcilePromise
  })

  it('does not clear a newer reconciliation owner when an older pass settles', async () => {
    const { runtime } = await setup()
    const gate = deferred<boolean>()
    const newer = Promise.resolve(false)
    const internals = runtime as unknown as {
      reconcile: () => Promise<boolean>
      reconcileNow: () => Promise<boolean>
      reconcilePromise?: Promise<boolean>
    }
    internals.reconcileNow = () => gate.promise
    const older = internals.reconcile()
    internals.reconcilePromise = newer
    gate.resolve(true)
    await expect(older).resolves.toBe(true)
    expect(internals.reconcilePromise).toBe(newer)
  })

  it('reconciles malformed lines and marks only previously running unseen records ended', async () => {
    const tmux = createFakeTmux()
    const { runtime, workspaceId } = await setup(tmux)
    const created = await runtime.create({ workspaceId, title: 'Shell', initialSize: { rows: 24, cols: 80 } })
    tmux.sessions.clear()
    tmux.sessions.set('line-without-tab', 'ignored')
    const base = tmux.spawn.getMockImplementation()
    tmux.spawn.mockImplementation((spec: { argv: readonly string[] }) => {
      const args = spec.argv.slice(3)
      if (args[0] === 'list-sessions') return commandHandle('line-without-tab\nunowned\tmetadata\n')
      if (base === undefined) throw new Error('missing fake implementation')
      return base(spec)
    })
    await runtime.list()
    expect(runtime.snapshot(created.id).status).toEqual({ kind: 'ended', reason: 'external' })
    await runtime.list()
    expect(runtime.snapshot(created.id).status).toEqual({ kind: 'ended', reason: 'external' })
  })

  it('rejects an empty create title after workspace validation', async () => {
    const { runtime, workspaceId } = await setup()
    await expect(runtime.create({ workspaceId, title: '', initialSize: { rows: 24, cols: 80 } })).rejects.toThrow('must not be empty')
  })

  it('handles failures before and after tmux session allocation', async () => {
    for (const failCommand of ['new-session', 'show-options']) {
      const tmux = createFakeTmux()
      const base = tmux.spawn.getMockImplementation()
      tmux.spawn.mockImplementation((spec: { argv: readonly string[] }) => {
        const args = spec.argv.slice(3)
        if (args[0] === failCommand) return commandHandle(failCommand === 'show-options' ? 'malformed\n' : '', `${failCommand} failed`, failCommand === 'show-options' ? 0 : 1)
        if (base === undefined) throw new Error('missing fake implementation')
        return base(spec)
      })
      const { runtime, workspaceId } = await setup(tmux)
      await expect(runtime.create({ workspaceId, title: 'Shell', initialSize: { rows: 24, cols: 80 } }))
        .rejects.toMatchObject({ code: 'PROVIDER_FAILURE' })
    }
  })

  it('rolls back when new-session creates its side effect before the runner rejects', async () => {
    const tmux = createFakeTmux()
    const base = tmux.spawn.getMockImplementation()
    tmux.spawn.mockImplementation((spec: { argv: readonly string[] }) => {
      const handle = base?.(spec)
      if (handle === undefined) throw new Error('missing fake implementation')
      if (spec.argv.slice(3)[0] === 'new-session') return { ...handle, done: Promise.reject(new Error('runner timed out after creation')) }
      return handle
    })
    const { runtime, workspaceId } = await setup(tmux)
    await expect(runtime.create({ workspaceId, title: 'Shell', initialSize: { rows: 24, cols: 80 } }))
      .rejects.toThrow('runner timed out after creation')
    expect(tmux.sessions.size).toBe(0)
  })

  it('treats an absent session as a completed rollback after new-session failure', async () => {
    const tmux = createFakeTmux()
    const base = tmux.spawn.getMockImplementation()
    tmux.spawn.mockImplementation((spec: { argv: readonly string[] }) => {
      const command = spec.argv.slice(3)[0]
      if (command === 'new-session') return commandHandle('', 'creation failed', 1)
      if (command === 'kill-session') return commandHandle('', "can't find session: missing", 1)
      if (base === undefined) throw new Error('missing fake implementation')
      return base(spec)
    })
    const { runtime, workspaceId } = await setup(tmux)
    await expect(runtime.create({ workspaceId, title: 'Shell', initialSize: { rows: 24, cols: 80 } }))
      .rejects.toMatchObject({ code: 'PROVIDER_FAILURE' })
  })

  it('reports disposal that begins while a terminal attachment is spawning', async () => {
    const { runtime, workspaceId, subprocess, terminal } = await setup()
    const created = await runtime.create({ workspaceId, title: 'Shell', initialSize: { rows: 24, cols: 80 } })
    subprocess.spawnTerminal.mockImplementationOnce(async () => {
      ;(runtime as unknown as { disposing: boolean }).disposing = true
      return terminal
    })
    await expect(runtime.attach({ consoleId: created.id, size: { rows: 24, cols: 80 } }))
      .rejects.toMatchObject({ code: 'SERVICE_DISPOSING' })
  })

  it('uses a DOM abort error for non-Error abort reasons', async () => {
    const { runtime, workspaceId } = await setup()
    const created = await runtime.create({ workspaceId, title: 'Shell', initialSize: { rows: 24, cols: 80 } })
    const opened = await runtime.attach({ consoleId: created.id, size: { rows: 24, cols: 80 } })
    const controller = new AbortController()
    controller.abort('cancelled')
    await expect(runtime.waitOutput(opened.access, 0, controller.signal)).rejects.toMatchObject({ name: 'AbortError' })
  })

  it('accepts string output and preserves a prior failure after terminal completion', async () => {
    const { runtime, workspaceId, terminal, terminalOutput } = await setup()
    const created = await runtime.create({ workspaceId, title: 'Shell', initialSize: { rows: 24, cols: 80 } })
    const opened = await runtime.attach({ consoleId: created.id, size: { rows: 24, cols: 80 } })
    terminalOutput.emit('data', 'text')
    expect(runtime.readOutput(opened.access, 0)).toMatchObject({ kind: 'data', nextByte: 4 })
    terminalOutput.emit('error', new Error('stream failed'))
    await terminal.terminate()
    await vi.waitFor(() =>{  expect(runtime.attachmentSnapshot(opened.access).status).toMatchObject({ kind: 'failed' }) })
  })

  it('runs idle attachment cleanup and swallows termination failure', async () => {
    vi.useFakeTimers()
    try {
      const { runtime, workspaceId, terminal } = await setup(createFakeTmux(), { ...config, attachmentIdleTtlMs: 10 })
      const created = await runtime.create({ workspaceId, title: 'Shell', initialSize: { rows: 24, cols: 80 } })
      const opened = await runtime.attach({ consoleId: created.id, size: { rows: 24, cols: 80 } })
      terminal.terminate.mockRejectedValueOnce(new Error('idle close failed'))
      await vi.advanceTimersByTimeAsync(11)
      expect(terminal.terminate).toHaveBeenCalled()
      expect(runtime.attachmentSnapshot(opened.access)).toMatchObject({ status: { kind: 'running' } })
    } finally {
      vi.useRealTimers()
    }
  })

  it('logs periodic reconciliation failures without crashing the provider', async () => {
    vi.useFakeTimers()
    const error = vi.spyOn(console, 'error').mockImplementation(() => {})
    try {
      const { runtime } = await setup(createFakeTmux(), { ...config, reconcileIntervalMs: 10 })
      ;(runtime as unknown as { reconcile: () => Promise<boolean> }).reconcile = async () => { throw new Error('periodic failure') }
      await vi.advanceTimersByTimeAsync(11)
      await vi.waitFor(() =>{  expect(error).toHaveBeenCalledWith('console-tmux periodic reconciliation failed:', expect.any(Error)) })
    } finally {
      error.mockRestore()
      vi.useRealTimers()
    }
  })

  it('rejects pending waiters and aggregates attachment failures during provider disposal', async () => {
    const { runtime, workspaceId, terminal } = await setup()
    const created = await runtime.create({ workspaceId, title: 'Shell', initialSize: { rows: 24, cols: 80 } })
    const opened = await runtime.attach({ consoleId: created.id, size: { rows: 24, cols: 80 } })
    const waiting = runtime.waitOutput(opened.access, 0, new AbortController().signal)
    terminal.terminate.mockRejectedValueOnce(new Error('dispose close failed'))
    const dispose = (runtime as unknown as { disposeAll: () => Promise<void> }).disposeAll()
    await expect(waiting).rejects.toMatchObject({ code: 'SERVICE_DISPOSING' })
    await expect(dispose).rejects.toBeInstanceOf(AggregateError)
  })

  it('does not revive a terminated Console from an older reconciliation result', async () => {
    const tmux = createFakeTmux()
    const { runtime, workspaceId } = await setup(tmux)
    const created = await runtime.create({ workspaceId, title: 'Shell', initialSize: { rows: 24, cols: 80 } })
    const staleCatalog = [...tmux.sessions].map(([name, metadata]) => `${name}\t${metadata}`).join('\n') + '\n'
    const catalog = deferred<{ exitCode: number; signal: null }>()
    const base = tmux.spawn.getMockImplementation()
    let delayCatalog = true
    tmux.spawn.mockImplementation((spec: { argv: readonly string[] }) => {
      const args = spec.argv.slice(3)
      if (delayCatalog && args[0] === 'list-sessions') {
        delayCatalog = false
        return { ...commandHandle(staleCatalog), done: catalog.promise }
      }
      if (base === undefined) throw new Error('missing fake implementation')
      return base(spec)
    })
    const listing = runtime.list()
    await runtime.terminate(created.id)
    catalog.resolve({ exitCode: 0, signal: null })
    await listing
    expect(() => runtime.snapshot(created.id)).toThrow(expect.objectContaining({ code: 'UNKNOWN_CONSOLE' }))
  })

  it('closes an attachment whose spawn finishes after termination begins', async () => {
    const { runtime, workspaceId, subprocess, terminal } = await setup()
    const created = await runtime.create({ workspaceId, title: 'Shell', initialSize: { rows: 24, cols: 80 } })
    const spawned = deferred<typeof terminal>()
    subprocess.spawnTerminal.mockImplementationOnce(() => spawned.promise)
    const attaching = runtime.attach({ consoleId: created.id, size: { rows: 24, cols: 80 } })
    await runtime.terminate(created.id)
    spawned.resolve(terminal)
    await expect(attaching).rejects.toMatchObject({ code: 'CONSOLE_TERMINATING' })
    expect(terminal.terminate).toHaveBeenCalledOnce()
  })

  it.each(['removed', 'ended'] as const)('closes an attachment when its Console becomes %s during spawn', async (state) => {
    const { runtime, workspaceId, subprocess, terminal } = await setup()
    const created = await runtime.create({ workspaceId, title: 'Shell', initialSize: { rows: 24, cols: 80 } })
    const spawned = deferred<typeof terminal>()
    subprocess.spawnTerminal.mockImplementationOnce(() => spawned.promise)
    const attaching = runtime.attach({ consoleId: created.id, size: { rows: 24, cols: 80 } })
    const records = (runtime as unknown as { records: Map<unknown, { status: { kind: string; reason?: string } }> }).records
    const record = records.get(created.id)
    if (record === undefined) throw new Error('missing record')
    if (state === 'removed') records.delete(created.id)
    else record.status = { kind: 'ended', reason: 'external' }
    spawned.resolve(terminal)
    await expect(attaching).rejects.toMatchObject({ code: state === 'removed' ? 'UNKNOWN_CONSOLE' : 'CONSOLE_ENDED' })
    expect(terminal.terminate).toHaveBeenCalledOnce()
  })

  it('removes the termination fence when tmux termination fails', async () => {
    const tmux = createFakeTmux()
    const { runtime, workspaceId } = await setup(tmux)
    const created = await runtime.create({ workspaceId, title: 'Shell', initialSize: { rows: 24, cols: 80 } })
    const base = tmux.spawn.getMockImplementation()
    tmux.spawn.mockImplementation((spec: { argv: readonly string[] }) => {
      const args = spec.argv.slice(3)
      if (args[0] === 'kill-session') return commandHandle('', 'kill failed', 1)
      if (base === undefined) throw new Error('missing fake implementation')
      return base(spec)
    })
    await expect(runtime.terminate(created.id)).rejects.toMatchObject({ code: 'PROVIDER_FAILURE' })
    expect((runtime as unknown as { terminatedConsoleIds: Set<unknown> }).terminatedConsoleIds.has(created.id)).toBe(false)
    expect(runtime.snapshot(created.id).status).toEqual({ kind: 'running' })
  })

  it('serializes metadata mutations so stale copies cannot lose fields', async () => {
    const tmux = createFakeTmux()
    const { runtime, workspaceId } = await setup(tmux)
    const created = await runtime.create({ workspaceId, title: 'Shell', initialSize: { rows: 24, cols: 80 } })
    const gate = deferred<{ exitCode: number; signal: null }>()
    const base = tmux.spawn.getMockImplementation()
    let metadataWrites = 0
    tmux.spawn.mockImplementation((spec: { argv: readonly string[] }) => {
      const args = spec.argv.slice(3)
      const handle = base?.(spec)
      if (handle === undefined) throw new Error('missing fake implementation')
      if (args[0] === 'set-option' && args.includes(CONSOLE_TMUX_METADATA_OPTION)) {
        metadataWrites += 1
        if (metadataWrites === 1) return { ...handle, done: gate.promise }
      }
      return handle
    })
    const renamed = runtime.rename(created.id, 'Renamed')
    const archived = runtime.setArchived(created.id, true)
    await vi.waitFor(() => { expect(metadataWrites).toBe(1) })
    gate.resolve({ exitCode: 0, signal: null })
    await expect(Promise.all([renamed, archived])).resolves.toEqual([
      expect.objectContaining({ title: 'Renamed', archived: false }),
      expect.objectContaining({ title: 'Renamed', archived: true }),
    ])
    expect(metadataWrites).toBe(2)
  })

  it('reserves Console capacity before asynchronous workspace validation', async () => {
    const { runtime, workspaceId, ctx } = await setup(createFakeTmux(), { ...config, maxConsoles: 1 })
    const status = deferred<'ok'>()
    ;(ctx.workspaceRegistry as unknown as { get: () => unknown }).get = () => ({ id: workspaceId, path: '/workspace', status: () => status.promise })
    const first = runtime.create({ workspaceId, title: 'First', initialSize: { rows: 24, cols: 80 } })
    await vi.waitFor(() => { expect((runtime as unknown as { pendingCreates: number }).pendingCreates).toBe(1) })
    await expect(runtime.create({ workspaceId, title: 'Second', initialSize: { rows: 24, cols: 80 } }))
      .rejects.toMatchObject({ code: 'RESOURCE_LIMIT' })
    status.resolve('ok')
    await expect(first).resolves.toMatchObject({ title: 'First' })
  })

  it('reserves attachment capacity before asynchronous PTY allocation', async () => {
    const { runtime, workspaceId, subprocess, terminal } = await setup(createFakeTmux(), { ...config, maxAttachmentsPerConsole: 1 })
    const created = await runtime.create({ workspaceId, title: 'Shell', initialSize: { rows: 24, cols: 80 } })
    const spawned = deferred<typeof terminal>()
    subprocess.spawnTerminal.mockImplementationOnce(() => spawned.promise)
    const first = runtime.attach({ consoleId: created.id, size: { rows: 24, cols: 80 } })
    const pendingAttachments = (runtime as unknown as { pendingAttachments: Map<unknown, number> }).pendingAttachments
    await vi.waitFor(() => { expect(pendingAttachments.get(created.id)).toBe(1) })
    await expect(runtime.attach({ consoleId: created.id, size: { rows: 24, cols: 80 } }))
      .rejects.toMatchObject({ code: 'RESOURCE_LIMIT' })
    spawned.resolve(terminal)
    await expect(first).resolves.toMatchObject({ attachment: { consoleId: created.id } })
  })

  it('retains remaining attachment reservations as concurrent spawns settle', async () => {
    const { runtime, workspaceId, subprocess, terminal } = await setup(createFakeTmux(), { ...config, maxAttachmentsPerConsole: 2 })
    const created = await runtime.create({ workspaceId, title: 'Shell', initialSize: { rows: 24, cols: 80 } })
    const firstSpawn = deferred<typeof terminal>()
    const secondSpawn = deferred<typeof terminal>()
    subprocess.spawnTerminal.mockImplementationOnce(() => firstSpawn.promise).mockImplementationOnce(() => secondSpawn.promise)
    const first = runtime.attach({ consoleId: created.id, size: { rows: 24, cols: 80 } })
    const second = runtime.attach({ consoleId: created.id, size: { rows: 24, cols: 80 } })
    const pendingAttachments = (runtime as unknown as { pendingAttachments: Map<unknown, number> }).pendingAttachments
    await vi.waitFor(() => { expect(pendingAttachments.get(created.id)).toBe(2) })
    firstSpawn.resolve(terminal)
    await first
    expect(pendingAttachments.get(created.id)).toBe(1)
    secondSpawn.resolve({ ...terminal, output: new PassThrough() })
    await second
  })

  it('continues a serialized metadata lane after an earlier mutation fails', async () => {
    const tmux = createFakeTmux()
    const { runtime, workspaceId } = await setup(tmux)
    const created = await runtime.create({ workspaceId, title: 'Shell', initialSize: { rows: 24, cols: 80 } })
    const base = tmux.spawn.getMockImplementation()
    let fail = true
    tmux.spawn.mockImplementation((spec: { argv: readonly string[] }) => {
      const args = spec.argv.slice(3)
      if (fail && args[0] === 'set-option' && args.includes(CONSOLE_TMUX_METADATA_OPTION)) {
        fail = false
        return commandHandle('', 'metadata failed', 1)
      }
      if (base === undefined) throw new Error('missing fake implementation')
      return base(spec)
    })
    const failed = runtime.rename(created.id, 'Failed')
    const recovered = runtime.setArchived(created.id, true)
    await expect(failed).rejects.toMatchObject({ code: 'PROVIDER_FAILURE' })
    await expect(recovered).resolves.toMatchObject({ title: 'Shell', archived: true })
  })

  it('waits for an admitted create to confirm its side effect and roll it back during disposal', async () => {
    const tmux = createFakeTmux()
    const command = deferred<{ exitCode: number; signal: null }>()
    const base = tmux.spawn.getMockImplementation()
    let delayCreate = true
    tmux.spawn.mockImplementation((spec: { argv: readonly string[] }) => {
      const handle = base?.(spec)
      if (handle === undefined) throw new Error('missing fake implementation')
      if (delayCreate && spec.argv.slice(3)[0] === 'new-session') {
        delayCreate = false
        return { ...handle, done: command.promise }
      }
      return handle
    })
    const { runtime, workspaceId } = await setup(tmux)
    const creating = runtime.create({ workspaceId, title: 'Shell', initialSize: { rows: 24, cols: 80 } })
    await vi.waitFor(() => { expect(tmux.sessions.size).toBe(1) })
    let disposed = false
    const disposal = (runtime as unknown as { disposeAll: () => Promise<void> }).disposeAll().then(() => { disposed = true })
    await Promise.resolve()
    expect(disposed).toBe(false)
    command.resolve({ exitCode: 0, signal: null })
    await expect(creating).rejects.toMatchObject({ code: 'SERVICE_DISPOSING' })
    await disposal
    expect(tmux.sessions.size).toBe(0)
  })

  it('waits for an admitted attachment to close when disposal interrupts PTY allocation', async () => {
    const { runtime, workspaceId, subprocess, terminal } = await setup()
    const created = await runtime.create({ workspaceId, title: 'Shell', initialSize: { rows: 24, cols: 80 } })
    const spawned = deferred<typeof terminal>()
    subprocess.spawnTerminal.mockImplementationOnce(() => spawned.promise)
    const attaching = runtime.attach({ consoleId: created.id, size: { rows: 24, cols: 80 } })
    await vi.waitFor(() => { expect((runtime as unknown as { activeOperations: number }).activeOperations).toBe(1) })
    let disposed = false
    const disposal = (runtime as unknown as { disposeAll: () => Promise<void> }).disposeAll().then(() => { disposed = true })
    await Promise.resolve()
    expect(disposed).toBe(false)
    spawned.resolve(terminal)
    await expect(attaching).rejects.toMatchObject({ code: 'SERVICE_DISPOSING' })
    await disposal
    expect(terminal.terminate).toHaveBeenCalledOnce()
  })

  it('combines a caller signal with the create lifecycle signal', async () => {
    const { runtime, workspaceId } = await setup()
    await expect(runtime.create(
      { workspaceId, title: 'Shell', initialSize: { rows: 24, cols: 80 } },
      new AbortController().signal,
    )).resolves.toMatchObject({ title: 'Shell' })
  })

  it('reuses one pending operation-drain promise', async () => {
    const { runtime } = await setup()
    const internals = runtime as unknown as {
      activeOperations: number
      drainOperations: () => Promise<void>
      finishOperationDrain?: () => void
    }
    internals.activeOperations = 1
    const first = internals.drainOperations()
    const second = internals.drainOperations()
    expect(second).toBe(first)
    internals.finishOperationDrain?.()
    await first
    internals.activeOperations = 0
  })
})
