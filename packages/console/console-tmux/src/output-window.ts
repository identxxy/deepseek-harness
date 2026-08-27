import { ConsoleError } from '@deepseek-ai/dsh-console'
import type { ConsoleOutputRead } from '@deepseek-ai/dsh-console'

/** Bounded raw-byte tail with absolute whole-stream cursors. */
export class OutputWindow {
  private chunks: Array<{ bytes: Uint8Array; offset: number } | undefined> = []
  private head = 0
  private retained = 0
  private oldest = 0
  private next = 0

  /** @param retentionBytes - Maximum retained tail bytes. @param maxReadBytes - Maximum bytes returned per read. */
  constructor(private readonly retentionBytes: number, private readonly maxReadBytes: number) {}

  /** Absolute cursor of the oldest retained byte. */
  get oldestByte(): number { return this.oldest }
  /** Absolute cursor immediately after all observed bytes. */
  get nextByte(): number { return this.next }

  /**
   * Append raw output and retain only the configured tail.
   * @param chunk - Raw output bytes in delivery order.
   */
  append(chunk: Uint8Array): void {
    if (chunk.byteLength === 0) return
    this.next += chunk.byteLength
    if (chunk.byteLength >= this.retentionBytes) {
      this.chunks = [{ bytes: chunk.slice(chunk.byteLength - this.retentionBytes), offset: 0 }]
      this.head = 0
      this.retained = this.retentionBytes
      this.oldest = this.next - this.retentionBytes
      return
    }
    this.chunks.push({ bytes: chunk.slice(), offset: 0 })
    this.retained += chunk.byteLength
    let drop = Math.max(0, this.retained - this.retentionBytes)
    this.oldest += drop
    this.retained -= drop
    while (drop > 0) {
      const current = this.chunks[this.head]
      /* v8 ignore next -- head always identifies a retained chunk while drop is positive. */
      if (current === undefined) throw new Error('output window retention accounting is inconsistent')
      const available = current.bytes.byteLength - current.offset
      if (drop < available) {
        current.offset += drop
        drop = 0
      } else {
        drop -= available
        this.chunks[this.head] = undefined
        this.head += 1
      }
    }
    if (this.head >= 64 && this.head * 2 >= this.chunks.length) {
      this.chunks = this.chunks.slice(this.head)
      this.head = 0
    }
  }

  /**
   * Read a repeatable page without advancing shared state.
   * @param fromByte - Absolute whole-stream cursor.
   * @returns a fresh page or explicit retention gap.
   */
  read(fromByte: number): ConsoleOutputRead {
    if (!Number.isSafeInteger(fromByte) || fromByte < 0 || fromByte > this.next) {
      throw new ConsoleError('INVALID_CURSOR', `invalid console output cursor: ${String(fromByte)}`)
    }
    if (fromByte < this.oldest) return { kind: 'gap', oldestByte: this.oldest, nextByte: this.next }
    const count = Math.min(this.maxReadBytes, this.next - fromByte)
    const data = new Uint8Array(count)
    let skip = fromByte - this.oldest
    let written = 0
    for (let index = this.head; index < this.chunks.length && written < count; index += 1) {
      const chunk = this.chunks[index]
      /* v8 ignore next -- compaction removes discarded prefixes and the live suffix contains no holes. */
      if (chunk === undefined) break
      const available = chunk.bytes.byteLength - chunk.offset
      if (skip >= available) {
        skip -= available
        continue
      }
      const start = chunk.offset + skip
      const copied = Math.min(count - written, chunk.bytes.byteLength - start)
      data.set(chunk.bytes.subarray(start, start + copied), written)
      written += copied
      skip = 0
    }
    return {
      kind: 'data',
      data,
      fromByte,
      nextByte: fromByte + count,
      availableThroughByte: this.next,
    }
  }
}
