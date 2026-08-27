/** Product actor address rendered inside one workspace pane. */
export type ActorRef =
  | { readonly kind: 'agent'; readonly id: string }
  | { readonly kind: 'console'; readonly id: string }

/** Pane split direction: horizontal places children side by side. */
export type PaneSplitDirection = 'horizontal' | 'vertical'

/** Versioned device-local pane tree node. */
export type PaneNode =
  | { readonly kind: 'leaf'; readonly id: string; readonly actor: ActorRef }
  | {
    readonly kind: 'split'
    readonly id: string
    readonly direction: PaneSplitDirection
    readonly ratio: number
    readonly first: PaneNode
    readonly second: PaneNode
  }

/** Versioned durable subset of the device-local pane layout. */
export interface PersistedPaneLayout {
  readonly paneVersion: 1
  readonly paneRoot: PaneNode | null
  readonly activePaneId: string | null
}

const MAX_PANE_DEPTH = 16
const MAX_PANE_NODES = 63

function paneNodeCount(node: PaneNode): number {
  return node.kind === 'leaf' ? 1 : 1 + paneNodeCount(node.first) + paneNodeCount(node.second)
}

function paneLeafDepth(node: PaneNode, paneId: string, depth = 0): number | undefined {
  if (node.kind === 'leaf') return node.id === paneId ? depth : undefined
  return paneLeafDepth(node.first, paneId, depth + 1) ?? paneLeafDepth(node.second, paneId, depth + 1)
}

function hasNodeId(node: PaneNode, id: string): boolean {
  return node.id === id || (node.kind === 'split' && (hasNodeId(node.first, id) || hasNodeId(node.second, id)))
}

function record(value: unknown, label: string): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new Error(`${label} must be an object`)
  }
  return value as Record<string, unknown>
}

function exactKeys(value: Record<string, unknown>, expected: readonly string[], label: string): void {
  const actual = Object.keys(value).sort()
  const wanted = [...expected].sort()
  if (actual.length !== wanted.length || actual.some((key, index) => key !== wanted[index])) {
    throw new Error(`${label} must contain exactly ${wanted.join(', ')}`)
  }
}

function nonEmptyString(value: unknown, label: string): string {
  if (typeof value !== 'string' || value.length === 0) throw new Error(`${label} must be a non-empty string`)
  return value
}

function decodeActor(value: unknown): ActorRef {
  const actor = record(value, 'pane actor')
  exactKeys(actor, ['id', 'kind'], 'pane actor')
  const id = nonEmptyString(actor['id'], 'pane actor id')
  if (actor['kind'] === 'agent' || actor['kind'] === 'console') return { kind: actor['kind'], id }
  throw new Error('pane actor kind must be agent or console')
}

function decodePaneNode(value: unknown, depth: number, ids: Set<string>, count: { value: number }): PaneNode {
  if (depth > MAX_PANE_DEPTH) throw new Error(`pane tree exceeds depth ${String(MAX_PANE_DEPTH)}`)
  count.value += 1
  if (count.value > MAX_PANE_NODES) throw new Error(`pane tree exceeds ${String(MAX_PANE_NODES)} nodes`)
  const node = record(value, 'pane node')
  const id = nonEmptyString(node['id'], 'pane node id')
  if (ids.has(id)) throw new Error(`duplicate pane node id '${id}'`)
  ids.add(id)
  if (node['kind'] === 'leaf') {
    exactKeys(node, ['actor', 'id', 'kind'], 'pane leaf')
    return { kind: 'leaf', id, actor: decodeActor(node['actor']) }
  }
  if (node['kind'] === 'split') {
    exactKeys(node, ['direction', 'first', 'id', 'kind', 'ratio', 'second'], 'pane split')
    if (node['direction'] !== 'horizontal' && node['direction'] !== 'vertical') {
      throw new Error('pane split direction must be horizontal or vertical')
    }
    if (typeof node['ratio'] !== 'number' || !Number.isFinite(node['ratio'])
      || node['ratio'] < 0.2 || node['ratio'] > 0.8) {
      throw new Error('pane split ratio must be between 0.2 and 0.8')
    }
    return {
      kind: 'split', id, direction: node['direction'], ratio: node['ratio'],
      first: decodePaneNode(node['first'], depth + 1, ids, count),
      second: decodePaneNode(node['second'], depth + 1, ids, count),
    }
  }
  throw new Error('pane node kind must be leaf or split')
}

