import { PassThrough } from 'node:stream'
import { Context, Service } from '@deepseek-ai/cordis'
import { describe, expect, it, vi } from 'vitest'
import { WorkspaceId } from '@deepseek-ai/dsh-workspace'
import { SubprocessRuntime } from '@deepseek-ai/dsh-subprocess'
import type {
  SubprocessHandle, SubprocessSpawnSpec, SubprocessTerminalHandle,
  SubprocessTerminalSpawnSpec,
} from '@deepseek-ai/dsh-subprocess'
import { ConsoleError, type ConsoleAccess } from '@deepseek-ai/dsh-console'
import LocalConsoleRuntime from '@deepseek-ai/dsh-console-local'

class StubWorkspaceRegistry extends Service {
  workspace = {
    id: WorkspaceId('workspace-1'), path: '/workspace',
    status: vi.fn<() => Promise<'ok' | 'missing-dir'>>(async () => 'ok'),
  }
  constructor(ctx: Context) { super(ctx, 'workspaceRegistry') }
  get(id: ReturnType<typeof WorkspaceId>): typeof this.workspace | undefined {
    return id === this.workspace.id ? this.workspace : undefined
  }
}

function deferred<T>(): { promise: Promise<T>; resolve: (value: T) => void; reject: (error: unknown) => void } {
  let resolve!: (value: T) => void
  let reject!: (error: unknown) => void
  const promise = new Promise<T>((res, rej) => { resolve = res; reject = rej })
  return { promise, resolve, reject }
}

class StubSubprocess extends SubprocessRuntime {
  readonly output = new PassThrough()
  readonly outcome = deferred<{ exitCode: number | null; signal: NodeJS.Signals | null }>()
  readonly terminalWrite = vi.fn(async () => {})
  readonly terminalResize = vi.fn(async () => {})
  readonly inspectForeground = vi.fn(async () => ({ processGroupId: 456, inputWaiting: true }))
  readonly signalForeground = vi.fn(async () => 456)
  readonly terminate = vi.fn(async () => { this.outcome.resolve({ exitCode: null, signal: 'SIGTERM' }); this.output.end() })
  readonly handle: SubprocessTerminalHandle = {
    pid: 123,
    output: this.output,
    done: this.outcome.promise,
    write: this.terminalWrite,
    resize: this.terminalResize,
    inspectForeground: this.inspectForeground,
    signalForeground: this.signalForeground,
    terminate: this.terminate,
  }
  readonly spawnTerminal = vi.fn(async (_spec: SubprocessTerminalSpawnSpec): Promise<SubprocessTerminalHandle> => this.handle)
  readonly resolveExecutable = vi.fn(async (command: string) => `/resolved/${command}`)
  spawn(_spec: SubprocessSpawnSpec): SubprocessHandle { throw new Error('unused') }
}

const config = {
  shellPath: 'bash', shellArgs: ['--noprofile', '--norc', '-i'], term: 'xterm-256color',
  disposeGraceMs: 100, outputRetentionBytes: 8, maxReadBytes: 3, maxOutputWaitersPerConsole: 2,
}

async function setup() {
  const ctx = new Context()
  const workspace = new StubWorkspaceRegistry(ctx)
  await ctx.plugin(StubSubprocess)
  const fiber = await ctx.plugin(LocalConsoleRuntime, config)
  return {
    ctx, workspace,
    subprocess: ctx.subprocess as StubSubprocess, runtime: ctx.consoles as LocalConsoleRuntime, fiber,
  }
}

