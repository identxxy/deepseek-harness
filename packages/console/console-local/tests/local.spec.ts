import { mkdtemp, realpath, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import { afterEach, describe, expect, it } from 'vitest'
import { WorkspaceId } from '@deepseek-ai/dsh-workspace'
import LocalSubprocessRuntime from '@deepseek-ai/dsh-subprocess-local'
import LocalConsoleRuntime from '@deepseek-ai/dsh-console-local'

const roots: string[] = []
afterEach(async () => { await Promise.all(roots.splice(0).map(path => rm(path, { recursive: true, force: true }))) })

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
  throw new Error(`timed out waiting for terminal output ${JSON.stringify(expected)}`)
}

describe.skipIf(process.platform === 'win32')('LocalConsoleRuntime with real node-pty', () => {
  it('opens in the workspace, carries output and resize, then stops the process', async () => {
    const root = await mkdtemp(join(tmpdir(), 'dsh-console-'))
    roots.push(root)
    const cwd = await realpath(root)
    const workspaceId = WorkspaceId('integration-workspace')
    const ctx = new Context()
    ctx.provide('workspaceRegistry', {
      get: (id: typeof workspaceId) => id === workspaceId
        ? { id: workspaceId, path: cwd, status: async () => 'ok' as const }
        : undefined,
    } as never)
    const subprocessFiber = await ctx.plugin(LocalSubprocessRuntime)
    const consoleFiber = await ctx.plugin(LocalConsoleRuntime, {
      shellPath: '/bin/bash', shellArgs: ['--noprofile', '--norc', '-i'], term: 'xterm-256color',
      disposeGraceMs: 500, outputRetentionBytes: 64_000, maxReadBytes: 64_000, maxOutputWaitersPerConsole: 8,
    })
    try {
      const opened = await ctx.consoles.openHumanShell({ workspaceId, size: { rows: 24, cols: 80 } })
      const pid = opened.console.pid
      let cursor = 0
      const read = (): Uint8Array => {
        const result = ctx.consoles.readOutput(opened.access, cursor)
        if (result.kind !== 'data') throw new Error('unexpected output gap')
        cursor = result.nextByte
        return result.data
      }
      await ctx.consoles.write(opened.access, "printf 'DSH_MARKER:%s:%s\\n' \"$PWD\" \"$TERM\"\n")
      await eventuallyOutput(read, `DSH_MARKER:${cwd}:xterm-256color`)
      await ctx.consoles.resize(opened.access, { rows: 31, cols: 101 })
      await ctx.consoles.write(opened.access, "printf 'DSH_SIZE:'; stty size\n")
      await eventuallyOutput(read, 'DSH_SIZE:31 101')
      await ctx.consoles.stop(opened.access)
      expect(() => ctx.consoles.snapshot(opened.access)).toThrow(expect.objectContaining({ code: 'ACCESS_DENIED' }))
      expect(() => process.kill(pid, 0)).toThrow()
    } finally {
      await consoleFiber.dispose()
      await subprocessFiber.dispose()
    }
  })
})
