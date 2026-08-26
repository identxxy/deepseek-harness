/** Browser-History integration for single-pane Session navigation. */
import { useEffect } from 'react'

/** Visible destination in the single-pane shell. */
export type MobileView = 'sessions' | 'conversation'

const STATE_KEY = '__dshMobileView'

interface MobileNavigationActions {
  showSessionList(): void
  showConversation(): void
}

/**
 * Read the DSH destination from one browser History state value.
 * @param state - opaque browser History state.
 * @returns the recognized destination, or undefined for an unrelated entry.
 */
export function readMobileHistoryView(state: unknown): MobileView | undefined {
  if (typeof state !== 'object' || state === null) return undefined
  const value = (state as Record<string, unknown>)[STATE_KEY]
  return value === 'sessions' || value === 'conversation' ? value : undefined
}

function stateFor(view: MobileView): Record<string, unknown> {
  const current = window.history.state as unknown
  const base = typeof current === 'object' && current !== null
    ? current as Record<string, unknown>
    : {}
  return { ...base, [STATE_KEY]: view }
}

/**
 * Bind single-pane navigation to same-URL browser History entries. The first
 * DSH entry represents the Session list; entering a conversation pushes one
 * child entry, so a browser back gesture returns to the list before leaving
 * the application.
 * @param singlePane - whether responsive single-pane navigation is active.
 * @param view - currently rendered destination.
 * @param actions - layout actions used by popstate navigation.
 */
export function useMobileHistory(
  singlePane: boolean,
  view: MobileView,
  actions: MobileNavigationActions,
): void {
  useEffect(() => {
    if (!singlePane) return
    if (readMobileHistoryView(window.history.state) === undefined) {
      window.history.replaceState(stateFor('sessions'), document.title)
      if (view === 'conversation') {
        window.history.pushState(stateFor('conversation'), document.title)
      }
    }

    const onPopState = (event: PopStateEvent): void => {
      if (readMobileHistoryView(event.state) === 'conversation') actions.showConversation()
      else actions.showSessionList()
    }
    window.addEventListener('popstate', onPopState)
    return () => { window.removeEventListener('popstate', onPopState) }
  }, [actions, singlePane, view])

  useEffect(() => {
    if (!singlePane) return
    const historyView = readMobileHistoryView(window.history.state)
    if (historyView === view) return
    if (view === 'conversation') {
      window.history.pushState(stateFor(view), document.title)
    } else if (historyView === 'conversation') {
      window.history.back()
    } else {
      window.history.replaceState(stateFor(view), document.title)
    }
  }, [singlePane, view])
}
