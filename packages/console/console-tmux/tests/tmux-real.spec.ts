import { execFile } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { mkdtemp, realpath, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { promisify } from 'node:util'
import { Context } from '@deepseek-ai/cordis'
import { WorkspaceId } from '@deepseek-ai/dsh-workspace'
import { afterEach, describe, expect, it } from 'vitest'
import LocalSubprocessRuntime from '@deepseek-ai/dsh-subprocess-local'
import TmuxConsoleRuntime, { consoleTmuxSessionName } from '../src/index.ts'

const execFileAsync = promisify(execFile)
const roots: string[] = []
const servers: string[] = []

afterEach(async () => {
  await Promise.all(servers.splice(0).map(async (server) => {
    try {
      await execFileAsync('tmux', ['-L', server, 'kill-server'])
    } catch {
      // A terminated test server is already clean.
    }
  }))
  await Promise.all(roots.splice(0).map(path => rm(path, { recursive: true, force: true })))
})

async function openRuntime(serverName: string, cwd: string) {
  const ctx = new Context()
  const workspaceId = WorkspaceId('integration-workspace')
  ctx.provide('workspaceRegistry', {
    get: (id: typeof workspaceId) => id === workspaceId
      ? { id: workspaceId, path: cwd, status: async () => 'ok' as const }
      : undefined,
  } as never)
  const subprocessFiber = await ctx.plugin(LocalSubprocessRuntime)
  const consoleFiber = await ctx.plugin(TmuxConsoleRuntime, {
    tmuxPath: 'tmux', serverName, shellPath: '/bin/bash', shellArgs: [], term: 'xterm-256color',
    windowSizePolicy: 'largest', commandTimeoutMs: 5_000, commandGraceMs: 500, commandOutputBytes: 64_000,
    attachmentGraceMs: 500, attachmentIdleTtlMs: 60_000, reconcileIntervalMs: 5_000,
    outputRetentionBytes: 64_000, maxReadBytes: 64_000, maxOutputWaitersPerAttachment: 8,
    maxConsoles: 8, maxAttachmentsPerConsole: 4,
  })
  return { ctx, workspaceId, consoleFiber, subprocessFiber }
}

async function eventuallyOutput(
  read: () => Uint8Array,
  expected: string,
): Promise<string> {
  const deadline = Date.now() + 5_000
  let text = ''
  while (Date.now() < deadline) {
    text += Buffer.from(read()).toString('utf8')
    if (text.includes(expected)) return text
    await new Promise(resolve => setTimeout(resolve, 20))
  }
  throw new Error(`timed out waiting for terminal output ${JSON.stringify(expected)}; observed ${JSON.stringify(text.slice(-2_000))}`)
}

describe.skipIf(process.platform === 'win32')('TmuxConsoleRuntime with real tmux and node-pty', () => {
  it('survives Web detach and Host restart, then terminates only on explicit request', async () => {
    const root = await mkdtemp(join(tmpdir(), 'dsh-console-tmux-'))
    roots.push(root)
    const cwd = await realpath(root)
    const serverName = `dsh-test-${process.pid}-${randomUUID()}`
    servers.push(serverName)

    const firstHost = await openRuntime(serverName, cwd)
    const created = await firstHost.ctx.consoles.create({
      workspaceId: firstHost.workspaceId, title: 'Integration shell', initialSize: { rows: 24, cols: 80 },
    })
    const sessionName = consoleTmuxSessionName(created.id)
    await execFileAsync('tmux', ['-L', serverName, 'new-window', '-d', '-t', sessionName])
    await expect(execFileAsync('tmux', ['-L', serverName, 'show-window-options', '-gv', 'window-size']))
      .resolves.toMatchObject({ stdout: 'largest\n' })
    await expect(execFileAsync('tmux', ['-L', serverName, 'show-window-options', '-v', '-t', `${sessionName}:1`, 'window-size']))
      .resolves.toMatchObject({ stdout: '' })
    const attached = await firstHost.ctx.consoles.attach({ consoleId: created.id, size: { rows: 24, cols: 80 } })
    let cursor = 0
    const read = (): Uint8Array => {
      const output = firstHost.ctx.consoles.readOutput(attached.access, cursor)
      if (output.kind !== 'data') throw new Error('unexpected output gap')
      cursor = output.nextByte
      return output.data
    }
    await firstHost.ctx.consoles.write(attached.access, "printf 'DSH_MARKER:%s:%s\\n' \"$PWD\" \"$TERM\"\n")
    await eventuallyOutput(read, `DSH_MARKER:${cwd}:tmux-256color`)
    await firstHost.ctx.consoles.detach(attached.access)
    await execFileAsync('tmux', ['-L', serverName, 'set-window-option', '-t', `${sessionName}:0`, 'window-size', 'smallest'])
    await execFileAsync('tmux', ['-L', serverName, 'set-window-option', '-t', `${sessionName}:1`, 'window-size', 'smallest'])
    await firstHost.consoleFiber.dispose()
    await firstHost.subprocessFiber.dispose()
    await expect(execFileAsync('tmux', ['-L', serverName, 'has-session', '-t', consoleTmuxSessionName(created.id)]))
      .resolves.toBeDefined()

    const secondHost = await openRuntime(serverName, cwd)
    for (const index of ['0', '1']) {
      await expect(execFileAsync('tmux', ['-L', serverName, 'show-window-options', '-v', '-t', `${sessionName}:${index}`, 'window-size']))
        .resolves.toMatchObject({ stdout: 'largest\n' })
    }
    await expect(secondHost.ctx.consoles.list()).resolves.toEqual([
      expect.objectContaining({ id: created.id, title: 'Integration shell', status: { kind: 'running' } }),
    ])
    await rm(root, { recursive: true, force: true })
    const reattached = await secondHost.ctx.consoles.attach({ consoleId: created.id, size: { rows: 24, cols: 80 } })
    await secondHost.ctx.consoles.detach(reattached.access)
    await secondHost.ctx.consoles.terminate(created.id)
    await expect(execFileAsync('tmux', ['-L', serverName, 'has-session', '-t', consoleTmuxSessionName(created.id)]))
      .rejects.toBeDefined()
    await secondHost.consoleFiber.dispose()
    await secondHost.subprocessFiber.dispose()
  }, 15_000)
})
