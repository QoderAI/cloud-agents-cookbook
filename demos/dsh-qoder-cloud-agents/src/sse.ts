/**
 * Minimal Server-Sent Events frame parser for the Qoder Cloud session stream.
 * Browser `EventSource` cannot send a Bearer header, so the stream is read
 * through `fetch` and decoded here.
 *
 * @module dsh-qoder-cloud-agents/sse
 */

/** One dispatched SSE frame. Comment-only frames (heartbeats) are dropped. */
export interface SseFrame {
  readonly id?: string
  readonly event: string
  readonly data: string
}

/**
 * Incremental parser: feed decoded text chunks, receive complete frames.
 * Handles `\n`, `\r\n` and `\r` line endings and frames split across chunks.
 */
export class SseParser {
  private buffer = ''
  private id: string | undefined
  private event: string | undefined
  private data: string[] = []

  /**
   * Feed one decoded chunk.
   * @param chunk - the next piece of the response body.
   * @returns frames completed by this chunk, in order.
   */
  push(chunk: string): SseFrame[] {
    this.buffer += chunk
    const frames: SseFrame[] = []
    for (;;) {
      const match = /\r\n|\r|\n/.exec(this.buffer)
      if (match === null) break
      // A trailing lone `\r` may be the first half of `\r\n`; wait for more.
      if (match[0] === '\r' && match.index === this.buffer.length - 1) break
      const line = this.buffer.slice(0, match.index)
      this.buffer = this.buffer.slice(match.index + match[0].length)
      const frame = this.line(line)
      if (frame !== undefined) frames.push(frame)
    }
    return frames
  }

  private line(line: string): SseFrame | undefined {
    if (line === '') return this.dispatch()
    if (line.startsWith(':')) return undefined
    const colon = line.indexOf(':')
    const field = colon < 0 ? line : line.slice(0, colon)
    let value = colon < 0 ? '' : line.slice(colon + 1)
    if (value.startsWith(' ')) value = value.slice(1)
    switch (field) {
      case 'id':
        if (!value.includes('\0')) this.id = value
        break
      case 'event':
        this.event = value
        break
      case 'data':
        this.data.push(value)
        break
      default:
        break
    }
    return undefined
  }

  private dispatch(): SseFrame | undefined {
    const data = this.data
    const event = this.event
    this.data = []
    this.event = undefined
    if (data.length === 0) return undefined
    return {
      ...this.id === undefined ? {} : { id: this.id },
      event: event ?? 'message',
      data: data.join('\n'),
    }
  }
}
