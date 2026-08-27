/**
 * Three-column shell frame, registered into the built-in 'root' slot (the web
 * shell renders only 'root'). Owns the grid tracks (sidebar | center |
 * details), the drag handles (pointer capture + rAF throttle), the concession
 * chain (columns.ts), and the child-slot render decisions: the sidebar slot
 * renders HERE with live parameters from the concession solve, and the
 * session-aware occupants render in fixed column positions; strict entries
 * gate themselves on current-session availability while session-maybe
 * entries retain identity. Pure component: everything arrives
 * through the three framework shares — zero cordis or framework imports,
 * zero self-made hooks.
 */
import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react'
import type { CSSProperties, PointerEvent as ReactPointerEvent, ReactNode } from 'react'
import type { SessionId } from '@deepseek-ai/dsh-client-runtime/client'
import type { InjectFace, PropsLocale, PropsRenderSlots, PropsRuntime, PropsStore } from '@deepseek-ai/dsh-client-ui-slots'
import { computeColumns, MOBILE_NAV_BREAKPOINT } from './columns.ts'
import { readMobileHistoryView, useMobileHistory } from './mobile-history.ts'
import type { createLayoutStore } from './stores.ts'
import { findPane, firstPaneId } from './panes.ts'
import type { ActorRef, PaneNode, PaneSplitDirection } from './panes.ts'
import css from './AppFrame.module.css'

/** Root-entry callbacks that bridge pane focus to the session domain. */
export interface AppFrameInjected {
  /** Make a focused Agent pane the global Session for details and navigation state. */
  selectSession: (sessionId: SessionId) => void
  /** Retain and stage one addressed Agent pane until its renderer unmounts. */
  stageSession: (sessionId: SessionId) => () => void
}

/** Full composed props: runtime share + child-slot render share + store share. */
export type AppFrameProps =
  & PropsRuntime<'root'>
  & PropsLocale<'layout'>
  & PropsRenderSlots<'sidebar' | 'conversation' | 'details' | 'shell.overlay' | 'workspace.console'>
  & PropsStore<ReturnType<typeof createLayoutStore>>
  & InjectFace<AppFrameInjected>

/** Center column grid item (session-body building block). */
function CenterColumn(props: { children?: ReactNode; mobileWidth?: number | undefined }) {
  return (
    <div className={css.centerCol} style={props.mobileWidth === undefined ? undefined : { width: props.mobileWidth }}>
      {props.children}
    </div>
  )
}

/** Details column grid item; width 0 keeps the subtree mounted (never unmount on close). */
function DetailsColumn(props: { children?: ReactNode }) {
  return <div className={css.detailsCol}>{props.children}</div>
}

function paneIdentity(prefix: 'pane' | 'split'): string {
  return `${prefix}-${globalThis.crypto.randomUUID()}`
}

interface PaneCanvasProps {
  node: PaneNode
  activePaneId: string | null
  mobile: boolean
  actions: AppFrameProps['actions']
  SessionProvider: AppFrameProps['SessionProvider']
  canSelectSession: (sessionId: SessionId) => boolean
  renderSlot: AppFrameProps['renderSlot']
  selectSession: AppFrameInjected['selectSession']
  stageSession: AppFrameInjected['stageSession']
  titleOf: (actor: ActorRef) => string
  t: AppFrameProps['t']
}

