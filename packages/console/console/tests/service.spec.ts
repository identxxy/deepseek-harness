import { Context } from '@deepseek-ai/cordis'
import {
  ConsoleAttachmentCapability, ConsoleAttachmentId, ConsoleId, ConsoleRuntime,
} from '@deepseek-ai/dsh-console'
import type {
  ConsoleAttachRequest, ConsoleAttachmentAccess, ConsoleAttachmentOpenResult, ConsoleAttachmentSnapshot,
  ConsoleCreateRequest, ConsoleOutputObservation, ConsoleOutputRead, ConsoleSize, ConsoleSnapshot,
} from '@deepseek-ai/dsh-console'
import { describe, expect, it } from 'vitest'

const consoleSnapshot: ConsoleSnapshot = {
  id: ConsoleId('c'), workspaceId: 'w' as never, cwd: '/w', title: 'Shell',
  createdAt: '2026-08-26T09:00:00.000Z', archived: false, status: { kind: 'running' },
}
const attachmentSnapshot: ConsoleAttachmentSnapshot = {
  id: ConsoleAttachmentId('a'), consoleId: consoleSnapshot.id, size: { rows: 24, cols: 80 },
  status: { kind: 'running' }, oldestOutputByte: 0, nextOutputByte: 0,
}
const access: ConsoleAttachmentAccess = {
  attachmentId: attachmentSnapshot.id, capability: ConsoleAttachmentCapability('k'),
}

class StubConsoleRuntime extends ConsoleRuntime {
  list(): Promise<readonly ConsoleSnapshot[]> { return Promise.resolve([consoleSnapshot]) }
  snapshot(): ConsoleSnapshot { return consoleSnapshot }
  create(_request: ConsoleCreateRequest): Promise<ConsoleSnapshot> { return Promise.resolve(consoleSnapshot) }
  rename(): Promise<ConsoleSnapshot> { return Promise.resolve(consoleSnapshot) }
  setArchived(): Promise<ConsoleSnapshot> { return Promise.resolve(consoleSnapshot) }
  attach(_request: ConsoleAttachRequest): Promise<ConsoleAttachmentOpenResult> {
    return Promise.resolve({ access, attachment: attachmentSnapshot })
  }
  attachmentSnapshot(): ConsoleAttachmentSnapshot { return attachmentSnapshot }
  readOutput(): ConsoleOutputRead { return { kind: 'data', data: new Uint8Array(), fromByte: 0, nextByte: 0, availableThroughByte: 0 } }
  waitOutput(): Promise<ConsoleOutputObservation> { return Promise.resolve({ attachment: attachmentSnapshot, output: this.readOutput() }) }
  write(): Promise<void> { return Promise.resolve() }
  resize(_access: ConsoleAttachmentAccess, _size: ConsoleSize): Promise<void> { return Promise.resolve() }
  detach(): Promise<void> { return Promise.resolve() }
  terminate(): Promise<void> { return Promise.resolve() }
}

describe('ConsoleRuntime seam', () => {
  it('publishes constructors for durable and attachment identities', async () => {
    const seam = await import('@deepseek-ai/dsh-console')
    expect(seam).toHaveProperty('ConsoleId')
    expect(seam).toHaveProperty('ConsoleAttachmentId')
    expect(seam).toHaveProperty('ConsoleAttachmentCapability')
  })

  it('registers one concrete durable Console provider as ctx.consoles', async () => {
    const ctx = new Context()
    await ctx.plugin(StubConsoleRuntime)
    await expect(ctx.consoles.list()).resolves.toEqual([consoleSnapshot])
    await expect(ctx.consoles.attach({ consoleId: consoleSnapshot.id, size: { rows: 24, cols: 80 } }))
      .resolves.toEqual({ access, attachment: attachmentSnapshot })
  })

  it('mounting the abstract seam directly fails loudly', async () => {
    const ctx = new Context()
    await expect(ctx.plugin(ConsoleRuntime as unknown as typeof StubConsoleRuntime))
      .rejects.toThrow(/abstract console runtime seam/)
  })
})
