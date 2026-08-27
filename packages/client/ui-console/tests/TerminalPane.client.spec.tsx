// @vitest-environment jsdom
import { act, fireEvent, render, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { ConsoleCatalogState } from '../src/client/controller.ts'

interface TerminalMockView {
  write: ReturnType<typeof vi.fn>
  dispose: ReturnType<typeof vi.fn>
  focus: ReturnType<typeof vi.fn>
  onData: ReturnType<typeof vi.fn>
  emitData: (data: string) => void
  rows: number
  cols: number
}

function abortReason(signal: AbortSignal): Error {
  return signal.reason instanceof Error ? signal.reason : new Error(String(signal.reason))
}

const terminalMocks = vi.hoisted(() => ({ instances: [] as TerminalMockView[], resize: undefined as ResizeObserverCallback | undefined }))

vi.mock('@xterm/xterm', () => ({
  Terminal: class {
    rows = 24
    cols = 80
    write = vi.fn()
    open = vi.fn()
    focus = vi.fn()
    dispose = vi.fn()
    loadAddon = vi.fn()
    private dataListener?: (data: string) => void
    onData = vi.fn((listener: (data: string) => void) => { this.dataListener = listener; return { dispose: vi.fn() } })
    emitData(data: string) { this.dataListener?.(data) }
    constructor() { terminalMocks.instances.push(this) }
  },
}))
vi.mock('@xterm/addon-fit', () => ({ FitAddon: class { fit = vi.fn() } }))

import { TerminalPane } from '../src/client/TerminalPane.tsx'

class ResizeObserverMock {
  observe = vi.fn()
  disconnect = vi.fn()
  constructor(callback: ResizeObserverCallback) { terminalMocks.resize = callback }
}

const catalog: ConsoleCatalogState = {
  phase: 'ready', connectionEpoch: 0,
  items: [{
    id: 'console-1', workspaceId: 'workspace-1', cwd: '/workspace', title: 'Research shell',
    createdAt: '2026-08-26T00:00:00.000Z', archived: false, status: { kind: 'running' },
  }],
}

beforeEach(() => {
  terminalMocks.instances.length = 0
  terminalMocks.resize = undefined
  vi.stubGlobal('ResizeObserver', ResizeObserverMock)
})

afterEach(() => { vi.unstubAllGlobals() })

describe('TerminalPane', () => {
  it('attaches xterm, streams output, and detaches only the Web Client on unmount', async () => {
    const access = { attachmentId: 'attachment-1', capability: 'memory-only' }
    const controller = {
      attach: vi.fn(async () => ({
        access,
        attachment: {
          id: 'attachment-1', consoleId: 'console-1', size: { rows: 24, cols: 80 },
          status: { kind: 'running' as const }, oldestOutputByte: 0, nextOutputByte: 0,
        },
      })),
      read: vi.fn()
        .mockResolvedValueOnce({
          attachment: {
            id: 'attachment-1', consoleId: 'console-1', size: { rows: 24, cols: 80 },
            status: { kind: 'running' as const }, oldestOutputByte: 0, nextOutputByte: 5,
          },
          output: { kind: 'data' as const, dataBase64: btoa('hello'), fromByte: 0, nextByte: 5, availableThroughByte: 5 },
          timedOut: false,
        })
        .mockImplementation((_access: unknown, _cursor: unknown, _wait: unknown, signal: AbortSignal) => (
          new Promise((_resolve, reject) => {
            signal.addEventListener('abort', () => { reject(abortReason(signal)) }, { once: true })
          })
        )),
      write: vi.fn(async () => {}),
      resize: vi.fn(async () => {}),
      detach: vi.fn(async () => {}),
    }
    const useConsoleCatalog = (<S,>(selector: (state: ConsoleCatalogState) => S): S => selector(catalog))
    const view = render(<TerminalPane
      actor={{ kind: 'console', id: 'console-1' }}
      paneId="pane-1"
      active
      mobile={false}
      controller={controller as never}
      useConsoleCatalog={useConsoleCatalog as never}
    />)

    await waitFor(() => { expect(controller.attach).toHaveBeenCalledOnce() })
    await waitFor(() => { expect(terminalMocks.instances[0]?.write).toHaveBeenCalledOnce() })
    expect(new TextDecoder().decode(terminalMocks.instances[0]?.write.mock.calls[0]?.[0] as Uint8Array)).toBe('hello')

    await act(async () => { view.unmount() })
    await waitFor(() => { expect(controller.detach).toHaveBeenCalledExactlyOnceWith(access) })
    expect(terminalMocks.instances[0]?.dispose).toHaveBeenCalledOnce()
  })

  it('handles resize, input, retention gaps, and an ended attachment', async () => {
    const access = { attachmentId: 'attachment-1', capability: 'memory-only' }
    const controller = {
      attach: vi.fn(async () => ({ access, attachment: { oldestOutputByte: 3 } })),
      read: vi.fn()
        .mockResolvedValueOnce({
          attachment: { status: { kind: 'running' } },
          output: { kind: 'gap', oldestByte: 7 }, timedOut: false,
        })
        .mockResolvedValueOnce({
          attachment: { status: { kind: 'running' } },
          output: { kind: 'data', dataBase64: '', nextByte: 7 }, timedOut: false,
        })
        .mockResolvedValueOnce({
          attachment: { status: { kind: 'exited', exitCode: 0, signal: null } },
          output: { kind: 'data', dataBase64: btoa('done'), nextByte: 11 }, timedOut: false,
        }),
      write: vi.fn(async () => {}), resize: vi.fn(async () => {}), detach: vi.fn(async () => {}),
      refresh: vi.fn(async () => {}),
    }
    const useConsoleCatalog = (<S,>(selector: (state: ConsoleCatalogState) => S): S => selector(catalog))
    const view = render(<TerminalPane actor={{ kind: 'console', id: 'console-1' }} paneId="pane-1" active={false}
      mobile={false} controller={controller as never} useConsoleCatalog={useConsoleCatalog as never} />)
    await waitFor(() => { expect(screenPhase(view.container)).toBe('ended') })
    expect(controller.refresh).toHaveBeenCalledOnce()
    expect(terminalMocks.instances[0]?.write).toHaveBeenCalledWith('\r\n[DSH: terminal output retention gap]\r\n')
    terminalMocks.instances[0]!.emitData('ls\n')
    await waitFor(() => { expect(controller.write).toHaveBeenCalledWith(access, 'ls\n') })
    terminalMocks.resize?.([], {} as ResizeObserver)
    terminalMocks.instances[0]!.rows = 40
    terminalMocks.instances[0]!.cols = 120
    terminalMocks.resize?.([], {} as ResizeObserver)
    terminalMocks.resize?.([], {} as ResizeObserver)
    await waitFor(() => { expect(controller.resize).toHaveBeenCalledWith(access, { rows: 40, cols: 120 }) })
    view.rerender(<TerminalPane actor={{ kind: 'console', id: 'console-1' }} paneId="pane-1" active
      mobile={false} controller={controller as never} useConsoleCatalog={useConsoleCatalog} />)
    expect(terminalMocks.instances[0]?.focus).toHaveBeenCalled()
  })

  it('keeps the ended phase and warns when the immediate catalog refresh fails', async () => {
    const warning = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const access = { attachmentId: 'attachment-1', capability: 'memory-only' }
    const controller = {
      attach: vi.fn(async () => ({ access, attachment: { oldestOutputByte: 0 } })),
      read: vi.fn(async () => ({
        attachment: { status: { kind: 'exited', exitCode: 0, signal: null } },
        output: { kind: 'data', dataBase64: '', nextByte: 0 },
        timedOut: false,
      })),
      refresh: vi.fn(async () => { throw new Error('catalog unavailable') }),
      write: vi.fn(), resize: vi.fn(), detach: vi.fn(async () => {}),
    }
    const useConsoleCatalog = (<S,>(selector: (state: ConsoleCatalogState) => S): S => selector(catalog))
    const view = render(<TerminalPane actor={{ kind: 'console', id: 'console-1' }} paneId="pane-1" active
      mobile={false} controller={controller as never} useConsoleCatalog={useConsoleCatalog as never} />)
    await waitFor(() => { expect(screenPhase(view.container)).toBe('ended') })
    await waitFor(() => {
      expect(warning).toHaveBeenCalledWith('Console catalog refresh after attachment ended failed:', expect.any(Error))
    })
    expect(controller.refresh).toHaveBeenCalledOnce()
    warning.mockRestore()
  })

  it('shows attach and stream failures without presenting an error after teardown', async () => {
    const warning = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const controller = {
      attach: vi.fn().mockRejectedValueOnce(new Error('attach failed')),
      read: vi.fn(), write: vi.fn(), resize: vi.fn(), detach: vi.fn(),
    }
    const emptyCatalog = { phase: 'ready' as const, items: [], connectionEpoch: 0 }
    const useConsoleCatalog = (<S,>(selector: (state: ConsoleCatalogState) => S): S => selector(emptyCatalog))
    const first = render(<TerminalPane actor={{ kind: 'console', id: 'long-console-id' }} paneId="pane-1" active
      mobile={false} controller={controller as never} useConsoleCatalog={useConsoleCatalog as never} />)
    await waitFor(() => { expect(first.getByRole('alert').textContent).toBe('attach failed') })
    expect(first.getByText('Terminal long-con')).toBeTruthy()
    first.unmount()

    controller.attach.mockRejectedValueOnce(new Error('plain failure'))
    const plain = render(<TerminalPane actor={{ kind: 'console', id: 'plain' }} paneId="pane-plain" active
      mobile={false} controller={controller as never} useConsoleCatalog={useConsoleCatalog as never} />)
    await waitFor(() => { expect(plain.getByRole('alert').textContent).toBe('plain failure') })
    plain.unmount()

    let resolveAttach!: (value: unknown) => void
    controller.attach.mockImplementationOnce(() => new Promise((resolve) => { resolveAttach = resolve }))
    controller.detach.mockResolvedValueOnce(undefined)
    const late = render(<TerminalPane actor={{ kind: 'console', id: 'late' }} paneId="pane-2" active
      mobile={false} controller={controller as never} useConsoleCatalog={useConsoleCatalog as never} />)
    late.unmount()
    resolveAttach({ access: { attachmentId: 'late', capability: 'late' }, attachment: { oldestOutputByte: 0 } })
    await waitFor(() => { expect(controller.detach).toHaveBeenCalled() })
    expect(warning).not.toHaveBeenCalled()
  })

  it('sends mobile keys and reports input and resize failures', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {})
    const access = { attachmentId: 'attachment-1', capability: 'memory-only' }
    let blockRead!: () => void
    const controller = {
      attach: vi.fn(async () => ({ access, attachment: { oldestOutputByte: 0 } })),
      read: vi.fn((_access, _cursor, _wait, signal: AbortSignal) => new Promise((_resolve, reject) => {
        blockRead = () =>{  reject(new Error('stream failed')) }
        signal.addEventListener('abort', () => { reject(abortReason(signal)) }, { once: true })
      })),
      write: vi.fn(async () => { throw new Error('write failed') }),
      resize: vi.fn(async () => { throw new Error('resize failed') }),
      detach: vi.fn(async () => { throw new Error('detach failed') }),
    }
    const useConsoleCatalog = (<S,>(selector: (state: ConsoleCatalogState) => S): S => selector(catalog))
    const view = render(<TerminalPane actor={{ kind: 'console', id: 'console-1' }} paneId="pane-1" active
      mobile controller={controller as never} useConsoleCatalog={useConsoleCatalog as never} />)
    fireEvent.click(view.getByRole('button', { name: 'Esc' }))
    terminalMocks.instances[0]!.emitData('before-attach')
    await waitFor(() => { expect(controller.attach).toHaveBeenCalled() })
    for (const label of ['Esc', 'Tab', '←', '↑', '↓', '→', 'Ctrl-C']) fireEvent.click(view.getByRole('button', { name: label }))
    await waitFor(() => { expect(view.getByRole('alert').textContent).toContain('write failed') })
    terminalMocks.instances[0]!.rows = 30
    terminalMocks.resize?.([], {} as ResizeObserver)
    await waitFor(() => { expect(controller.resize).toHaveBeenCalled() })
    blockRead()
    await waitFor(() => { expect(view.getByRole('alert').textContent).toBe('stream failed') })
    terminalMocks.instances[0]!.emitData('x')
    await act(async () => { view.unmount() })
    await waitFor(() => { expect(vi.mocked(console.warn)).toHaveBeenCalledWith('Console attachment detach failed:', expect.any(Error)) })
  })

  it('ignores a mobile input failure after pane teardown', async () => {
    const write = deferredWrite()
    const stringify = vi.fn(() => 'late write failure')
    const warning = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const controller = terminalController(write.promise)
    const useConsoleCatalog = (<S,>(selector: (state: ConsoleCatalogState) => S): S => selector(catalog))
    const view = render(<TerminalPane actor={{ kind: 'console', id: 'console-1' }} paneId="pane-1" active
      mobile controller={controller as never} useConsoleCatalog={useConsoleCatalog as never} />)
    await waitFor(() => { expect(controller.attach).toHaveBeenCalledOnce() })
    fireEvent.click(view.getByRole('button', { name: 'Esc' }))
    await waitFor(() => { expect(controller.write).toHaveBeenCalledOnce() })
    view.unmount()
    await act(async () => { await Promise.resolve() })
    warning.mockClear()
    write.reject({ toString: stringify })
    await act(async () => { await Promise.resolve() })
    expect(stringify).not.toHaveBeenCalled()
    expect(warning).not.toHaveBeenCalled()
    warning.mockRestore()
  })

  it('does not let an old mobile input failure replace a fresh attachment phase', async () => {
    let epoch = 0
    const write = deferredWrite()
    const controller = terminalController(write.promise)
    const useConsoleCatalog = (<S,>(selector: (state: ConsoleCatalogState) => S): S => selector({ ...catalog, connectionEpoch: epoch }))
    const props = { actor: { kind: 'console' as const, id: 'console-1' }, paneId: 'pane-1', active: true, mobile: true,
      controller: controller as never, useConsoleCatalog: useConsoleCatalog as never }
    const view = render(<TerminalPane {...props} />)
    await waitFor(() => { expect(controller.attach).toHaveBeenCalledOnce() })
    fireEvent.click(view.getByRole('button', { name: 'Esc' }))
    await waitFor(() => { expect(controller.write).toHaveBeenCalledOnce() })
    epoch = 1
    view.rerender(<TerminalPane {...props} />)
    await waitFor(() => { expect(controller.attach).toHaveBeenCalledTimes(2) })
    expect(screenPhase(view.container)).toBe('running')
    write.reject(new Error('old write failure'))
    await act(async () => { await Promise.resolve() })
    expect(screenPhase(view.container)).toBe('running')
    expect(view.queryByRole('alert')).toBeNull()
    view.unmount()
  })

  it('replaces the terminal attachment when the connection epoch changes', async () => {
    let epoch = 0
    let sequence = 0
    const controller = {
      attach: vi.fn(async () => {
        sequence += 1
        return { access: { attachmentId: `attachment-${sequence}`, capability: `capability-${sequence}` }, attachment: { oldestOutputByte: 0 } }
      }),
      read: vi.fn((_access, _cursor, _wait, signal: AbortSignal) => new Promise((_resolve, reject) => {
        signal.addEventListener('abort', () => { reject(abortReason(signal)) }, { once: true })
      })),
      write: vi.fn(), resize: vi.fn(), detach: vi.fn(async () => {}),
    }
    const useConsoleCatalog = (<S,>(selector: (state: ConsoleCatalogState) => S): S => selector({ ...catalog, connectionEpoch: epoch }))
    const props = {
      actor: { kind: 'console' as const, id: 'console-1' }, paneId: 'pane-1', active: true, mobile: false,
      controller: controller as never, useConsoleCatalog: useConsoleCatalog as never,
    }
    const view = render(<TerminalPane {...props} />)
    await waitFor(() => { expect(controller.attach).toHaveBeenCalledOnce() })
    epoch = 1
    view.rerender(<TerminalPane {...props} />)
    await waitFor(() => { expect(controller.attach).toHaveBeenCalledTimes(2) })
    expect(controller.detach).toHaveBeenCalledWith({ attachmentId: 'attachment-1', capability: 'capability-1' })
    view.unmount()
  })

  it('ignores a read observation that resolves after pane teardown', async () => {
    const observation = deferredObservation()
    const controller = {
      attach: vi.fn(async () => ({
        access: { attachmentId: 'attachment-1', capability: 'capability' },
        attachment: { oldestOutputByte: 0 },
      })),
      read: vi.fn(() => observation.promise), refresh: vi.fn(), write: vi.fn(), resize: vi.fn(), detach: vi.fn(async () => {}),
    }
    const useConsoleCatalog = (<S,>(selector: (state: ConsoleCatalogState) => S): S => selector(catalog))
    const view = render(<TerminalPane actor={{ kind: 'console', id: 'console-1' }} paneId="pane-1" active
      mobile={false} controller={controller as never} useConsoleCatalog={useConsoleCatalog as never} />)
    await waitFor(() => { expect(controller.read).toHaveBeenCalledOnce() })
    const terminal = terminalMocks.instances[0]!
    view.unmount()
    observation.resolve(endedObservation('late'))
    await act(async () => { await Promise.resolve() })
    expect(terminal.write).not.toHaveBeenCalled()
    expect(controller.refresh).not.toHaveBeenCalled()
  })

  it('ignores an old attachment observation after the connection epoch changes', async () => {
    let epoch = 0
    const oldObservation = deferredObservation()
    const controller = {
      attach: vi.fn(async () => ({
        access: { attachmentId: `attachment-${controller.attach.mock.calls.length}`, capability: 'capability' },
        attachment: { oldestOutputByte: 0 },
      })),
      read: vi.fn()
        .mockImplementationOnce(() => oldObservation.promise)
        .mockImplementation((_access, _cursor, _wait, signal: AbortSignal) => new Promise((_resolve, reject) => {
          signal.addEventListener('abort', () => { reject(abortReason(signal)) }, { once: true })
        })),
      refresh: vi.fn(), write: vi.fn(), resize: vi.fn(), detach: vi.fn(async () => {}),
    }
    const useConsoleCatalog = (<S,>(selector: (state: ConsoleCatalogState) => S): S => selector({ ...catalog, connectionEpoch: epoch }))
    const props = { actor: { kind: 'console' as const, id: 'console-1' }, paneId: 'pane-1', active: true, mobile: false,
      controller: controller as never, useConsoleCatalog: useConsoleCatalog as never }
    const view = render(<TerminalPane {...props} />)
    await waitFor(() => { expect(controller.read).toHaveBeenCalledOnce() })
    const oldTerminal = terminalMocks.instances[0]!
    epoch = 1
    view.rerender(<TerminalPane {...props} />)
    await waitFor(() => { expect(controller.attach).toHaveBeenCalledTimes(2) })
    oldObservation.resolve(endedObservation('late'))
    await act(async () => { await Promise.resolve() })
    expect(oldTerminal.write).not.toHaveBeenCalled()
    expect(controller.refresh).not.toHaveBeenCalled()
    view.unmount()
  })
})

