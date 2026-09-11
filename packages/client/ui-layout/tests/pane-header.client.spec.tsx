// @vitest-environment jsdom
/** Plugin pane headers render through the production slot registry and AppFrame. */
import { afterEach, describe, expect, it, vi } from 'vitest'
import { act, cleanup, fireEvent, within } from '@testing-library/react'
import { SlotTestRuntime, stubSettingsScope } from '@deepseek-ai/dsh-client-test-runtime'
import { LocaleRuntime } from '@deepseek-ai/dsh-client-locale/client'
import { apply as themeApply, inject as themeInject } from '@deepseek-ai/dsh-client-ui-theme/client'
import { apply, inject, type PluginPaneOwnerProps } from '../src/client/index.ts'

class ResizeObserverStub {
  observe(): void {}
  unobserve(): void {}
  disconnect(): void {}
}

afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
})

async function bench() {
  vi.stubGlobal('ResizeObserver', ResizeObserverStub)
  vi.stubGlobal('innerWidth', 1280)
  const runtime = await SlotTestRuntime.create()
  const locale = new LocaleRuntime(runtime.ctx)
  locale.setLocale('en')
  runtime.ctx.provide('locale', locale)
  runtime.slots.installLocale(locale)
  runtime.ctx.provide('connection', { api: { settings: {} }, isLoopback: false } as never)
  runtime.ctx.provide('remote', { $on: () => () => {} } as never)
  runtime.ctx.provide('settingsScope', { bind: () => stubSettingsScope().scope } as never)
  await runtime.mount({ inject: themeInject, apply: themeApply })
  await runtime.mount({ inject: [...inject], apply })
  return runtime
}

describe('plugin pane headers', () => {
  it('renders the keyed title and back control in native chrome while retaining split and close actions', async () => {
    const runtime = await bench()
    try {
      const back = vi.fn()
      const owners: PluginPaneOwnerProps[] = []
      await runtime.mount({
        inject: ['slots'],
        apply(ctx) {
          ctx.effect(() => ctx.slots.register({ name: 'workspace.panel.header', key: 'plugin' },
            (owner: PluginPaneOwnerProps) => {
              owners.push(owner)
              return <><button type="button" onClick={back}>Back to windows</button><span>Actual terminal title</span></>
            }))
          ctx.effect(() => ctx.slots.register({ name: 'workspace.panel.header', key: 'other' },
            () => <span>Unselected header</span>))
          ctx.effect(() => ctx.slots.register({ name: 'workspace.panel' }, () => <main>Terminal body</main>))
        },
      })
      const view = runtime.renderRoot()
      act(() => { runtime.ctx.layout.openActor({ kind: 'panel', id: 'plugin' }) })
      const pane = view.container.querySelector('[data-actor-kind="panel"]')!
      const header = pane.firstElementChild as HTMLElement
      expect(within(header).getByText('Actual terminal title')).toBeTruthy()
      expect(within(header).queryByText('Unselected header')).toBeNull()
      expect(within(header).queryByText('Panel')).toBeNull()
      expect(within(header).queryByText('Terminal body')).toBeNull()
      fireEvent.click(within(header).getByRole('button', { name: 'Back to windows' }))
      expect(back).toHaveBeenCalledOnce()
      expect(owners.at(-1)).toMatchObject({ actor: { kind: 'panel', id: 'plugin' }, active: true, mobile: false })
      expect(owners.at(-1)?.paneId).toBe(pane.getAttribute('data-actor-pane'))
      fireEvent.click(within(header).getByRole('button', { name: 'Split right' }))
      expect(view.container.querySelectorAll('[data-actor-kind="panel"]')).toHaveLength(2)
      fireEvent.click(view.getAllByRole('button', { name: 'Close pane' })[0]!)
      expect(view.container.querySelectorAll('[data-actor-kind="panel"]')).toHaveLength(1)
    } finally {
      await runtime.dispose()
    }
  })

  it('retains the generic Panel label and actor id when no plugin header is registered', async () => {
    const runtime = await bench()
    try {
      const view = runtime.renderRoot()
      act(() => { runtime.ctx.layout.openActor({ kind: 'panel', id: 'unregistered' }) })
      const pane = view.container.querySelector('[data-actor-kind="panel"]')!
      const header = pane.firstElementChild as HTMLElement
      expect(within(header).getByText('Panel')).toBeTruthy()
      expect(within(header).getByText('unregistered')).toBeTruthy()
      expect(within(header).getByRole('button', { name: 'Close pane' })).toBeTruthy()
    } finally {
      await runtime.dispose()
    }
  })
})