/**
 * Validate the pane-only value restored from browser storage.
 * @param value - parsed but untrusted durable data.
 * @returns a valid current pane layout.
 */
export function decodePersistedPaneLayout(value: unknown): PersistedPaneLayout {
  const layout = record(value, 'persisted pane layout')
  exactKeys(layout, ['activePaneId', 'paneRoot', 'paneVersion'], 'persisted pane layout')
  if (layout['paneVersion'] !== 1) throw new Error('unsupported pane layout version')
  if (layout['activePaneId'] !== null && typeof layout['activePaneId'] !== 'string') {
    throw new Error('active pane id must be a string or null')
  }
  const paneRoot = layout['paneRoot'] === null
    ? null
    : decodePaneNode(layout['paneRoot'], 0, new Set(), { value: 0 })
  const activePaneId = layout['activePaneId']
  if (paneRoot === null && activePaneId !== null) throw new Error('empty pane layout cannot have an active pane')
  if (paneRoot !== null && (activePaneId === null || !hasPaneId(paneRoot, activePaneId))) {
    throw new Error('active pane id must identify a pane leaf')
  }
  return { paneVersion: 1, paneRoot, activePaneId }
}

function assertNever(value: never): never {
  throw new Error(`unknown pane node: ${JSON.stringify(value)}`)
}

/**
 * Find the first leaf identity in display order.
 * @param node - possible pane tree.
 * @returns the first leaf id, or undefined for an empty tree.
 */
export function firstPaneId(node: PaneNode | null): string | undefined {
  if (node === null) return undefined
  switch (node.kind) {
    case 'leaf': return node.id
    case 'split': return firstPaneId(node.first)
    default: return assertNever(node)
  }
}

/**
 * Test whether a pane tree contains one leaf identity.
 * @param node - possible pane tree.
 * @param paneId - candidate leaf id.
 * @returns whether the leaf exists.
 */
export function hasPaneId(node: PaneNode | null, paneId: string): boolean {
  if (node === null) return false
  switch (node.kind) {
    case 'leaf': return node.id === paneId
    case 'split': return hasPaneId(node.first, paneId) || hasPaneId(node.second, paneId)
    default: return assertNever(node)
  }
}

/**
 * Resolve one leaf by identity.
 * @param node - possible pane tree.
 * @param paneId - addressed leaf id.
 * @returns the leaf, or undefined when absent.
 */
export function findPane(node: PaneNode | null, paneId: string): Extract<PaneNode, { kind: 'leaf' }> | undefined {
  if (node === null) return undefined
  switch (node.kind) {
    case 'leaf': return node.id === paneId ? node : undefined
    case 'split': return findPane(node.first, paneId) ?? findPane(node.second, paneId)
    default: return assertNever(node)
  }
}

/**
 * Replace one leaf's actor without changing tree geometry.
 * @param node - pane tree.
 * @param paneId - addressed leaf.
 * @param actor - replacement actor.
 * @returns the updated tree.
 */
export function replacePaneActor(node: PaneNode, paneId: string, actor: ActorRef): PaneNode {
  switch (node.kind) {
    case 'leaf': return node.id === paneId ? { ...node, actor } : node
    case 'split': return {
      ...node,
      first: replacePaneActor(node.first, paneId, actor),
      second: replacePaneActor(node.second, paneId, actor),
    }
    default: return assertNever(node)
  }
}

/**
 * Split one leaf, retaining it as the first child and placing the new actor second.
 * @param node - pane tree.
 * @param paneId - addressed leaf.
 * @param direction - split orientation.
 * @param splitId - new split identity.
 * @param newPaneId - new leaf identity.
 * @param actor - actor for the new leaf.
 * A split that would exceed the durable decoder's depth or node limit, or
 * introduce a duplicate node identity, leaves the tree unchanged.
 * @returns the updated tree, or the original tree when the request is unavailable.
 */
