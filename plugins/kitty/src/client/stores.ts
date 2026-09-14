/** Window selection and display settings shared by Kitty's browsing and terminal views. */
import { defineStore } from '@deepseek-ai/dsh-client-store';
import type { BoundActions } from '@deepseek-ai/dsh-client-ui-slots';

interface KittyView {
  selected: string;
  previewUrl: string;
  previewRequest: number;
  previewOpen: boolean;
  previewWidth: number;
  previewPinned: boolean;
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
    init: (): KittyView => ({ selected: '', previewUrl: '', previewRequest: 0, previewOpen: false, previewWidth: 640, previewPinned: false, result: null, follow: true, history: false, wideScreen: false }),
    actions: {
      openPreview: (draft, url: string) => { draft.previewUrl = url; draft.previewRequest++; draft.previewOpen = true; },
      showPreview: draft => { draft.previewOpen = true; },
      closePreview: draft => { draft.previewOpen = false; },
      resizePreview: (draft, width: number) => { draft.previewWidth = Math.max(320, width); },
      pinPreview: (draft, pinned: boolean) => { draft.previewPinned = pinned; },
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
