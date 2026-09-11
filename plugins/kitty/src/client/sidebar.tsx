/** Kitty window rows occupy the shell's session-browsing region. */
import { useEffect, useRef, useState } from 'react';
import { Button, IconChevronLeftOutline14, IconCodeOutline16, IconSettingsOutline16 } from '@deepseek-ai/dsh-client-ui-primitives';
import type { InjectFace, PropsLocale, PropsRuntime, PropsStore } from '@deepseek-ai/dsh-client-ui-slots';
import { endpoint, request, type KittyCatalog } from './catalog.ts';
import type { createKittyStore } from './stores.ts';
import './panel.css';

/** Private catalog source and shared-read or forced-refresh actions supplied at slot registration. */
export type KittyCatalogInjected = {
  hooks: { catalog: KittyCatalog['source'] };
  load: () => Promise<void>;
  refresh: () => Promise<void>;
};

type KittyBrowserProps = PropsLocale<'dsh.kitty'> & PropsRuntime<'sidebar.page'>
  & PropsStore<ReturnType<typeof createKittyStore>>
  & InjectFace<KittyCatalogInjected & { open: (token: string) => void; backHome: () => void }>;

/**
 * Render touch-sized window rows, keeping the selected window highlighted.
 * @param props - column geometry, catalog hook, selection and navigation actions.
 * @returns the window browser or its collapsed-rail control.
 */
export function KittyBrowser({ t, wide, expandSidebar, useCatalog, useStore, actions, load, refresh, open, backHome }: KittyBrowserProps) {
  const { value, loading, failed } = useCatalog(s => s);
  const { selected, result, follow, history, wideScreen } = useStore(s => s);
  const pane = value?.panes.find(p => p.token === selected);
  const [options, setOptions] = useState(false);
  const [creating, setCreating] = useState(false);
  const [notice, setNotice] = useState('');
  const busy = useRef(false);
  const alive = useRef(true);
  useEffect(() => { alive.current = true; return () => { alive.current = false; }; }, []);
  useEffect(() => { if (wide) void load(); }, [wide, load]);
  async function createWindow() {
    if (!pane || busy.current) return;
    busy.current = true;
    setCreating(true);
    setNotice('');
    try {
      const created = await request<{ id: number }>(endpoint, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ token: pane.token, action: 'create' }) });
      if (alive.current) {
        actions.created(created.id);
        void refresh();
      }
    } catch (error) {
      if (alive.current) {
        if (error instanceof Error && error.message === 'stale_target') {
          actions.stale();
          void refresh();
        } else setNotice(t('failed'));
      }
    } finally {
      busy.current = false;
      if (alive.current) setCreating(false);
    }
  }
  if (!wide) return <Button className="dsh-kitty-icon" aria-label={t('windows')} onClick={expandSidebar}><IconCodeOutline16/></Button>;
  return <section className="dsh-kitty-browser" aria-label={t('windows')}>
    <header className="dsh-kitty-browser-header">
      <Button className="dsh-kitty-icon" aria-label={t('backHome')} title={t('backHome')} onClick={backHome}><IconChevronLeftOutline14/></Button>
      <h2>{t('windows')}</h2>
    </header>
    <div className="dsh-kitty-browser-toolbar">
      <Button disabled={!pane || creating || loading} title={t('createHint')} onClick={() => void createWindow()}>{creating ? t('creating') : t('create')}</Button>
      <Button disabled={loading || creating} onClick={() => void refresh()}>{loading ? t('loading') : t('refresh')}</Button>
      <Button className="dsh-kitty-icon" aria-label={t('settings')} title={t('settings')} aria-expanded={options} onClick={() => setOptions(!options)}><IconSettingsOutline16/></Button>
    </div>
    {options && <div className="dsh-kitty-browser-options">
      <div className="dsh-kitty-toolbar">
        <Button aria-pressed={follow} onClick={() => actions.setFollow(!follow)}>{t('follow')}</Button>
        <Button aria-pressed={history} onClick={() => actions.setHistory(!history)}>{t('history')}</Button>
        <Button aria-pressed={wideScreen} onClick={() => actions.setWideScreen(!wideScreen)}>{t('wide')}</Button>
      </div>
      {pane && <p>{pane.cwd} · PID {pane.pid}</p>}
      <p>{t('notice')}</p>
    </div>}
    {result && <p className="dsh-kitty-browser-notice" role="status">{result.kind === 'stale' ? t('stale') : `${t('created')} #${result.id}`}</p>}
    {notice && <p className="dsh-kitty-browser-notice" role="alert">{notice}</p>}
    {failed && <p className="dsh-kitty-browser-notice" role="alert">{t('listFailed')}</p>}
    <div className="dsh-kitty-window-list">
      {value?.panes.map(pane => <button type="button" key={pane.token} className="dsh-kitty-window" aria-label={`#${pane.id} · ${pane.title}`} aria-pressed={pane.token === selected} disabled={creating} onClick={() => open(pane.token)}>
        <IconCodeOutline16/>
        <span className="dsh-kitty-window-info"><span className="dsh-kitty-window-title">{`#${pane.id} · ${pane.title}`}</span><span className="dsh-kitty-window-program">{pane.program}</span><span className="dsh-kitty-window-cwd">{pane.cwd}</span></span>
      </button>)}
      {!loading && !failed && value?.panes.length === 0 && <p className="dsh-kitty-browser-notice">{t('empty')}</p>}
    </div>
  </section>;
}
