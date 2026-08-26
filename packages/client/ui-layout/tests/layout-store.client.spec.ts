// @vitest-environment jsdom
/**
 * createLayoutStore unit account: init shape, the action write set (clamp
 * inside actions), and the absence of browser persistence. Uses the
 * test-sanctioned path: factory self-call + .create() gives the
 * real engine instance (same create path as production).
 */
import { beforeEach, describe, expect, it } from 'vitest'
import { createLayoutStore } from '@deepseek-ai/dsh-client-ui-layout/src/client/stores.ts'
import {
  DETAILS_DEFAULT, DETAILS_MAX, DETAILS_MIN,
  SIDEBAR_DEFAULT, SIDEBAR_MAX, SIDEBAR_MIN,
} from '@deepseek-ai/dsh-client-ui-layout/src/client/columns.ts'

const PERSIST_KEY = 'dsh.layout.panels'

beforeEach(() => { localStorage.clear() })

describe('createLayoutStore', () => {
  it('initializes desktop geometry and leaves the mobile destination automatic', () => {
    const { store } = createLayoutStore().create()
    expect(store.getSnapshot()).toEqual({
      sidebar: SIDEBAR_DEFAULT,
      details: 0,
      singlePane: false,
      mobileView: 'auto',
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

  it('does not persist panel geometry', () => {
    const first = createLayoutStore().create()
    first.actions.setSidebar(400)
    first.actions.openDetails()
    first.actions.setDetails(500)
    expect(localStorage.getItem(PERSIST_KEY)).toBeNull()

    const second = createLayoutStore().create()
    expect(second.store.getSnapshot()).toEqual({
      sidebar: SIDEBAR_DEFAULT,
      details: 0,
      singlePane: false,
      mobileView: 'auto',
    })
  })
})
