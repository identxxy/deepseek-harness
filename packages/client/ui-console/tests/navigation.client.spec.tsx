// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import type { ConsoleRemoteSnapshot } from '@deepseek-ai/dsh-api-remotes/client'
import type { SessionId, WorkspaceId } from '@deepseek-ai/dsh-client-runtime/client'

vi.mock('@deepseek-ai/dsh-client-ui-primitives', async () => {
  const React = await import('react')
  const Icon = () => React.createElement('i')
  return {
    IconArchiveOutline20: Icon, IconBranchOutline16: Icon, IconCodeOutline16: Icon,
    IconEditOutline16: Icon, IconEllipsisOutline16: Icon, IconTrashOutline16: Icon,
    Tooltip: ({ children }: { children: React.ReactNode }) => children,
    Menu: ({ open, anchor, items, onSelect, onClose }: {
      open: boolean
      anchor: React.ReactNode
      items: readonly { id: string; type?: string }[]
      onSelect: (id: string) => void
      onClose: () => void
    }) => React.createElement(React.Fragment, null, anchor, open && React.createElement('div', null,
      items.filter(item => item.type !== 'separator').map(item => React.createElement('button', {
        key: item.id, type: 'button', onClick: () =>{  onSelect(item.id) }, onBlur: onClose,
      }, item.id)))),
  }
})
import { ConsoleRows, NewTerminalAction } from '../src/client/Navigation.tsx'
import type { ConsoleNavigationInjected } from '../src/client/Navigation.tsx'
import { en } from '../src/client/locales.ts'

afterEach(() => {
  cleanup()
  vi.restoreAllMocks()
})

const sid = (id: string) => id as SessionId
const wid = (id: string) => id as WorkspaceId
const hook = <T,>(snapshot: T) => <S,>(selector: (value: T) => S): S => selector(snapshot)
const consoleSnapshot = (id: string, workspaceId: string, archived = false): ConsoleRemoteSnapshot => ({
  id,
  workspaceId,
  cwd: `/projects/${workspaceId}`,
  title: `Terminal ${id}`,
  createdAt: '2026-08-26T00:00:00.000Z',
  archived,
  status: { kind: 'running' },
})

function navigation(): ConsoleNavigationInjected {
  const items = [
    consoleSnapshot('c-alpha', 'alpha'),
    consoleSnapshot('c-beta', 'beta'),
    consoleSnapshot('c-archived', 'alpha', true),
  ]
  return {
    hooks: {
      consoleCatalog: {
        getSnapshot: () => ({ phase: 'ready' as const, items, connectionEpoch: 0 }),
        subscribe: () => () => {},
      },
    },
    createAndOpen: vi.fn(async () => {}),
    open: vi.fn(),
    split: vi.fn(),
    rename: vi.fn(async () => {}),
    setArchived: vi.fn(async () => {}),
    terminate: vi.fn(async () => {}),
  }
}

const t = (key: keyof typeof en): string => en[key]