/** Stable scaffold for the session-maybe conversation before a pane tree exists. */
function ImplicitAgentPane(props: {
  actions: AppFrameProps['actions']
  currentSession: SessionId | undefined
  mobile: boolean
  renderSlot: AppFrameProps['renderSlot']
  title: string | undefined
  t: AppFrameProps['t']
}) {
  const split = (direction: PaneSplitDirection): void => {
    if (props.currentSession === undefined) return
    const actor: ActorRef = { kind: 'agent', id: props.currentSession }
    props.actions.openActor(actor, paneIdentity('pane'))
    props.actions.splitActor(actor, direction, paneIdentity('split'), paneIdentity('pane'))
  }
  return (
    <div
      className={css.actorPane}
      data-actor-pane={props.currentSession === undefined ? undefined : 'implicit-current'}
      data-actor-kind={props.currentSession === undefined ? undefined : 'agent'}
      data-active={props.currentSession === undefined ? undefined : true}
      data-implicit-empty={props.currentSession === undefined ? true : undefined}
    >
      <div className={css.paneHeader}>
        <span className={css.paneKind}>{props.currentSession === undefined ? null : props.t('agent')}</span>
        <span className={css.paneTitle}>{props.title}</span>
        {props.currentSession !== undefined && !props.mobile && (
          <span className={css.paneActions}>
            <button type="button" title={props.t('splitRight')} aria-label={props.t('splitRight')} onClick={() => { split('horizontal') }}>⇥</button>
            <button type="button" title={props.t('splitDown')} aria-label={props.t('splitDown')} onClick={() => { split('vertical') }}>⇲</button>
          </span>
        )}
      </div>
      <div className={css.paneBody}>{props.renderSlot('conversation', {})}</div>
    </div>
  )
}

/** One leaf with view-only split and close controls. */
function ActorPane(props: PaneCanvasProps & { node: Extract<PaneNode, { kind: 'leaf' }> }) {
  const {
    node, activePaneId, mobile, actions, SessionProvider, canSelectSession,
    renderSlot, selectSession, stageSession, titleOf, t,
  } = props
  const active = activePaneId === node.id
  const sessionSelectable = node.actor.kind === 'agent'
    && canSelectSession(node.actor.id as SessionId)
  const selectSessionRef = useRef(selectSession)
  selectSessionRef.current = selectSession
  useEffect(() => node.actor.kind === 'agent'
    ? stageSession(node.actor.id as SessionId)
    : undefined, [node.actor, stageSession])
  useEffect(() => {
    if (active && node.actor.kind === 'agent' && sessionSelectable) {
      selectSessionRef.current(node.actor.id as SessionId)
    }
  }, [active, node.actor.id, node.actor.kind, sessionSelectable])
  const focus = (): void => {
    actions.focusPane(node.id)
    if (node.actor.kind === 'agent' && sessionSelectable) selectSession(node.actor.id as SessionId)
  }
  const split = (direction: PaneSplitDirection): void => {
    actions.splitActor(node.actor, direction, paneIdentity('split'), paneIdentity('pane'))
  }
  const body = node.actor.kind === 'agent'
    ? (
      <SessionProvider sessionId={node.actor.id as SessionId} empty={() => <div className={css.paneUnavailable}>{t('sessionUnavailable')}</div>}>
        {() => renderSlot('conversation', {})}
      </SessionProvider>
    )
    : renderSlot('workspace.console', { actor: node.actor, paneId: node.id, active, mobile })
  return (
    <div
      className={css.actorPane}
      data-actor-pane={node.id}
      data-actor-kind={node.actor.kind}
      data-active={active || undefined}
      onPointerDown={focus}
    >
      <div className={css.paneHeader}>
        <span className={css.paneKind}>{node.actor.kind === 'agent' ? t('agent') : t('terminal')}</span>
        <span className={css.paneTitle}>{titleOf(node.actor)}</span>
        {!mobile && (
          <span className={css.paneActions}>
            <button type="button" title={t('splitRight')} aria-label={t('splitRight')} onClick={() => { split('horizontal') }}>⇥</button>
            <button type="button" title={t('splitDown')} aria-label={t('splitDown')} onClick={() => { split('vertical') }}>⇲</button>
            <button type="button" title={t('closePane')} aria-label={t('closePane')} onClick={() => { actions.closeActorPane(node.id) }}>×</button>
          </span>
        )}
      </div>
      <div className={css.paneBody}>{body}</div>
    </div>
  )
}

