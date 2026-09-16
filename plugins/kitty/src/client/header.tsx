/** Kitty's selected window title and return action in the native pane bar. */
import { Button, IconChevronLeftOutline14 } from '@deepseek-ai/dsh-client-ui-primitives';
import type { InjectFace, PropsLocale, PropsRuntime, PropsStore } from '@deepseek-ai/dsh-client-ui-slots';
import type { KittyCatalogInjected } from './sidebar.tsx';
import type { createKittyStore } from './stores.ts';
import './panel.css';

type KittyHeaderProps = PropsLocale<'dsh.kitty'> & PropsRuntime<'workspace.panel.header'>
  & PropsStore<ReturnType<typeof createKittyStore>>
  & InjectFace<KittyCatalogInjected & { browse: () => void }>;

/**
 * Render the selected terminal title without a second toolbar in its body.
 * @param props - catalog, selection and return action from the plugin registration.
 * @returns the pane header's return control and current title.
 */
export function KittyHeader({ t, useStore, useCatalog, browse, paneId }: KittyHeaderProps) {
  const selected = useStore(s => s.panes[paneId]?.selected);
  const pane = useCatalog(s => s.value?.panes.find(p => p.token === selected));
  const title = pane ? `#${pane.id} · ${pane.title}` : t('title');
  return <div className="dsh-kitty-pane-header">
    <Button className="dsh-kitty-icon" aria-label={t('backWindows')} title={t('backWindows')} onClick={browse}><IconChevronLeftOutline14/></Button>
    <span className="dsh-kitty-pane-title" title={title}>{title}</span>
  </div>;
}
