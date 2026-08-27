// @vitest-environment jsdom
// Assembled Human Terminal snapshot: boots the shipped browser plugin graph
// from built bundles, creates a Console through the fixture Remote transport,
// and pins the navigation row, pane identity, attachment phase, cwd, and
// terminal screen. The provider's real tmux lifecycle is covered separately;
// this lane proves the complete browser composition without a model or key.
import { mkdirSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fireEvent, screen, waitFor, within } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import { hasClass, installAssembledBootEnv, mountAssembledApp, REFRESHING_GOLDEN } from './assembled-boot.ts'

const EXPECTED = join(process.cwd(), 'apps/web/tests/snapshots/human-terminal/created.expected.txt')

installAssembledBootEnv()

function firstText(root: Element, logicalClass: string): string {
  const element = [...root.querySelectorAll('*')].find(candidate => hasClass(candidate, logicalClass))
  return element?.textContent?.trim() ?? '<absent>'
}

/** Normalize stable Human Terminal facts from the assembled application. */
function terminalShape(pane: Element, terminal: Element): string {
  const row = screen.getByRole('treeitem', { name: /Terminal/ })
  return [
    `row=${row.textContent?.trim() ?? ''}`,
    `actor=${pane.getAttribute('data-actor-kind')}`,
    `pane-title=${firstText(pane, 'paneTitle')}`,
    `terminal-title=${firstText(terminal, 'title')}`,
    `cwd=${firstText(terminal, 'path')}`,
    `phase=${terminal.getAttribute('data-terminal-phase')}`,
    `screen=${terminal.querySelector('.xterm-rows')?.textContent?.replaceAll(/\s+/g, ' ').trim() ?? '<absent>'}`,
  ].join('\n') + '\n'
}

describe('assembled Human Terminal', () => {
  it('creates and attaches a Console through the shipped browser composition', async () => {
    mountAssembledApp()
    fireEvent.click(await screen.findByRole('button', { name: 'New terminal' }, { timeout: 10_000 }))

    const terminal = await waitFor(() => {
      const found = document.querySelector('[data-terminal-phase="running"]')
      expect(found).not.toBeNull()
      return found!
    }, { timeout: 10_000 })
    const pane = terminal.closest('[data-actor-pane]')
    if (pane === null) throw new Error('Human Terminal must render inside an Actor pane')
    await waitFor(() => {
      expect(terminal.querySelector('.xterm-rows')?.textContent).toContain('fixture terminal ready')
    }, { timeout: 10_000 })

    const shape = terminalShape(pane, terminal)
    if (REFRESHING_GOLDEN) {
      mkdirSync(dirname(EXPECTED), { recursive: true })
      writeFileSync(EXPECTED, shape)
    }
    await expect(shape).toMatchFileSnapshot(EXPECTED)
  })

  it('removes the navigation row and its pane after explicit termination', async () => {
    vi.spyOn(window, 'confirm').mockReturnValue(true)
    mountAssembledApp()
    fireEvent.click(await screen.findByRole('button', { name: 'New terminal' }, { timeout: 10_000 }))
    const row = await screen.findByRole('treeitem', { name: /Terminal/ }, { timeout: 10_000 })
    await waitFor(() => { expect(document.querySelector('[data-actor-kind="console"]')).not.toBeNull() }, { timeout: 10_000 })
    fireEvent.click(within(row).getByRole('button', { name: 'Terminal actions' }))
    fireEvent.click(await screen.findByRole('menuitem', { name: 'Terminate', hidden: true }))
    await waitFor(() => {
      expect(screen.queryByRole('treeitem', { name: /Terminal/ })).toBeNull()
      expect(document.querySelector('[data-actor-kind="console"]')).toBeNull()
    }, { timeout: 10_000 })
  })

  it('removes the navigation row and pane after terminal Ctrl-D', async () => {
    mountAssembledApp()
    fireEvent.click(await screen.findByRole('button', { name: 'New terminal' }, { timeout: 10_000 }))
    const terminal = await waitFor(() => {
      const found = document.querySelector('[data-terminal-phase="running"]')
      expect(found).not.toBeNull()
      return found!
    }, { timeout: 10_000 })
    const helper = terminal.querySelector('textarea.xterm-helper-textarea')
    if (helper === null) throw new Error('xterm helper textarea is missing')
    fireEvent.keyDown(helper, { key: 'd', code: 'KeyD', keyCode: 68, which: 68, ctrlKey: true })
    await waitFor(() => {
      expect(screen.queryByRole('treeitem', { name: /Terminal/ })).toBeNull()
      expect(document.querySelector('[data-actor-kind="console"]')).toBeNull()
    }, { timeout: 10_000 })
  })
})
