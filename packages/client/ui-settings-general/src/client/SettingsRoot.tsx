/**
 * Settings shell root: the sidebar-foot trigger row plus the modal panel
 * (figma 501:29947, 1080x700) with the section nav rail. Phone widths use
 * History-backed list and content levels; wider widths show both. The shell is
 * a pure composition face — every piece of text (trigger label, panel title,
 * close label, sections) arrives from registrants through slots; accessible
 * names resolve to that content (trigger: its own text; dialog:
 * aria-labelledby the title node; close: visually-hidden slot text). Modal
 * open state and the active section id are component-local viewing state;
 * the onboarding coordinator mounts exactly one ordered registrant while the
 * sessions-derived empty-Hero fact is active. Visible dialog chrome belongs
 * to the step, so a mounted-but-deciding step paints nothing here.
 */
import { useCallback, useEffect, useId, useLayoutEffect, useRef, useState } from 'react'
import clsx from 'clsx'
import {
  ConnectionIndicator,
  IconAgentPresetOutline16, IconCloseOutline16, IconDataOutline16,
  IconPersonalizationOutline16, IconSettingsOutline16,
} from '@deepseek-ai/dsh-client-ui-primitives'
import type { ConnectionIndicatorState } from '@deepseek-ai/dsh-client-ui-primitives'
import type { SettingsRootComponentProps, SettingsSectionRow } from './shell-contract.ts'
import css from './SettingsRoot.module.css'

const RECOVERY_CONFIRMATION_MS = 2_000

/** Nav glyph by section id; unknown ids fall back to the settings gear. */
function navIcon(id: string) {
  if (id === 'models') return <IconDataOutline16 className={css.navIcon} size={16} />
  if (id === 'agent-presets') return <IconAgentPresetOutline16 className={css.navIcon} size={16} />
  if (id === 'plugins') return <IconPersonalizationOutline16 className={css.navIcon} size={16} />
  return <IconSettingsOutline16 className={css.navIcon} size={16} />
}

type PanelProps = {
  rows: readonly SettingsSectionRow[]
  renderSlot: SettingsRootComponentProps['renderSlot']
  activeId: string | undefined
  onSelect: (id: string) => void
  onClose: () => void
}

const PHONE_MEDIA_QUERY = '(max-width: 639px)'
const SETTINGS_HISTORY_KEY = '__dshSettingsView'

type MobileSettingsView = 'sections' | 'content'

function readSettingsHistoryView(state: unknown): MobileSettingsView | undefined {
  if (typeof state !== 'object' || state === null) return undefined
  const value = (state as Record<string, unknown>)[SETTINGS_HISTORY_KEY]
  return value === 'sections' || value === 'content' ? value : undefined
}

function settingsHistoryState(view: MobileSettingsView): Record<string, unknown> {
  const current = window.history.state as unknown
  const base = typeof current === 'object' && current !== null
    ? current as Record<string, unknown>
    : {}
  return { ...base, [SETTINGS_HISTORY_KEY]: view }
}

function usePhoneLayout(): boolean {
  // Non-browser component tests do not provide the browser media-query API.
  const [phone, setPhone] = useState(() => (
    typeof matchMedia === 'undefined' ? false : matchMedia(PHONE_MEDIA_QUERY).matches
  ))

  useEffect(() => {
    if (typeof matchMedia === 'undefined') return
    const media = matchMedia(PHONE_MEDIA_QUERY)
    const update = () => { setPhone(media.matches) }
    media.addEventListener('change', update)
    update()
    return () => { media.removeEventListener('change', update) }
  }, [])

  return phone
}

/**
 * The modal layer: full-viewport mask plus responsive panel. Close paths are
 * the header button, a mask click, and document-level Escape. The listener
 * lifetime matches the open panel.
 */
