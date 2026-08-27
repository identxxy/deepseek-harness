/** Sidebar creation control and Workspace-browser rows for Human Terminals. */

import { useState } from 'react'
import type { KeyboardEvent } from 'react'
import type { ConsoleRemoteSnapshot } from '@deepseek-ai/dsh-api-remotes/client'
import type { WorkspaceId } from '@deepseek-ai/dsh-client-runtime/client'
import type { HostObservable, InjectFace, PropsLocale, PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import type { SidebarPrimaryActionOwnerProps } from '@deepseek-ai/dsh-client-ui-sidebar/client'
import type { WorkspaceActorRowsOwnerProps } from '@deepseek-ai/dsh-client-ui-workspace/client'
import {
  IconArchiveOutline20, IconBranchOutline16, IconCodeOutline16, IconEditOutline16,
  IconEllipsisOutline16, IconTrashOutline16, Menu, Tooltip,
} from '@deepseek-ai/dsh-client-ui-primitives'
import type { ConsoleCatalogState } from './controller.ts'
import type { ConsoleLocaleKey } from './locales.ts'
import css from './Navigation.module.css'

/** Browser actions supplied to Console navigation surfaces. */
export interface ConsoleNavigationInjected {
  hooks: {
    /** Observable durable Console catalog. */
    consoleCatalog: HostObservable<ConsoleCatalogState>
  }
  /** Create a Console in one Workspace and focus it. */
  createAndOpen: (workspaceId: WorkspaceId) => Promise<void>
  /** Replace the active pane with one Console. */
  open: (consoleId: string) => void
  /** Open one Console beside the active pane. */
  split: (consoleId: string, direction: 'right' | 'down') => void
  /** Rename a Console workload. */
  rename: (consoleId: string, title: string) => Promise<void>
  /** Archive or restore a Console without stopping it. */
  setArchived: (consoleId: string, archived: boolean) => Promise<void>
  /** Terminate a Console after presentation confirms the destructive action. */
  terminate: (consoleId: string) => Promise<void>
}

/** Composed New Terminal action props. */
export type NewTerminalActionProps =
  & SidebarPrimaryActionOwnerProps
  & PropsRuntime<'sidebar.primary.action'>
  & InjectFace<ConsoleNavigationInjected>
  & PropsLocale<'console'>

/** Composed Console catalog-row props. */
export type ConsoleRowsProps =
  & WorkspaceActorRowsOwnerProps
  & PropsRuntime<'sidebar.workspaces.actor'>
  & InjectFace<ConsoleNavigationInjected>
  & PropsLocale<'console'>

function report(action: string, error: unknown): void {
  console.warn(`Console ${action} failed:`, error)
}

/** Render the New Terminal action directly below New Session. */
export function NewTerminalAction({
  wide, useSessions, useWorkspaces, createAndOpen, t,
}: NewTerminalActionProps) {
  const currentSessionId = useSessions(state => state.current)
  const targetWorkspaceId = useWorkspaces((state) => {
    const current = currentSessionId === undefined
      ? undefined
      : state.items.find(workspace => workspace.sessionIds.includes(currentSessionId))?.workspaceId
    return current ?? state.recentWorkspaceId ?? state.items[0]?.workspaceId
  })
  const [creating, setCreating] = useState(false)
  const disabled = targetWorkspaceId === undefined || creating

  return (
    <Tooltip label={targetWorkspaceId === undefined ? t('noWorkspace') : t('newTerminal')} disabled={wide}>
      <button
        type="button"
        className={css.newTerminal}
        aria-label={t('newTerminal')}
        disabled={disabled}
        onClick={() => {
          /* v8 ignore next -- reentry fence: the button is disabled for both states, so browser clicks cannot reach this guard. */
          if (targetWorkspaceId === undefined || creating) return
          setCreating(true)
          void createAndOpen(targetWorkspaceId).catch((error: unknown) => {
            report('creation', error)
          }).finally(() => { setCreating(false) })
        }}
      >
        <IconCodeOutline16 size={wide ? 14 : 18} />
        {wide ? <span>{creating ? t('creating') : t('newTerminal')}</span> : null}
      </button>
    </Tooltip>
  )
}

function invokeFromKeyboard(event: KeyboardEvent<HTMLDivElement>, action: () => void): void {
  if (event.key !== 'Enter' && event.key !== ' ') return
  event.preventDefault()
  action()
}

function ConsoleRow({ item, open, split, rename, setArchived, terminate, t }: {
  item: ConsoleRemoteSnapshot
  open: ConsoleNavigationInjected['open']
  split: ConsoleNavigationInjected['split']
  rename: ConsoleNavigationInjected['rename']
  setArchived: ConsoleNavigationInjected['setArchived']
  terminate: ConsoleNavigationInjected['terminate']
  t: (key: ConsoleLocaleKey) => string
}) {
  const [menuOpen, setMenuOpen] = useState(false)
  const running = item.status.kind === 'running'
  const activate = (): void => {
    if (running && !item.archived) open(item.id)
  }
  const items = item.archived
    ? [
      { id: 'restore', label: t('restore') },
      { type: 'separator' as const, id: 'danger-separator' },
      { id: 'terminate', label: t('terminate'), icon: <IconTrashOutline16 />, danger: true },
    ]
    : [
      { id: 'rename', label: t('rename'), icon: <IconEditOutline16 /> },
      { id: 'split-right', label: t('splitRight'), icon: <IconBranchOutline16 />, disabled: !running },
      { id: 'split-down', label: t('splitDown'), icon: <IconBranchOutline16 />, disabled: !running },
      { id: 'archive', label: t('archive'), icon: <IconArchiveOutline20 size={16} /> },
      { type: 'separator' as const, id: 'danger-separator' },
      { id: 'terminate', label: t('terminate'), icon: <IconTrashOutline16 />, danger: true },
    ]

  return (
    <div
      className={css.consoleRow}
      role="treeitem"
      aria-disabled={!running || item.archived}
      tabIndex={running && !item.archived ? 0 : -1}
      onClick={activate}
      onKeyDown={(event) => { invokeFromKeyboard(event, activate) }}
    >
      <span className={css.consoleIcon}><IconCodeOutline16 /></span>
      <span className={css.consoleTitle}>{item.title}</span>
      <Menu
        open={menuOpen}
        onClose={() => { setMenuOpen(false) }}
        items={items}
        onSelect={(id) => {
          setMenuOpen(false)
          if (id === 'split-right') split(item.id, 'right')
          if (id === 'split-down') split(item.id, 'down')
          if (id === 'archive' || id === 'restore') {
            void setArchived(item.id, id === 'archive').catch((error: unknown) => { report(id, error) })
          }
          if (id === 'rename') {
            const title = window.prompt(t('renamePrompt'), item.title)?.trim()
            if (title !== undefined && title !== '') {
              void rename(item.id, title).catch((error: unknown) => { report('rename', error) })
            }
          }
          if (id === 'terminate' && window.confirm(t('terminateConfirm'))) {
            void terminate(item.id).catch((error: unknown) => { report('termination', error) })
          }
        }}
        portal
        closeOnPointerLeave
        anchor={(
          <button
            type="button"
            className={css.rowAction}
            aria-label={t('actions')}
            onClick={(event) => {
              event.stopPropagation()
              setMenuOpen(value => !value)
            }}
          >
            <IconEllipsisOutline16 />
          </button>
        )}
      />
    </div>
  )
}

/** Render filtered Human Terminal rows at one Workspace-browser placement. */
export function ConsoleRows(props: ConsoleRowsProps) {
  const { mode, open, split, rename, setArchived, terminate, useConsoleCatalog, t } = props
  const rows = useConsoleCatalog((state: ConsoleCatalogState) => state.items.filter((item) => {
    if (item.status.kind !== 'running') return false
    if (mode === 'archived') return item.archived
    if (item.archived) return false
    if (mode === 'flat') return true
    return item.workspaceId === props.workspaceId
  }))
  if (rows.length === 0) return null

  return (
    <div className={css.consoleRows} data-console-list={mode}>
      {mode === 'archived' ? <div className={css.sectionLabel}>{t('archived')}</div> : null}
      {rows.map(item => (
        <ConsoleRow
          key={item.id}
          item={item}
          open={open}
          split={split}
          rename={rename}
          setArchived={setArchived}
          terminate={terminate}
          t={t}
        />
      ))}
    </div>
  )
}
