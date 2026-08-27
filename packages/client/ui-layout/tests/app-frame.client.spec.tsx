// @vitest-environment jsdom
/**
 * AppFrame interaction spec under the four-share props form: real layout
 * store instance (createLayoutStore().create() — the test-sanctioned engine
 * path), a recording renderSlot stub, and a render-prop SessionProvider stub
 * (the real one is framework-wired to the renderer host; its own behavior is
 * ui-renderer's spec territory). Drag sequences (pointer capture + rAF flush),
 * concession response to viewport change, and details staying mounted at
 * zero width are the preserved behavior assertions. jsdom has no layout
 * engine, so the frame width comes from a mocked getBoundingClientRect and
 * resizes are driven through the ResizeObserver stub.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, cleanup, render } from '@testing-library/react'
import { useSyncExternalStore } from 'react'
import { AppFrame } from '@deepseek-ai/dsh-client-ui-layout/src/client/AppFrame.tsx'
import type { AppFrameProps } from '@deepseek-ai/dsh-client-ui-layout/src/client/AppFrame.tsx'
import { SIDEBAR_COLLAPSED } from '@deepseek-ai/dsh-client-ui-layout/src/client/columns.ts'
import { createLayoutStore } from '@deepseek-ai/dsh-client-ui-layout/src/client/stores.ts'
import type { LayoutActions } from '@deepseek-ai/dsh-client-ui-layout/src/client/service.ts'
import type { PaneNode } from '@deepseek-ai/dsh-client-ui-layout/src/client/panes.ts'
import { en, zh, type LayoutLocaleKey } from '@deepseek-ai/dsh-client-ui-layout/src/client/locales.ts'
import type {
  SessionId, SessionListState, WorkspaceListState,
} from '@deepseek-ai/dsh-client-runtime/client'

// Session selection controls for the SessionProvider and useSessions stubs.
const selectedSession = { current: 's-test' as SessionId | undefined }
const selectedSessionBlank = { current: false }
const baselinesReady = { current: true }

// Render-prop contract stub fed through the standard seat prop (the renderer
// injects the real one in production): session mode runs children(id), empty
// mode runs the empty branch — the frame must work against exactly this
// shape. Typed as the seat's own component type so the branded sessionId
// parameter stays contract-checked.
/** Observer stub: captures the callback so tests can fire resizes manually. */
let fireResize: (() => void) | null = null
class ResizeObserverStub {
  #cb: ResizeObserverCallback
  constructor(cb: ResizeObserverCallback) { this.#cb = cb }
  observe(): void { fireResize = () => { this.#cb([], this) } }
  unobserve(): void {}
  disconnect(): void { fireResize = null }
}

let frameWidth = 1920

/** Test-local selector hook over a framework-neutral store instance. */
function hookOf<T>(inst: { subscribe: (fn: () => void) => () => void; getSnapshot: () => T }) {
  return function useSelector<S>(sel: (s: T) => S): S { return sel(useSyncExternalStore(inst.subscribe, inst.getSnapshot)) }
}

function agentIds(node: PaneNode | null): SessionId[] {
  if (node === null) return []
  if (node.kind === 'leaf') return node.actor.kind === 'agent' ? [node.actor.id as SessionId] : []
  return [...agentIds(node.first), ...agentIds(node.second)]
}

function mountFrame(options: {
  availableSessionIds?: readonly SessionId[]
  stageSession?: (sessionId: SessionId) => (() => void)
  selectSession?: (sessionId: SessionId) => void
  setupLayout?: (actions: LayoutActions) => void
  locale?: typeof en
  sessionUnavailable?: boolean
} = {}) {
  window.innerWidth = frameWidth // first-render viewport source before the observer fires
  const instance = createLayoutStore().create()
  options.setupLayout?.(instance.actions)
  const slotCalls: { key: string; props: unknown }[] = []
  const renderSlot = ((key: string, owner: object) => {
    slotCalls.push({ key, props: owner })
    if (key === 'sidebar') return <div data-testid="sidebar-content" />
    if (key === 'conversation') return <header data-testid="center-content" />
    if (key === 'details') return <div data-testid="details-content" />
    if (key === 'workspace.console') return <div data-testid="console-content" data-console-id={(owner as { actor: { id: string } }).actor.id} />
    if (key === 'conversation.empty') return <div data-testid="empty-content" />
    return <div data-testid="other-content" />
  }) as AppFrameProps['renderSlot']
  const workspaceState: WorkspaceListState = {
    items: [], archivedSessionIds: [], state: 'idle', phase: 'ready', error: null,
    baselinesReady: baselinesReady.current, recentWorkspaceId: undefined,
  }
  const SessionProviderStub: AppFrameProps['SessionProvider'] = ({ sessionId, children, empty }) => {
    const selected = sessionId ?? selectedSession.current
    return selected === undefined || options.sessionUnavailable === true
      ? <>{empty?.() ?? null}</>
      : <>{children(selected)}</>
  }
  const element = () => {
    const current = selectedSession.current
    const ids = [...new Set([
      ...(current === undefined ? [] : [current]),
      ...(options.availableSessionIds ?? agentIds(instance.getSnapshot().paneRoot)),
    ])]
    const sessionState = {
      ids,
      byId: Object.fromEntries(ids.map(id => [id, {
        id,
        displayTitle: id === current ? 'Test' : id,
        running: false,
        blank: id === current ? selectedSessionBlank.current : false,
        updatedAt: 1,
      }])),
      current,
      phase: 'ready',
    } as SessionListState
    const useSessions = ((sel: (s: SessionListState) => unknown) => sel(sessionState)) as never
    return (
      <AppFrame
        useStore={hookOf(instance)}
        actions={instance.actions}
        renderSlot={renderSlot}
        useSessions={useSessions}
        useWorkspaces={((sel: (s: WorkspaceListState) => unknown) => sel(workspaceState)) as never}
        SessionProvider={SessionProviderStub}
        selectSession={options.selectSession ?? ((sessionId) => { selectedSession.current = sessionId })}
        stageSession={options.stageSession ?? (() => () => {})}
        t={key => (options.locale ?? en)[key as LayoutLocaleKey]}
      />
    )
  }
  const utils = render(element())
  const frame = utils.container.firstElementChild as HTMLElement
  return { instance, frame, slotCalls, rerenderFrame: () => { utils.rerender(element()) }, ...utils }
}

function tracks(frame: HTMLElement): number[] {
  const m = /^(\d+)px minmax\(0, 1fr\) (\d+)px$/.exec(frame.style.gridTemplateColumns)
  if (m === null) throw new Error(`unexpected template: ${frame.style.gridTemplateColumns}`)
  return [Number(m[1]), Number(m[2])]
}

function drag(handle: Element, fromX: number, toX: number): void {
  const down = new PointerEvent('pointerdown', { pointerId: 1, clientX: fromX, bubbles: true })
  const move = new PointerEvent('pointermove', { pointerId: 1, clientX: toX, bubbles: true })
  const up = new PointerEvent('pointerup', { pointerId: 1, clientX: toX, bubbles: true })
  act(() => { handle.dispatchEvent(down) })
  act(() => { handle.dispatchEvent(move); vi.advanceTimersByTime(20) })
  act(() => { handle.dispatchEvent(up) })
}

beforeEach(() => {
  window.localStorage.clear()
  frameWidth = 1920
  selectedSession.current = 's-test' as SessionId
  selectedSessionBlank.current = false
  baselinesReady.current = true
  vi.useFakeTimers()
  vi.stubGlobal('ResizeObserver', ResizeObserverStub)
  vi.stubGlobal('requestAnimationFrame', (cb: FrameRequestCallback) => setTimeout(() => { cb(0) }, 16) as unknown as number)
  vi.stubGlobal('cancelAnimationFrame', (h: number) => { clearTimeout(h) })
  window.innerWidth = frameWidth
  window.history.replaceState(null, '', '/')
  Element.prototype.getBoundingClientRect = function () {
    return { width: frameWidth, height: 1080, top: 0, left: 0, right: frameWidth, bottom: 1080, x: 0, y: 0, toJSON: () => ({}) }
  }
  // jsdom lacks pointer capture: emulate per-element so hasPointerCapture gates pass.
  const captured = new WeakSet<Element>()
  Element.prototype.setPointerCapture = function () { captured.add(this) }
  Element.prototype.releasePointerCapture = function () { captured.delete(this) }
  Element.prototype.hasPointerCapture = function () { return captured.has(this) }
})

afterEach(() => {
  cleanup()
  window.history.replaceState(null, '', '/')
  vi.useRealTimers()
  vi.unstubAllGlobals()
})

describe('AppFrame', () => {
  it('renders three tracks from store state', () => {
    const { frame } = mountFrame()
    expect(tracks(frame)).toEqual([280, 0])
    expect((frame.children[1] as HTMLElement).style.width).toBe('')
  })

  it('renders the session pair with empty owner shares (sessionId is framework-standard)', () => {
    const { slotCalls, getByTestId } = mountFrame()
    expect(getByTestId('center-content')).toBeTruthy()
    expect(getByTestId('details-content')).toBeTruthy()
    const keys = slotCalls.map(c => c.key)
    expect(keys).toContain('conversation')
    expect(keys).toContain('details')
    expect(keys).not.toContain('conversation.empty')
    expect(slotCalls.find(c => c.key === 'conversation')!.props).toEqual({})
    expect(slotCalls.find(c => c.key === 'details')!.props).toEqual({})
  })

  it('keeps the conversation slot mounted while no session is current', () => {
    // No current session: the session-maybe conversation shell owns the New
    // Session view itself — the center column renders it unconditionally.
    selectedSession.current = undefined
    const { slotCalls, getByTestId } = mountFrame()
    expect(getByTestId('center-content')).toBeTruthy()
    expect(slotCalls.map(c => c.key)).toContain('conversation')
  })

  it('adopts the first current Session without replacing the conversation DOM', () => {
    selectedSession.current = undefined
    const { instance, getByLabelText, getByTestId, rerenderFrame } = mountFrame()
    const conversation = getByTestId('center-content')

    selectedSession.current = 's-adopted' as SessionId
    act(() => { rerenderFrame() })

    expect(getByTestId('center-content')).toBe(conversation)
    expect(instance.getSnapshot()).toMatchObject({ paneRoot: null, activePaneId: null })

    act(() => { getByLabelText('Split right').click() })
    expect(instance.getSnapshot().paneRoot).toMatchObject({ kind: 'split', direction: 'horizontal' })
  })

  it('renders both column occupants before baselines settle (no loading gate)', () => {
    // No loading gate: a bare loading status reads worse than the shell's own
    // pending rendering — both occupants mount from first paint.
    baselinesReady.current = false
    const { slotCalls } = mountFrame()
    expect(slotCalls.map(c => c.key)).toContain('conversation')
    expect(slotCalls.map(c => c.key)).toContain('details')
  })

  it('renders an addressed Agent and Human Terminal in independent desktop panes', () => {
    const { instance, getByTestId, getByRole, container } = mountFrame({
      availableSessionIds: ['s-agent' as SessionId],
    })
    act(() => {
      instance.actions.openActor({ kind: 'agent', id: 's-agent' }, 'pane-agent')
      instance.actions.splitActor({ kind: 'console', id: 'c-terminal' }, 'horizontal', 'split-1', 'pane-terminal')
    })
    expect(getByTestId('center-content')).toBeTruthy()
    expect(getByTestId('console-content').getAttribute('data-console-id')).toBe('c-terminal')
    expect(container.querySelectorAll('[data-actor-pane]')).toHaveLength(2)
    expect(getByTestId('center-content').getAttribute('role')).toBeNull()
    expect(getByTestId('center-content').tagName).toBe('HEADER')
    expect(getByRole('banner')).toBe(getByTestId('center-content'))
    expect(container.querySelector('[data-actor-pane]')?.tagName).toBe('DIV')
    expect(container.querySelector('[class*="paneHeader"]')?.tagName).toBe('DIV')
  })

  it('renders pane chrome in the active locale', () => {
    const english = mountFrame({ locale: en })
    act(() => {
      english.instance.actions.openActor({ kind: 'console', id: 'c-terminal' }, 'pane-terminal')
    })
    expect(english.getByText('Terminal')).toBeTruthy()
    expect(english.getByLabelText('Split right')).toBeTruthy()
    expect(english.getByLabelText('Split down')).toBeTruthy()
    expect(english.getByLabelText('Close pane')).toBeTruthy()
    english.unmount()

    const chinese = mountFrame({ locale: zh })
    act(() => {
      chinese.instance.actions.openActor({ kind: 'console', id: 'c-terminal' }, 'pane-terminal')
    })
    expect(chinese.getByText('终端')).toBeTruthy()
    expect(chinese.getByLabelText('向右分屏')).toBeTruthy()
    expect(chinese.getByLabelText('向下分屏')).toBeTruthy()
    expect(chinese.getByLabelText('关闭窗格')).toBeTruthy()
  })

  it('localizes an unavailable addressed Agent', () => {
    const availableSessionIds = ['s-missing' as SessionId]
    const english = mountFrame({ availableSessionIds, locale: en, sessionUnavailable: true })
    act(() => { english.instance.actions.openActor({ kind: 'agent', id: 's-missing' }, 'pane-missing') })
    expect(english.getByText('Session unavailable')).toBeTruthy()
    english.unmount()

    const chinese = mountFrame({ availableSessionIds, locale: zh, sessionUnavailable: true })
    act(() => { chinese.instance.actions.openActor({ kind: 'agent', id: 's-missing' }, 'pane-missing') })
    expect(chinese.getByText('会话不可用')).toBeTruthy()
  })

  it('keeps a restored active Console when the persisted current Session first projects', () => {
    selectedSession.current = undefined
    const first = mountFrame()
    act(() => {
      first.instance.actions.openActor({ kind: 'console', id: 'c-restored' }, 'pane-console')
    })
    first.unmount()

    selectedSession.current = 's-restored' as SessionId
    const restored = mountFrame()
    expect(restored.instance.getSnapshot().paneRoot).toMatchObject({
      kind: 'leaf',
      id: 'pane-console',
      actor: { kind: 'console', id: 'c-restored' },
    })
    expect(restored.instance.getSnapshot().activePaneId).toBe('pane-console')
  })

  it('drops a restored Agent pane that is absent from the ready Session catalog', () => {
    selectedSession.current = undefined
    const first = mountFrame()
    act(() => {
      first.instance.actions.openActor({ kind: 'agent', id: 's-draft' }, 'pane-draft')
    })
    first.unmount()

    const selectSession = vi.fn()
    const restored = mountFrame({ selectSession, availableSessionIds: [] })

    expect(selectSession).not.toHaveBeenCalled()
    expect(restored.instance.getSnapshot()).toMatchObject({ paneRoot: null, activePaneId: null })
  })

  it('replaces the active Console after a post-mount Session selection', () => {
    selectedSession.current = undefined
    const frame = mountFrame()
    act(() => { frame.instance.actions.openActor({ kind: 'console', id: 'c-active' }, 'pane-console') })

    selectedSession.current = 's-selected' as SessionId
    act(() => { frame.rerenderFrame() })
    expect(frame.instance.getSnapshot().paneRoot).toMatchObject({
      kind: 'leaf',
      id: 'pane-console',
      actor: { kind: 'agent', id: 's-selected' },
    })
  })

  it.each([
    ['catalog reconciliation', (actions: LayoutActions) => { actions.reconcileActorCatalog('console', new Set()) }],
    ['ordinary close', (actions: LayoutActions) => { actions.closeActorPane('pane-console') }],
  ])('selects the surviving Agent after %s removes the active Console', (_label, remove) => {
    const selectSession = vi.fn((sessionId: SessionId) => { selectedSession.current = sessionId })
    const frame = mountFrame({
      selectSession,
      setupLayout: (actions) => {
        actions.openActor({ kind: 'agent', id: 's-fallback' }, 'pane-agent')
        actions.splitActor({ kind: 'console', id: 'c-active' }, 'horizontal', 'split-1', 'pane-console')
      },
    })
    selectSession.mockClear()

    act(() => { remove(frame.instance.actions) })

    expect(frame.instance.getSnapshot().activePaneId).toBe('pane-agent')
    expect(selectSession).toHaveBeenCalledWith('s-fallback')
    expect(selectedSession.current).toBe('s-fallback')
  })

  it('does not restore the old active Agent during an external Session transition', () => {
    const selectSession = vi.fn((sessionId: SessionId) => { selectedSession.current = sessionId })
    const frame = mountFrame({
      selectSession,
      setupLayout: (actions) => { actions.openActor({ kind: 'agent', id: 's-old' }, 'pane-agent') },
    })
    selectSession.mockClear()

    selectedSession.current = 's-external' as SessionId
    act(() => { frame.rerenderFrame() })

    expect(selectSession).not.toHaveBeenCalledWith('s-old')
    expect(frame.instance.getSnapshot().paneRoot).toMatchObject({ actor: { kind: 'agent', id: 's-external' } })
  })

  it('stages every mounted Agent pane and releases only its own lease', () => {
    selectedSession.current = undefined
    const staged: string[] = []
    const leaseCounts = new Map<string, number>()
    const frame = mountFrame({
      availableSessionIds: ['s-one' as SessionId, 's-two' as SessionId],
      stageSession: (sessionId) => {
        staged.push(sessionId)
        leaseCounts.set(sessionId, (leaseCounts.get(sessionId) ?? 0) + 1)
        return () => { leaseCounts.set(sessionId, (leaseCounts.get(sessionId) ?? 1) - 1) }
      },
    })
    act(() => {
      frame.instance.actions.openActor({ kind: 'agent', id: 's-one' }, 'pane-one')
      frame.instance.actions.splitActor({ kind: 'agent', id: 's-two' }, 'horizontal', 'split-agents', 'pane-two')
    })
    expect(staged).toEqual(['s-one', 's-two'])
    expect(Object.fromEntries(leaseCounts)).toEqual({ 's-one': 1, 's-two': 1 })

    act(() => { frame.instance.actions.closeActorPane('pane-two') })
    expect(Object.fromEntries(leaseCounts)).toEqual({ 's-one': 1, 's-two': 0 })
    frame.unmount()
    expect(Object.fromEntries(leaseCounts)).toEqual({ 's-one': 0, 's-two': 0 })
  })

  it('ignores unselected states and closes only when the Session id changes', () => {
    const { frame, instance, rerenderFrame } = mountFrame()
    expect(tracks(frame)).toEqual([280, 0])

    act(() => { instance.actions.openDetails() })
    expect(tracks(frame)).toEqual([280, 360])

    selectedSession.current = 's-next' as SessionId
    act(() => { rerenderFrame() })
    expect(tracks(frame)).toEqual([280, 0])

    act(() => { instance.actions.openDetails() })
    selectedSession.current = 's-blank' as SessionId
    selectedSessionBlank.current = true
    act(() => { rerenderFrame() })
    expect(tracks(frame)).toEqual([280, 0])
    expect(instance.getSnapshot().details).toBe(360)

    selectedSession.current = 's-next' as SessionId
    selectedSessionBlank.current = false
    act(() => { rerenderFrame() })
    expect(tracks(frame)).toEqual([280, 360])

    selectedSession.current = undefined
    act(() => { rerenderFrame() })
    expect(tracks(frame)).toEqual([280, 0])
    selectedSession.current = 's-test' as SessionId
    act(() => { rerenderFrame() })
    expect(tracks(frame)).toEqual([280, 0])
  })

  it('keeps details closed when the first Session materializes', () => {
    selectedSession.current = undefined
    const { frame, instance, rerenderFrame } = mountFrame()
    expect(tracks(frame)).toEqual([280, 0])
    expect(instance.getSnapshot().details).toBe(0)

    selectedSession.current = 's-first' as SessionId
    act(() => { rerenderFrame() })
    expect(tracks(frame)).toEqual([280, 0])
  })

  it('sidebar slot receives live concession output as owner props', () => {
    const { slotCalls } = mountFrame()
    expect(slotCalls.find(c => c.key === 'sidebar')!.props).toEqual({ collapsed: false, width: 280 })
  })

  it('sidebar drag widens through rAF-batched pointer moves', () => {
    const { frame } = mountFrame()
    const handles = frame.querySelectorAll('[class*="handle"]')
    drag(handles[0]!, 280, 350)
    expect(tracks(frame)[0]).toBe(350)
  })

  it('details drag widens leftward (negative dx grows the panel)', () => {
    const { frame, instance } = mountFrame()
    act(() => { instance.actions.openDetails() })
    const handles = frame.querySelectorAll('[class*="handle"]')
    drag(handles[1]!, 1560, 1500)
    expect(tracks(frame)[1]).toBe(420)
  })

  it('drag base is the rendered (concession-clamped) width, not the preference', () => {
    frameWidth = 1250 // step-2 squeeze: details renders 330 while preference is 360
    const { frame, instance } = mountFrame()
    act(() => { instance.actions.openDetails() })
    expect(tracks(frame)).toEqual([280, 330])
    const handles = frame.querySelectorAll('[class*="handle"]')
    drag(handles[1]!, 920, 930) // shrink by 10 from the rendered width
    expect(instance.getSnapshot().details).toBe(320)
  })

  it('details column stays mounted at zero width', () => {
    const { frame, getByTestId } = mountFrame()
    expect(tracks(frame)).toEqual([280, 0])
    expect(getByTestId('details-content')).toBeTruthy()
    expect(frame.hasAttribute('data-details-collapsed')).toBe(true)
  })

  it('closed sidebar keeps its compact rail with mounted slot content and collapsed owner props', () => {
    const { frame, instance, slotCalls, getByTestId } = mountFrame()
    act(() => { instance.actions.toggleSidebar() })
    expect(tracks(frame)).toEqual([SIDEBAR_COLLAPSED, 0])
    expect(getByTestId('sidebar-content')).toBeTruthy()
    expect(frame.hasAttribute('data-sidebar-collapsed')).toBe(true)
    const lastSidebarCall = slotCalls.filter(c => c.key === 'sidebar').at(-1)!
    expect(lastSidebarCall.props).toEqual({ collapsed: true, width: SIDEBAR_COLLAPSED })
  })

  it('viewport shrink triggers the concession chain via ResizeObserver', () => {
    const { frame, instance } = mountFrame()
    act(() => { instance.actions.openDetails() })
    frameWidth = 1250
    act(() => { fireResize?.(); vi.advanceTimersByTime(20) })
    expect(tracks(frame)).toEqual([280, 330])
    frameWidth = 1920
    act(() => { fireResize?.(); vi.advanceTimersByTime(20) })
    expect(tracks(frame)).toEqual([280, 360])
  })

  it('drag handles disappear for collapsed columns', () => {
    const { frame, instance } = mountFrame()
    expect(frame.querySelectorAll('[class*="handle"]')).toHaveLength(1)
    act(() => { instance.actions.openDetails() })
    expect(frame.querySelectorAll('[class*="handle"]')).toHaveLength(2)
    act(() => { instance.actions.closeDetails() })
    expect(frame.querySelectorAll('[class*="handle"]')).toHaveLength(1)
    act(() => { instance.actions.toggleSidebar() })
    expect(frame.querySelectorAll('[class*="handle"]')).toHaveLength(0)
  })
})

describe('AppFrame — single-pane mobile navigation', () => {
  it('focuses the explicitly reopened current Agent after a Console was active', () => {
    frameWidth = 980
    const { instance, container } = mountFrame()
    act(() => {
      instance.actions.splitActor({ kind: 'console', id: 'c-mobile' }, 'horizontal', 'split-mobile', 'pane-console')
    })
    expect(container.querySelector('[data-actor-kind="console"]')).toBeTruthy()

    act(() => {
      instance.actions.openActor({ kind: 'agent', id: selectedSession.current! }, 'unused-pane')
      instance.actions.showConversation()
    })
    expect(container.querySelector('[data-actor-kind="agent"]')).toBeTruthy()
    expect(container.querySelector('[data-actor-kind="console"]')).toBeNull()
  })

  it('starts in the selected conversation with the sidebar fully hidden', () => {
    frameWidth = 980
    const { frame, slotCalls } = mountFrame()
    expect(tracks(frame)).toEqual([0, 0])
    expect(frame.dataset.mobileView).toBe('conversation')
    expect(frame.hasAttribute('data-sidebar-collapsed')).toBe(true)
    expect((frame.children[1] as HTMLElement).style.width).toBe('980px')
    expect(slotCalls.filter(c => c.key === 'sidebar').at(-1)!.props).toEqual({ collapsed: true, width: 0 })
    expect(window.history.state).toMatchObject({ __dshMobileView: 'conversation' })
    expect(frame.querySelectorAll('[class*="handle"]')).toHaveLength(0)
  })

  it('starts at the full-width Session list when no Session is selected', () => {
    frameWidth = 980
    selectedSession.current = undefined
    const { frame, slotCalls } = mountFrame()
    expect(tracks(frame)).toEqual([980, 0])
    expect(frame.dataset.mobileView).toBe('sessions')
    expect(frame.hasAttribute('data-sidebar-collapsed')).toBe(false)
    expect((frame.children[1] as HTMLElement).style.width).toBe('980px')
    expect(slotCalls.filter(c => c.key === 'sidebar').at(-1)!.props).toEqual({ collapsed: false, width: 980 })
    expect(window.history.state).toMatchObject({ __dshMobileView: 'sessions' })
  })

  it('opens a conversation from the list and restores the list on popstate', () => {
    frameWidth = 980
    window.history.replaceState({ __dshMobileView: 'sessions' }, '', '/')
    const { frame, instance } = mountFrame()
    expect(tracks(frame)).toEqual([980, 0])

    act(() => { instance.actions.showConversation() })
    expect(tracks(frame)).toEqual([0, 0])
    expect(window.history.state).toMatchObject({ __dshMobileView: 'conversation' })

    act(() => {
      window.history.replaceState({ __dshMobileView: 'sessions' }, '', '/')
      window.dispatchEvent(new PopStateEvent('popstate', { state: window.history.state as unknown }))
    })
    expect(tracks(frame)).toEqual([980, 0])
    expect(frame.dataset.mobileView).toBe('sessions')
  })

  it('requests browser back when an in-app action returns from conversation to the list', () => {
    frameWidth = 980
    const { frame, instance } = mountFrame()
    const back = vi.spyOn(window.history, 'back').mockImplementation(() => {})
    act(() => { instance.actions.showSessionList() })
    expect(tracks(frame)).toEqual([980, 0])
    expect(back).toHaveBeenCalledOnce()
  })

  it('restores desktop panel geometry after crossing the breakpoint twice', () => {
    const { frame, instance } = mountFrame()
    act(() => { instance.actions.setSidebar(400) })
    frameWidth = 980
    act(() => { fireResize?.(); vi.advanceTimersByTime(20) })
    expect(tracks(frame)).toEqual([0, 0])
    frameWidth = 1920
    act(() => { fireResize?.(); vi.advanceTimersByTime(20) })
    expect(tracks(frame)).toEqual([400, 0])
  })
})

describe('AppFrame — guard branches', () => {
  it('pointer moves without capture are ignored (no width write)', () => {
    const { frame, instance } = mountFrame()
    const handle = frame.querySelectorAll('[class*="handle"]')[0]!
    const before = instance.getSnapshot().sidebar
    // Move + up without a preceding pointerdown: hasPointerCapture is false.
    act(() => {
      handle.dispatchEvent(new PointerEvent('pointermove', { pointerId: 9, clientX: 500, bubbles: true }))
      vi.advanceTimersByTime(20)
      handle.dispatchEvent(new PointerEvent('pointerup', { pointerId: 9, clientX: 500, bubbles: true }))
    })
    expect(instance.getSnapshot().sidebar).toBe(before)
  })

  it('two moves inside one frame coalesce through the pending rAF', () => {
    const { frame, instance } = mountFrame()
    const handle = frame.querySelectorAll('[class*="handle"]')[0]!
    act(() => { handle.dispatchEvent(new PointerEvent('pointerdown', { pointerId: 1, clientX: 280, bubbles: true })) })
    act(() => {
      // Two moves before the frame flushes: the second must ride the pending
      // rAF (frame.current ??= guard), and the flush sees the latest x.
      handle.dispatchEvent(new PointerEvent('pointermove', { pointerId: 1, clientX: 320, bubbles: true }))
      handle.dispatchEvent(new PointerEvent('pointermove', { pointerId: 1, clientX: 340, bubbles: true }))
      vi.advanceTimersByTime(20)
    })
    act(() => { handle.dispatchEvent(new PointerEvent('pointerup', { pointerId: 1, clientX: 340, bubbles: true })) })
    expect(instance.getSnapshot().sidebar).toBe(340)
  })

  it('pointerup with a pending rAF cancels it and commits the final position', () => {
    const { frame, instance } = mountFrame()
    const handle = frame.querySelectorAll('[class*="handle"]')[0]!
    act(() => { handle.dispatchEvent(new PointerEvent('pointerdown', { pointerId: 1, clientX: 280, bubbles: true })) })
    act(() => {
      handle.dispatchEvent(new PointerEvent('pointermove', { pointerId: 1, clientX: 360, bubbles: true }))
      // No timer advance: the rAF is still pending when pointerup arrives.
      handle.dispatchEvent(new PointerEvent('pointerup', { pointerId: 1, clientX: 360, bubbles: true }))
    })
    expect(instance.getSnapshot().sidebar).toBe(360)
  })

  it('zero-width resize reports are ignored (display:none window)', () => {
    const { frame } = mountFrame()
    frameWidth = 0
    act(() => { fireResize?.(); vi.advanceTimersByTime(20) })
    // Track template still reflects the last non-zero viewport.
    expect(tracks(frame)).toEqual([280, 0])
  })
})

describe('AppFrame — unmount with an in-flight resize frame', () => {
  it('cancels the pending rAF on unmount (no post-unmount setState)', () => {
    const { unmount } = mountFrame()
    frameWidth = 800
    act(() => { fireResize?.() }) // rAF scheduled, NOT flushed
    unmount()
    // Flushing after unmount must be a no-op (the frame was cancelled).
    expect(() => { vi.advanceTimersByTime(20) }).not.toThrow()
  })

  it('double resize inside one frame rides the pending rAF (??= guard)', () => {
    const { frame, instance } = mountFrame()
    act(() => { instance.actions.openDetails() })
    frameWidth = 1250
    act(() => { fireResize?.(); fireResize?.(); vi.advanceTimersByTime(20) })
    expect(tracks(frame)).toEqual([280, 330])
  })
})
