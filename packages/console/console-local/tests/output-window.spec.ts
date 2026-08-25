import { describe, expect, it } from 'vitest'
import { OutputWindow } from '../src/output-window.ts'

describe('OutputWindow', () => {
  it('ignores empty delivery chunks', () => {
    const output = new OutputWindow(8, 3)
    output.append(new Uint8Array())
    expect(output.read(0)).toMatchObject({ kind: 'data', data: new Uint8Array(), nextByte: 0 })
  })

  it('supports repeatable pagination with fresh byte arrays', () => {
    const output = new OutputWindow(8, 3)
    output.append(Uint8Array.from([1, 2, 3, 4, 5]))

    const first = output.read(0)
    const again = output.read(0)
    expect(first).toMatchObject({ kind: 'data', fromByte: 0, nextByte: 3, availableThroughByte: 5 })
    expect(again).toEqual(first)
    if (first.kind !== 'data' || again.kind !== 'data') throw new Error('expected data')
    expect(first.data).not.toBe(again.data)
    first.data[0] = 99
    expect(again.data).toEqual(Uint8Array.from([1, 2, 3]))
    expect(output.read(3)).toMatchObject({ kind: 'data', fromByte: 3, nextByte: 5, availableThroughByte: 5 })
  })

  it('reports retention gaps and rejects future cursors', () => {
    const output = new OutputWindow(4, 4)
    output.append(Uint8Array.from([1, 2, 3]))
    output.append(Uint8Array.from([4, 5, 6]))
    expect(output.read(0)).toEqual({ kind: 'gap', oldestByte: 2, nextByte: 6 })
    expect(output.read(2)).toMatchObject({ kind: 'data', data: Uint8Array.from([3, 4, 5, 6]) })
    expect(() => output.read(7)).toThrow(expect.objectContaining({ code: 'INVALID_CURSOR' }))
    expect(() => output.read(1.5)).toThrow(expect.objectContaining({ code: 'INVALID_CURSOR' }))
  })

  it('keeps the exact tail under sustained small chunks at a full window', () => {
    const output = new OutputWindow(5, 5)
    for (let value = 0; value < 100; value += 1) output.append(Uint8Array.of(value))
    expect(output.read(95)).toMatchObject({
      kind: 'data', data: Uint8Array.from([95, 96, 97, 98, 99]), nextByte: 100,
    })
    expect(output.read(94)).toEqual({ kind: 'gap', oldestByte: 95, nextByte: 100 })
  })

  it('retains only the direct tail of one oversized chunk', () => {
    const output = new OutputWindow(4, 4)
    output.append(Uint8Array.from({ length: 100 }, (_value, index) => index))
    expect(output.read(96)).toMatchObject({ kind: 'data', data: Uint8Array.from([96, 97, 98, 99]) })
    expect(output.read(0)).toEqual({ kind: 'gap', oldestByte: 96, nextByte: 100 })
  })

  it('releases backing arrays as complete chunks leave the retention window', () => {
    const output = new OutputWindow(10, 10)
    for (let index = 0; index < 20; index += 1) {
      output.append(new Uint8Array(index % 2 === 0 ? 6 : 4))
    }

    const chunks = (output as unknown as { chunks: Array<{ bytes: Uint8Array } | undefined> }).chunks
    expect(chunks.reduce((bytes, chunk) => bytes + (chunk?.bytes.byteLength ?? 0), 0)).toBeLessThanOrEqual(10)
  })
})
