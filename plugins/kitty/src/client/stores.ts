/** Window selection and display settings shared by Kitty's browsing and terminal views. */
import { defineStore } from '@deepseek-ai/dsh-client-store';
import type { BoundActions } from '@deepseek-ai/dsh-client-ui-slots';

interface KittyView {
  selected: string;
  result: { kind: 'created'; id: number } | { kind: 'stale' } | null;
  follow: boolean;
  history: boolean;
  wideScreen: boolean;
}

/**
 * Create transient selection state; Kitty tokens are never persisted.
 * @returns the shared root-slot store declaration.
 */
export function createKittyStore() {
  return defineStore({
    init: (): KittyView => ({ selected: '', result: null, follow: true, history: false, wideScreen: false }),
    actions: {
      select: (draft, token: string) => { draft.selected = token; draft.result = null; },
      stale: draft => { draft.selected = ''; draft.result = { kind: 'stale' }; },
      created: (draft, id: number) => { draft.selected = ''; draft.result = { kind: 'created', id }; },
      setFollow: (draft, follow: boolean) => { draft.follow = follow; },
      setHistory: (draft, history: boolean) => { draft.history = history; },
      setWideScreen: (draft, wideScreen: boolean) => { draft.wideScreen = wideScreen; },
    },
  });
}

/** Renderer-bound mutations shared by the Kitty navigation entries. */
export type KittyActions = BoundActions<ReturnType<typeof createKittyStore>>;
