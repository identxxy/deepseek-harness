/**
 * LayoutController behavior: the cross-plugin viewing-action face. Geometry
 * lives in the entry store (layout-store.spec.ts) — here we assert the
 * delegation contract: attachActions wiring, all public actions forwarding, the
 * unwired fail-loud, and re-attach overwriting a stale action set.
 */
import { describe, expect, it, vi } from 'vitest'
import { LayoutController } from '@deepseek-ai/dsh-client-ui-layout/src/client/service.ts'
import type { LayoutActions } from '@deepseek-ai/dsh-client-ui-layout/src/client/service.ts'

function fakeActions(): LayoutActions {
  return {
    setSidebar: vi.fn(),
    setDetails: vi.fn(),
    toggleSidebar: vi.fn(),
    setSinglePane: vi.fn(),
    showSessionList: vi.fn(),
    showConversation: vi.fn(),
    openDetails: vi.fn(),
    closeDetails: vi.fn(),
    openActor: vi.fn(),
    splitActor: vi.fn(),
    focusPane: vi.fn(),
    closeActorPane: vi.fn(),
    reconcileActorCatalog: vi.fn(),
    resizeActorSplit: vi.fn(),
  }
}

describe('LayoutController', () => {
  it('forwards the public viewing actions to the attached set', () => {
    const service = new LayoutController()
    const actions = fakeActions()
    service.attachActions(actions)

    service.toggleSidebar()
    service.showSessionList()
    service.showConversation()
    service.openDetails()
    service.closeDetails()
    service.openActor({ kind: 'agent', id: 's1' })
    service.openActorInSplit({ kind: 'console', id: 'c1' }, 'horizontal')
    service.reconcileActorCatalog('console', new Set(['c1']))

    expect(actions.toggleSidebar).toHaveBeenCalledTimes(1)
    expect(actions.showSessionList).toHaveBeenCalledTimes(1)
    expect(actions.showConversation).toHaveBeenCalledTimes(1)
    expect(actions.openDetails).toHaveBeenCalledTimes(1)
    expect(actions.closeDetails).toHaveBeenCalledTimes(1)
    expect(actions.openActor).toHaveBeenCalledWith({ kind: 'agent', id: 's1' }, expect.stringMatching(/^pane-/))
    expect(actions.splitActor).toHaveBeenCalledWith(
      { kind: 'console', id: 'c1' }, 'horizontal', expect.stringMatching(/^split-/), expect.stringMatching(/^pane-/),
    )
    expect(actions.reconcileActorCatalog).toHaveBeenCalledWith('console', new Set(['c1']))
    expect(actions.setSidebar).not.toHaveBeenCalled()
    expect(actions.setDetails).not.toHaveBeenCalled()
  })

  it('fails loud before the root entry wired its actions', () => {
    const service = new LayoutController()
    expect(() => { service.toggleSidebar() }).toThrow(/actions not wired/)
    expect(() => { service.showSessionList() }).toThrow(/actions not wired/)
    expect(() => { service.showConversation() }).toThrow(/actions not wired/)
    expect(() => { service.openDetails() }).toThrow(/actions not wired/)
    expect(() => { service.closeDetails() }).toThrow(/actions not wired/)
  })

  it('re-attach overwrites the stale action set (entry re-register)', () => {
    const service = new LayoutController()
    const stale = fakeActions()
    const fresh = fakeActions()
    service.attachActions(stale)
    service.attachActions(fresh)

    service.toggleSidebar()

    expect(stale.toggleSidebar).not.toHaveBeenCalled()
    expect(fresh.toggleSidebar).toHaveBeenCalledTimes(1)
  })
})