describe('Console navigation', () => {
  it('creates in the current Session Workspace before using the recent fallback', () => {
    const injected = navigation()
    render(<NewTerminalAction
      wide
      useSessions={hook({ current: sid('s-alpha') }) as never}
      useWorkspaces={hook({
        items: [
          { workspaceId: wid('alpha'), sessionIds: [sid('s-alpha')] },
          { workspaceId: wid('beta'), sessionIds: [] },
        ],
        recentWorkspaceId: wid('beta'),
      }) as never}
      {...injected}
      useConsoleCatalog={hook(injected.hooks.consoleCatalog.getSnapshot())}
      t={t as never}
    />)
    fireEvent.click(screen.getByRole('button', { name: 'New terminal' }))
    expect(injected.createAndOpen).toHaveBeenCalledWith(wid('alpha'))
  })

  it('places active and archived Console rows in their requested browser seats', () => {
    const injected = navigation()
    const common = {
      useSessions: hook({}) as never,
      useWorkspaces: hook({}) as never,
      ...injected,
      useConsoleCatalog: hook(injected.hooks.consoleCatalog.getSnapshot()),
      t: t as never,
    }
    const view = render(<ConsoleRows mode="workspace" workspaceId={wid('alpha')} {...common} />)
    expect(screen.getByText('Terminal c-alpha')).toBeTruthy()
    expect(screen.queryByText('Terminal c-beta')).toBeNull()
    expect(screen.queryByText('Terminal c-archived')).toBeNull()
    fireEvent.click(screen.getByText('Terminal c-alpha'))
    expect(injected.open).toHaveBeenCalledWith('c-alpha')

    view.rerender(<ConsoleRows mode="archived" {...common} />)
    expect(screen.getByText('Archived')).toBeTruthy()
    expect(screen.getByText('Terminal c-archived')).toBeTruthy()
    expect(screen.queryByText('Terminal c-alpha')).toBeNull()
  })

  it('uses Workspace fallbacks and disables creation without a Workspace', async () => {
    const injected = navigation()
    const base = {
      wide: false,
      useSessions: hook({ current: undefined }) as never,
      ...injected,
      useConsoleCatalog: hook(injected.hooks.consoleCatalog.getSnapshot()),
      t: t as never,
    }
    const view = render(<NewTerminalAction {...base} useWorkspaces={hook({ items: [], recentWorkspaceId: wid('recent') }) as never} />)
    fireEvent.click(screen.getByRole('button', { name: 'New terminal' }))
    expect(injected.createAndOpen).toHaveBeenCalledWith(wid('recent'))
    await vi.waitFor(() => { expect(screen.getByRole('button', { name: 'New terminal' }).hasAttribute('disabled')).toBe(false) })
    view.rerender(<NewTerminalAction {...base} useWorkspaces={hook({ items: [{ workspaceId: wid('first'), sessionIds: [] }] }) as never} />)
    fireEvent.click(screen.getByRole('button', { name: 'New terminal' }))
    expect(injected.createAndOpen).toHaveBeenLastCalledWith(wid('first'))
    view.rerender(<NewTerminalAction {...base} useWorkspaces={hook({ items: [] }) as never} />)
    expect(screen.getByRole('button', { name: 'New terminal' }).hasAttribute('disabled')).toBe(true)
  })

  it('guards duplicate creation and reports creation failure', async () => {
    let reject!: (error: Error) => void
    const pending = new Promise<void>((_resolve, rejectPromise) => { reject = rejectPromise })
    const injected = navigation()
    injected.createAndOpen = vi.fn(() => pending)
    const warning = vi.spyOn(console, 'warn').mockImplementation(() => {})
    render(<NewTerminalAction
      wide
      useSessions={hook({ current: undefined }) as never}
      useWorkspaces={hook({ items: [{ workspaceId: wid('first'), sessionIds: [] }] }) as never}
      {...injected}
      useConsoleCatalog={hook(injected.hooks.consoleCatalog.getSnapshot())}
      t={t as never}
    />)
    const button = screen.getByRole('button', { name: 'New terminal' })
    fireEvent.click(button)
    fireEvent.click(button)
    expect(injected.createAndOpen).toHaveBeenCalledOnce()
    reject(new Error('create failed'))
    await vi.waitFor(() => { expect(warning).toHaveBeenCalledWith('Console creation failed:', expect.any(Error)) })
    expect((button as HTMLButtonElement).disabled).toBe(false)
  })

  it('supports keyboard activation and every row lifecycle action', async () => {
    const injected = navigation()
    const warning = vi.spyOn(console, 'warn').mockImplementation(() => {})
    vi.spyOn(window, 'prompt').mockReturnValue('  Renamed terminal  ')
    vi.spyOn(window, 'confirm').mockReturnValue(true)
    const common = {
      useSessions: hook({}) as never, useWorkspaces: hook({}) as never, ...injected,
      useConsoleCatalog: hook(injected.hooks.consoleCatalog.getSnapshot()), t: t as never,
    }
    const view = render(<ConsoleRows mode="flat" {...common} />)
    const alpha = screen.getByText('Terminal c-alpha').closest('[role="treeitem"]') as HTMLElement
    fireEvent.keyDown(alpha, { key: 'x' })
    fireEvent.keyDown(alpha, { key: 'Enter' })
    fireEvent.keyDown(alpha, { key: ' ' })
    expect(injected.open).toHaveBeenCalledTimes(2)

    const action = (): void => { fireEvent.click(alpha.querySelector('button') as HTMLElement) }
    action(); fireEvent.blur(screen.getByRole('button', { name: 'split-right' }))
    action(); fireEvent.click(screen.getByRole('button', { name: 'split-right' }))
    action(); fireEvent.click(screen.getByRole('button', { name: 'split-down' }))
    action(); fireEvent.click(screen.getByRole('button', { name: 'archive' }))
    action(); fireEvent.click(screen.getByRole('button', { name: 'rename' }))
    action(); fireEvent.click(screen.getByRole('button', { name: 'terminate' }))
    expect(injected.split).toHaveBeenCalledWith('c-alpha', 'right')
    expect(injected.split).toHaveBeenCalledWith('c-alpha', 'down')
    expect(injected.setArchived).toHaveBeenCalledWith('c-alpha', true)
    expect(injected.rename).toHaveBeenCalledWith('c-alpha', 'Renamed terminal')
    expect(injected.terminate).toHaveBeenCalledWith('c-alpha')

    vi.mocked(window.prompt).mockReturnValueOnce(null).mockReturnValueOnce('  ')
    vi.mocked(window.confirm).mockReturnValueOnce(false)
    action(); fireEvent.click(screen.getByRole('button', { name: 'rename' }))
    action(); fireEvent.click(screen.getByRole('button', { name: 'rename' }))
    action(); fireEvent.click(screen.getByRole('button', { name: 'terminate' }))

    injected.rename = vi.fn(async () => { throw new Error('rename') })
    injected.setArchived = vi.fn(async () => { throw new Error('archive') })
    injected.terminate = vi.fn(async () => { throw new Error('terminate') })
    view.rerender(<ConsoleRows mode="flat" {...common} {...injected} />)
    const updated = screen.getByText('Terminal c-alpha').closest('[role="treeitem"]') as HTMLElement
    const updatedAction = (): void => { fireEvent.click(updated.querySelector('button') as HTMLElement) }
    updatedAction(); fireEvent.click(screen.getByRole('button', { name: 'archive' }))
    updatedAction(); fireEvent.click(screen.getByRole('button', { name: 'rename' }))
    updatedAction(); fireEvent.click(screen.getByRole('button', { name: 'terminate' }))
    await vi.waitFor(() => { expect(warning).toHaveBeenCalledTimes(3) })
  })

  it('hides ended rows and restores archived running rows', async () => {
    const injected = navigation()
    const ended: ConsoleRemoteSnapshot = { ...consoleSnapshot('c-ended', 'alpha'), status: { kind: 'ended', reason: 'external' } }
    const archived = consoleSnapshot('c-archived', 'alpha', true)
    const common = {
      useSessions: hook({}) as never, useWorkspaces: hook({}) as never, ...injected,
      t: t as never,
    }
    const { rerender } = render(<ConsoleRows mode="workspace" workspaceId={wid('missing')} {...common}
      useConsoleCatalog={hook({ phase: 'ready', items: [], connectionEpoch: 0 })} />)
    expect(document.querySelector('[data-console-list]')).toBeNull()
    rerender(<ConsoleRows mode="flat" {...common} useConsoleCatalog={hook({ phase: 'ready', items: [ended], connectionEpoch: 0 })} />)
    expect(screen.queryByText('Terminal c-ended')).toBeNull()
    expect(document.querySelector('[data-console-list]')).toBeNull()
    expect(injected.open).not.toHaveBeenCalled()
    rerender(<ConsoleRows mode="archived" {...common} useConsoleCatalog={hook({ phase: 'ready', items: [archived], connectionEpoch: 0 })} />)
    const archivedRow = screen.getByText('Terminal c-archived').closest('[role="treeitem"]') as HTMLElement
    fireEvent.click(archivedRow.querySelector('button') as HTMLElement)
    fireEvent.click(screen.getByRole('button', { name: 'restore' }))
    expect(injected.setArchived).toHaveBeenCalledWith('c-archived', false)
  })
})
