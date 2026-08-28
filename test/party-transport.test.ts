import { describe, it, expect, vi, beforeEach } from 'vitest'
import type { SequencedBatch } from '../src/protocol.ts'
import { AuthError } from '../src/client/errors.ts'

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

const message = (frame: unknown) => ({ data: JSON.stringify(frame) })
// a raw frame: what the socket delivers when it isn't our JSON at all
const raw = (data: unknown) => ({ data })
// the init object of the i-th write POST (headers, method, body)
const writeInit = (i = 0) => Fake.fetch.mock.calls[i][1] as any

// a transport with a subscriber attached, which every frame test needs
function subscribed() {
  const transport = partyTransport({ host: 'example.com', room: 'r1' })
  const seen: SequencedBatch[] = []
  transport.subscribe((b) => seen.push(b))
  return { transport, seen, socket: lastSocket() }
}

beforeEach(() => {
  Fake.instances.length = 0
  Fake.fetch.mockClear()
})

describe('partyTransport reconnect query (?since tracking)', () => {
  it('asks for a full snapshot (no ?since) before any batch is seen, marked as party-db traffic', () => {
    partyTransport({ host: 'example.com', room: 'r1' })
    const query = lastSocket().opts.query
    // the literal marker value is the wire contract a composed host routes on —
    // pinned here so a rename shows up as a breaking change.
    expect(query()).toEqual({ proto: 'party-db' })
  })

  it('asks for the delta since the highest applied seq after batches arrive', () => {
    const transport = partyTransport({ host: 'example.com', room: 'r1' })
    transport.subscribe(() => {})

    lastSocket().emit('message', message({ channel: 'todos', seq: 7, ops: [] }))
    expect(lastSocket().opts.query()).toEqual({ proto: 'party-db', since: '7' })
  })

  it('tracks the max seq, not the last — an out-of-order straggler cannot lower it', () => {
    const transport = partyTransport({ host: 'example.com', room: 'r1' })
    transport.subscribe(() => {})

    lastSocket().emit('message', message({ channel: 'todos', seq: 7, ops: [] }))
    lastSocket().emit('message', message({ channel: 'todos', seq: 3, ops: [] }))
    expect(lastSocket().opts.query()).toEqual({ proto: 'party-db', since: '7' })
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

    const [info, init] = Fake.fetch.mock.calls[0]
    // the write POST carries the same party-db marker as the connect
    expect((info as any).query).toEqual({ proto: 'party-db' })
    expect((init as any).method).toBe('POST')
    expect(JSON.parse((init as any).body)).toEqual([
      { channel: 'todos', ops: [{ type: 'insert', value: { id: 'a' } }] },
    ])
  })

  it('throws a WriteError carrying the status + parsed reject (so apps manage it by kind)', async () => {
    Fake.fetch.mockResolvedValueOnce({
      ok: false,
      status: 409,
      text: async () => JSON.stringify({ error: 'UNIQUE constraint failed: todos.id', constraint: 'UNIQUE: todos.id', channel: 'todos' }),
    })
    const transport = partyTransport({ host: 'example.com', room: 'r1' })

    await expect(transport.send([{ channel: 'todos', ops: [] }])).rejects.toMatchObject({
      name: 'WriteError',
      status: 409,
      message: 'UNIQUE constraint failed: todos.id',
      constraint: 'UNIQUE: todos.id',
      channel: 'todos',
    })
  })

  it('falls back cleanly when the rejection body is not JSON (a bare 404/proxy error)', async () => {
    Fake.fetch.mockResolvedValueOnce({ ok: false, status: 404, text: async () => 'not found' })
    const transport = partyTransport({ host: 'example.com', room: 'r1' })

    await expect(transport.send([{ channel: 'todos', ops: [] }])).rejects.toMatchObject({
      name: 'WriteError',
      status: 404,
      message: 'not found',
    })
  })

  it('wraps a no-response failure as a (retriable) TransportError, not a WriteError', async () => {
    const cause = new Error('Failed to fetch')
    Fake.fetch.mockRejectedValueOnce(cause)
    const transport = partyTransport({ host: 'example.com', room: 'r1' })

    await expect(transport.send([{ channel: 'todos', ops: [] }])).rejects.toMatchObject({
      name: 'TransportError',
      cause,
    })
  })
})