export function splitPane(
  node: PaneNode,
  paneId: string,
  direction: PaneSplitDirection,
  splitId: string,
  newPaneId: string,
  actor: ActorRef,
): PaneNode {
  const targetDepth = paneLeafDepth(node, paneId)
  if (targetDepth === undefined
    || targetDepth + 1 > MAX_PANE_DEPTH
    || paneNodeCount(node) + 2 > MAX_PANE_NODES
    || splitId.length === 0
    || newPaneId.length === 0
    || splitId === newPaneId
    || hasNodeId(node, splitId)
    || hasNodeId(node, newPaneId)) return node
  return splitPaneUnchecked(node, paneId, direction, splitId, newPaneId, actor)
}

function splitPaneUnchecked(
  node: PaneNode,
  paneId: string,
  direction: PaneSplitDirection,
  splitId: string,
  newPaneId: string,
  actor: ActorRef,
): PaneNode {
  switch (node.kind) {
    case 'leaf': return node.id === paneId
      ? {
        kind: 'split', id: splitId, direction, ratio: 0.5,
        first: node,
        second: { kind: 'leaf', id: newPaneId, actor },
      }
      : node
    case 'split': return {
      ...node,
      first: splitPaneUnchecked(node.first, paneId, direction, splitId, newPaneId, actor),
      second: splitPaneUnchecked(node.second, paneId, direction, splitId, newPaneId, actor),
    }
    default: return assertNever(node)
  }
}

/**
 * Close one leaf and collapse its parent split onto the surviving sibling.
 * @param node - pane tree.
 * @param paneId - addressed leaf.
 * @returns the remaining tree, or null after closing the final pane.
 */
export function closePane(node: PaneNode, paneId: string): PaneNode | null {
  switch (node.kind) {
    case 'leaf': return node.id === paneId ? null : node
    case 'split': {
      const first = closePane(node.first, paneId)
      const second = closePane(node.second, paneId)
      if (first === null) return second
      if (second === null) return first
      return first === node.first && second === node.second ? node : { ...node, first, second }
    }
    default: return assertNever(node)
  }
}

/**
 * Remove leaves whose actor is absent from one actor kind's current catalog.
 * Leaves of every other actor kind remain available, and empty splits collapse
 * onto their surviving child.
 * @param node - possible pane tree.
 * @param actorKind - actor kind owned by the catalog being reconciled.
 * @param availableIds - complete set of available actor ids for that kind.
 * @returns the reconciled tree, or null when no leaves survive.
 */
export function reconcileActorPanes(
  node: PaneNode | null,
  actorKind: ActorRef['kind'],
  availableIds: ReadonlySet<string>,
): PaneNode | null {
  if (node === null) return null
  switch (node.kind) {
    case 'leaf': return node.actor.kind === actorKind && !availableIds.has(node.actor.id) ? null : node
    case 'split': {
      const first = reconcileActorPanes(node.first, actorKind, availableIds)
      const second = reconcileActorPanes(node.second, actorKind, availableIds)
      if (first === null) return second
      if (second === null) return first
      return first === node.first && second === node.second ? node : { ...node, first, second }
    }
    default: return assertNever(node)
  }
}

/**
 * Set one divider ratio inside the usable 20–80 percent range.
 * @param node - pane tree.
 * @param splitId - addressed split.
 * @param ratio - requested first-child fraction.
 * @returns the updated tree.
 */
export function resizePaneSplit(node: PaneNode, splitId: string, ratio: number): PaneNode {
  switch (node.kind) {
    case 'leaf': return node
    case 'split': return node.id === splitId
      ? { ...node, ratio: Math.min(0.8, Math.max(0.2, ratio)) }
      : {
        ...node,
        first: resizePaneSplit(node.first, splitId, ratio),
        second: resizePaneSplit(node.second, splitId, ratio),
      }
    default: return assertNever(node)
  }
}
