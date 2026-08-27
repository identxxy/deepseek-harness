/**
 * The root entry's transient layout store: panel geometry as plain widths in
 * px (0 = closed) plus responsive navigation state. Module level exports the factory only — a module-level
 * handle would pin the store's identity in the module
 * cache (a de-facto singleton surviving plugin reloads). register() receives
 * the factory (exclusive use: the framework instantiates per entry), AppFrame
 * derives its PropsStore share from the return type, and the service face
 * receives the bound actions through the registration's inject hook.
 */
import { defineStore, type EngineStoreHandle } from '@deepseek-ai/dsh-client-store'
import {
  clampWidth, DETAILS_DEFAULT, DETAILS_MAX, DETAILS_MIN,
  SIDEBAR_DEFAULT, SIDEBAR_MAX, SIDEBAR_MIN,
} from './columns.ts'
import {
  closePane, decodePersistedPaneLayout, firstPaneId, hasPaneId, reconcileActorPanes, replacePaneActor,
  resizePaneSplit, splitPane,
} from './panes.ts'
import type { ActorRef, PaneNode, PaneSplitDirection } from './panes.ts'

/**
 * Layout store state: desktop panel width preferences in px (0 = closed),
 * plus the single-pane flag and its current mobile destination. `auto` lets
 * AppFrame derive the initial destination from browser History and Session
 * selection without persisting either fact in this transient store.
 */
type LayoutState = {
  sidebar: number
  details: number
  singlePane: boolean
  mobileView: 'auto' | 'sessions' | 'conversation'
  paneVersion: 1
  paneRoot: PaneNode | null
  activePaneId: string | null
}

/**
 * Annotation twin of the actions literal below (the export needs a declared
 * return type); drift fails assignability at the defineStore call.
 */
type LayoutActions = {
  setSidebar: (draft: LayoutState, px: number) => void
  setDetails: (draft: LayoutState, px: number) => void
  toggleSidebar: (draft: LayoutState) => void
  setSinglePane: (draft: LayoutState, singlePane: boolean) => void
  showSessionList: (draft: LayoutState) => void
  showConversation: (draft: LayoutState) => void
  openDetails: (draft: LayoutState) => void
  closeDetails: (draft: LayoutState) => void
  openActor: (draft: LayoutState, actor: ActorRef, paneId: string) => void
  splitActor: (draft: LayoutState, actor: ActorRef, direction: PaneSplitDirection, splitId: string, paneId: string) => void
  focusPane: (draft: LayoutState, paneId: string) => void
  closeActorPane: (draft: LayoutState, paneId: string) => void
  reconcileActorCatalog: (draft: LayoutState, actorKind: ActorRef['kind'], availableIds: ReadonlySet<string>) => void
  resizeActorSplit: (draft: LayoutState, splitId: string, ratio: number) => void
}

const PANE_PERSIST_KEY = 'dsh.layout.panes.v1'

/**
 * Create the layout panel store handle. The preference IS the width, so
 * closing a panel forgets its drag width — reopening restores the contract
 * default. Actions are the complete write set: drag writes clamp
 * into the panel's contract range and never cross the open/closed line;
 * open/close transitions write 0 / the default explicitly. In single-pane
 * mode the sidebar toggle moves between the Session list and conversation;
 * desktop width preferences remain untouched.
 * @returns the store handle (spec + type + identity + factory in one).
 */
export function createLayoutStore(): EngineStoreHandle<LayoutState, LayoutActions>  {
  const handle = defineStore({
    init: (): LayoutState => ({
      sidebar: SIDEBAR_DEFAULT,
      details: 0,
      singlePane: false,
      mobileView: 'auto',
      paneVersion: 1,
      paneRoot: null,
      activePaneId: null,
    }),
    persist: {
      name: PANE_PERSIST_KEY,
      select: (state: LayoutState) => ({
        paneVersion: state.paneVersion,
        paneRoot: state.paneRoot,
        activePaneId: state.activePaneId,
      }),
      merge: (initial: LayoutState, persisted: unknown): LayoutState => ({
        ...initial,
        ...decodePersistedPaneLayout(persisted),
      }),
    },
    actions: {
      setSidebar: (d, px: number) => { d.sidebar = clampWidth(px, SIDEBAR_MIN, SIDEBAR_MAX) },
      setDetails: (d, px: number) => { d.details = clampWidth(px, DETAILS_MIN, DETAILS_MAX) },
      toggleSidebar: (d) => {
        if (d.singlePane) d.mobileView = d.mobileView === 'conversation' ? 'sessions' : 'conversation'
        else d.sidebar = d.sidebar === 0 ? SIDEBAR_DEFAULT : 0
      },
      setSinglePane: (d, singlePane: boolean) => {
        if (d.singlePane === singlePane) return
        d.singlePane = singlePane
        d.mobileView = 'auto'
      },
      showSessionList: (d) => { d.mobileView = 'sessions' },
      showConversation: (d) => { d.mobileView = 'conversation' },
      openDetails: (d) => { if (d.details === 0) d.details = DETAILS_DEFAULT },
      closeDetails: (d) => { d.details = 0 },
      openActor: (d, actor: ActorRef, paneId: string) => {
        if (d.paneRoot === null) {
          d.paneRoot = { kind: 'leaf', id: paneId, actor }
          d.activePaneId = paneId
          return
        }
        const target = d.activePaneId !== null && hasPaneId(d.paneRoot, d.activePaneId)
          ? d.activePaneId
          : firstPaneId(d.paneRoot)
        if (target === undefined) return
        d.paneRoot = replacePaneActor(d.paneRoot, target, actor)
        d.activePaneId = target
      },
      splitActor: (d, actor: ActorRef, direction: PaneSplitDirection, splitId: string, paneId: string) => {
        if (d.paneRoot === null) {
          d.paneRoot = { kind: 'leaf', id: paneId, actor }
          d.activePaneId = paneId
          return
        }
        const target = d.activePaneId !== null && hasPaneId(d.paneRoot, d.activePaneId)
          ? d.activePaneId
          : firstPaneId(d.paneRoot)
        if (target === undefined) return
        const splitRoot = splitPane(d.paneRoot, target, direction, splitId, paneId, actor)
        if (splitRoot === d.paneRoot) return
        d.paneRoot = splitRoot
        d.activePaneId = paneId
      },
      focusPane: (d, paneId: string) => {
        if (hasPaneId(d.paneRoot, paneId)) d.activePaneId = paneId
      },
      closeActorPane: (d, paneId: string) => {
        if (d.paneRoot === null) return
        d.paneRoot = closePane(d.paneRoot, paneId)
        if (d.activePaneId === paneId || !hasPaneId(d.paneRoot, d.activePaneId ?? '')) {
          d.activePaneId = firstPaneId(d.paneRoot) ?? null
        }
      },
      reconcileActorCatalog: (d, actorKind: ActorRef['kind'], availableIds: ReadonlySet<string>) => {
        d.paneRoot = reconcileActorPanes(d.paneRoot, actorKind, availableIds)
        if (!hasPaneId(d.paneRoot, d.activePaneId ?? '')) {
          d.activePaneId = firstPaneId(d.paneRoot) ?? null
        }
        if (d.paneRoot === null) d.mobileView = 'sessions'
      },
      resizeActorSplit: (d, splitId: string, ratio: number) => {
        if (d.paneRoot !== null) d.paneRoot = resizePaneSplit(d.paneRoot, splitId, ratio)
      },
    },
  })
  return handle
}