function deferredObservation() {
  let resolve!: (value: ReturnType<typeof endedObservation>) => void
  const promise = new Promise<ReturnType<typeof endedObservation>>((done) => { resolve = done })
  return { promise, resolve }
}

function deferredWrite() {
  let reject!: (error: unknown) => void
  const promise = new Promise<void>((_resolve, fail) => { reject = fail })
  return { promise, reject }
}

function terminalController(write: Promise<void>) {
  let sequence = 0
  return {
    attach: vi.fn(async () => {
      sequence += 1
      return { access: { attachmentId: `attachment-${sequence}`, capability: `capability-${sequence}` }, attachment: { oldestOutputByte: 0 } }
    }),
    read: vi.fn((_access, _cursor, _wait, signal: AbortSignal) => new Promise((_resolve, reject) => {
      signal.addEventListener('abort', () => { reject(abortReason(signal)) }, { once: true })
    })),
    write: vi.fn(() => write), resize: vi.fn(), detach: vi.fn(async () => {}),
  }
}

function endedObservation(data: string) {
  return {
    attachment: { status: { kind: 'exited' as const, exitCode: 0, signal: null } },
    output: { kind: 'data' as const, dataBase64: btoa(data), nextByte: data.length },
    timedOut: false,
  }
}

function screenPhase(container: HTMLElement): string | null {
  return container.querySelector('[data-terminal-phase]')?.getAttribute('data-terminal-phase') ?? null
}
