import { describe, it, expect, vi, beforeEach } from 'vitest'
import type { SequencedBatch } from '../src/protocol.ts'

// A fake PartySocket: records constructor opts, lets the test fire 'message'
// events, and exposes a static fetch() like the real default export.
const hoisted = vi.hoisted(() => {
  class FakePartySocket {
    static instances: FakePartySocket[] = []
    static fetch = vi.fn(async (_info: unknown, _init?: unknown): Promise<any> => ({
      ok: true,
      status: 200,
      text: async () => '',
      json: async () => ({ accepted: [] }),
    }))
    CONNECTING = 0
    OPEN = 1
    readyState = 1
    opts: any
    private listeners: Record<string, ((e: any) => void)[]> = {}
    constructor(opts: any) {
      this.opts = opts
      FakePartySocket.instances.push(this)
    }
    addEventListener(type: string, h: (e: any) => void) {
      ;(this.listeners[type] ??= []).push(h)
    }
    removeEventListener(type: string, h: (e: any) => void) {
      this.listeners[type] = (this.listeners[type] ?? []).filter((x) => x !== h)
    }
    emit(type: string, e: any) {
      for (const h of this.listeners[type] ?? []) h(e)
    }
  }
  return { FakePartySocket }
})

vi.mock('partysocket', () => ({ default: hoisted.FakePartySocket }))

const { partyTransport } = await import('../src/client/party-db.ts')
const Fake = hoisted.FakePartySocket

function lastSocket() {
  return Fake.instances[Fake.instances.length - 1]
}

const message = (batch: SequencedBatch) => ({ data: JSON.stringify(batch) })

beforeEach(() => {
  Fake.instances.length = 0
  Fake.fetch.mockClear()
})

describe('partyTransport reconnect query (?since tracking)', () => {
  it('asks for a full snapshot (no ?since) before any batch is seen', () => {
    partyTransport({ host: 'example.com', room: 'r1' })
    const query = lastSocket().opts.query
    expect(query()).toEqual({})
  })

  it('asks for the delta since the highest applied seq after batches arrive', () => {
    const transport = partyTransport({ host: 'example.com', room: 'r1' })
    transport.subscribe(() => {})

    lastSocket().emit('message', message({ channel: 'todos', seq: 7, ops: [] }))
    expect(lastSocket().opts.query()).toEqual({ since: '7' })
  })

  it('tracks the max seq, not the last — an out-of-order straggler cannot lower it', () => {
    const transport = partyTransport({ host: 'example.com', room: 'r1' })
    transport.subscribe(() => {})

    lastSocket().emit('message', message({ channel: 'todos', seq: 7, ops: [] }))
    lastSocket().emit('message', message({ channel: 'todos', seq: 3, ops: [] }))
    expect(lastSocket().opts.query()).toEqual({ since: '7' })
  })

  it('delivers the parsed batch to the subscriber', () => {
    const transport = partyTransport({ host: 'example.com', room: 'r1' })
    const seen: SequencedBatch[] = []
    transport.subscribe((b) => seen.push(b))

    const batch: SequencedBatch = { channel: 'todos', seq: 1, ops: [{ type: 'insert', value: { id: 'a' } }] }
    lastSocket().emit('message', message(batch))
    expect(seen).toEqual([batch])
  })

  it('stops delivering after the subscription is torn down', () => {
    const transport = partyTransport({ host: 'example.com', room: 'r1' })
    const seen: SequencedBatch[] = []
    const off = transport.subscribe((b) => seen.push(b))
    off()

    lastSocket().emit('message', message({ channel: 'todos', seq: 1, ops: [] }))
    expect(seen).toEqual([])
  })
})

describe('partyTransport send', () => {
  it('POSTs the batches as JSON and returns the parsed ack', async () => {
    Fake.fetch.mockResolvedValueOnce({
      ok: true,
      status: 200,
      text: async () => '',
      json: async () => ({ accepted: [{ channel: 'todos', seq: 1 }] }),
    })
    const transport = partyTransport({ host: 'example.com', room: 'r1' })

    const ack = await transport.send([{ channel: 'todos', ops: [{ type: 'insert', value: { id: 'a' } }] }])
    expect(ack).toEqual({ accepted: [{ channel: 'todos', seq: 1 }] })

    const [, init] = Fake.fetch.mock.calls[0]
    expect((init as any).method).toBe('POST')
    expect(JSON.parse((init as any).body)).toEqual([
      { channel: 'todos', ops: [{ type: 'insert', value: { id: 'a' } }] },
    ])
  })

  it('throws when the write is rejected by the server', async () => {
    Fake.fetch.mockResolvedValueOnce({
      ok: false,
      status: 400,
      text: async () => 'unknown channel: todos',
      json: async () => ({}),
    })
    const transport = partyTransport({ host: 'example.com', room: 'r1' })

    await expect(transport.send([{ channel: 'todos', ops: [] }])).rejects.toThrow(/400/)
  })
})

describe('partyTransport isConnecting', () => {
  it('reflects the socket readyState', () => {
    const transport = partyTransport({ host: 'example.com', room: 'r1' })
    const socket = lastSocket()

    socket.readyState = socket.OPEN
    expect(transport.isConnecting?.()).toBe(false)
    socket.readyState = socket.CONNECTING
    expect(transport.isConnecting?.()).toBe(true)
  })
})
