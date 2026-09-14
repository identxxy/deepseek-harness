/** Explicit pane selection with replaceable snapshots and non-retried input. */
import { useEffect, useRef, useState } from 'react';
import { Button, Tooltip, IconPaperclipOutline16, IconCodeOutline16, IconSendOutline16 } from '@deepseek-ai/dsh-client-ui-primitives';
import { ComposerAttachments } from '@deepseek-ai/dsh-client-ui-attachment/src/client/ComposerAttachments.tsx';
import type { ComposerAttachmentsProps, DraftAttachmentId } from '@deepseek-ai/dsh-client-ui-conversation/client';
import navigation from '@deepseek-ai/dsh-client-ui-console/src/client/Navigation.module.css';
import composer from '@deepseek-ai/dsh-client-ui-conversation/src/client/skeleton/InputBar.module.css';
import conversation from '@deepseek-ai/dsh-client-ui-conversation/src/client/skeleton/ConversationRoot.module.css';
import type { InjectFace, PropsLocale, PropsRuntime, PropsStore } from '@deepseek-ai/dsh-client-ui-slots';
import { renderAnsiTerminalText } from './ansi.mjs';
import { endpoint, request } from './catalog.ts';
import type { KittyCatalogInjected } from './sidebar.tsx';
import type { createKittyStore } from './stores.ts';
import './panel.css';

type Locale = PropsLocale<'dsh.kitty'>;
type KittyPaneProps = Locale & PropsRuntime<'workspace.panel'> & PropsStore<ReturnType<typeof createKittyStore>>
  & InjectFace<KittyCatalogInjected & { attachmentT: ComposerAttachmentsProps['t']; browse: () => void }>;