/** Recursive split renderer with pointer-resizable dividers. */
function PaneCanvas(props: PaneCanvasProps) {
  const { node } = props
  const splitRef = useRef<HTMLDivElement | null>(null)
  if (node.kind === 'leaf') return <ActorPane {...props} node={node} />
  const horizontal = node.direction === 'horizontal'
  const style: CSSProperties = horizontal
    ? { gridTemplateColumns: `${node.ratio * 100}% 5px minmax(0, 1fr)` }
    : { gridTemplateRows: `${node.ratio * 100}% 5px minmax(0, 1fr)` }
  const move = (event: ReactPointerEvent<HTMLDivElement>): void => {
    if (!event.currentTarget.hasPointerCapture(event.pointerId)) return
    const rect = splitRef.current?.getBoundingClientRect()
    if (rect === undefined) return
    const ratio = horizontal
      ? (event.clientX - rect.left) / rect.width
      : (event.clientY - rect.top) / rect.height
    props.actions.resizeActorSplit(node.id, ratio)
  }
  return (
    <div ref={splitRef} className={css.paneSplit} data-direction={node.direction} style={style}>
      <PaneCanvas {...props} node={node.first} />
      <div
        className={css.paneDivider}
        data-direction={node.direction}
        onPointerDown={(event) => { event.currentTarget.setPointerCapture(event.pointerId) }}
        onPointerMove={move}
        onPointerUp={(event) => {
          if (event.currentTarget.hasPointerCapture(event.pointerId)) event.currentTarget.releasePointerCapture(event.pointerId)
        }}
      />
      <PaneCanvas {...props} node={node.second} />
    </div>
  )
}

/**
 * One drag handle: pointer capture, rAF-throttled dx reports against the drag-start origin.
 * `side` keys the hover-reveal CSS to the owning column.
 */
function DragHandle(props: { side: 'sidebar' | 'details'; left: number; onStart: () => void; onDrag: (dx: number) => void; onEnd: () => void }) {
  const [dragging, setDragging] = useState(false)
  const origin = useRef(0)
  const latest = useRef(0)
  const frame = useRef<number | null>(null)
  const callbacks = useRef({ onStart: props.onStart, onDrag: props.onDrag, onEnd: props.onEnd })
  callbacks.current = { onStart: props.onStart, onDrag: props.onDrag, onEnd: props.onEnd }

  const onPointerDown = useCallback((e: React.PointerEvent<HTMLDivElement>) => {
    e.preventDefault()
    e.currentTarget.setPointerCapture(e.pointerId)
    origin.current = e.clientX
    latest.current = e.clientX
    callbacks.current.onStart()
    setDragging(true)
  }, [])
  const onPointerMove = useCallback((e: React.PointerEvent<HTMLDivElement>) => {
    if (!e.currentTarget.hasPointerCapture(e.pointerId)) return
    latest.current = e.clientX
    frame.current ??= requestAnimationFrame(() => {
      frame.current = null
      callbacks.current.onDrag(latest.current - origin.current)
    })
  }, [])
  const onPointerUp = useCallback((e: React.PointerEvent<HTMLDivElement>) => {
    if (!e.currentTarget.hasPointerCapture(e.pointerId)) return
    e.currentTarget.releasePointerCapture(e.pointerId)
    if (frame.current !== null) { cancelAnimationFrame(frame.current); frame.current = null }
    callbacks.current.onDrag(latest.current - origin.current)
    setDragging(false)
    callbacks.current.onEnd()
  }, [])

  return (
    <div
      className={css.handle}
      style={{ left: props.left }}
      data-side={props.side}
      data-dragging={dragging || undefined}
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={onPointerUp}
    />
  )
}

