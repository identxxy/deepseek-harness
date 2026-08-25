import { describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import { ConsoleRuntime } from '@deepseek-ai/dsh-console'
import type {
  ConsoleAccess, ConsoleOpenResult, ConsoleOutputObservation, ConsoleOutputRead, ConsoleSignal,
  ConsoleSignalResult, ConsoleSize, ConsoleSnapshot, HumanShellOpenRequest,
} from '@deepseek-ai/dsh-console'

class StubConsoleRuntime extends ConsoleRuntime {
  openHumanShell(_request: HumanShellOpenRequest): Promise<ConsoleOpenResult> {
    return Promise.reject(new Error('not implemented'))
  }

  snapshot(_access: ConsoleAccess): ConsoleSnapshot {
    throw new Error('not implemented')
  }

  readOutput(_access: ConsoleAccess, _fromByte: number): ConsoleOutputRead {
    throw new Error('not implemented')
  }

  waitOutput(_access: ConsoleAccess, _fromByte: number, _signal: AbortSignal): Promise<ConsoleOutputObservation> {
    return Promise.reject(new Error('not implemented'))
  }

  write(_access: ConsoleAccess, _data: string): Promise<void> {
    return Promise.resolve()
  }

  resize(_access: ConsoleAccess, _size: ConsoleSize): Promise<void> {
    return Promise.resolve()
  }

  signal(_access: ConsoleAccess, _signal: ConsoleSignal): Promise<ConsoleSignalResult> {
    return Promise.resolve({ delivered: true, targetPgid: 42 })
  }

  stop(_access: ConsoleAccess): Promise<void> {
    return Promise.resolve()
  }
}

describe('ConsoleRuntime seam', () => {
  it('a concrete subclass registers as ctx.consoles', async () => {
    const ctx = new Context()
    await ctx.plugin(StubConsoleRuntime)
    await expect(ctx.consoles.signal({ consoleId: 'c' as never, capability: 'k' as never }, 'SIGINT'))
      .resolves.toEqual({ delivered: true, targetPgid: 42 })
  })

  it('mounting the abstract seam directly fails loudly', async () => {
    const ctx = new Context()
    await expect(ctx.plugin(ConsoleRuntime as unknown as typeof StubConsoleRuntime))
      .rejects.toThrow(/abstract console runtime seam/)
  })
})
