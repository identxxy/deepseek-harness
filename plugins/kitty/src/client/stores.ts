/** Per-pane terminal selections and shared Kitty display preferences and report drawer. */
import { defineStore } from '@deepseek-ai/dsh-client-store';
import type { BoundActions } from '@deepseek-ai/dsh-client-ui-slots';
import type { en } from './locales.ts';

interface KittyInput {
  text: string;
  attachment: { name: string; mime: string; file: File } | null;
  busy: boolean;
  notice: keyof typeof en | null;
}

function emptyInput(): KittyInput {
  return { text: '', attachment: null, busy: false, notice: null };
}

interface KittyTerminalView {
  selected: string;
  result: { kind: 'created'; id: number } | { kind: 'stale' } | null;
  follow: boolean;
  appendNewline: boolean;
  inputVersion: number;
  input: KittyInput;
}

interface KittyView {
  panes: Record<string, KittyTerminalView>;
  lastSelected: string;
  previewUrl: string;
  previewRequest: number;
  previewOpen: boolean;
  previewWidth: number;
  previewPinned: boolean;
  history: boolean;
  wideScreen: boolean;
}

/**
 * Create transient selection state; Kitty tokens are never persisted.
 * @returns the shared root-slot store declaration.
 */
export function createKittyStore() {
  return defineStore({
    init: (): KittyView => ({ panes: {}, lastSelected: '', previewUrl: '', previewRequest: 0, previewOpen: false, previewWidth: 640, previewPinned: false, history: false, wideScreen: false }),
    actions: {
      mountPane: (draft, paneId: string, active: boolean) => {
        draft.panes[paneId] ??= { selected: draft.lastSelected, result: null, follow: true, appendNewline: true, inputVersion: 0, input: emptyInput() };
        if (active) draft.lastSelected = draft.panes[paneId].selected;
      },
      openPreview: (draft, url: string) => { draft.previewUrl = url; draft.previewRequest++; draft.previewOpen = true; },
      showPreview: draft => { draft.previewOpen = true; },
      closePreview: draft => { draft.previewOpen = false; },
      resizePreview: (draft, width: number) => { draft.previewWidth = Math.max(320, width); },
      pinPreview: (draft, pinned: boolean) => { draft.previewPinned = pinned; },
      select: (draft, paneId: string | null, token: string) => {
        draft.lastSelected = token;
        if (paneId !== null) {
          const previous = draft.panes[paneId];
          draft.panes[paneId] = {
            selected: token, result: null, follow: previous?.follow ?? true, appendNewline: previous?.appendNewline ?? true,
            inputVersion: previous?.selected === token ? previous.inputVersion : (previous?.inputVersion ?? 0) + 1,
            input: previous?.selected === token ? previous.input : emptyInput(),
          };
        }
      },
      stale: (draft, paneId: string, version: number) => {
        const pane = draft.panes[paneId];
        if (pane?.inputVersion !== version) return;
        pane.selected = ''; pane.result = { kind: 'stale' }; pane.inputVersion++; pane.input = emptyInput();
      },
      created: (draft, paneId: string, id: number) => { const pane = draft.panes[paneId]; pane.selected = ''; pane.result = { kind: 'created', id }; pane.inputVersion++; pane.input = emptyInput(); },
      updateInput: (draft, paneId: string, version: number, input: Partial<KittyInput>) => {
        const pane = draft.panes[paneId];
        // Late receipts belong to the selection that dispatched them, even after A → B → A.
        if (pane?.inputVersion === version) Object.assign(pane.input, input);
      },
      attachImage: (draft, paneId: string, file: File, maxBytes: number) => {
        const pane = draft.panes[paneId];
        if (!pane.selected || pane.input.busy) return;
        if (file.size > maxBytes) { pane.input.notice = 'tooLarge'; return; }
        const types: Record<string, string> = { png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', webp: 'image/webp', gif: 'image/gif', heic: 'image/heic', heif: 'image/heif' };
        const mime = file.type || types[file.name.split('.').pop()?.toLowerCase() ?? ''];
        if (!Object.values(types).includes(mime)) { pane.input.notice = 'invalidImage'; return; }
        pane.input.attachment = { name: file.name, mime, file };
        pane.input.notice = null;
      },
      setFollow: (draft, paneId: string, follow: boolean) => { draft.panes[paneId].follow = follow; },
      setAppendNewline: (draft, paneId: string, enabled: boolean) => { draft.panes[paneId].appendNewline = enabled; },
      setHistory: (draft, history: boolean) => { draft.history = history; },
      setWideScreen: (draft, wideScreen: boolean) => { draft.wideScreen = wideScreen; },
    },
  });
}

/** Renderer-bound mutations shared by the Kitty navigation entries. */
export type KittyActions = BoundActions<ReturnType<typeof createKittyStore>>;
