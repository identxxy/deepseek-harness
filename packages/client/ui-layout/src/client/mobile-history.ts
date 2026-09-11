/** Browser-History integration for single-pane contextual Session navigation. */
import { useEffect, useRef } from 'react'

/** Visible destination in the single-pane shell. */
export type MobileView = 'sessions' | 'conversation'

/** One browser destination, including its contextual Session browser. */
export interface MobileNavigation {
  /** Whether the Session browser or its selected conversation is visible. */
  view: MobileView
  /** Plugin browser key, or null for the main Session list. */
  sidebarPage: string | null
}

const STATE_KEY = '__dshMobileView'
const PAGE_KEY = '__dshSidebarPage'

interface MobileNavigationActions {
  restoreMobileNavigation(view: MobileView, sidebarPage: string | null): void
}

/**
 * Read DSH navigation from one browser History state value.
 * @param state - opaque browser History state.
 * @returns the recognized destination, or undefined for an unrelated or malformed entry.
 */
export function readMobileHistoryNavigation(state: unknown): MobileNavigation | undefined {
  if (typeof state !== 'object' || state === null) return undefined
  const record = state as Record<string, unknown>
  const view = record[STATE_KEY]
  const sidebarPage = record[PAGE_KEY] ?? null
  if (view !== 'sessions' && view !== 'conversation') return undefined
  if (sidebarPage !== null && typeof sidebarPage !== 'string') return undefined
  return { view, sidebarPage }
}

function stateFor(navigation: MobileNavigation): Record<string, unknown> {
  const current = window.history.state as unknown
  const base = typeof current === 'object' && current !== null
    ? current as Record<string, unknown>
    : {}
  return { ...base, [STATE_KEY]: navigation.view, [PAGE_KEY]: navigation.sidebarPage }
}

function depth(navigation: MobileNavigation): number {
  return (navigation.sidebarPage === null ? 0 : 1) + (navigation.view === 'conversation' ? 1 : 0)
}

interface PendingTraversal {
  target: MobileNavigation | undefined
}

function writeNavigation(target: MobileNavigation, pending: PendingTraversal): void {
  if (pending.target !== undefined) {
    pending.target = target
    return
  }
  const { view, sidebarPage } = target
  const current = readMobileHistoryNavigation(window.history.state)
  if (current === undefined) {
    window.history.replaceState(stateFor({ view: 'sessions', sidebarPage: null }), document.title)
    if (sidebarPage !== null) {
      window.history.pushState(stateFor({ view: 'sessions', sidebarPage }), document.title)
    }
    if (view === 'conversation') window.history.pushState(stateFor(target), document.title)
    return
  }
  if (current.view === view && current.sidebarPage === sidebarPage) return
  const isParent = view === 'sessions' && (sidebarPage === null || sidebarPage === current.sidebarPage)
  const changesBrowser = current.sidebarPage !== null && current.sidebarPage !== sidebarPage
  if (changesBrowser || (isParent && depth(target) < depth(current))) {
    pending.target = target
    const distance = changesBrowser ? depth(current) : depth(current) - depth(target)
    if (distance === 1) window.history.back()
    else window.history.go(-distance)
  } else if (current.view === 'conversation') {
    window.history.replaceState(stateFor({ view: 'sessions', sidebarPage }), document.title)
    if (view === 'conversation') window.history.pushState(stateFor(target), document.title)
  } else {
    if (sidebarPage !== current.sidebarPage && sidebarPage !== null) {
      window.history.pushState(stateFor({ view: 'sessions', sidebarPage }), document.title)
    }
    if (view === 'conversation') window.history.pushState(stateFor(target), document.title)
  }
}

/**
 * Bind mobile navigation to same-URL History entries. Contextual browsers sit
 * between the main Session list and conversations. In-app returns traverse
 * existing entries; browser back/forward restores both viewing fields together.
 * @param singlePane - whether responsive single-pane navigation is active.
 * @param view - currently rendered destination.
 * @param sidebarPage - current contextual browser key.
 * @param actions - atomic layout restoration used by popstate navigation.
 */
export function useMobileHistory(
  singlePane: boolean,
  view: MobileView,
  sidebarPage: string | null,
  actions: MobileNavigationActions,
): void {
  // History traversal settles on popstate; later UI gestures supersede its
  // destination without issuing a second traversal against the stale entry.
  const pending = useRef<PendingTraversal>({ target: undefined })
  useEffect(() => {
    if (!singlePane) return
    const onPopState = (event: PopStateEvent): void => {
      const target = pending.current.target
      pending.current.target = undefined
      if (target !== undefined) {
        writeNavigation(target, pending.current)
        actions.restoreMobileNavigation(target.view, target.sidebarPage)
      } else {
        const navigation = readMobileHistoryNavigation(event.state)
        actions.restoreMobileNavigation(navigation?.view ?? 'sessions', navigation?.sidebarPage ?? null)
      }
    }
    window.addEventListener('popstate', onPopState)
    return () => {
      window.removeEventListener('popstate', onPopState)
      pending.current.target = undefined
    }
  }, [actions, singlePane])

  useEffect(() => {
    if (!singlePane) return
    writeNavigation({ view, sidebarPage }, pending.current)
    actions.restoreMobileNavigation(view, sidebarPage)
  }, [actions, singlePane, view, sidebarPage])
}
