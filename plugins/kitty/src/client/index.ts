/** Register the existing-terminal native pane in DSH's sidebar. */
import type { Context } from '@deepseek-ai/cordis';
import type {} from '@deepseek-ai/dsh-client-locale/client';
import type {} from '@deepseek-ai/dsh-client-ui-sidebar/client';
import type {} from '@deepseek-ai/dsh-client-ui-renderer/client';
import type {} from '@deepseek-ai/dsh-client-ui-layout/client';
import { KittyAction, KittyPane } from './panel.tsx';
import { KittyBrowser } from './sidebar.tsx';
import { KittyHeader } from './header.tsx';
import { KittyPreview } from './preview.tsx';
import { KittyCatalog, type Pane } from './catalog.ts';
import { createKittyStore, type KittyActions } from './stores.ts';
import { en, zh } from './locales.ts';
declare module '@deepseek-ai/dsh-client-ui-slots' {
  interface LocaleNamespaceMap { 'dsh.kitty': keyof typeof en }
}
/** Services used to register localized Kitty navigation and content. */
export const inject = ['slots', 'locale', 'layout'];
/**
 * Install Kitty navigation with one shared catalog and a selection per canvas pane.
 * @param ctx - Client plugin context.
 */
export function apply(ctx: Context): void {
  const store = createKittyStore();
  const catalog = new KittyCatalog();
  const catalogProps = { hooks: { catalog: catalog.source }, load: () => catalog.load(), refresh: () => catalog.refresh() };
  ctx.effect(() => ctx.locale.register('dsh.kitty', { en, zh }), 'kitty: dictionaries');
  ctx.effect(() => () => catalog.dispose(), 'kitty: catalog requests');
  void catalog.load();
  ctx.slots.inject('shell.overlay', () => ctx.slots.register({
    name: 'shell.overlay', id: 'kitty-browser', locale: 'dsh.kitty', store,
  }, KittyPreview));
  ctx.slots.inject('sidebar.primary.action', () => ctx.slots.register({
    name: 'sidebar.primary.action', id: 'kitty-terminal', order: 10, locale: 'dsh.kitty', store,
    inject: (actions: KittyActions) => ({ open: (paneId: string | null) => {
      actions.select(paneId, null);
      ctx.layout.openActor({ kind: 'panel', id: 'Kitty' });
      ctx.layout.closeDetails();
      ctx.layout.openSidebarPage('kitty');
    } }),
  }, KittyAction));
  ctx.slots.inject('sidebar.page', () => ctx.slots.register({
    name: 'sidebar.page', key: 'kitty', locale: 'dsh.kitty', store,
    inject: (actions: KittyActions) => ({ ...catalogProps, backHome: () => ctx.layout.closeSidebarPage(), open: (paneId: string | null, target: Pane) => {
      actions.select(paneId, target);
      ctx.layout.openActor({ kind: 'panel', id: 'Kitty' });
      ctx.layout.closeDetails();
      ctx.layout.showConversation();
    } }),
  }, KittyBrowser));
  ctx.slots.inject('workspace.panel', () => ctx.slots.register({
    name: 'workspace.panel', locale: 'dsh.kitty', store,
    inject: () => ({ ...catalogProps, attachmentT: ctx.locale.bind('conversation'), browse: () => ctx.layout.openSidebarPage('kitty') }),
  }, KittyPane));
  ctx.slots.inject('workspace.panel.header', () => ctx.slots.register({
    name: 'workspace.panel.header', key: 'Kitty', locale: 'dsh.kitty', store,
    inject: () => ({ ...catalogProps, browse: () => ctx.layout.openSidebarPage('kitty') }),
  }, KittyHeader));
}