describe('partyTransport 1008 (policy violation) is terminal', () => {
  const closeEvent = (code: number, reason = '') => ({ code, reason })

  it('does not reconnect on a 1008 close (shouldReconnectOnClose returns false)', () => {
    partyTransport({ host: 'example.com', room: 'r1' })
    const { shouldReconnectOnClose } = lastSocket().opts
    expect(shouldReconnectOnClose(closeEvent(1008))).toBe(false)
  })

  it('keeps the default reconnect for other close codes', () => {
    partyTransport({ host: 'example.com', room: 'r1' })
    const { shouldReconnectOnClose } = lastSocket().opts
    // 1006 network, 1011 server, 1000 normal — all stay on the reconnect path.
    expect(shouldReconnectOnClose(closeEvent(1006))).toBe(true)
    expect(shouldReconnectOnClose(closeEvent(1011))).toBe(true)
    expect(shouldReconnectOnClose(closeEvent(1000))).toBe(true)
  })

  it('surfaces an AuthError to onAuthError subscribers on a 1008 close', () => {
    const transport = partyTransport({ host: 'example.com', room: 'r1' })
    const seen: AuthError[] = []
    transport.onAuthError?.((e) => seen.push(e))

    lastSocket().emit('close', closeEvent(1008, 'not a member of this room'))

    expect(seen).toHaveLength(1)
    expect(seen[0]).toBeInstanceOf(AuthError)
    expect(seen[0]).toMatchObject({ name: 'AuthError', code: 1008, message: 'not a member of this room' })
  })

  it('falls back to a default message when the 1008 close carries no reason', () => {
    const transport = partyTransport({ host: 'example.com', room: 'r1' })
    const seen: AuthError[] = []
    transport.onAuthError?.((e) => seen.push(e))

    lastSocket().emit('close', closeEvent(1008))
    expect(seen[0].message).toMatch(/1008/)
  })

  it('does not surface an AuthError for non-1008 closes', () => {
    const transport = partyTransport({ host: 'example.com', room: 'r1' })
    const seen: AuthError[] = []
    transport.onAuthError?.((e) => seen.push(e))

    lastSocket().emit('close', closeEvent(1006))
    lastSocket().emit('close', closeEvent(1011))
    expect(seen).toEqual([])
  })

  it('stops delivering after onAuthError is unsubscribed', () => {
    const transport = partyTransport({ host: 'example.com', room: 'r1' })
    const seen: AuthError[] = []
    const off = transport.onAuthError?.((e) => seen.push(e))
    off?.()

    lastSocket().emit('close', closeEvent(1008))
    expect(seen).toEqual([])
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

describe('partyTransport token attachment', () => {
  it('carries a static token on the connect query and as a bearer header on the write', async () => {
    const transport = partyTransport({ host: 'example.com', room: 'r1', token: 'tok-1' })
    expect(lastSocket().opts.query()).toEqual({ proto: 'party-db', token: 'tok-1' })

    await transport.send([{ channel: 'todos', ops: [{ type: 'insert', value: { id: 'a' } }] }])
    expect(writeInit().headers.authorization).toBe('Bearer tok-1')
  })

  it('re-reads a function token on every write and every reconnect query', async () => {
    const token = vi.fn<() => string>()
    token.mockReturnValueOnce('a').mockReturnValueOnce('b').mockReturnValue('c')
    const transport = partyTransport({ host: 'example.com', room: 'r1', token })

    await transport.send([{ channel: 'todos', ops: [] }])
    await transport.send([{ channel: 'todos', ops: [] }])
    expect(writeInit(0).headers.authorization).toBe('Bearer a')
    expect(writeInit(1).headers.authorization).toBe('Bearer b')
    // the connect query reads the same source, so a refreshed token sticks
    expect(lastSocket().opts.query()).toEqual({ proto: 'party-db', token: 'c' })
  })

  it('sends no token key and no authorization header when the room is not gated', async () => {
    const transport = partyTransport({ host: 'example.com', room: 'r1' })
    expect(lastSocket().opts.query()).not.toHaveProperty('token')

    await transport.send([{ channel: 'todos', ops: [] }])
    expect(writeInit().headers).not.toHaveProperty('authorization')
  })

  it('composes the token with ?since once a batch has been applied', () => {
    const transport = partyTransport({ host: 'example.com', room: 'r1', token: 'tok-1' })
    transport.subscribe(() => {})

    lastSocket().emit('message', message({ channel: 'todos', seq: 7, ops: [] }))
    expect(lastSocket().opts.query()).toEqual({ proto: 'party-db', since: '7', token: 'tok-1' })
  })
})

describe('partyTransport drops frames that are not ours', () => {
  it('drops a binary frame and text that is not JSON, then delivers the next real batch', () => {
    const { seen, socket } = subscribed()

    expect(() => socket.emit('message', raw('not json'))).not.toThrow()
    expect(() => socket.emit('message', raw(new ArrayBuffer(4)))).not.toThrow()
    expect(seen).toEqual([])

    const batch: SequencedBatch = { channel: 'todos', seq: 4, ops: [{ type: 'insert', value: { id: 'a' } }] }
    socket.emit('message', message(batch))
    expect(seen).toEqual([batch])
    expect(socket.opts.query()).toEqual({ proto: 'party-db', since: '4' })
  })

  it('drops JSON that is not a batch — no channel, or no ops — without moving the cursor', () => {
    const { seen, socket } = subscribed()

    socket.emit('message', message({ type: 'cf_agent_stream', seq: 99 }))
    socket.emit('message', message({ channel: 'todos', seq: 99 })) // no ops
    socket.emit('message', message({ ops: [], seq: 99 })) // no channel
    socket.emit('message', message(null))
    socket.emit('message', message(['todos']))

    expect(seen).toEqual([])
    expect(socket.opts.query()).toEqual({ proto: 'party-db' })
  })
})

