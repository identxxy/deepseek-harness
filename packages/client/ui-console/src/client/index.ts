/** Human Terminal browser plugin: Console catalog service and xterm pane renderer. */

import type { ClientContext } from '@deepseek-ai/dsh-client-runtime/client'
import type {} from '@deepseek-ai/dsh-api-remotes/client'
import type {} from '@deepseek-ai/dsh-client-locale/client'
import type {} from '@deepseek-ai/dsh-client-ui-layout/client'
import type {} from '@deepseek-ai/dsh-client-ui-sidebar/client'
import type {} from '@deepseek-ai/dsh-client-ui-workspace/client'
import { ConsoleClient } from './controller.ts'
import { ConsoleRows, NewTerminalAction, type ConsoleNavigationInjected } from './Navigation.tsx'
import { TerminalPane } from './TerminalPane.tsx'
import { ConsoleLifecycleCoordinator } from './LifecycleCoordinator.tsx'
import { en, zh, type ConsoleLocaleKey } from './locales.ts'
import { CONSOLE_CONFIG_GLOBAL, type Config } from '../config.ts'

declare module '@deepseek-ai/cordis' {
  interface Context {
    /** Browser Console catalog and attachment service. */
    consoleClient: ConsoleClient
  }
}

declare module '@deepseek-ai/dsh-client-ui-slots' {
  interface LocaleNamespaceMap {
    /** Human Terminal navigation and lifecycle copy. */
    console: ConsoleLocaleKey
  }
}

const NS = 'console'

function browserConfig(): Config {
  const value = (globalThis as Record<string, unknown>)[CONSOLE_CONFIG_GLOBAL]
  if (typeof value !== 'object' || value === null) throw new Error('ui-console browser configuration is missing')
  const interval = (value as Record<string, unknown>)['catalogRefreshIntervalMs']
  if (!Number.isSafeInteger(interval) || (interval as number) < 1) throw new Error('ui-console catalogRefreshIntervalMs must be a positive safe integer')
  return { catalogRefreshIntervalMs: interval as number }
}

/** Required services for Console RPC, pane rendering, and localized navigation. */
export const inject = ['slots', 'remote', 'remote.consoles', 'locale', 'layout']

/**
 * Install the browser Console service and terminal pane contribution.
 * @param ctx - client Cordis root.
 */
export function apply(ctx: ClientContext): void {
  const config = browserConfig()
  const controller = new ConsoleClient(ctx.remote.consoles)
  ctx.effect(() => ctx.locale.register(NS, { zh, en }), 'ui-console: dictionaries')
  ctx.effect(() => {
    const unprovide = ctx.reflect.provide('consoleClient', controller)
    void controller.refresh().catch((error: unknown) => {
      console.warn('Initial Console catalog refresh failed:', error)
    })
    return async () => {
      await controller.dispose()
      await unprovide()
    }
  }, 'ui-console: service')
  ctx.effect(() => {
    const timer = setInterval(() => {
      void controller.refresh().catch((error: unknown) => {
        console.warn('Periodic Console catalog refresh failed:', error)
      })
    }, config.catalogRefreshIntervalMs)
    return () => { clearInterval(timer) }
  }, 'ui-console: catalog refresh')
  ctx.on('connection/reset', () => {
    controller.resetConnection()
    void controller.refresh().catch((error: unknown) => {
      console.warn('Console catalog refresh failed after reconnect:', error)
    })
  })
  const navigation = (): ConsoleNavigationInjected => ({
    hooks: { consoleCatalog: controller },
    createAndOpen: async (workspaceId) => {
      const created = await controller.create({
        workspaceId,
        title: 'Terminal',
        initialSize: { rows: 24, cols: 80 },
      })
      ctx.layout.openActor({ kind: 'console', id: created.id })
      ctx.layout.showConversation()
    },
    open: (consoleId) => {
      ctx.layout.openActor({ kind: 'console', id: consoleId })
      ctx.layout.showConversation()
    },
    split: (consoleId, direction) => {
      ctx.layout.openActorInSplit(
        { kind: 'console', id: consoleId },
        direction === 'right' ? 'horizontal' : 'vertical',
      )
      ctx.layout.showConversation()
    },
    rename: (consoleId, title) => controller.rename(consoleId, title).then(() => {}),
    setArchived: (consoleId, archived) => controller.setArchived(consoleId, archived).then(() => {}),
    terminate: consoleId => controller.terminate(consoleId),
  })
  const reconcile = (availableIds: ReadonlySet<string>): void => {
    ctx.layout.reconcileActorCatalog('console', availableIds)
  }
  ctx.slots.inject('sidebar.primary.action', () => ctx.slots.register({
    name: 'sidebar.primary.action',
    id: 'new-terminal',
    inject: navigation,
    locale: NS,
  }, NewTerminalAction))
  ctx.slots.inject('sidebar.workspaces.actor', () => ctx.slots.register({
    name: 'sidebar.workspaces.actor',
    id: 'console-rows',
    inject: navigation,
    locale: NS,
  }, ConsoleRows))
  ctx.slots.inject('workspace.console', () => ctx.slots.register({
    name: 'workspace.console',
    inject: () => ({ controller, hooks: { consoleCatalog: controller } }),
  }, TerminalPane))
  ctx.slots.inject('shell.overlay', () => ctx.slots.register({
    name: 'shell.overlay',
    id: 'console-lifecycle',
    inject: () => ({
      hooks: { consoleCatalog: controller },
      reconcile,
    }),
  }, ConsoleLifecycleCoordinator))
}
