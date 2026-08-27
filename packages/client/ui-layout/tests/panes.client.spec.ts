import { describe, expect, it } from 'vitest'
import {
  closePane, decodePersistedPaneLayout, reconcileActorPanes, replacePaneActor, resizePaneSplit, splitPane,
  type ActorRef, type PaneNode,
} from '@deepseek-ai/dsh-client-ui-layout/src/client/panes.ts'

const agent = (id: string): ActorRef => ({ kind: 'agent', id })
const terminal = (id: string): ActorRef => ({ kind: 'console', id })
const leaf = (id: string, actor: ActorRef): PaneNode => ({ kind: 'leaf', id, actor })

describe('pane tree', () => {
  it('replaces only the addressed leaf actor', () => {
    const root: PaneNode = {
      kind: 'split', id: 'split-1', direction: 'horizontal', ratio: 0.5,
      first: leaf('pane-a', agent('s1')),
      second: leaf('pane-b', terminal('c1')),
    }
    expect(replacePaneActor(root, 'pane-b', agent('s2'))).toEqual({
      ...root,
      second: leaf('pane-b', agent('s2')),
    })
  })

  it('splits the addressed leaf and preserves its existing actor', () => {
    const root = leaf('pane-a', agent('s1'))
    expect(splitPane(root, 'pane-a', 'vertical', 'split-1', 'pane-b', terminal('c1'))).toEqual({
      kind: 'split', id: 'split-1', direction: 'vertical', ratio: 0.5,
      first: root,
      second: leaf('pane-b', terminal('c1')),
    })
  })

  it('refuses a split that would exceed the durable depth limit', () => {
    let root = leaf('pane-0', agent('s0'))
    let deepest = 'pane-0'
    for (let index = 1; index <= 16; index += 1) {
      const next = `pane-${String(index)}`
      root = splitPane(root, deepest, 'horizontal', `split-${String(index)}`, next, agent(`s${String(index)}`))
      deepest = next
    }
    const atLimit = root
    expect(splitPane(root, deepest, 'horizontal', 'split-over', 'pane-over', agent('over'))).toBe(atLimit)
    expect(() => decodePersistedPaneLayout({ paneVersion: 1, paneRoot: root, activePaneId: deepest })).not.toThrow()
  })

  it('refuses a split that would exceed the durable node limit', () => {
    let root = leaf('pane-0', agent('s0'))
    const leaves = ['pane-0']
    for (let index = 1; index <= 31; index += 1) {
      const target = leaves.shift()!
      const next = `pane-${String(index)}`
      root = splitPane(root, target, 'vertical', `split-${String(index)}`, next, agent(`s${String(index)}`))
      leaves.push(target, next)
    }
    const atLimit = root
    expect(splitPane(root, leaves[0]!, 'vertical', 'split-over', 'pane-over', agent('over'))).toBe(atLimit)
    expect(() => decodePersistedPaneLayout({ paneVersion: 1, paneRoot: root, activePaneId: leaves[0]! })).not.toThrow()
  })

  it('collapses a split onto the surviving sibling when a pane closes', () => {
    const surviving = leaf('pane-a', agent('s1'))
    const root: PaneNode = {
      kind: 'split', id: 'split-1', direction: 'horizontal', ratio: 0.5,
      first: surviving,
      second: leaf('pane-b', terminal('c1')),
    }
    expect(closePane(root, 'pane-b')).toEqual(surviving)
    expect(closePane(surviving, 'pane-a')).toBeNull()
  })

  it('removes every unavailable actor occurrence and collapses nested splits', () => {
    const survivingAgent = leaf('pane-agent', agent('s1'))
    const survivingConsole = leaf('pane-console-live', terminal('c-live'))
    const root: PaneNode = {
      kind: 'split', id: 'split-root', direction: 'horizontal', ratio: 0.5,
      first: {
        kind: 'split', id: 'split-left', direction: 'vertical', ratio: 0.4,
        first: leaf('pane-console-stale-a', terminal('c-stale')),
        second: survivingAgent,
      },
      second: {
        kind: 'split', id: 'split-right', direction: 'vertical', ratio: 0.6,
        first: survivingConsole,
        second: leaf('pane-console-stale-b', terminal('c-stale')),
      },
    }

    expect(reconcileActorPanes(root, 'console', new Set(['c-live']))).toEqual({
      ...root,
      first: survivingAgent,
      second: survivingConsole,
    })
  })

  it('clamps divider ratios without changing other splits', () => {
    const root: PaneNode = {
      kind: 'split', id: 'split-1', direction: 'horizontal', ratio: 0.5,
      first: leaf('pane-a', agent('s1')),
      second: leaf('pane-b', terminal('c1')),
    }
    expect(resizePaneSplit(root, 'split-1', 0.95)).toMatchObject({ ratio: 0.8 })
    expect(resizePaneSplit(root, 'split-1', 0.05)).toMatchObject({ ratio: 0.2 })
  })
})
