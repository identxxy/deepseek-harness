// @vitest-environment jsdom
/**
 * createLayoutStore unit account: init shape, the action write set (clamp
 * inside actions), and pane-only browser persistence. Uses the
 * test-sanctioned path: factory self-call + .create() gives the
 * real engine instance (same create path as production).
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { createLayoutStore } from '@deepseek-ai/dsh-client-ui-layout/src/client/stores.ts'
import {
  DETAILS_DEFAULT, DETAILS_MAX, DETAILS_MIN,
  SIDEBAR_DEFAULT, SIDEBAR_MAX, SIDEBAR_MIN,
} from '@deepseek-ai/dsh-client-ui-layout/src/client/columns.ts'

const PERSIST_KEY = 'dsh.layout.panes.v1'

beforeEach(() => { localStorage.clear() })

describe('createLayoutStore', () => {
  it('initializes desktop geometry and leaves the mobile destination automatic', () => {
    const { store } = createLayoutStore().create()
    expect(store.getSnapshot()).toEqual({
      sidebar: SIDEBAR_DEFAULT,
      details: 0,
      singlePane: false,
      mobileView: 'auto',
      paneVersion: 1,
      paneRoot: null,
      activePaneId: null,
    })
  })

  it('each create() is an independent instance (factory is not a singleton)', () => {
    const a = createLayoutStore().create()
    const b = createLayoutStore().create()
    a.actions.setSidebar(400)
    expect(b.store.getSnapshot().sidebar).toBe(SIDEBAR_DEFAULT)
  })

  it('setSidebar/setDetails clamp into the contract ranges', () => {
    const { store, actions } = createLayoutStore().create()
    actions.setSidebar(1)
    expect(store.getSnapshot().sidebar).toBe(SIDEBAR_MIN)
    actions.setSidebar(9999)
    expect(store.getSnapshot().sidebar).toBe(SIDEBAR_MAX)
    actions.setDetails(1)
    expect(store.getSnapshot().details).toBe(DETAILS_MIN)
    actions.setDetails(9999)
    expect(store.getSnapshot().details).toBe(DETAILS_MAX)
  })

  it('toggleSidebar flips closed <-> contract default (drag width forgotten)', () => {
    const { store, actions } = createLayoutStore().create()
    actions.setSidebar(400)
    actions.toggleSidebar()
    expect(store.getSnapshot().sidebar).toBe(0)
    actions.toggleSidebar()
    expect(store.getSnapshot().sidebar).toBe(SIDEBAR_DEFAULT)
  })

  it('single-pane navigation actions preserve the desktop width preference', () => {
    const { store, actions } = createLayoutStore().create()
    actions.setSidebar(400)
    actions.setSinglePane(true)
    actions.toggleSidebar()
    expect(store.getSnapshot()).toEqual({
      sidebar: 400,
      details: 0,
      singlePane: true,
      mobileView: 'conversation',
      paneVersion: 1,
      paneRoot: null,
      activePaneId: null,
    })
    actions.toggleSidebar()
    expect(store.getSnapshot().mobileView).toBe('sessions')
    actions.showConversation()
    expect(store.getSnapshot().mobileView).toBe('conversation')
    actions.showSessionList()
    expect(store.getSnapshot().mobileView).toBe('sessions')
    expect(store.getSnapshot().sidebar).toBe(400)
  })

  it('crossing the breakpoint resets the destination while a same-value write keeps it', () => {
    const { store, actions } = createLayoutStore().create()
    actions.setSinglePane(true)
    actions.showConversation()
    actions.setSinglePane(true)
    expect(store.getSnapshot().mobileView).toBe('conversation')
    actions.setSinglePane(false)
    expect(store.getSnapshot()).toMatchObject({ singlePane: false, mobileView: 'auto' })
    actions.setSinglePane(true)
    expect(store.getSnapshot().mobileView).toBe('auto')
  })

  it('openDetails uses the contract default, preserves an open width, and closeDetails zeroes', () => {
    const { store, actions } = createLayoutStore().create()
    actions.openDetails()
    expect(store.getSnapshot().details).toBe(DETAILS_DEFAULT)
    actions.setDetails(500)
    actions.openDetails()
    expect(store.getSnapshot().details).toBe(500)
    actions.closeDetails()
    expect(store.getSnapshot().details).toBe(0)
  })

  it('opens, splits, focuses, and closes product actors without changing workload state', () => {
    const { store, actions } = createLayoutStore().create()
    actions.openActor({ kind: 'agent', id: 's1' }, 'pane-a')
    actions.splitActor({ kind: 'console', id: 'c1' }, 'horizontal', 'split-1', 'pane-b')
    expect(store.getSnapshot()).toMatchObject({
      activePaneId: 'pane-b',
      paneRoot: {
        kind: 'split', id: 'split-1', direction: 'horizontal',
        first: { kind: 'leaf', id: 'pane-a', actor: { kind: 'agent', id: 's1' } },
        second: { kind: 'leaf', id: 'pane-b', actor: { kind: 'console', id: 'c1' } },
      },
    })
    actions.focusPane('pane-a')
    actions.closeActorPane('pane-a')
    expect(store.getSnapshot()).toMatchObject({
      activePaneId: 'pane-b',
      paneRoot: { kind: 'leaf', id: 'pane-b', actor: { kind: 'console', id: 'c1' } },
    })
  })

  it('reconciles an actor catalog atomically and falls back from a removed active pane', () => {
    const { store, actions } = createLayoutStore().create()
    actions.openActor({ kind: 'console', id: 'stale' }, 'pane-stale-a')
    actions.splitActor({ kind: 'agent', id: 's1' }, 'horizontal', 'split-1', 'pane-agent')
    actions.splitActor({ kind: 'console', id: 'stale' }, 'vertical', 'split-2', 'pane-stale-b')
    actions.reconcileActorCatalog('console', new Set())

    expect(store.getSnapshot()).toMatchObject({
      paneRoot: { kind: 'leaf', id: 'pane-agent', actor: { kind: 'agent', id: 's1' } },
      activePaneId: 'pane-agent',
    })
  })

  it('keeps a surviving active pane and returns an emptied mobile workspace to sessions', () => {
    const retained = createLayoutStore().create()
    retained.actions.openActor({ kind: 'console', id: 'c1' }, 'pane-console')
    retained.actions.splitActor({ kind: 'agent', id: 's1' }, 'horizontal', 'split-1', 'pane-agent')
    retained.actions.reconcileActorCatalog('console', new Set(['c1']))
    expect(retained.store.getSnapshot().activePaneId).toBe('pane-agent')

    const emptied = createLayoutStore().create()
    emptied.actions.setSinglePane(true)
    emptied.actions.showConversation()
    emptied.actions.openActor({ kind: 'console', id: 'stale' }, 'pane-stale')
    emptied.actions.reconcileActorCatalog('console', new Set())
    expect(emptied.store.getSnapshot()).toMatchObject({
      paneRoot: null,
      activePaneId: null,
      mobileView: 'sessions',
    })
  })

  it('persists the pane tree but not panel geometry or responsive navigation state', () => {
    const first = createLayoutStore().create()
    first.actions.setSidebar(400)
    first.actions.openDetails()
    first.actions.setDetails(500)
    first.actions.setSinglePane(true)
    first.actions.showConversation()
    first.actions.openActor({ kind: 'agent', id: 's1' }, 'pane-a')
    first.actions.splitActor({ kind: 'console', id: 'c1' }, 'horizontal', 'split-1', 'pane-b')
    expect(JSON.parse(localStorage.getItem(PERSIST_KEY)!)).toEqual({
      paneVersion: 1,
      paneRoot: {
        kind: 'split', id: 'split-1', direction: 'horizontal', ratio: 0.5,
        first: { kind: 'leaf', id: 'pane-a', actor: { kind: 'agent', id: 's1' } },
        second: { kind: 'leaf', id: 'pane-b', actor: { kind: 'console', id: 'c1' } },
      },
      activePaneId: 'pane-b',
    })

    const second = createLayoutStore().create()
    expect(second.store.getSnapshot()).toEqual({
      sidebar: SIDEBAR_DEFAULT,
      details: 0,
      singlePane: false,
      mobileView: 'auto',
      paneVersion: 1,
      paneRoot: {
        kind: 'split', id: 'split-1', direction: 'horizontal', ratio: 0.5,
        first: { kind: 'leaf', id: 'pane-a', actor: { kind: 'agent', id: 's1' } },
        second: { kind: 'leaf', id: 'pane-b', actor: { kind: 'console', id: 'c1' } },
      },
      activePaneId: 'pane-b',
    })
  })

  it('persists and restores the largest live pane tree without decode fallback', () => {
    const first = createLayoutStore().create()
    first.actions.openActor({ kind: 'agent', id: 's0' }, 'pane-0')
    const leaves = ['pane-0']
    for (let index = 1; index <= 31; index += 1) {
      const target = leaves.shift()!
      first.actions.focusPane(target)
      const next = `pane-${String(index)}`
      first.actions.splitActor({ kind: 'agent', id: `s${String(index)}` }, 'horizontal', `split-${String(index)}`, next)
      leaves.push(target, next)
    }
    const atLimit = first.store.getSnapshot().paneRoot
    first.actions.focusPane(leaves[0]!)
    first.actions.splitActor({ kind: 'console', id: 'overflow' }, 'horizontal', 'split-over', 'pane-over')
    expect(first.store.getSnapshot().paneRoot).toBe(atLimit)

    const error = vi.spyOn(console, 'error').mockImplementation(() => {})
    const restored = createLayoutStore().create().store.getSnapshot()
    expect(restored.paneRoot).toEqual(atLimit)
    expect(error).not.toHaveBeenCalled()
    error.mockRestore()
  })

  it('rejects an invalid durable pane tree and starts from the safe initial layout', () => {
    localStorage.setItem(PERSIST_KEY, JSON.stringify({
      paneVersion: 1,
      paneRoot: { kind: 'leaf', id: 'pane-a', actor: { kind: 'shell', id: 'x' } },
      activePaneId: 'pane-a',
    }))
    const error = vi.spyOn(console, 'error').mockImplementation(() => {})
    const { store } = createLayoutStore().create()
    expect(store.getSnapshot()).toMatchObject({ paneRoot: null, activePaneId: null })
    expect(error).toHaveBeenCalledOnce()
    error.mockRestore()
  })
})
