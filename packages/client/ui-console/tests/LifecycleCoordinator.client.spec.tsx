// @vitest-environment jsdom
import { act, cleanup, render, waitFor } from '@testing-library/react'
import { useSyncExternalStore } from 'react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { ConsoleRemoteSnapshot } from '@deepseek-ai/dsh-api-remotes/client'
import { ConsoleLifecycleCoordinator } from '../src/client/LifecycleCoordinator.tsx'
import { ConsoleClient } from '../src/client/controller.ts'
import type { ConsoleCatalogState } from '../src/client/controller.ts'

afterEach(cleanup)

const running = (id: string, archived = false): ConsoleRemoteSnapshot => ({
  id,
  workspaceId: 'workspace-1',
  cwd: '/workspace',
  title: id,
  createdAt: '2026-08-26T00:00:00.000Z',
  archived,
  status: { kind: 'running' },
})

const hook = (state: ConsoleCatalogState) => <S,>(selector: (value: ConsoleCatalogState) => S): S => selector(state)
const emptyHook = <S,>(selector: (state: never) => S): S => selector({} as never)
const rootProps = { useSessions: emptyHook, useWorkspaces: emptyHook }

describe('ConsoleLifecycleCoordinator', () => {
  it.each(['cold', 'loading', 'error'] as const)('does not reconcile an incomplete %s catalog', (phase) => {
    const reconcile = vi.fn()
    render(<ConsoleLifecycleCoordinator
      {...rootProps}
      reconcile={reconcile}
      useConsoleCatalog={hook({ phase, items: [running('c1')], connectionEpoch: 0 })}
    />)
    expect(reconcile).not.toHaveBeenCalled()
  })

  it('reconciles every running Console from a ready complete catalog', () => {
    const reconcile = vi.fn()
    const ended: ConsoleRemoteSnapshot = { ...running('ended'), status: { kind: 'ended', reason: 'external' } }
    render(<ConsoleLifecycleCoordinator
      {...rootProps}
      reconcile={reconcile}
      useConsoleCatalog={hook({ phase: 'ready', items: [running('active'), running('archived', true), ended], connectionEpoch: 0 })}
    />)
    expect(reconcile).toHaveBeenCalledOnce()
    expect(reconcile).toHaveBeenCalledWith(new Set(['active', 'archived']))
  })

  it('publishes ready to a real React observer while slow periodic demand continues', async () => {
    vi.useFakeTimers()
    try {
      let lists = 0
      const remote = {
        list: vi.fn(() => new Promise((resolve) => {
          const id = `list-${++lists}`
          setTimeout(() => { resolve({ ok: true, value: { ok: true, value: [running(id)] } }) }, 15)
        })),
      }
      const client = new ConsoleClient(remote as never)
      const reconcile = vi.fn()
      const useConsoleCatalog = <S,>(selector: (state: ConsoleCatalogState) => S): S => (
        useSyncExternalStore(client.subscribe.bind(client), () => selector(client.getSnapshot()))
      )
      render(<ConsoleLifecycleCoordinator {...rootProps} reconcile={reconcile} useConsoleCatalog={useConsoleCatalog} />)
      const completions: Promise<void>[] = [client.refresh()]
      const timer = setInterval(() => { completions.push(client.refresh()) }, 10)

      await act(async () => { await vi.advanceTimersByTimeAsync(35) })

      expect(reconcile).toHaveBeenCalled()
      await expect(Promise.all(completions.slice(0, 2))).resolves.toEqual([undefined, undefined])
      clearInterval(timer)
    } finally {
      vi.useRealTimers()
    }
  })

  it('reconciles an empty point projection after a complete catalog refresh fails', async () => {
    let rejectRecovery!: (error: unknown) => void
    const recovery = new Promise((_resolve, reject) => { rejectRecovery = reject })
    const remote = {
      list: vi.fn()
        .mockResolvedValueOnce({ ok: true, value: { ok: true, value: [running('c1')] } })
        .mockRejectedValueOnce(new Error('background offline'))
        .mockReturnValueOnce(recovery),
      terminate: vi.fn(async () => ({ ok: true, value: { ok: true, value: null } })),
    }
    const client = new ConsoleClient(remote as never)
    const reconcile = vi.fn()
    const useConsoleCatalog = <S,>(selector: (state: ConsoleCatalogState) => S): S => (
      useSyncExternalStore(client.subscribe.bind(client), () => selector(client.getSnapshot()))
    )
    render(<ConsoleLifecycleCoordinator {...rootProps} reconcile={reconcile} useConsoleCatalog={useConsoleCatalog} />)
    await act(async () => { await client.refresh() })
    await act(async () => { await client.refresh().catch(() => {}) })
    const staleRecovery = client.refresh()

    await act(async () => { await client.terminate('c1') })
    await waitFor(() => { expect(reconcile).toHaveBeenLastCalledWith(new Set()) })
    rejectRecovery(new Error('recovery offline'))
    await act(async () => { await staleRecovery })
    expect(reconcile).toHaveBeenLastCalledWith(new Set())
  })
})
