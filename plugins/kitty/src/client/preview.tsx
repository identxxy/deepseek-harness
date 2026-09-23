/** Stable report drawer beside Kitty terminals; navigation never replaces the terminal pane. */
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import type { CSSProperties } from 'react';
import type { PropsLocale, PropsRuntime, PropsStore } from '@deepseek-ai/dsh-client-ui-slots';
import { Button } from '@deepseek-ai/dsh-client-ui-primitives';
import { randomUUID } from '@deepseek-ai/dsh-util-crypto';
import { endpoint, request } from './catalog.ts';
import { previewDocument } from './preview-bridge.ts';
import type { createKittyStore } from './stores.ts';
import './preview.css';

type PreviewProps = PropsRuntime<'shell.overlay'> & PropsLocale<'dsh.kitty'> & PropsStore<ReturnType<typeof createKittyStore>>;
interface Page { url: string; scope: string; html: string; }
interface Resource { url: string; contentType: string; data: string; status: number; }
const HISTORY_KEY = '__dshKittyPreview';

function failureKey(error: unknown): 'browserFailed' | 'browserTooLarge' | 'browserNotFound' | 'browserUnavailable' | 'browserForbidden' {
  if (error instanceof Error && error.message === 'preview_too_large') return 'browserTooLarge';
  if (error instanceof Error && error.message === 'preview_not_found') return 'browserNotFound';
  if (error instanceof Error && error.message === 'preview_scope_forbidden') return 'browserForbidden';
  if (error instanceof Error && error.message === 'kitty_endpoint_unavailable') return 'browserUnavailable';
  return 'browserFailed';
}

function reportUrl(value: unknown, base?: string): string | undefined {
  if (typeof value !== 'string') return;
  try {
    const url = new URL(value, base);
    if (!['http:', 'https:', 'file:'].includes(url.protocol) || url.username || url.password) return;
    return url.href;
  } catch { return; }
}

/**
 * Render the sandboxed report drawer and its retained collapsed handle.
 * @param props - shared preview requests, display preferences and localized copy.
 * @returns the drawer or its reopen control.
 */
