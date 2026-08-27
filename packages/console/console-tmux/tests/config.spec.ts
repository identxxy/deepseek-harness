import { describe, expect, it } from 'vitest'
import { validateConfig, type Config } from '../src/config.ts'

const config: Config = {
  tmuxPath: 'tmux',
  serverName: 'dsh',
  shellPath: 'bash',
  shellArgs: [],
  term: 'xterm-256color',
  windowSizePolicy: 'largest',
  commandTimeoutMs: 5_000,
  commandGraceMs: 500,
  commandOutputBytes: 64_000,
  attachmentGraceMs: 500,
  attachmentIdleTtlMs: 60_000,
  reconcileIntervalMs: 5_000,
  outputRetentionBytes: 64_000,
  maxReadBytes: 16_000,
  maxOutputWaitersPerAttachment: 8,
  maxConsoles: 16,
  maxAttachmentsPerConsole: 4,
}

describe('tmux Console config', () => {
  it.each(['', 'has/slash', 'has space', '$(command)'])('rejects unsafe server name %j', (serverName) => {
    expect(() =>{  validateConfig({ ...config, serverName }) }).toThrow('serverName')
  })

  it('rejects output pages larger than attachment retention', () => {
    expect(() =>{  validateConfig({ ...config, maxReadBytes: config.outputRetentionBytes + 1 }) })
      .toThrow('maxReadBytes must not exceed outputRetentionBytes')
  })

  it('rejects shell arguments that tmux would reinterpret as one shell command', () => {
    expect(() =>{  validateConfig({ ...config, shellArgs: ['--noprofile'] }) }).toThrow('shellArgs')
  })

  it('accepts the complete shipped configuration', () => {
    expect(() =>{  validateConfig(config) }).not.toThrow()
  })
})