/** The three-column frame (see module doc). */
export function AppFrame({
  useStore,
  useSessions,
  actions,
  renderSlot,
  SessionProvider,
  selectSession,
  stageSession,
  t,
}: AppFrameProps) {
  const panels = useStore(s => s)
  const sessionsState = useSessions(s => s)
  const currentSession = useSessions(s => s.current)
  const detailsSession = useSessions((s) => {
    const current = s.current
    return current !== undefined && s.byId[current]?.blank === false ? current : undefined
  })
  const frameRef = useRef<HTMLDivElement | null>(null)
  const [viewport, setViewport] = useState(() => window.innerWidth)
  const paneSelection = useRef({ root: panels.paneRoot, activePaneId: panels.activePaneId })
  paneSelection.current = { root: panels.paneRoot, activePaneId: panels.activePaneId }
  // Pane selections may outpace Session projection during one React batch.
  const paneSelectedSessions = useRef(new Set<SessionId>())
  const selectPaneSession = useCallback((sessionId: SessionId) => {
    paneSelectedSessions.current.add(sessionId)
    selectSession(sessionId)
  }, [selectSession])
  const canSelectSession = useCallback((sessionId: SessionId) =>
    sessionsState.phase === 'ready' && sessionsState.byId[sessionId] !== undefined,
  [sessionsState.byId, sessionsState.phase])

  useEffect(() => {
    if (sessionsState.phase !== 'ready' || panels.paneRoot === null) return
    actions.reconcileActorCatalog('agent', new Set(sessionsState.ids))
  }, [actions, panels.paneRoot, sessionsState.ids, sessionsState.phase])

  const previousSession = useRef(currentSession)
  const selectionEffectMounted = useRef(false)
  useEffect(() => {
    const mounted = selectionEffectMounted.current
    selectionEffectMounted.current = true
    if (currentSession === undefined) return
    const { root, activePaneId } = paneSelection.current
    const active = activePaneId === null ? undefined : findPane(root, activePaneId)
    const previous = previousSession.current
    const selectionChanged = mounted && previous !== currentSession
    const selectedByPane = paneSelectedSessions.current.delete(currentSession)
    if (!selectedByPane && selectionChanged) paneSelectedSessions.current.clear()
    const replacesExplicitPane = root !== null
      && selectionChanged
      && !selectedByPane
      && (active?.actor.kind !== 'agent' || active.actor.id !== currentSession)
    const establishesPaneAfterSelection = root === null && selectionChanged && previous !== undefined
    previousSession.current = currentSession
    if (replacesExplicitPane || establishesPaneAfterSelection) {
      actions.openActor({ kind: 'agent', id: currentSession }, paneIdentity('pane'))
    }
  }, [actions, currentSession])

  const lastSession = useRef(detailsSession)
  useLayoutEffect(() => {
    if (detailsSession === undefined) return
    if (lastSession.current !== undefined && lastSession.current !== detailsSession) {
      actions.closeDetails()
    }
    lastSession.current = detailsSession
  }, [actions, detailsSession])

  // Track the frame's own box (not the window): rAF-throttled ResizeObserver.
  useEffect(() => {
    const el = frameRef.current
    /* v8 ignore next -- the ref is always attached by effect time: the frame div renders unconditionally. */
    if (el === null) return
    let raf: number | null = null
    const observer = new ResizeObserver(() => {
      raf ??= requestAnimationFrame(() => {
        raf = null
        const width = el.getBoundingClientRect().width
        if (width > 0) setViewport(width)
      })
    })
    observer.observe(el)
    return () => {
      observer.disconnect()
      if (raf !== null) cancelAnimationFrame(raf)
    }
  }, [])

  // Below the mobile breakpoint the shell becomes a two-level, single-pane
  // navigation. Both subtrees stay mounted; zero-width tracks preserve their
  // local state while clipping the inactive destination.
  const singlePane = viewport < MOBILE_NAV_BREAKPOINT
  useEffect(() => { actions.setSinglePane(singlePane) }, [actions, singlePane])
  const mobileView = panels.mobileView === 'auto'
    ? readMobileHistoryView(window.history.state) ?? (currentSession === undefined ? 'sessions' : 'conversation')
    : panels.mobileView
  useMobileHistory(singlePane, mobileView, actions)

  const desktopCols = computeColumns(
    viewport,
    panels.sidebar,
    detailsSession === undefined ? 0 : panels.details,
  )
  const cols = singlePane
    ? {
      sidebar: mobileView === 'sessions' ? viewport : 0,
      center: mobileView === 'conversation' ? viewport : 0,
      details: 0,
    }
    : desktopCols
  const sidebarCollapsed = singlePane ? mobileView === 'conversation' : panels.sidebar === 0
  const colsRef = useRef(cols)
  colsRef.current = cols

  // The drag base is the rendered width captured at drag start (grabbing a
  // concession-clamped panel must not jump back to the stored preference);
  // it stays frozen for the whole gesture so dx deltas do not compound.
  const sidebarBase = useRef(0)
  const detailsBase = useRef(0)
  // Track-level transitions pause for the whole gesture: eased tracks would
  // detach the column edge from the pointer (AppFrame.module.css).
  const [dragging, setDragging] = useState(false)
  const onDragEnd = useCallback(() => { setDragging(false) }, [])
  const onSidebarStart = useCallback(() => { sidebarBase.current = colsRef.current.sidebar; setDragging(true) }, [])
  const onDetailsStart = useCallback(() => { detailsBase.current = colsRef.current.details; setDragging(true) }, [])
  const onSidebarDrag = useCallback((dx: number) => {
    actions.setSidebar(sidebarBase.current + dx)
  }, [actions])
  const onDetailsDrag = useCallback((dx: number) => {
    actions.setDetails(detailsBase.current - dx)
  }, [actions])
  const visiblePane = singlePane && panels.paneRoot !== null
    ? findPane(panels.paneRoot, panels.activePaneId ?? '')
      ?? findPane(panels.paneRoot, firstPaneId(panels.paneRoot) ?? '')
    : undefined
  const paneTree = visiblePane ?? panels.paneRoot
  const titleOf = (actor: ActorRef): string => actor.kind === 'agent'
    ? sessionsState.byId[actor.id as SessionId]?.displayTitle ?? actor.id
    : actor.id

  return (
    <div
      ref={frameRef}
      className={css.frame}
      style={{ gridTemplateColumns: `${cols.sidebar}px minmax(0, 1fr) ${cols.details}px` }}
      data-sidebar-collapsed={sidebarCollapsed || undefined}
      data-details-collapsed={cols.details === 0 || undefined}
      data-mobile-view={singlePane ? mobileView : undefined}
      data-dragging={dragging || undefined}
    >
      <div className={css.sidebarCol}>
        {/* Render-site slot call with live layout output. Desktop close keeps
            the compact rail; single-pane conversation navigation clips the
            mounted sidebar at zero width. */}
        {renderSlot('sidebar', {
          collapsed: sidebarCollapsed,
          width: cols.sidebar,
        })}
      </div>
      <>
        {/* Both column occupants stay at fixed tree positions from first
            paint — no loading gate: a bare status line reads worse than
            the shell's own pending rendering. The conversation
            is session-maybe; the strict details entry naturally renders
            empty while no session is current. */}
        <CenterColumn mobileWidth={singlePane ? viewport : undefined}>{paneTree === null
          ? (
            <ImplicitAgentPane
              actions={actions}
              currentSession={currentSession}
              mobile={singlePane}
              renderSlot={renderSlot}
              title={currentSession === undefined ? undefined : titleOf({ kind: 'agent', id: currentSession })}
              t={t}
            />
          )
          : (
            <PaneCanvas
              node={paneTree}
              activePaneId={panels.activePaneId}
              mobile={singlePane}
              actions={actions}
              SessionProvider={SessionProvider}
              canSelectSession={canSelectSession}
              renderSlot={renderSlot}
              selectSession={selectPaneSession}
              stageSession={stageSession}
              titleOf={titleOf}
              t={t}
            />
          )}</CenterColumn>
        <DetailsColumn>{renderSlot('details', {})}</DetailsColumn>
      </>
      <div className={css.overlayLayer} data-shell-overlay>
        {renderSlot('shell.overlay', {})}
      </div>
      {/* The collapsed rail is fixed-width: no resize handle while closed. */}
      {!singlePane && !sidebarCollapsed && <DragHandle side="sidebar" left={cols.sidebar} onStart={onSidebarStart} onDrag={onSidebarDrag} onEnd={onDragEnd} />}
      {!singlePane && cols.details > 0 && <DragHandle side="details" left={viewport - cols.details} onStart={onDetailsStart} onDrag={onDetailsDrag} onEnd={onDragEnd} />}
    </div>
  )
}
