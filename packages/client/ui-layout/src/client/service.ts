/**
 * LayoutController: the cross-plugin viewing-action face behind ctx.layout.
 * Panel geometry itself lives in the root entry's layout store (stores.ts);
 * the current-session selection lives with the runtime sessions service, and
 * the per-session active view dissolved into ui-conversation's session store
 * (its only consumer). What remains here is the contract other plugins'
 * apply worlds reach for responsive navigation and panel transitions. Writes
 * stay inside the store's declared action set, delivered as the
 * registration's bound actions.
 */
import type { BoundActions } from '@deepseek-ai/dsh-client-ui-slots'
import { randomUUID } from '@deepseek-ai/dsh-util-crypto'
import type { ActorRef, PaneSplitDirection } from './panes.ts'
import type { createLayoutStore } from './stores.ts'

/** The layout store's bound action set (framework-baked, draft params peeled). */
export type LayoutActions = BoundActions<ReturnType<typeof createLayoutStore>>

/**
 * The outward layout face (`ctx.layout`): the viewing transitions other
 * plugins may trigger — and exactly what a test fake must supply. The
 * attachActions wiring hook stays on the concrete class (root-entry assembly only).
 */
export interface ILayout {
  /** Toggle the sidebar panel (closed ⟷ contract default width). */
  toggleSidebar(): void
  /**
   * Show a plugin's keyed sidebar page and expand the sidebar.
   * @param page - key registered in sidebar.page.
   */
  openSidebarPage(page: string): void
  /** Return to the main Session list and clear the contextual sidebar page. */
  closeSidebarPage(): void
  /** Show the Session list in single-pane navigation, retaining its sidebar page. */
  showSessionList(): void
  /** Show the conversation in single-pane navigation, retaining its sidebar page. */
  showConversation(): void
  /** Open the details panel (no-op when already open). */
  openDetails(): void
  /** Close the details panel. */
  closeDetails(): void
  /**
   * Replace the active pane with an addressed product actor.
   * @param actor - Agent Session or Console to display.
   */
  openActor(actor: ActorRef): void
  /**
   * Add an addressed product actor beside the active pane.
   * @param actor - Agent Session or Console to display.
   * @param direction - Axis along which the active pane is split.
   */
  openActorInSplit(actor: ActorRef, direction: PaneSplitDirection): void
  /**
   * Remove pane occurrences absent from one actor kind's ready, complete catalog.
   * The available-id set is consumed synchronously and is not retained.
   * @param actorKind - actor kind owned by the catalog.
   * @param availableIds - every currently available actor id after the catalog owner confirms ready.
   */
  reconcileActorCatalog(actorKind: ActorRef['kind'], availableIds: ReadonlySet<string>): void
}

function layoutId(prefix: 'pane' | 'split'): string {
  return `${prefix}-${randomUUID()}`
}

/** Cross-plugin viewing-action face (ctx.layout). */
export class LayoutController implements ILayout {
  #actions: LayoutActions | undefined

  /**
   * Adopt the root entry's bound store actions. Called from the root
   * registration's inject hook (a sanctioned assembly side effect), so the
   * face is live from the entry's first render; on entry re-register the
   * fresh actions overwrite the stale set.
   * @param actions - bound actions of the entry's layout store instance.
   */
  attachActions(actions: LayoutActions): void {
    this.#actions = actions
  }

  /** Toggle the sidebar panel (closed ⟷ contract default width). */
  toggleSidebar(): void {
    this.#require().toggleSidebar()
  }

  /**
   * Show a plugin's keyed sidebar page and expand the sidebar.
   * @param page - key registered in sidebar.page.
   */
  openSidebarPage(page: string): void {
    this.#require().openSidebarPage(page)
  }

  /** Return to the main Session list and clear the contextual sidebar page. */
  closeSidebarPage(): void {
    this.#require().closeSidebarPage()
  }

  /** Show the Session list in single-pane navigation, retaining its sidebar page. */
  showSessionList(): void {
    this.#require().showSessionList()
  }

  /** Show the conversation in single-pane navigation, retaining its sidebar page. */
  showConversation(): void {
    this.#require().showConversation()
  }

  /** Open the details panel (no-op when already open). */
  openDetails(): void {
    this.#require().openDetails()
  }

  /** Close the details panel. */
  closeDetails(): void {
    this.#require().closeDetails()
  }

  /**
   * Replace the active pane with an addressed product actor.
   * @param actor - Agent Session or Console to display.
   */
  openActor(actor: ActorRef): void {
    this.#require().openActor(actor, layoutId('pane'))
  }

  /**
   * Add an addressed product actor beside the active pane.
   * @param actor - Agent Session or Console to display.
   * @param direction - Axis along which the active pane is split.
   */
  openActorInSplit(actor: ActorRef, direction: PaneSplitDirection): void {
    this.#require().splitActor(actor, direction, layoutId('split'), layoutId('pane'))
  }

  /**
   * Remove pane occurrences absent from one actor kind's ready, complete catalog.
   * @param actorKind - actor kind owned by the catalog.
   * @param availableIds - synchronously consumed and unretained complete set after the catalog owner confirms ready.
   */
  reconcileActorCatalog(actorKind: ActorRef['kind'], availableIds: ReadonlySet<string>): void {
    this.#require().reconcileActorCatalog(actorKind, availableIds)
  }

  #require(): LayoutActions {
    // Callers are UI gestures, which cannot fire before the root entry
    // rendered (the inject hook runs in its first render) — reaching this
    // unwired is a boot-order bug, not a race to tolerate.
    if (this.#actions === undefined) throw new Error('layout: actions not wired (root entry not mounted)')
    return this.#actions
  }
}