export function KittyPreview({ useStore, actions, t }: PreviewProps) {
  const { previewOpen: open, previewUrl, previewRequest, previewWidth: width, previewPinned: pinned, panes } = useStore(s => s);
  const [pages, setPages] = useState<Pick<Page, 'url' | 'scope'>[]>([]);
  const [page, setPage] = useState<Page>();
  const [position, setPosition] = useState(-1);
  const [address, setAddress] = useState('');
  const [loading, setLoading] = useState(false);
  const [failed, setFailed] = useState<ReturnType<typeof failureKey>>();
  const [resizing, setResizing] = useState(false);
  const frame = useRef<HTMLIFrameElement>(null);
  const drawer = useRef<HTMLElement>(null);
  const navigation = useRef<AbortController | null>(null);
  const historyId = useRef(randomUUID());
  const wasOpen = useRef(false);
  const lastRequest = useRef(0);
  const swipe = useRef<{ x: number; y: number } | null>(null);
  const current = useRef({ page, position });
  current.current = { page, position };
  const channel = useMemo(() => randomUUID(), [page, open]);
  const srcDoc = useMemo(() => page ? previewDocument(page.html, channel, page.url) : undefined, [page, channel]);
  const close = useCallback(() => { actions.closePreview(); }, [actions]);
  const load = useCallback(async (value: string, scope?: string, mode: 'root' | 'push' | 'replace' | 'history' = 'root', historyIndex?: number) => {
    const url = reportUrl(value, current.current.page?.url);
    if (!url) { setFailed('browserFailed'); return; }
    navigation.current?.abort();
    const controller = new AbortController();
    navigation.current = controller;
    setLoading(true);
    setFailed(undefined);
    setAddress(url);
    try {
      const next = await request<Page>(`${endpoint}/preview`, {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ url, ...(scope === undefined ? {} : { scope }) }), signal: controller.signal,
      });
      if (controller.signal.aborted) return;
      if (!reportUrl(next.url) || typeof next.scope !== 'string' || !next.scope || typeof next.html !== 'string') throw new Error('Invalid report document');
      const index = mode === 'root' ? 0 : mode === 'push' ? current.current.position + 1 : historyIndex ?? current.current.position;
      const entry = { url: next.url, scope: next.scope };
      setPages(previous => mode === 'replace' || mode === 'history'
        ? previous.map((previousPage, previousIndex) => previousIndex === index ? entry : previousPage)
        : [...previous.slice(0, Math.max(0, index)), entry]);
      setPage(next);
      setPosition(Math.max(0, index));
      setAddress(next.url);
    } catch (error) {
      if (!controller.signal.aborted) setFailed(failureKey(error));
    } finally {
      if (!controller.signal.aborted) setLoading(false);
      if (navigation.current === controller) navigation.current = null;
    }
  }, []);

  useEffect(() => () => { navigation.current?.abort(); }, []);
  useEffect(() => { if (!open) { navigation.current?.abort(); setLoading(false); } }, [open]);
  useEffect(() => {
    if (previewRequest === lastRequest.current) return;
    lastRequest.current = previewRequest;
    void load(previewUrl);
  }, [previewRequest, previewUrl, load]);
  useEffect(() => {
    const onPop = (event: PopStateEvent) => {
      if (event.state?.[HISTORY_KEY] === historyId.current) actions.showPreview();
      else actions.closePreview();
    };
    window.addEventListener('popstate', onPop);
    return () => window.removeEventListener('popstate', onPop);
  }, [actions]);
  useEffect(() => {
    if (open && !wasOpen.current && window.history.state?.[HISTORY_KEY] !== historyId.current) {
      window.history.pushState({ ...window.history.state, [HISTORY_KEY]: historyId.current }, '', window.location.href);
    } else if (!open && wasOpen.current && window.history.state?.[HISTORY_KEY] === historyId.current) {
      window.history.back();
    }
    wasOpen.current = open;
  }, [open]);
  useEffect(() => {
    if (!open || pinned) return;
    const outside = (event: PointerEvent) => {
      if (event.target instanceof Element && event.target.closest('a[data-preview-url]')) return;
      if (event.target instanceof Node && !drawer.current?.contains(event.target)) close();
    };
    document.addEventListener('pointerdown', outside);
    return () => document.removeEventListener('pointerdown', outside);
  }, [open, pinned, close]);
  useLayoutEffect(() => {
    if (!open || !page) return;
    const pending = new Set<AbortController>();
    const resources = new Map<string, Promise<Resource>>();
    let live = true;
    const onMessage = (event: MessageEvent) => {
      const message: unknown = event.data;
      if (event.source !== frame.current?.contentWindow || !message || typeof message !== 'object') return;
      const data = message as Record<string, unknown>;
      if (data.channel !== channel) return;
      if (data.type === 'failure') { setFailed('browserFailed'); return; }
      const url = reportUrl(data.url, page.url);
      if (!url) {
        setFailed('browserFailed');
        if (data.type === 'resource' && Number.isSafeInteger(data.id)) {
          frame.current?.contentWindow?.postMessage({ channel, type: 'resource-result', id: data.id, error: t('browserFailed') }, '*');
        }
        return;
      }
      if (data.type === 'navigate') { if (navigation.current === null) void load(url, page.scope, 'push'); return; }
      if (data.type !== 'resource' || !Number.isSafeInteger(data.id) || (data.id as number) < 1 || !['GET', 'HEAD'].includes(data.method as string)) return;
      let read = resources.get(url);
      if (!read) {
        const controller = new AbortController();
        pending.add(controller);
        read = request<Resource>(`${endpoint}/preview`, {
          method: 'POST', headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ url, scope: page.scope, resource: true }), signal: controller.signal,
        }).finally(() => { pending.delete(controller); resources.delete(url); });
        resources.set(url, read);
      }
      const target = frame.current!.contentWindow!;
      void read.then(resource => {
        if (!live) return;
        if (!reportUrl(resource.url) || typeof resource.contentType !== 'string' || typeof resource.data !== 'string' || !Number.isInteger(resource.status)) throw new Error('Invalid report resource');
        target.postMessage({ channel, type: 'resource-result', id: data.id, method: data.method, url: resource.url, contentType: resource.contentType, data: resource.data, status: resource.status }, '*');
      }).catch((error: unknown) => {
        if (!live) return;
        setFailed(failureKey(error));
        target.postMessage({ channel, type: 'resource-result', id: data.id, error: t(failureKey(error)) }, '*');
      });
    };
    window.addEventListener('message', onMessage);
    return () => {
      live = false;
      window.removeEventListener('message', onMessage);
      for (const controller of pending) controller.abort();
    };
  }, [open, page, channel, load, t]);

  const move = (next: number) => {
    const entry = pages[next]!;
    void load(entry.url, entry.scope, 'history', next);
  };
  if (!Object.values(panes).some(pane => pane.selected) && !previewUrl && !page && !open) return null;
  return <>
    {!open && <Button className="dsh-kitty-browser-handle" aria-label={t('browser')} title={t('browser')} onClick={() => actions.showPreview()}>
      <svg className="dsh-kitty-browser-handle-icon" viewBox="0 0 20 20" fill="none" stroke="currentColor" strokeWidth="1.4" aria-hidden="true">
        <rect x="2.5" y="3.5" width="15" height="13" rx="2.5"/>
        <path d="M3 7.5h14"/>
        <circle cx="5.5" cy="5.5" r=".6" fill="currentColor" stroke="none"/>
      </svg>
      <span className="dsh-kitty-browser-handle-label" aria-hidden="true">{t('browserHandle')}</span>
    </Button>}
    <aside ref={drawer} className={`dsh-kitty-preview ${open ? 'is-open' : ''} ${resizing ? 'is-resizing' : ''}`} aria-label={t('browser')} aria-hidden={!open} {...(!open ? { inert: '' } : {})} style={{ '--kitty-preview-width': `${width}px` } as CSSProperties}>
      <div className="dsh-kitty-preview-resize" role="separator" aria-label={t('browserResize')} aria-orientation="vertical" tabIndex={0}
        onKeyDown={event => { if (event.key === 'ArrowLeft' || event.key === 'ArrowRight') { event.preventDefault(); actions.resizePreview(Math.min(innerWidth, width + (event.key === 'ArrowLeft' ? 32 : -32))); } }}
        onPointerDown={event => { event.currentTarget.setPointerCapture(event.pointerId); setResizing(true); }}
        onPointerMove={event => { if (event.currentTarget.hasPointerCapture(event.pointerId)) actions.resizePreview(Math.min(innerWidth, innerWidth - event.clientX)); }}
        onPointerUp={event => { if (event.currentTarget.hasPointerCapture(event.pointerId)) event.currentTarget.releasePointerCapture(event.pointerId); setResizing(false); }}
        onPointerCancel={() => setResizing(false)}/>
      <header className="dsh-kitty-preview-title" onPointerDown={event => { if (event.pointerType === 'touch') swipe.current = { x: event.clientX, y: event.clientY }; }} onPointerUp={event => {
        const start = swipe.current; swipe.current = null;
        if (start && event.clientX - start.x > 70 && Math.abs(event.clientY - start.y) < event.clientX - start.x) close();
      }} onPointerCancel={() => { swipe.current = null; }}>
        <strong>{t('browser')}</strong>
        <Button aria-label={t('browserPin')} aria-pressed={pinned} onClick={() => actions.pinPreview(!pinned)}>⌖</Button>
        <Button aria-label={t('browserClose')} onClick={close}>×</Button>
      </header>
      <form className="dsh-kitty-preview-controls" onSubmit={event => { event.preventDefault(); void load(address); }}>
        <Button aria-label={t('browserBack')} onClick={() => position > 0 ? move(position - 1) : close()}>←</Button>
        <Button aria-label={t('browserForward')} disabled={position + 1 >= pages.length} onClick={() => move(position + 1)}>→</Button>
        <Button aria-label={t('browserReload')} disabled={!page || loading} onClick={() => { if (page) void load(page.url, page.scope, 'replace'); }}>↻</Button>
        <input aria-label={t('browserAddress')} value={address} onChange={event => setAddress(event.target.value)} placeholder={t('browserAddress')}/>
        <Button type="submit">{t('browserGo')}</Button>
      </form>
      {loading && <div className="dsh-kitty-preview-status" role="status">{t('loading')}</div>}
      {failed && <div className="dsh-kitty-preview-status" role="alert">{t(failed)}</div>}
      <div className="dsh-kitty-preview-content">
        {open && page ? <iframe ref={frame} key={channel} title={t('browser')} sandbox="allow-scripts allow-forms allow-modals" srcDoc={srcDoc}/> : open && !loading && !failed ? <p>{t('browserEmpty')}</p> : null}
      </div>
    </aside>
  </>;
}