describe('LocalConsoleRuntime', () => {
  it.each([
    { rows: 0, cols: 80 },
    { rows: 1.5, cols: 80 },
    { rows: 24, cols: 0 },
    { rows: 24, cols: 1.5 },
  ])('rejects invalid terminal dimensions before allocation', async (size) => {
    const { runtime, subprocess } = await setup()
    await expect(runtime.openHumanShell({ workspaceId: WorkspaceId('workspace-1'), size }))
      .rejects.toThrow('console size rows and cols must be positive safe integers')
    expect(subprocess.spawnTerminal).not.toHaveBeenCalled()
  })

  it('rejects invalid cross-field and shell-argument configuration at load', async () => {
    async function expectLoadFailure(overrides: Partial<typeof config>, message: string): Promise<void> {
      const ctx = new Context()
      new StubWorkspaceRegistry(ctx)
      await ctx.plugin(StubSubprocess)
      await expect(ctx.plugin(LocalConsoleRuntime, { ...config, ...overrides })).rejects.toThrow(message)
    }
    await expectLoadFailure({ maxReadBytes: 9 }, 'maxReadBytes must not exceed outputRetentionBytes')
    await expectLoadFailure({ shellArgs: [''] }, 'shellArgs entries must be non-empty')
  })

  it('resolves the executable at init and spawns the exact workspace shell spec', async () => {
    const { runtime, subprocess } = await setup()
    const opened = await runtime.openHumanShell({ workspaceId: WorkspaceId('workspace-1'), size: { rows: 24, cols: 80 } })
    expect(subprocess.resolveExecutable).toHaveBeenCalledExactlyOnceWith('bash')
    const spawnSpec = subprocess.spawnTerminal.mock.calls[0]?.[0]
    expect(spawnSpec).toMatchObject({
      argv: ['/resolved/bash', '--noprofile', '--norc', '-i'], cwd: '/workspace',
      term: 'xterm-256color', rows: 24, cols: 80, graceMs: 100,
    })
    expect(spawnSpec).not.toHaveProperty('env')
    expect(spawnSpec?.signal).toBeInstanceOf(AbortSignal)
    expect(opened.console).toMatchObject({ workspaceId: 'workspace-1', cwd: '/workspace', pid: 123, status: { kind: 'running' } })
    expect(opened.console).not.toHaveProperty('capability')
  })

  it('rejects unknown or unavailable workspaces before spawning', async () => {
    const { runtime, workspace, subprocess } = await setup()
    await expect(runtime.openHumanShell({ workspaceId: WorkspaceId('missing'), size: { rows: 24, cols: 80 } }))
      .rejects.toEqual(expect.objectContaining({ code: 'UNKNOWN_WORKSPACE' }))
    workspace.workspace.status.mockResolvedValueOnce('missing-dir')
    await expect(runtime.openHumanShell({ workspaceId: workspace.workspace.id, size: { rows: 24, cols: 80 } }))
      .rejects.toEqual(expect.objectContaining({ code: 'WORKSPACE_UNAVAILABLE' }))
    expect(subprocess.spawnTerminal).not.toHaveBeenCalled()
  })

  it('uses one bearer capability and hides existence for failed access', async () => {
    const { runtime } = await setup()
    const opened = await runtime.openHumanShell({ workspaceId: WorkspaceId('workspace-1'), size: { rows: 24, cols: 80 } })
    const wrong = { ...opened.access, capability: 'wrong' as ConsoleAccess['capability'] }
    const unknown = { ...opened.access, consoleId: 'unknown' as ConsoleAccess['consoleId'] }
    for (const access of [wrong, unknown]) {
      expect(() => runtime.snapshot(access)).toThrow(expect.objectContaining({ code: 'ACCESS_DENIED' }))
      expect(() => runtime.readOutput(access, 0)).toThrow(expect.objectContaining({ code: 'ACCESS_DENIED' }))
      await expect(runtime.write(access, 'x')).rejects.toEqual(expect.objectContaining({ code: 'ACCESS_DENIED' }))
      await expect(runtime.resize(access, { rows: 1, cols: 1 })).rejects.toEqual(expect.objectContaining({ code: 'ACCESS_DENIED' }))
      await expect(runtime.signal(access, 'SIGINT')).rejects.toEqual(expect.objectContaining({ code: 'ACCESS_DENIED' }))
      await expect(runtime.stop(access)).rejects.toEqual(expect.objectContaining({ code: 'ACCESS_DENIED' }))
    }
    expect(ConsoleError).toBeDefined()
  })

  it('atomically wakes independent output observers and isolates caller cancellation', async () => {
    const { runtime, subprocess } = await setup()
    const opened = await runtime.openHumanShell({ workspaceId: WorkspaceId('workspace-1'), size: { rows: 24, cols: 80 } })
    const aborted = new AbortController()
    const first = runtime.waitOutput(opened.access, 0, new AbortController().signal)
    const second = runtime.waitOutput(opened.access, 0, aborted.signal)
    aborted.abort(new Error('caller stopped'))
    await expect(second).rejects.toThrow('caller stopped')
    subprocess.output.write(Buffer.from('abcd'))
    await expect(first).resolves.toMatchObject({
      console: { nextOutputByte: 4 },
      output: { kind: 'data', fromByte: 0, nextByte: 3, availableThroughByte: 4 },
    })
  })

  it('returns gaps and terminal exit without parking', async () => {
    const { runtime, subprocess } = await setup()
    const opened = await runtime.openHumanShell({ workspaceId: WorkspaceId('workspace-1'), size: { rows: 24, cols: 80 } })
    subprocess.output.write(Buffer.from('0123456789'))
    await expect(runtime.waitOutput(opened.access, 0, new AbortController().signal))
      .resolves.toMatchObject({ output: { kind: 'gap', oldestByte: 2, nextByte: 10 } })
    const atEnd = runtime.waitOutput(opened.access, 10, new AbortController().signal)
    subprocess.output.end()
    subprocess.outcome.resolve({ exitCode: 0, signal: null })
    await expect(atEnd).resolves.toMatchObject({ console: { status: { kind: 'running' } } })
    await new Promise(resolve => setImmediate(resolve))
    await expect(runtime.waitOutput(opened.access, 10, new AbortController().signal))
      .resolves.toMatchObject({ console: { status: { kind: 'exited' } } })
  })

  it('wakes a parked observer when output ends before process outcome settles', async () => {
    const { runtime, subprocess } = await setup()
    const opened = await runtime.openHumanShell({ workspaceId: WorkspaceId('workspace-1'), size: { rows: 24, cols: 80 } })
    const waiting = runtime.waitOutput(opened.access, 0, new AbortController().signal)
    subprocess.output.end()
    await expect(waiting).resolves.toMatchObject({ console: { status: { kind: 'running' } }, output: { kind: 'data', nextByte: 0 } })
  })

  it('caps parked observers and rejects them during disposal', async () => {
    const { runtime, fiber } = await setup()
    const opened = await runtime.openHumanShell({ workspaceId: WorkspaceId('workspace-1'), size: { rows: 24, cols: 80 } })
    const waits = [
      runtime.waitOutput(opened.access, 0, new AbortController().signal),
      runtime.waitOutput(opened.access, 0, new AbortController().signal),
    ]
    await expect(runtime.waitOutput(opened.access, 0, new AbortController().signal))
      .rejects.toEqual(expect.objectContaining({ code: 'OUTPUT_WAITER_LIMIT' }))
    const disposing = fiber.dispose()
    await Promise.all(waits.map(wait => expect(wait).rejects.toEqual(expect.objectContaining({ code: 'SERVICE_DISPOSING' }))))
    await disposing
  })

  it('forwards mutations and retains output until its stream drains before exit', async () => {
    const { runtime, subprocess } = await setup()
    const opened = await runtime.openHumanShell({ workspaceId: WorkspaceId('workspace-1'), size: { rows: 24, cols: 80 } })
    await runtime.write(opened.access, 'echo marker\n')
    await runtime.resize(opened.access, { rows: 30, cols: 100 })
    await expect(runtime.signal(opened.access, 'SIGINT')).resolves.toEqual({ delivered: true, targetPgid: 456 })
    expect(subprocess.terminalWrite).toHaveBeenCalledWith('echo marker\n')
    expect(subprocess.terminalResize).toHaveBeenCalledWith({ rows: 30, cols: 100 })

    subprocess.output.write(Buffer.from('abcdef'))
    expect(runtime.readOutput(opened.access, 0)).toMatchObject({ kind: 'data', data: Uint8Array.from(Buffer.from('abc')), nextByte: 3, availableThroughByte: 6 })
    expect(runtime.readOutput(opened.access, 0)).toMatchObject({ kind: 'data', data: Uint8Array.from(Buffer.from('abc')) })
    subprocess.outcome.resolve({ exitCode: 7, signal: null })
    await new Promise(resolve => setImmediate(resolve))
    expect(runtime.snapshot(opened.access).status).toEqual({ kind: 'running' })
    subprocess.output.end(Buffer.from('ghij'))
    await new Promise(resolve => setImmediate(resolve))
    expect(runtime.snapshot(opened.access)).toMatchObject({
      size: { rows: 30, cols: 100 }, status: { kind: 'exited', exitCode: 7, signal: null },
      oldestOutputByte: 2, nextOutputByte: 10,
    })
    expect(runtime.readOutput(opened.access, 0)).toEqual({ kind: 'gap', oldestByte: 2, nextByte: 10 })
    await expect(runtime.write(opened.access, 'x')).rejects.toEqual(expect.objectContaining({ code: 'CONSOLE_EXITED' }))
  })

  it('joins concurrent stop and removes access after quiescence', async () => {
    const { runtime, subprocess } = await setup()
    const opened = await runtime.openHumanShell({ workspaceId: WorkspaceId('workspace-1'), size: { rows: 24, cols: 80 } })
    const first = runtime.stop(opened.access)
    const second = runtime.stop(opened.access)
    expect(first).toBe(second)
    await first
    expect(subprocess.terminate).toHaveBeenCalledTimes(1)
    expect(() => runtime.snapshot(opened.access)).toThrow(expect.objectContaining({ code: 'ACCESS_DENIED' }))
  })

  it('keeps access and drains final output after terminate resolves before deleting the record', async () => {
    const { runtime, subprocess } = await setup()
    const opened = await runtime.openHumanShell({ workspaceId: WorkspaceId('workspace-1'), size: { rows: 24, cols: 80 } })
    subprocess.terminate.mockImplementationOnce(async () => {})
    let stopped = false
    const stopping = runtime.stop(opened.access).then(() => { stopped = true })
    await Promise.resolve()
    expect(stopped).toBe(false)
    expect(runtime.snapshot(opened.access).status).toEqual({ kind: 'running' })
    subprocess.output.write('last')
    expect(runtime.readOutput(opened.access, 0)).toMatchObject({
      kind: 'data', data: Uint8Array.from(Buffer.from('las')), availableThroughByte: 4,
    })
    subprocess.outcome.resolve({ exitCode: 0, signal: null })
    await Promise.resolve()
    expect(stopped).toBe(false)
    expect(runtime.snapshot(opened.access).status).toEqual({ kind: 'running' })
    subprocess.output.end('!')
    await stopping
    expect(() => runtime.snapshot(opened.access)).toThrow(expect.objectContaining({ code: 'ACCESS_DENIED' }))
  })

  it('checks resize authorization before validating dimensions', async () => {
    const { runtime } = await setup()
    const opened = await runtime.openHumanShell({ workspaceId: WorkspaceId('workspace-1'), size: { rows: 24, cols: 80 } })
    const wrong = { ...opened.access, capability: 'wrong' as ConsoleAccess['capability'] }
    const unknown = { ...opened.access, consoleId: 'unknown' as ConsoleAccess['consoleId'] }
    for (const access of [wrong, unknown]) {
      await expect(runtime.resize(access, { rows: 0, cols: 0 }))
        .rejects.toEqual(expect.objectContaining({ code: 'ACCESS_DENIED' }))
    }
  })

  it('fences mutations by closing, failed, and disposing lifecycle before resize payload validation', async () => {
    const closingSetup = await setup()
    const closing = await closingSetup.runtime.openHumanShell({ workspaceId: WorkspaceId('workspace-1'), size: { rows: 24, cols: 80 } })
    const release = deferred<undefined>()
    closingSetup.subprocess.terminate.mockImplementationOnce(async () => { await release.promise })
    const stopping = closingSetup.runtime.stop(closing.access)
    await expect(closingSetup.runtime.write(closing.access, 'x')).rejects.toEqual(expect.objectContaining({ code: 'CONSOLE_CLOSING' }))
    await expect(closingSetup.runtime.resize(closing.access, { rows: 0, cols: 0 })).rejects.toEqual(expect.objectContaining({ code: 'CONSOLE_CLOSING' }))
    await expect(closingSetup.runtime.signal(closing.access, 'SIGINT')).rejects.toEqual(expect.objectContaining({ code: 'CONSOLE_CLOSING' }))
    release.resolve(undefined)
    closingSetup.subprocess.outcome.resolve({ exitCode: 0, signal: null })
    closingSetup.subprocess.output.end()
    await stopping

    const failedSetup = await setup()
    const failed = await failedSetup.runtime.openHumanShell({ workspaceId: WorkspaceId('workspace-1'), size: { rows: 24, cols: 80 } })
    failedSetup.subprocess.output.emit('error', new Error('transport lost'))
    await expect(failedSetup.runtime.write(failed.access, 'x')).rejects.toEqual(expect.objectContaining({ code: 'CONSOLE_EXITED' }))
    await expect(failedSetup.runtime.resize(failed.access, { rows: 0, cols: 0 })).rejects.toEqual(expect.objectContaining({ code: 'CONSOLE_EXITED' }))
    await expect(failedSetup.runtime.signal(failed.access, 'SIGINT')).rejects.toEqual(expect.objectContaining({ code: 'CONSOLE_EXITED' }))

    const disposingSetup = await setup()
    const disposing = await disposingSetup.runtime.openHumanShell({ workspaceId: WorkspaceId('workspace-1'), size: { rows: 24, cols: 80 } })
    const runtimeState = disposingSetup.runtime as unknown as { disposing: boolean }
    runtimeState.disposing = true
    await expect(disposingSetup.runtime.write(disposing.access, 'x')).rejects.toEqual(expect.objectContaining({ code: 'SERVICE_DISPOSING' }))
    await expect(disposingSetup.runtime.resize(disposing.access, { rows: 0, cols: 0 })).rejects.toEqual(expect.objectContaining({ code: 'SERVICE_DISPOSING' }))
    await expect(disposingSetup.runtime.signal(disposing.access, 'SIGINT')).rejects.toEqual(expect.objectContaining({ code: 'SERVICE_DISPOSING' }))
  })

  it('retains a record after cleanup failure and permits a stop retry', async () => {
    const { runtime, subprocess } = await setup()
    const opened = await runtime.openHumanShell({ workspaceId: WorkspaceId('workspace-1'), size: { rows: 24, cols: 80 } })
    subprocess.terminate.mockRejectedValueOnce(new Error('cleanup failed'))
    await expect(runtime.stop(opened.access)).rejects.toThrow('cleanup failed')
    expect(runtime.snapshot(opened.access).status).toEqual({ kind: 'running' })
    await expect(runtime.stop(opened.access)).resolves.toBeUndefined()
    expect(subprocess.terminate).toHaveBeenCalledTimes(2)
    expect(() => runtime.snapshot(opened.access)).toThrow(expect.objectContaining({ code: 'ACCESS_DENIED' }))
  })

  it('drains an allocated terminal before rejecting cancellation without publishing it', async () => {
    const { runtime, subprocess } = await setup()
    const controller = new AbortController()
    subprocess.terminate.mockImplementationOnce(async () => {})
    subprocess.spawnTerminal.mockImplementationOnce(async () => {
      controller.abort(new Error('caller cancelled'))
      return subprocess.handle
    })
    let settled = false
    const opening = runtime.openHumanShell(
      { workspaceId: WorkspaceId('workspace-1'), size: { rows: 24, cols: 80 } }, controller.signal,
    ).finally(() => { settled = true })
    const rejected = opening.catch((error: unknown) => error instanceof Error ? error : new Error(String(error)))
    await new Promise(resolve => setImmediate(resolve))
    expect(subprocess.terminate).toHaveBeenCalledOnce()
    expect(settled).toBe(false)
    subprocess.output.write('final bytes')
    subprocess.outcome.resolve({ exitCode: null, signal: 'SIGTERM' })
    await Promise.resolve()
    expect(settled).toBe(false)
    subprocess.output.end('!')
    await expect(rejected).resolves.toEqual(expect.objectContaining({ message: 'caller cancelled' }))
    expect(settled).toBe(true)
  })

  it('service disposal aborts and awaits an unpublished allocation', async () => {
    const { runtime, subprocess, fiber } = await setup()
    subprocess.spawnTerminal.mockImplementationOnce(async spec => await new Promise<SubprocessTerminalHandle>((_resolve, reject) => {
      spec.signal?.addEventListener('abort', () => {
        const reason: unknown = spec.signal?.reason
        reject(reason instanceof Error ? reason : new Error(String(reason)))
      }, { once: true })
    }))
    const opening = runtime.openHumanShell({ workspaceId: WorkspaceId('workspace-1'), size: { rows: 24, cols: 80 } })
    const openingResult = opening.then(
      () => undefined,
      (error: unknown) => error instanceof Error ? error : new Error(String(error)),
    )
    await new Promise(resolve => setImmediate(resolve))
    await expect(fiber.dispose()).resolves.toBeUndefined()
    await expect(openingResult).resolves.toEqual(expect.objectContaining({ code: 'SERVICE_DISPOSING' }))
    await expect(runtime.openHumanShell({ workspaceId: WorkspaceId('workspace-1'), size: { rows: 24, cols: 80 } }))
      .rejects.toEqual(expect.objectContaining({ code: 'SERVICE_DISPOSING' }))
  })

  it('rolls back an allocation that completes after disposal starts', async () => {
    const { runtime, subprocess, fiber } = await setup()
    const allocated = deferred<SubprocessTerminalHandle>()
    subprocess.spawnTerminal.mockImplementationOnce(async () => await allocated.promise)
    const opening = runtime.openHumanShell({ workspaceId: WorkspaceId('workspace-1'), size: { rows: 24, cols: 80 } })
    await new Promise(resolve => setImmediate(resolve))
    const disposing = fiber.dispose()
    allocated.resolve(subprocess.handle)
    await expect(opening).rejects.toEqual(expect.objectContaining({ code: 'SERVICE_DISPOSING' }))
    await disposing
    expect(subprocess.terminate).toHaveBeenCalledOnce()
  })

  it('retains unpublished rollback cleanup failures for disposal retry', async () => {
    const { runtime, subprocess, fiber } = await setup()
    const allocated = deferred<SubprocessTerminalHandle>()
    subprocess.spawnTerminal.mockImplementationOnce(async () => await allocated.promise)
    subprocess.terminate.mockRejectedValue(new Error('rollback cleanup failed'))
    const opening = runtime.openHumanShell({ workspaceId: WorkspaceId('workspace-1'), size: { rows: 24, cols: 80 } })
    const openingResult = opening.catch((error: unknown) => error instanceof Error ? error : new Error(String(error)))
    await new Promise(resolve => setImmediate(resolve))
    allocated.resolve(subprocess.handle)
    const disposing = fiber.dispose()
    await expect(openingResult).resolves.toEqual(expect.objectContaining({ message: 'rollback cleanup failed' }))
    await disposing
    expect(subprocess.terminate.mock.calls.length).toBeGreaterThanOrEqual(2)
    expect((runtime as unknown as { rollbackRecords: Set<unknown> }).rollbackRecords.size).toBe(1)

    subprocess.terminate.mockReset()
    subprocess.terminate.mockImplementation(async () => {
      subprocess.outcome.resolve({ exitCode: null, signal: 'SIGTERM' })
      subprocess.output.end()
    })
    await expect((runtime as unknown as { disposeAll(): Promise<void> }).disposeAll()).resolves.toBeUndefined()
    expect((runtime as unknown as { rollbackRecords: Set<unknown> }).rollbackRecords.size).toBe(0)
  })

  it('service disposal attempts every published console when one cleanup fails', async () => {
    const { runtime, subprocess } = await setup()
    await runtime.openHumanShell({ workspaceId: WorkspaceId('workspace-1'), size: { rows: 24, cols: 80 } })
    await runtime.openHumanShell({ workspaceId: WorkspaceId('workspace-1'), size: { rows: 24, cols: 80 } })
    subprocess.terminate.mockRejectedValueOnce(new Error('first cleanup failed'))
    await expect((runtime as unknown as { disposeAll(): Promise<void> }).disposeAll())
      .rejects.toThrow('console-local teardown failed')
    expect(subprocess.terminate).toHaveBeenCalledTimes(2)
  })

  it('marks transport errors failed without losing retained output', async () => {
    const { runtime, subprocess } = await setup()
    const opened = await runtime.openHumanShell({ workspaceId: WorkspaceId('workspace-1'), size: { rows: 24, cols: 80 } })
    subprocess.output.write('before')
    subprocess.output.emit('error', new Error('transport lost'))
    await Promise.resolve()
    expect(runtime.snapshot(opened.access).status).toEqual({ kind: 'failed', message: 'Error: transport lost' })
    expect(runtime.readOutput(opened.access, 0)).toMatchObject({ kind: 'data', data: Uint8Array.from(Buffer.from('bef')) })
    subprocess.outcome.resolve({ exitCode: 0, signal: null })
    await Promise.resolve()
    expect(runtime.snapshot(opened.access).status.kind).toBe('failed')
  })

  it('wakes a parked output waiter with failed as its first observation', async () => {
    const { runtime, subprocess } = await setup()
    const opened = await runtime.openHumanShell({ workspaceId: WorkspaceId('workspace-1'), size: { rows: 24, cols: 80 } })
    const waiting = runtime.waitOutput(opened.access, 0, new AbortController().signal)
    subprocess.output.emit('error', new Error('transport lost'))
    await expect(waiting).resolves.toMatchObject({ console: { status: { kind: 'failed' } } })
  })

  it('rejects a newly requested wait while stop is in progress', async () => {
    const { runtime, subprocess } = await setup()
    const opened = await runtime.openHumanShell({ workspaceId: WorkspaceId('workspace-1'), size: { rows: 24, cols: 80 } })
    const release = deferred<undefined>()
    subprocess.terminate.mockImplementationOnce(async () => { await release.promise })
    const stopping = runtime.stop(opened.access)
    await expect(runtime.waitOutput(opened.access, 0, new AbortController().signal))
      .rejects.toEqual(expect.objectContaining({ code: 'CONSOLE_CLOSING' }))
    release.resolve(undefined)
    subprocess.outcome.resolve({ exitCode: 0, signal: null })
    subprocess.output.end()
    await stopping
  })

  it('preserves a non-Error abort reason from an output waiter', async () => {
    const { runtime } = await setup()
    const opened = await runtime.openHumanShell({ workspaceId: WorkspaceId('workspace-1'), size: { rows: 24, cols: 80 } })
    const controller = new AbortController()
    const waiting = runtime.waitOutput(opened.access, 0, controller.signal)
    controller.abort('caller stopped')
    await expect(waiting).rejects.toEqual(expect.objectContaining({ name: 'AbortError' }))
  })

  it('maps a rejected process outcome to failed and contains rejected cleanup', async () => {
    const { runtime, subprocess } = await setup()
    subprocess.terminate.mockRejectedValueOnce('cleanup failed')
    const opened = await runtime.openHumanShell({ workspaceId: WorkspaceId('workspace-1'), size: { rows: 24, cols: 80 } })
    subprocess.output.emit('error', new Error('transport failed'))
    subprocess.outcome.reject(new Error('process observation failed'))
    await new Promise(resolve => setImmediate(resolve))
    expect(runtime.snapshot(opened.access).status).toEqual({ kind: 'failed', message: 'Error: transport failed' })
  })

  it('accepts string chunks from a terminal output implementation', async () => {
    const { runtime, subprocess } = await setup()
    const opened = await runtime.openHumanShell({ workspaceId: WorkspaceId('workspace-1'), size: { rows: 24, cols: 80 } })
    subprocess.output.emit('data', 'text')
    expect(runtime.readOutput(opened.access, 0)).toMatchObject({
      kind: 'data', data: Uint8Array.from(Buffer.from('tex')), availableThroughByte: 4,
    })
  })

  it('normalizes non-Error cleanup failures in aggregate disposal diagnostics', async () => {
    const { runtime, subprocess } = await setup()
    await runtime.openHumanShell({ workspaceId: WorkspaceId('workspace-1'), size: { rows: 24, cols: 80 } })
    subprocess.terminate.mockRejectedValueOnce('string cleanup failure')
    await expect((runtime as unknown as { disposeAll(): Promise<void> }).disposeAll())
      .rejects.toEqual(expect.objectContaining({ errors: [expect.objectContaining({ message: 'string cleanup failure' })] }))
  })

  it('removes the abort listener when an already-aborted wait rejects', async () => {
    const { runtime } = await setup()
    const opened = await runtime.openHumanShell({ workspaceId: WorkspaceId('workspace-1'), size: { rows: 24, cols: 80 } })
    const controller = new AbortController()
    controller.abort(new Error('already aborted'))
    const add = vi.spyOn(controller.signal, 'addEventListener')
    const remove = vi.spyOn(controller.signal, 'removeEventListener')
    await expect(runtime.waitOutput(opened.access, 0, controller.signal)).rejects.toThrow('already aborted')
    expect(add).toHaveBeenCalledOnce()
    expect(remove).toHaveBeenCalledOnce()
    expect(remove).toHaveBeenCalledWith('abort', add.mock.calls[0]?.[1])
  })
})