function SettingsPanel({ rows, renderSlot, activeId, onSelect, onClose }: PanelProps) {
  // Entries can unmount underneath the requested id, so the render-time
  // projection falls back to the first row when the id is gone.
  const active = rows.find(r => r.id === activeId)?.id ?? rows[0]?.id
  const titleId = useId()
  const phone = usePhoneLayout()
  const [mobileView, setMobileView] = useState<MobileSettingsView>(
    activeId === undefined ? 'sections' : 'content',
  )
  const historyInitialized = useRef(false)

  useEffect(() => {
    if (!phone) {
      historyInitialized.current = false
      return
    }
    if (historyInitialized.current) return
    historyInitialized.current = true
    window.history.pushState(settingsHistoryState('sections'), document.title)
    if (mobileView === 'content') {
      window.history.pushState(settingsHistoryState('content'), document.title)
    }
  }, [mobileView, phone])

  useEffect(() => {
    if (!phone) return
    const onPopState = (event: PopStateEvent): void => {
      const view = readSettingsHistoryView(event.state)
      if (view === undefined) onClose()
      else setMobileView(view)
    }
    window.addEventListener('popstate', onPopState)
    return () => { window.removeEventListener('popstate', onPopState) }
  }, [onClose, phone])

  const selectSection = useCallback((id: string) => {
    onSelect(id)
    if (!phone) return
    setMobileView('content')
    window.history.pushState(settingsHistoryState('content'), document.title)
  }, [onSelect, phone])

  const closePanel = useCallback(() => {
    if (phone) window.history.go(mobileView === 'content' ? -2 : -1)
    onClose()
  }, [mobileView, onClose, phone])

  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') closePanel()
    }
    document.addEventListener('keydown', onKeyDown)
    return () => { document.removeEventListener('keydown', onKeyDown) }
  }, [closePanel])

  // Focus follows the visible close control when phone History changes panes.
  const closeButton = useRef<HTMLButtonElement | null>(null)
  useEffect(() => { closeButton.current?.focus() }, [mobileView])

  return (
    <div className={css.overlay} role="presentation">
      <div className={css.mask} aria-hidden="true" onClick={closePanel} />
      <div
        className={css.panel}
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        data-mobile-view={phone ? mobileView : undefined}
      >
        <nav
          className={css.nav}
          aria-hidden={phone && mobileView !== 'sections' ? true : undefined}
        >
          <div className={css.navHeader}>
            <div className={css.navTitle} id={titleId}>{renderSlot('settings.header', {})}</div>
            {phone && (
              <button
                ref={mobileView === 'sections' ? closeButton : undefined}
                type="button"
                className={css.close}
                onClick={closePanel}
              >
                <IconCloseOutline16 size={14} />
                <span className={css.hiddenLabel}>{renderSlot('settings.close', {})}</span>
              </button>
            )}
          </div>
          <div className={css.navList}>
            {rows.map(row => (
              <button
                key={row.id}
                type="button"
                className={clsx(css.navCell, row.id === active && css.active)}
                aria-current={row.id === active ? 'true' : undefined}
                onClick={() => { selectSection(row.id) }}
              >
                {navIcon(row.id)}
                <span className={css.navLabel}>{row.label}</span>
              </button>
            ))}
          </div>
        </nav>
        <div
          className={css.content}
          aria-hidden={phone && mobileView !== 'content' ? true : undefined}
        >
          <div className={css.header}>
            <div className={css.actions}>{renderSlot('settings.action', {})}</div>
            <button
              ref={!phone || mobileView === 'content' ? closeButton : undefined}
              type="button"
              className={css.close}
              onClick={closePanel}
            >
              <IconCloseOutline16 size={14} />
              <span className={css.hiddenLabel}>{renderSlot('settings.close', {})}</span>
            </button>
          </div>
          <div className={css.options}>
            {active !== undefined && renderSlot('settings.section', { close: onClose }, { only: active })}
          </div>
        </div>
      </div>
    </div>
  )
}

/**
 * Render the settings trigger and panel.
 * @param props - composed slot props (contract/slots.ts).
 * @returns the settings shell element tree.
 */
