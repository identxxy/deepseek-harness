/** Per-pane terminal snapshots with shared draft storage for file drops. */
import { useEffect, useLayoutEffect, useRef } from 'react';
import { Button, Tooltip, IconCodeOutline16 } from '@deepseek-ai/dsh-client-ui-primitives';
import navigation from '@deepseek-ai/dsh-client-ui-console/src/client/Navigation.module.css';
import conversation from '@deepseek-ai/dsh-client-ui-conversation/src/client/skeleton/ConversationRoot.module.css';
import type { InjectFace, PropsLocale, PropsRuntime, PropsStore } from '@deepseek-ai/dsh-client-ui-slots';
import { renderAnsiTerminalText } from './ansi.mjs';
import { useKittyScreen } from './screen.ts';
import type { KittyCatalogInjected } from './sidebar.tsx';
import type { createKittyStore } from './stores.ts';
import './panel.css';

type Locale = PropsLocale<'dsh.kitty'>;
type KittyPaneProps = Locale & PropsRuntime<'workspace.panel'> & PropsStore<ReturnType<typeof createKittyStore>>
  & InjectFace<KittyCatalogInjected & { browse: () => void }>;
export function KittyAction({ t, wide, activePaneId, open }: Locale & PropsRuntime<'sidebar.primary.action'> & InjectFace<{open: (paneId: string | null) => void}>) {
  return <Tooltip label={t('title')} disabled={wide}><button type="button" className={navigation.newTerminal} aria-label={t('title')} onClick={() => open(activePaneId)}><IconCodeOutline16 size={wide ? 14 : 18}/>{wide ? <span>{t('title')}</span> : null}</button></Tooltip>;
}
export function KittyPane(props: KittyPaneProps) {
  const view = props.useStore(s => s.panes[props.paneId]);
  useLayoutEffect(() => {
    if (props.actor.id === 'Kitty') props.actions.mountPane(props.paneId, props.active);
  }, [props.actor.id, props.paneId, props.active, props.actions, view?.selected]);
  return props.actor.id === 'Kitty' && view ? <Panel key={view.selected} {...props}/> : null;
}
function Panel({ t, useStore, actions, useCatalog, refresh, browse, paneId, active }: KittyPaneProps) {
  const { history, wideScreen } = useStore(s => s);
  const { selected, follow, inputVersion } = useStore(s => s.panes[paneId]);
  const { value: settings, loading } = useCatalog(s => s);
  const pane = settings?.panes.find(p => p.token === selected);
  const screenRef = useRef<HTMLPreElement>(null);
  const focused = useRef(active); focused.current = active;
  const alive = useRef(true);
  useEffect(() => { alive.current = true; return () => { alive.current = false; }; }, []);
  function failure(error: unknown) {
    if (!alive.current) return;
    actions.updateInput(paneId, inputVersion, { notice: error instanceof Error && error.message === 'stale_target' ? 'stale' : 'failed' });
    if (error instanceof Error && error.message === 'stale_target') {
      actions.stale(paneId, inputVersion);
      if (focused.current) browse();
      void refresh();
    }
  }
  useEffect(() => {
    if (selected && settings && !loading && !pane) {
      actions.stale(paneId, inputVersion);
      if (active) browse();
    }
  }, [selected, settings, loading, pane, actions, browse, paneId, inputVersion, active]);
  const { screen, scrolling, latest } = useKittyScreen({ target: selected, history, settings, element: screenRef, onFailure: failure, onFollow: follow => actions.setFollow(paneId, follow) });
  useEffect(() => { if (follow && screenRef.current) screenRef.current.scrollTop = screenRef.current.scrollHeight; }, [screen, follow]);
  return <div className={`${conversation.root} dsh-kitty-panel`} onDragOver={e => { if (e.dataTransfer.types.includes('Files')) { e.preventDefault(); e.stopPropagation(); } }} onDrop={e => { if (e.dataTransfer.types.includes('Files')) { e.preventDefault(); e.stopPropagation(); const file = e.dataTransfer.files[0]; if (file && settings) actions.attachImage(paneId, file, settings.maxImageBytes); } }}>
    <main className="dsh-kitty-output">
      {!selected ? <div className="dsh-kitty-empty"><h3>{t('select')}</h3><p>{t('selectHint')}</p><Button onClick={browse}>{t('windows')}</Button></div> : <pre ref={screenRef} aria-busy={scrolling} className={`dsh-kitty-screen ${wideScreen ? 'is-wide' : ''}`} onClick={event => { const link = (event.target as Element).closest<HTMLAnchorElement>('a[data-preview-url]'); if (!link) return; event.preventDefault(); const url = link.dataset.previewUrl; if (url && /^(?:https?:|file:)\/\//i.test(url)) actions.openPreview(url); }} onScroll={e => { const el=e.currentTarget; if (el.scrollHeight-el.scrollTop-el.clientHeight>60) actions.setFollow(paneId, false); }} dangerouslySetInnerHTML={{ __html: renderAnsiTerminalText(screen) }}/>}
      {scrolling && <div className="dsh-kitty-scroll-status" role="status">{t('scrolling')}</div>}
      {selected && !follow && <Button className="dsh-kitty-follow" onClick={latest}>{t('latest')} ↓</Button>}
    </main>
  </div>;
}
