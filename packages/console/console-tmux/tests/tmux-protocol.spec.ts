import { ConsoleId } from '@deepseek-ai/dsh-console'
import { describe, expect, it } from 'vitest'
import { consoleTmuxSessionName, parseConsoleTmuxSessionName } from '../src/tmux-protocol.ts'

describe('tmux Console session names', () => {
  const id = ConsoleId('123e4567-e89b-42d3-a456-426614174000')

  it('round-trips a lowercase UUID v4', () => {
    expect(consoleTmuxSessionName(id)).toBe(`dsh-${id}`)
    expect(parseConsoleTmuxSessionName(`dsh-${id}`)).toBe(id)
  })

  it.each(['not-a-uuid', '123e4567-e89b-12d3-a456-426614174000', '123E4567-E89B-42D3-A456-426614174000'])
  ('rejects invalid Console identity %s', (value) => {
    expect(() => consoleTmuxSessionName(ConsoleId(value))).toThrow('lowercase UUID v4')
  })

  it.each(['ordinary', 'dsh-invalid', 'dsh-123e4567-e89b-12d3-a456-426614174000'])
  ('does not claim an unowned session %s', (value) => {
    expect(parseConsoleTmuxSessionName(value)).toBeUndefined()
  })
})
