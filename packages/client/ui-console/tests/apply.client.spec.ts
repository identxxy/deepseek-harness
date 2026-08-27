import { Context, Service } from '@deepseek-ai/cordis'
import { describe, expect, it, vi } from 'vitest'
import { LocaleRuntime } from '@deepseek-ai/dsh-client-locale/client'
import { SlotRegistry } from '@deepseek-ai/dsh-client-runtime/client'
import { apply, inject } from '../src/client/index.ts'
import { apply as applyHost } from '../src/index.ts'
import { ConsoleRows, NewTerminalAction } from '../src/client/Navigation.tsx'
import { TerminalPane } from '../src/client/TerminalPane.tsx'
import { ConsoleLifecycleCoordinator } from '../src/client/LifecycleCoordinator.tsx'

const carried = <T>(value: T) => Promise.resolve({ ok: true as const, value: { ok: true as const, value } })

async function bench() {
  ;(globalThis as Record<string, unknown>)['__DSH_CONSOLE_CONFIG__'] = { catalogRefreshIntervalMs: 60_000 }
  const ctx = new Context()
  await ctx.plugin(SlotRegistry).await()
  ctx.slots.register({
    name: 'root',
    children: {
      'sidebar.primary.action': { kind: 'list', scope: 'root' },
      'sidebar.workspaces.actor': { kind: 'list', scope: 'root' },
      'workspace.console': { kind: 'single', scope: 'root' },
      'shell.overlay': { kind: 'list', scope: 'root' },
    },
  } as never, () => null)
  ctx.provide('locale', new LocaleRuntime(ctx))
  const layout = {
    openActor: vi.fn(), openActorInSplit: vi.fn(), showConversation: vi.fn(), reconcileActorCatalog: vi.fn(),
  }
  ctx.provide('layout', layout as never)
  class RemoteService extends Service {
    constructor(serviceCtx: Context) { super(serviceCtx, 'remote') }
  }
  new RemoteService(ctx)
  const consoles = {
    list: vi.fn(() => carried([])),
    create: vi.fn(() => carried({ id: 'console-1' })), snapshot: vi.fn(),
    rename: vi.fn(() => carried({ id: 'console-1' })), setArchived: vi.fn(() => carried({ id: 'console-1' })), attach: vi.fn(),
    attachmentSnapshot: vi.fn(), read: vi.fn(), write: vi.fn(), resize: vi.fn(), detach: vi.fn(), terminate: vi.fn(() => carried(null)),
  }
  ctx.provide('remote.consoles', consoles as never)
  return { ctx, list: consoles.list, consoles, layout }
}

