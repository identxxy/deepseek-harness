import { useEffect, useRef, useState } from 'react'
import { FitAddon } from '@xterm/addon-fit'
import { Terminal } from '@xterm/xterm'
import '@xterm/xterm/css/xterm.css'
import type { ConsoleRemoteAttachmentAccess, ConsoleRemoteSnapshot } from '@deepseek-ai/dsh-api-remotes/client'
import type { PropsHooks } from '@deepseek-ai/dsh-client-ui-slots'
import type { ConsolePaneOwnerProps } from '@deepseek-ai/dsh-client-ui-layout/client'
import type { ConsoleCatalogState, ConsoleClient } from './controller.ts'
import css from './TerminalPane.module.css'

/** Registration-side business face for each terminal pane occurrence. */
export interface TerminalPaneInjected {
  /** Shared Console catalog and Remote attachment controller. */
  controller: ConsoleClient
  hooks: {
    /** Observable durable Console catalog. */
    consoleCatalog: ConsoleClient
  }
}

/** Fully composed Human Terminal pane props. */
export type TerminalPaneProps =
  & ConsolePaneOwnerProps
  & Omit<TerminalPaneInjected, 'hooks'>
  & PropsHooks<TerminalPaneInjected['hooks']>

type PanePhase = 'attaching' | 'running' | 'ended' | 'error'

const PHASE_LABEL: Record<PanePhase, string> = {
  attaching: '正在连接',
  running: '运行中',
  ended: '已结束',
  error: '错误',
}

function decodedBase64(value: string): Uint8Array {
  const binary = atob(value)
  const bytes = new Uint8Array(binary.length)
  for (let index = 0; index < binary.length; index++) bytes[index] = binary.charCodeAt(index)
  return bytes
}

function shortId(id: string): string {
  return id.slice(0, 8)
}

/** xterm renderer for one independent Web tmux Client attachment. */
export function TerminalPane({ actor, active, mobile, controller, useConsoleCatalog }: TerminalPaneProps) {
  const containerRef = useRef<HTMLDivElement | null>(null)
  const terminalRef = useRef<Terminal | null>(null)
  const accessRef = useRef<ConsoleRemoteAttachmentAccess | null>(null)
  const [phase, setPhase] = useState<PanePhase>('attaching')
  const [diagnostic, setDiagnostic] = useState<string | null>(null)
  const consoleSnapshot = useConsoleCatalog((state: ConsoleCatalogState): ConsoleRemoteSnapshot | undefined => (
    state.items.find(item => item.id === actor.id)
  ))
  const connectionEpoch = useConsoleCatalog((state: ConsoleCatalogState): number => state.connectionEpoch)

  useEffect(() => {
    if (active) terminalRef.current?.focus()
  }, [active])

  useEffect(() => {
    const container = containerRef.current
    /* v8 ignore next -- ref-null guard: React attaches the terminal container before passive effects run. */
    if (container === null) return
    const abort = new AbortController()
    let live = true
    let cursor = 0
    let lastSize = { rows: 0, cols: 0 }
    const terminal = new Terminal({
      cursorBlink: true,
      convertEol: false,
      scrollback: 5_000,
      fontFamily: 'ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace',
      fontSize: mobile ? 12 : 13,
    })
    const fit = new FitAddon()
    terminal.loadAddon(fit)
    terminal.open(container)
    terminalRef.current = terminal
    fit.fit()

    const report = (error: unknown): void => {
      if (!live || abort.signal.aborted) return
      setPhase('error')
      setDiagnostic(error instanceof Error ? error.message : String(error))
    }
    const attachmentLive = (): boolean => live && !abort.signal.aborted
    const resize = (): void => {
      fit.fit()
      const access = accessRef.current
      const size = { rows: terminal.rows, cols: terminal.cols }
      if (access === null || size.rows === lastSize.rows && size.cols === lastSize.cols) return
      lastSize = size
      void controller.resize(access, size).catch(report)
    }
    const resizeObserver = new ResizeObserver(resize)
    resizeObserver.observe(container)
    const input = terminal.onData((data) => {
      const access = accessRef.current
      if (access !== null) void controller.write(access, data).catch(report)
    })

    void controller.attach(actor.id, { rows: terminal.rows, cols: terminal.cols }, abort.signal).then(async (opened) => {
      if (!live) {
        await controller.detach(opened.access)
        return
      }
      accessRef.current = opened.access
      cursor = opened.attachment.oldestOutputByte
      lastSize = { rows: terminal.rows, cols: terminal.cols }
      setPhase('running')
      terminal.focus()
      while (!abort.signal.aborted) {
        const observation = await controller.read(opened.access, cursor, 20_000, abort.signal)
        if (!attachmentLive()) break
        if (observation.output.kind === 'gap') {
          cursor = observation.output.oldestByte
          terminal.write('\r\n[DSH: terminal output retention gap]\r\n')
        } else {
          if (observation.output.dataBase64.length > 0) terminal.write(decodedBase64(observation.output.dataBase64))
          cursor = observation.output.nextByte
        }
        if (observation.attachment.status.kind !== 'running') {
          setPhase('ended')
          void controller.refresh().catch((error: unknown) => {
            console.warn('Console catalog refresh after attachment ended failed:', error)
          })
          break
        }
      }
    }).catch(report)

    return () => {
      live = false
      abort.abort(new DOMException('Terminal pane detached', 'AbortError'))
      resizeObserver.disconnect()
      input.dispose()
      terminal.dispose()
      terminalRef.current = null
      const access = accessRef.current
      accessRef.current = null
      if (access !== null) {
        void controller.detach(access).catch((error: unknown) => {
          console.warn('Console attachment detach failed:', error)
        })
      }
    }
  }, [actor.id, connectionEpoch, controller, mobile])

  const send = (data: string): void => {
    const access = accessRef.current
    if (access !== null) void controller.write(access, data).catch((error: unknown) => {
      if (accessRef.current !== access) return
      setPhase('error')
      setDiagnostic(String(error))
    })
    terminalRef.current?.focus()
  }

  return (
    <div className={css.root} data-terminal-phase={phase}>
      <div className={css.statusBar}>
        <span className={css.title}>{consoleSnapshot?.title ?? `Terminal ${shortId(actor.id)}`}</span>
        <span className={css.path}>{consoleSnapshot?.cwd}</span>
        <span className={css.phase}>{PHASE_LABEL[phase]}</span>
      </div>
      <div ref={containerRef} className={css.terminal} />
      {diagnostic !== null ? <div className={css.error} role="alert">{diagnostic}</div> : null}
      {mobile ? (
        <div className={css.mobileKeys} aria-label="终端按键">
          <button type="button" onClick={() => { send('\x1b') }}>Esc</button>
          <button type="button" onClick={() => { send('\t') }}>Tab</button>
          <button type="button" onClick={() => { send('\x1b[D') }}>←</button>
          <button type="button" onClick={() => { send('\x1b[A') }}>↑</button>
          <button type="button" onClick={() => { send('\x1b[B') }}>↓</button>
          <button type="button" onClick={() => { send('\x1b[C') }}>→</button>
          <button type="button" onClick={() => { send('\x03') }}>Ctrl-C</button>
        </div>
      ) : null}
    </div>
  )
}
