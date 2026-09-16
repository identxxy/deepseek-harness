/** One canvas composer addressing the focused Kitty pane and retaining each pane's draft. */
import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { Button, IconPaperclipOutline16, IconCodeOutline16, IconSendOutline16 } from '@deepseek-ai/dsh-client-ui-primitives';
import { ComposerAttachments } from '@deepseek-ai/dsh-client-ui-attachment/src/client/ComposerAttachments.tsx';
import type { ComposerAttachmentsProps, DraftAttachmentId } from '@deepseek-ai/dsh-client-ui-conversation/client';
import composer from '@deepseek-ai/dsh-client-ui-conversation/src/client/skeleton/InputBar.module.css';
import type { InjectFace, PropsLocale, PropsRuntime, PropsStore } from '@deepseek-ai/dsh-client-ui-slots';
import { endpoint, request } from './catalog.ts';
import type { KittyCatalogInjected } from './sidebar.tsx';
import type { createKittyStore } from './stores.ts';
import './panel.css';

type KittyComposerProps = PropsLocale<'dsh.kitty'> & PropsRuntime<'workspace.panel.composer'>
  & PropsStore<ReturnType<typeof createKittyStore>>
  & InjectFace<KittyCatalogInjected & { attachmentT: ComposerAttachmentsProps['t']; browse: () => void }>;

/**
 * Render the shared input only for a selected Kitty terminal.
 * @param props - Focused pane, shared drafts, catalog and window navigation.
 * @returns one input area below the canvas, or no input before selecting a window.
 */
export function KittyComposer(props: KittyComposerProps) {
  const selected = props.useStore(s => s.panes[props.paneId]?.selected);
  return selected ? <Composer {...props}/> : null;
}

