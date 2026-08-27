import { useEffect } from 'react'
import type { InjectFace, PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import type { HostObservable } from '@deepseek-ai/dsh-client-ui-slots'
import type { ConsoleCatalogState } from './controller.ts'

/** Business dependencies for Console lifecycle reconciliation. */
export interface ConsoleLifecycleInjected {
  hooks: {
    /** Observable durable Console catalog. */
    consoleCatalog: HostObservable<ConsoleCatalogState>
  }
  /** Reconcile all Console panes against a ready, complete catalog. */
  reconcile: (availableIds: ReadonlySet<string>) => void
}

/** Composed root-overlay props for Console lifecycle reconciliation. */
export type ConsoleLifecycleCoordinatorProps =
  & PropsRuntime<'shell.overlay'>
  & InjectFace<ConsoleLifecycleInjected>

/** Reconcile stale Console panes after the root layout has mounted. */
export function ConsoleLifecycleCoordinator({ useConsoleCatalog, reconcile }: ConsoleLifecycleCoordinatorProps) {
  const catalog = useConsoleCatalog((state: ConsoleCatalogState) => state)
  useEffect(() => {
    if (catalog.phase !== 'ready') return
    reconcile(new Set(catalog.items.filter(item => item.status.kind === 'running').map(item => item.id)))
  }, [catalog, reconcile])
  return null
}