export function SettingsRoot(props: SettingsRootComponentProps) {
  const {
    wide, reconnect, useConnectionState, useSections, useOnboardingSteps, useSessions, renderSlot, t,
  } = props
  const [open, setOpen] = useState(false)
  const [activeId, setActiveId] = useState<string | undefined>(undefined)
  const [completedOnboarding, setCompletedOnboarding] = useState<ReadonlySet<string>>(() => new Set())
  const [showRecovery, setShowRecovery] = useState(false)
  const triggerButton = useRef<HTMLButtonElement | null>(null)
  const wasOpen = useRef(open)
  const close = useCallback(() => {
    setOpen(false)
    setActiveId(undefined)
  }, [])
  // Restore after the close commit, when the dialog can no longer own focus.
  useEffect(() => {
    if (wasOpen.current && !open) triggerButton.current?.focus()
    wasOpen.current = open
  }, [open])
  const openSection = useCallback((id: string) => {
    setActiveId(id)
    setOpen(true)
  }, [])

  // The ledger tick keeps the nav rows fresh: registrants re-register with
  // freshly localized text on locale change, and the trigger/header/close
  // seats re-render through their own outlets' subscriptions.
  const rows = useSections(s => s)
  const connectionState = useConnectionState(state => state)
  const previousConnectionState = useRef(connectionState)
  const onboardingSteps = useOnboardingSteps(s => s)
  const onboardingActive = useSessions(state =>
    state.phase === 'ready'
    && (state.current === undefined || state.byId[state.current]?.blank === true))
  const onboardingStep = onboardingActive
    ? onboardingSteps.find(step => !completedOnboarding.has(step.id))
    : undefined

  useEffect(() => {
    if (onboardingActive) return
    setCompletedOnboarding(new Set())
  }, [onboardingActive])

  useLayoutEffect(() => {
    const previous = previousConnectionState.current
    previousConnectionState.current = connectionState
    if (connectionState !== 'connected') {
      setShowRecovery(false)
      return
    }
    if (previous !== 'disconnected' && previous !== 'connecting') return
    setShowRecovery(true)
    const timeout = window.setTimeout(() => { setShowRecovery(false) }, RECOVERY_CONFIRMATION_MS)
    return () => { window.clearTimeout(timeout) }
  }, [connectionState])

  const completeOnboardingStep = useCallback((id: string) => {
    setCompletedOnboarding((previous) => {
      if (previous.has(id)) return previous
      return new Set([...previous, id])
    })
  }, [])

  let connectionIndicator: ConnectionIndicatorState | undefined
  if (connectionState === 'disconnected') {
    connectionIndicator = 'disconnected'
  } else if (connectionState === 'connecting') {
    connectionIndicator = 'connecting'
  } else if (showRecovery) {
    connectionIndicator = 'recovered'
  }

  return (
    <>
      <div className={clsx(css.triggerRow, !wide && css.railRow)}>
        <button
          ref={triggerButton}
          type="button"
          className={clsx(css.trigger, !wide && css.rail)}
          aria-haspopup="dialog"
          aria-expanded={open}
          onClick={() => { setOpen(true) }}
        >
          {renderSlot('settings.trigger', { wide })}
        </button>
        <ConnectionIndicator
          state={wide ? connectionIndicator : undefined}
          disconnectedLabel={t('connection.error')}
          reconnectLabel={t('connection.retry')}
          connectingLabel={t('connection.connecting')}
          recoveredLabel={t('connection.connected')}
          reconnectActionLabel={t('connection.reconnect')}
          restartActionLabel={t('connection.restart')}
          onReconnect={reconnect}
        />
      </div>
      {open && (
        <SettingsPanel
          rows={rows}
          renderSlot={renderSlot}
          activeId={activeId}
          onSelect={setActiveId}
          onClose={close}
        />
      )}
      {/* Dialog chrome and `#root` inert ownership live inside each step's
          visible branch. A step still deciding (private facts loading)
          renders null, so nothing paints or blocks while it decides. */}
      {onboardingStep !== undefined && renderSlot('settings.onboarding', {
        stepId: onboardingStep.id,
        complete: () => { completeOnboardingStep(onboardingStep.id) },
        openSection,
      }, { only: onboardingStep.id })}
    </>
  )
}
