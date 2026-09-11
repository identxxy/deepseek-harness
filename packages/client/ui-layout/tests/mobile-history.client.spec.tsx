// @vitest-environment jsdom
/** Contextual mobile navigation preserves the main-list/browser/conversation hierarchy. */
import { useMemo, useState } from 'react'
import { act, cleanup, renderHook } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  readMobileHistoryNavigation, useMobileHistory,
  type MobileNavigation,
} from '../src/client/mobile-history.ts'

const home: MobileNavigation = { view: 'sessions', sidebarPage: null }
const browser: MobileNavigation = { view: 'sessions', sidebarPage: 'plugin' }
const conversation: MobileNavigation = { view: 'conversation', sidebarPage: 'plugin' }

function historyHarness(entries: unknown[] = [null], deferTraversal = false) {
  const stack = [...entries]
  let index = entries.length - 1
  const traversals: number[] = []
  vi.spyOn(window.history, 'state', 'get').mockImplementation(() => stack[index])
  const replace = vi.spyOn(window.history, 'replaceState').mockImplementation((state) => { stack[index] = state })
  const push = vi.spyOn(window.history, 'pushState').mockImplementation((state) => {
    stack.splice(index + 1, stack.length, state)
    index++
  })
  const traverse = (offset: number) => {
    index += offset
    if (index < 0 || index >= stack.length) throw new Error('history left the owned fixture')
    window.dispatchEvent(new PopStateEvent('popstate', { state: stack[index] }))
  }
  const go = (offset: number) => {
    if (deferTraversal) traversals.push(offset)
    else traverse(offset)
  }
  const back = vi.spyOn(window.history, 'back').mockImplementation(() => { go(-1) })
  vi.spyOn(window.history, 'go').mockImplementation((offset) => { go(offset ?? 0) })
  vi.spyOn(window.history, 'forward').mockImplementation(() => { go(1) })
  return {
    push, replace, back, stack, index: () => index,
    settleTraversal() { traverse(traversals.shift()!) },
  }
}

function mountNavigation(initial: MobileNavigation = home) {
  return renderHook(({ mobile }: { mobile: boolean }) => {
    const [navigation, navigate] = useState(initial)
    const actions = useMemo(() => ({
      restoreMobileNavigation(view: MobileNavigation['view'], sidebarPage: string | null) {
        navigate(current => current.view === view && current.sidebarPage === sidebarPage
          ? current
          : { view, sidebarPage })
      },
    }), [])
    useMobileHistory(mobile, navigation.view, navigation.sidebarPage, actions)
    return { navigation, navigate }
  }, { initialProps: { mobile: true } })
}

afterEach(() => {
  cleanup()
  vi.restoreAllMocks()
})

describe('contextual mobile History', () => {
  it('returns through the browser before home, supports forward, and reopens without reverse entries', () => {
    const history = historyHarness()
    const hook = mountNavigation()
    act(() => { hook.result.current.navigate(browser) })
    act(() => { hook.result.current.navigate(conversation) })
    expect(history.stack.map(readMobileHistoryNavigation)).toEqual([home, browser, conversation])

    act(() => { hook.result.current.navigate(browser) })
    expect(history.index()).toBe(1)
    expect(history.push).toHaveBeenCalledTimes(2)
    act(() => { window.history.back() })
    expect(hook.result.current.navigation).toEqual(home)
    act(() => { window.history.forward() })
    expect(hook.result.current.navigation).toEqual(browser)
    act(() => { window.history.forward() })
    expect(hook.result.current.navigation).toEqual(conversation)
    act(() => { hook.result.current.navigate(home) })
    expect(history.index()).toBe(0)

    act(() => { hook.result.current.navigate(browser) })
    expect(history.stack.map(readMobileHistoryNavigation)).toEqual([home, browser])
  })

  it('keeps a newly selected conversation when an earlier UI back settles asynchronously', () => {
    const history = historyHarness([null], true)
    const hook = mountNavigation(conversation)
    act(() => { hook.result.current.navigate(browser) })
    expect(history.back).toHaveBeenCalledOnce()
    act(() => { hook.result.current.navigate(conversation) })
    expect(history.back).toHaveBeenCalledOnce()
    act(() => { history.settleTraversal() })
    expect(hook.result.current.navigation).toEqual(conversation)
    expect(history.stack.map(readMobileHistoryNavigation)).toEqual([home, browser, conversation])
    expect(history.index()).toBe(2)
  })

  it('replaces a native conversation with a contextual browser above the same home', () => {
    const history = historyHarness()
    const hook = mountNavigation({ view: 'conversation', sidebarPage: null })
    act(() => { hook.result.current.navigate(browser) })
    expect(history.stack.map(readMobileHistoryNavigation)).toEqual([home, browser])
    act(() => { window.history.back() })
    expect(hook.result.current.navigation).toEqual(home)
  })

  it('adds the contextual parent when a native conversation changes to a plugin conversation on desktop', () => {
    const history = historyHarness()
    const hook = mountNavigation({ view: 'conversation', sidebarPage: null })
    hook.rerender({ mobile: false })
    act(() => { hook.result.current.navigate(conversation) })
    hook.rerender({ mobile: true })
    expect(history.stack.map(readMobileHistoryNavigation)).toEqual([home, browser, conversation])
    act(() => { window.history.back() })
    expect(hook.result.current.navigation).toEqual(browser)
  })

  it('replaces a contextual parent when changing browser keys and removes it when opening a native conversation', () => {
    const history = historyHarness()
    const hook = mountNavigation(conversation)
    const other = { view: 'conversation', sidebarPage: 'other' } as const
    act(() => { hook.result.current.navigate(other) })
    expect(history.stack.map(readMobileHistoryNavigation)).toEqual([
      home, { view: 'sessions', sidebarPage: 'other' }, other,
    ])
    act(() => { hook.result.current.navigate({ view: 'conversation', sidebarPage: null }) })
    expect(history.index()).toBe(1)
    expect(history.stack.map(readMobileHistoryNavigation)).toEqual([home, { view: 'conversation', sidebarPage: null }])
    act(() => { window.history.back() })
    expect(hook.result.current.navigation).toEqual(home)
  })

  it('seeds every ancestor when a plugin conversation first enters mobile navigation', () => {
    const history = historyHarness()
    const hook = mountNavigation(conversation)
    expect(history.stack.map(readMobileHistoryNavigation)).toEqual([home, browser, conversation])
    hook.rerender({ mobile: false })
    hook.rerender({ mobile: true })
    expect(history.stack).toHaveLength(3)
    act(() => { window.history.back() })
    expect(hook.result.current.navigation).toEqual(browser)
  })

  it('preserves unrelated History fields and rejects malformed destinations', () => {
    historyHarness([{ external: 1 }])
    mountNavigation(browser)
    expect(window.history.state).toMatchObject({ external: 1, __dshSidebarPage: 'plugin' })
    expect(readMobileHistoryNavigation(null)).toBeUndefined()
    expect(readMobileHistoryNavigation({ __dshMobileView: 'other' })).toBeUndefined()
    expect(readMobileHistoryNavigation({ __dshMobileView: 'sessions', __dshSidebarPage: 1 })).toBeUndefined()
    expect(readMobileHistoryNavigation({ __dshMobileView: 'sessions' })).toEqual(home)
  })
})