export function KittyAction({ t, wide, open }: Locale & PropsRuntime<'sidebar.primary.action'> & InjectFace<{open: () => void}>) {
  return <Tooltip label={t('title')} disabled={wide}><button type="button" className={navigation.newTerminal} aria-label={t('title')} onClick={open}><IconCodeOutline16 size={wide ? 14 : 18}/>{wide ? <span>{t('title')}</span> : null}</button></Tooltip>;
}
export function KittyPane(props: KittyPaneProps) {
  const selected = props.useStore(s => s.selected);
  return props.actor.id === 'Kitty' ? <Panel key={selected} {...props}/> : null;
}
function Panel({ t, attachmentT, useStore, actions, useCatalog, refresh, browse }: KittyPaneProps) {
  const { selected, follow, history, wideScreen } = useStore(s => s);
  const { value: settings, loading } = useCatalog(s => s);
  const pane = settings?.panes.find(p => p.token === selected);
  const [attachment, setAttachment] = useState<{name: string; mime: string; data: string; preview: string; file: File} | null>(null);
  const [reading, setReading] = useState(false);
  const [keysOpen, setKeysOpen] = useState(false);
  const fileInput = useRef<HTMLInputElement>(null);
  const fileReader = useRef<FileReader | null>(null);
  const panelRef = useRef<HTMLDivElement>(null);
  useEffect(() => () => fileReader.current?.abort(), []);
  const [screen, setScreen] = useState('');
  const [text, setText] = useState('');
  const [busy, setBusy] = useState(false);
  const busyRef = useRef(false);
  const [notice, setNotice] = useState('');
  const screenRef = useRef<HTMLPreElement>(null);
  const current = useRef(selected); current.current = selected;
  const alive = useRef(true);
  useEffect(() => { alive.current = true; return () => { alive.current = false; }; }, []);
  function failure(error: unknown) {
    if (!alive.current) return;
    setNotice(error instanceof Error && error.message === 'stale_target' ? t('stale') : t('failed'));
    if (error instanceof Error && error.message === 'stale_target') {
      actions.stale();
      browse();
      void refresh();
    }
  }
  useEffect(() => {
    if (selected && settings && !loading && !pane) {
      actions.stale();
      browse();
    }
  }, [selected, settings, loading, pane, actions, browse]);
  useEffect(() => {
    setScreen('');
    if (!selected || !settings) return;
    const controller = new AbortController(); let running = false;
    async function poll() {
      if (running || document.visibilityState !== 'visible') return;
      running = true;
      try {
        const value = await request<{text: string}>(`${endpoint}?token=${selected}&extent=${history ? 'all' : 'screen'}`, { signal: controller.signal });
        if (!controller.signal.aborted && current.current === selected) setScreen(value.text);
      } catch (error) { if (!controller.signal.aborted && current.current === selected) failure(error); }
      finally { running = false; }
    }
    void poll();
    const timer = window.setInterval(() => { void poll(); }, settings.pollIntervalMs);
    const visible = () => { void poll(); };
    document.addEventListener('visibilitychange', visible);
    return () => { controller.abort(); window.clearInterval(timer); document.removeEventListener('visibilitychange', visible); };
  }, [selected, history, settings?.pollIntervalMs]);
  useEffect(() => { if (follow && screenRef.current) screenRef.current.scrollTop = screenRef.current.scrollHeight; }, [screen, follow]);
  async function send(input: Record<string, unknown>, clear = false) {
    const target = selected;
    if (!target || busyRef.current) return;
    busyRef.current = true; setBusy(true); setNotice(t('pending'));
    try {
      await request(endpoint, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ token: target, ...input }) });
      if (alive.current && current.current === target) { setNotice(t('delivered')); if (clear) { setText(''); setAttachment(null); } }
    } catch (error) { if (current.current === target) failure(error); }
    finally { busyRef.current = false; if (alive.current) setBusy(false); }
  }
  function attach(file?: File) {
    if (!file || !selected || !settings || busyRef.current) return;
    if (file.size > settings.maxImageBytes) { setNotice(t('tooLarge')); return; }
    const types: Record<string, string> = {png:'image/png',jpg:'image/jpeg',jpeg:'image/jpeg',webp:'image/webp',gif:'image/gif',heic:'image/heic',heif:'image/heif'};
    const mime = file.type || types[file.name.split('.').pop()?.toLowerCase() ?? ''];
    if (!Object.values(types).includes(mime)) { setNotice(t('invalidImage')); return; }
    const target = selected;
    fileReader.current?.abort();
    const reader = new FileReader(); fileReader.current = reader; setReading(true);
    reader.onload = () => {
      if (alive.current && current.current === target && fileReader.current === reader) {
        const data = String(reader.result).split(',')[1];
        setAttachment({name:file.name,mime,data,file,preview:`data:${mime};base64,${data}`}); setNotice(''); setReading(false);
      }
    };
    reader.onerror = () => { if (alive.current && fileReader.current === reader) { setReading(false); failure(reader.error); } };
    reader.readAsDataURL(file);
  }
  const disabled = !selected || busy || reading;
  const compose = (submit: boolean) => void send({action:'text',text,submit,...(attachment ? {image:{mime:attachment.mime,data:attachment.data}} : {})},true);
  return <div className={`${conversation.root} dsh-kitty-panel`} ref={panelRef} onDragOver={e => { if (e.dataTransfer.types.includes('Files')) { e.preventDefault(); e.stopPropagation(); } }} onDrop={e => { if (e.dataTransfer.types.includes('Files')) { e.preventDefault(); e.stopPropagation(); attach(e.dataTransfer.files[0]); } }}>
    <main className="dsh-kitty-output">
      {!selected ? <div className="dsh-kitty-empty"><h3>{t('select')}</h3><p>{t('selectHint')}</p><Button onClick={browse}>{t('windows')}</Button></div> : <pre ref={screenRef} className={`dsh-kitty-screen ${wideScreen ? 'is-wide' : ''}`} onClick={event => { const link = (event.target as Element).closest<HTMLAnchorElement>('a[data-preview-url]'); if (!link) return; event.preventDefault(); const url = link.dataset.previewUrl; if (url && /^(?:https?:|file:)\/\//i.test(url)) actions.openPreview(url); }} onScroll={e => { const el=e.currentTarget; if (el.scrollHeight-el.scrollTop-el.clientHeight>60) actions.setFollow(false); }} dangerouslySetInnerHTML={{ __html: renderAnsiTerminalText(screen) }}/>}
      {selected && !follow && <Button className="dsh-kitty-follow" onClick={() => { actions.setFollow(true); if(screenRef.current) screenRef.current.scrollTop=screenRef.current.scrollHeight; }}>{t('latest')} ↓</Button>}
    </main>
    {selected && <footer className={`${composer.root} dsh-kitty-compose`}>
      {keysOpen && <div className="dsh-kitty-keyboard" aria-label={t('keys')}>{['alt+up','enter','escape','tab','up','down','left','right','backspace','ctrl+c','ctrl+d'].map(key => <Button key={key} disabled={disabled} onClick={() => { if (!['ctrl+c','ctrl+d'].includes(key) || window.confirm(`${t('confirm')} ${key}`)) void send({action:'key',key}); }}>{key === 'alt+up' ? t('altUp') : key}</Button>)}</div>}
      <div className={`${composer.card} dsh-kitty-input`}>
        <ComposerAttachments documentDrop={false} t={attachmentT} attachments={attachment ? [{kind:'image',id:'kitty-draft-image' as DraftAttachmentId,file:attachment.file,previewUrl:attachment.preview}] : []} canAcceptDrop={!disabled} onAddFiles={files => attach(files[0])} onRemoveAttachment={() => setAttachment(null)} uploads={{}} onRetryFile={() => {}}/>
        <textarea aria-label={t('prompt')} placeholder={t('keyboard')} value={text} disabled={disabled} rows={2} onChange={e => setText(e.target.value)} onPaste={e => { const file=Array.from(e.clipboardData.items).find(i=>i.kind==='file')?.getAsFile(); if(file){e.preventDefault();attach(file);} }} onKeyDown={e => { if ((e.ctrlKey||e.metaKey) && e.key==='Enter' && !e.nativeEvent.isComposing && (text.trim()||attachment)) { e.preventDefault(); compose(true); } }}/>
        <div className="dsh-kitty-actions">
          <input ref={fileInput} className="dsh-kitty-file" aria-label={t('image')} type="file" accept="image/png,image/jpeg,image/webp,image/gif,image/heic,image/heif" disabled={disabled} onChange={e => { attach(e.target.files?.[0]); e.target.value=''; }}/>
          <Button className="dsh-kitty-icon" aria-label={t('image')} title={t('image')} disabled={disabled} onClick={() => fileInput.current?.click()}><Icon kind="image"/></Button>
          <Button className="dsh-kitty-icon" aria-label={t('keys')} title={t('keys')} aria-expanded={keysOpen} onClick={() => setKeysOpen(!keysOpen)}><Icon kind="keys"/></Button>
          <Button className="dsh-kitty-paste" disabled={disabled || (!text.trim() && !attachment)} onClick={() => compose(false)}>{t('paste')}</Button>
          <span className="dsh-kitty-spacer"/>
          <Button className="dsh-kitty-enter" disabled={disabled} onClick={() => void send({action:'key',key:'enter'})}>Enter ↵</Button>
          <Button variant="primary" className="dsh-kitty-send" disabled={disabled || (!text.trim() && !attachment)} onClick={() => compose(true)}>{busy ? t('pending') : t('send')}<Icon kind="send"/></Button>
        </div>
      </div>
      <div className="dsh-kitty-status" role="status">{reading ? t('loading') : notice || t('composerHint')}</div>
    </footer>}
  </div>;
}
function Icon({kind}:{kind:'image'|'keys'|'send'}) {
  const Component = {image:IconPaperclipOutline16,keys:IconCodeOutline16,send:IconSendOutline16}[kind];
  return <Component/>;
}