function Composer({ t, attachmentT, useStore, actions, useCatalog, refresh, browse, paneId }: KittyComposerProps) {
  const { selected, appendNewline, inputVersion, input: { text, attachment, busy, notice } } = useStore(s => s.panes[paneId]);
  const settings = useCatalog(s => s.value);
  const pane = settings?.panes.find(p => p.token === selected);
  const title = pane ? `#${pane.id} · ${pane.title}` : t('title');
  const [keysOpen, setKeysOpen] = useState(false);
  const [preview, setPreview] = useState<{ file: File; url: string } | null>(null);
  const fileInput = useRef<HTMLInputElement>(null);
  const inFlight = useRef(new Set<string>());
  const current = useRef({ paneId, inputVersion }); current.current = { paneId, inputVersion };
  const alive = useRef(true);
  useEffect(() => { alive.current = true; return () => { alive.current = false; }; }, []);
  useLayoutEffect(() => {
    if (!attachment) { setPreview(null); return; }
    const url = URL.createObjectURL(attachment.file);
    setPreview({ file: attachment.file, url });
    return () => URL.revokeObjectURL(url);
  }, [attachment]);
  async function send(input: Record<string, unknown>, clear = false) {
    const key = JSON.stringify([paneId, inputVersion]);
    if (!selected || busy || inFlight.current.has(key)) return;
    inFlight.current.add(key);
    actions.updateInput(paneId, inputVersion, { busy: true, notice: 'pending' });
    try {
      const image = clear && attachment ? { mime: attachment.mime, data: await imageData(attachment.file) } : undefined;
      await request(endpoint, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ token: selected, ...input, ...(image ? { image } : {}) }) });
      actions.updateInput(paneId, inputVersion, { notice: 'delivered', ...(clear ? { text: '', attachment: null } : {}) });
    } catch (error) {
      const stale = error instanceof Error && error.message === 'stale_target';
      actions.updateInput(paneId, inputVersion, { notice: stale ? 'stale' : 'failed' });
      if (stale) {
        actions.stale(paneId, inputVersion);
        if (alive.current && current.current.paneId === paneId && current.current.inputVersion === inputVersion) browse();
        void refresh();
      }
    } finally {
      inFlight.current.delete(key);
      actions.updateInput(paneId, inputVersion, { busy: false });
    }
  }
  function attach(file?: File) {
    if (file && settings) actions.attachImage(paneId, file, settings.maxImageBytes);
  }
  const disabled = !selected || busy;
  const compose = (submit: boolean) => void send({ action: 'text', text, submit }, true);
  return <footer className={`${composer.root} dsh-kitty-compose`}
    onDragOver={event => { if (event.dataTransfer.types.includes('Files')) { event.preventDefault(); event.stopPropagation(); } }}
    onDrop={event => { if (event.dataTransfer.types.includes('Files')) { event.preventDefault(); event.stopPropagation(); attach(event.dataTransfer.files[0]); } }}>
      <div className="dsh-kitty-composer-target"><span>{t('sendTo')}</span><strong title={title}>{title}</strong></div>
      {keysOpen && <div className="dsh-kitty-keyboard" aria-label={t('keys')}>
        <Button disabled={disabled} onClick={() => void send({action:'key',key:'alt+up'})}>{t('altUp')}</Button>
        {([['up','↑','keyUp'],['down','↓','keyDown'],['left','←','keyLeft'],['right','→','keyRight']] as const).map(([key, glyph, label]) => <Button key={key} className="dsh-kitty-direction" aria-label={t(label)} title={t(label)} disabled={disabled} onClick={() => void send({action:'key',key})}><span aria-hidden="true">{glyph}</span></Button>)}
        {['enter','escape','tab','backspace','ctrl+c','ctrl+d'].map(key => <Button key={key} disabled={disabled} onClick={() => { if (!['ctrl+c','ctrl+d'].includes(key) || window.confirm(`${t('confirm')} ${key}`)) void send({action:'key',key}); }}>{key}</Button>)}
      </div>}
      <div className={`${composer.card} dsh-kitty-input`}>
        <ComposerAttachments key={`${paneId}:${inputVersion}`} documentDrop={false} t={attachmentT} attachments={attachment && preview?.file === attachment.file ? [{kind:'image',id:'kitty-draft-image' as DraftAttachmentId,file:attachment.file,previewUrl:preview.url}] : []} canAcceptDrop={!disabled} onAddFiles={files => attach(files[0])} onRemoveAttachment={() => actions.updateInput(paneId, inputVersion, { attachment: null })} uploads={{}} onRetryFile={() => {}}/>
        <textarea aria-label={t('prompt')} placeholder={t('keyboard')} value={text} disabled={disabled} rows={2} onChange={e => actions.updateInput(paneId, inputVersion, { text: e.target.value })} onPaste={e => { const file=Array.from(e.clipboardData.items).find(i=>i.kind==='file')?.getAsFile(); if(file){e.preventDefault();attach(file);} }} onKeyDown={e => { if ((e.ctrlKey||e.metaKey) && e.key==='Enter' && !e.nativeEvent.isComposing && (text.trim()||attachment)) { e.preventDefault(); compose(appendNewline); } }}/>
        <div className="dsh-kitty-actions">
          <input ref={fileInput} className="dsh-kitty-file" aria-label={t('image')} type="file" accept="image/png,image/jpeg,image/webp,image/gif,image/heic,image/heif" disabled={disabled} onChange={e => { attach(e.target.files?.[0]); e.target.value=''; }}/>
          <Button className="dsh-kitty-icon" aria-label={t('image')} title={t('image')} disabled={disabled} onClick={() => fileInput.current?.click()}><Icon kind="image"/></Button>
          <Button className="dsh-kitty-icon" aria-label={t('keys')} title={t('keys')} aria-expanded={keysOpen} onClick={() => setKeysOpen(!keysOpen)}><Icon kind="keys"/></Button>
          <Button className="dsh-kitty-paste" disabled={disabled || (!text.trim() && !attachment)} onClick={() => compose(false)}>{t('paste')}</Button>
          <span className="dsh-kitty-spacer"/>
          <Button className="dsh-kitty-enter" disabled={disabled} onClick={() => void send({action:'key',key:'enter'})}>Enter ↵</Button>
          <div className="dsh-kitty-send-options">
            <label className="dsh-kitty-newline" title={t('appendNewlineHint')}>
              <input type="checkbox" checked={appendNewline} disabled={disabled} onChange={event => actions.setAppendNewline(paneId, event.target.checked)}/>
              <span>{t('appendNewline')}</span>
            </label>
            <Button variant="primary" className="dsh-kitty-send" disabled={disabled || (!text.trim() && !attachment)} onClick={() => compose(appendNewline)}>{busy ? t('pending') : t('send')}<Icon kind="send"/></Button>
          </div>
        </div>
      </div>
      <div className="dsh-kitty-status" role="status">{notice ? t(notice) : t('composerHint')}</div>
  </footer>;
}

function imageData(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result).split(',')[1]);
    reader.onerror = () => reject(reader.error);
    reader.readAsDataURL(file);
  });
}

function Icon({kind}:{kind:'image'|'keys'|'send'}) {
  const Component = {image:IconPaperclipOutline16,keys:IconCodeOutline16,send:IconSendOutline16}[kind];
  return <Component/>;
}