describe('ui-console apply', () => {
  it('fails loudly when browser refresh configuration is missing or invalid', () => {
    delete (globalThis as Record<string, unknown>)['__DSH_CONSOLE_CONFIG__']
    expect(() => { apply({} as never) }).toThrow('browser configuration is missing')
    ;(globalThis as Record<string, unknown>)['__DSH_CONSOLE_CONFIG__'] = { catalogRefreshIntervalMs: 0 }
    expect(() => { apply({} as never) }).toThrow('must be a positive safe integer')
  })

  it('registers and releases the creation, catalog, and terminal-pane contributions together', async () => {
    const host = new Context()
    applyHost(host, { catalogRefreshIntervalMs: 5_000 })
    const injections: unknown[] = []
    host.emit('webserver/index-inject', injections as never)
    expect(injections).toEqual([{ kind: 'global', name: '__DSH_CONSOLE_CONFIG__', value: { catalogRefreshIntervalMs: 5_000 } }])
    expect(inject).toEqual(['slots', 'remote', 'remote.consoles', 'locale', 'layout'])
    const b = await bench()
    const fiber = b.ctx.plugin({ inject: [...inject], apply })
    await fiber.await()
    await vi.waitFor(() => { expect(b.list).toHaveBeenCalledOnce() })
    expect(b.ctx.slots.entries('sidebar.primary.action')[0]?.component).toBe(NewTerminalAction)
    expect(b.ctx.slots.entries('sidebar.workspaces.actor')[0]?.component).toBe(ConsoleRows)
    expect(b.ctx.slots.entries('workspace.console')[0]?.component).toBe(TerminalPane)
    expect(b.ctx.slots.entries('shell.overlay')[0]?.component).toBe(ConsoleLifecycleCoordinator)

    const navigation = b.ctx.slots.entries('sidebar.primary.action')[0]?.inject?.() as never as {
      createAndOpen: (workspaceId: string) => Promise<void>
      open: (id: string) => void
      split: (id: string, direction: 'right' | 'down') => void
      rename: (id: string, title: string) => Promise<void>
      setArchived: (id: string, archived: boolean) => Promise<void>
      terminate: (id: string) => Promise<void>
    }
    await navigation.createAndOpen('workspace-1')
    navigation.open('console-1')
    navigation.split('console-1', 'right')
    navigation.split('console-1', 'down')
    await navigation.rename('console-1', 'Renamed')
    await navigation.setArchived('console-1', true)
    await navigation.terminate('console-1')
    expect(b.layout.openActor).toHaveBeenCalledWith({ kind: 'console', id: 'console-1' })
    expect(b.layout.openActorInSplit).toHaveBeenCalledWith({ kind: 'console', id: 'console-1' }, 'horizontal')
    expect(b.layout.openActorInSplit).toHaveBeenCalledWith({ kind: 'console', id: 'console-1' }, 'vertical')
    expect(b.ctx.slots.entries('workspace.console')[0]?.inject?.()).toMatchObject({ controller: b.ctx.consoleClient })

    b.ctx.emit('connection/reset')
    await vi.waitFor(() => { expect(b.list).toHaveBeenCalledTimes(2) })
    expect(b.ctx.consoleClient.getSnapshot().connectionEpoch).toBe(1)

    await fiber.dispose()
    expect(b.ctx.slots.entries('sidebar.primary.action')).toHaveLength(0)
    expect(b.ctx.slots.entries('sidebar.workspaces.actor')).toHaveLength(0)
    expect(b.ctx.slots.entries('workspace.console')).toHaveLength(0)
    expect(b.ctx.slots.entries('shell.overlay')).toHaveLength(0)
  })

  it('refreshes the catalog on the configured interval and clears the timer on teardown', async () => {
    vi.useFakeTimers()
    try {
      const b = await bench()
      ;(globalThis as Record<string, unknown>)['__DSH_CONSOLE_CONFIG__'] = { catalogRefreshIntervalMs: 10 }
      const fiber = b.ctx.plugin({ inject: [...inject], apply })
      await fiber.await()
      await vi.advanceTimersByTimeAsync(21)
      expect(b.list).toHaveBeenCalledTimes(3)
      await fiber.dispose()
      await vi.advanceTimersByTimeAsync(20)
      expect(b.list).toHaveBeenCalledTimes(3)
    } finally {
      vi.useRealTimers()
    }
  })

  it('reports a periodic catalog refresh failure', async () => {
    vi.useFakeTimers()
    const warning = vi.spyOn(console, 'warn').mockImplementation(() => {})
    try {
      const b = await bench()
      ;(globalThis as Record<string, unknown>)['__DSH_CONSOLE_CONFIG__'] = { catalogRefreshIntervalMs: 10 }
      const fiber = b.ctx.plugin({ inject: [...inject], apply })
      await fiber.await()
      b.list.mockRejectedValueOnce(new Error('periodic failure'))
      await vi.advanceTimersByTimeAsync(11)
      await vi.waitFor(() => { expect(warning).toHaveBeenCalledWith('Periodic Console catalog refresh failed:', expect.any(Error)) })
      await fiber.dispose()
    } finally {
      warning.mockRestore()
      vi.useRealTimers()
    }
  })

  it('reports initial and reconnect catalog failures', async () => {
    const warning = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const b = await bench()
    b.list.mockRejectedValueOnce(new Error('initial failure'))
    const fiber = b.ctx.plugin({ inject: [...inject], apply })
    await fiber.await()
    await vi.waitFor(() => { expect(warning).toHaveBeenCalledWith('Initial Console catalog refresh failed:', expect.any(Error)) })
    b.list.mockRejectedValueOnce(new Error('reset failure'))
    b.ctx.emit('connection/reset')
    await vi.waitFor(() => { expect(warning).toHaveBeenCalledWith('Console catalog refresh failed after reconnect:', expect.any(Error)) })
    await fiber.dispose()
  })

  it('does not open a pane when plugin disposal supersedes pending creation', async () => {
    const b = await bench()
    let resolveCreate!: (value: Awaited<ReturnType<typeof carried<{ id: string }>>>) => void
    b.consoles.create.mockReturnValueOnce(new Promise((resolve) => { resolveCreate = resolve }) as never)
    const fiber = b.ctx.plugin({ inject: [...inject], apply })
    await fiber.await()
    const navigation = b.ctx.slots.entries('sidebar.primary.action')[0]?.inject?.() as never as {
      createAndOpen: (workspaceId: string) => Promise<void>
    }
    const creating = navigation.createAndOpen('workspace-1')
    await vi.waitFor(() => { expect(b.consoles.create).toHaveBeenCalledOnce() })
    const disposing = fiber.dispose()
    resolveCreate(await carried({ id: 'console-late' }))
    await expect(creating).rejects.toThrow('disposed')
    await disposing
    expect(b.layout.openActor).not.toHaveBeenCalled()
  })
})
