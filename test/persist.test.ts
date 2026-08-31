import { describe, it, expect, vi } from 'vitest'
import { toEvent, makePersist } from '../src/client/collection.ts'
import type { SyncClient } from '../src/client/sync-client.ts'
import type { WriteBatch } from '../src/protocol.ts'

describe('toEvent', () => {
  it('maps an insert mutation to an insert event carrying the new value', () => {
    expect(toEvent({ type: 'insert', modified: { id: 'a', text: 'hi' } }, 'id')).toEqual({
      type: 'insert',
      value: { id: 'a', text: 'hi' },
    })
  })

  it('sends only the changed columns of an update, plus the key', () => {
    expect(
      toEvent(
        {
          type: 'update',
          changes: { text: 'new' },
          modified: { id: 'a', text: 'new', done: false },
          original: { id: 'a', text: 'old', done: false },
        },
        'id',
      ),
    ).toEqual({
      type: 'update',
      // `done` never travels: the writer didn't touch it, so nothing overwrites it
      value: { text: 'new', id: 'a' },
      previousValue: { id: 'a', text: 'old', done: false },
    })
  })

  it('keeps the key column of an update that changed it', () => {
    expect(
      toEvent({ type: 'update', changes: { id: 'b' }, modified: { id: 'b' }, original: { id: 'a' } }, 'id'),
    ).toEqual({ type: 'update', value: { id: 'b' }, previousValue: { id: 'a' } })
  })

  it('maps a delete mutation off the original value', () => {
    expect(toEvent({ type: 'delete', original: { id: 'a' } }, 'id')).toEqual({
      type: 'delete',
      value: { id: 'a' },
    })
  })
})

// makePersist only touches `send` + `waitForSeq`, so a two-method stub stands in
// for the whole SyncClient.
// `rejects` turns one of the two methods into the failing path: `send` for a
// server verdict, `waitOn` for a seq that never settles.
function mockClient(
  accepted: { channel: string; seq: number }[],
  rejects: { send?: Error; waitOn?: [channel: string, error: Error] } = {},
) {
  const send = vi.fn(async (_batches: WriteBatch[]) => {
    if (rejects.send) throw rejects.send
    return { accepted }
  })
  const waitForSeq = vi.fn(async (channel: string, _seq: number) => {
    if (rejects.waitOn?.[0] === channel) throw rejects.waitOn[1]
  })
  return { client: { send, waitForSeq } as unknown as SyncClient, send, waitForSeq }
}

// Stand-in "collections": identity is all the binding map keys off, so plain
// objects suffice.
const todos = { name: 'todos' } as any
const lists = { name: 'lists' } as any
const bindings = new Map<any, { channel: string; key: string }>([
  [todos, { channel: 'todos', key: 'id' }],
  [lists, { channel: 'lists', key: 'id' }],
])

describe('makePersist', () => {
  it('groups mutations by channel into one batch per collection', async () => {
    const { client, send } = mockClient([
      { channel: 'todos', seq: 1 },
      { channel: 'lists', seq: 2 },
    ])
    const persist = makePersist(client, bindings)

    await persist({
      transaction: {
        mutations: [
          { collection: todos, type: 'insert', modified: { id: 't1' } },
          { collection: lists, type: 'insert', modified: { id: 'l1' } },
          { collection: todos, type: 'update', changes: {}, modified: { id: 't2' }, original: { id: 't2-' } },
        ],
      },
    })

    expect(send).toHaveBeenCalledOnce()
    const batches = send.mock.calls[0][0] as WriteBatch[]
    expect(batches).toEqual([
      {
        channel: 'todos',
        ops: [
          { type: 'insert', value: { id: 't1' } },
          { type: 'update', value: { id: 't2' }, previousValue: { id: 't2-' } },
        ],
      },
      { channel: 'lists', ops: [{ type: 'insert', value: { id: 'l1' } }] },
    ])
  })

  it('drops mutations on collections it does not manage', async () => {
    const { client, send } = mockClient([{ channel: 'todos', seq: 1 }])
    const persist = makePersist(client, bindings)
    const foreign = { name: 'foreign' } as any

    await persist({
      transaction: {
        mutations: [
          { collection: todos, type: 'insert', modified: { id: 't1' } },
          { collection: foreign, type: 'insert', modified: { id: 'f1' } },
        ],
      },
    })

    const batches = send.mock.calls[0][0] as WriteBatch[]
    expect(batches).toEqual([{ channel: 'todos', ops: [{ type: 'insert', value: { id: 't1' } }] }])
  })

  it('does not POST when no mutation targets a managed collection', async () => {
    const { client, send, waitForSeq } = mockClient([])
    const persist = makePersist(client, bindings)
    const foreign = { name: 'foreign' } as any

    await persist({
      transaction: { mutations: [{ collection: foreign, type: 'insert', modified: { id: 'f1' } }] },
    })

    expect(send).not.toHaveBeenCalled()
    expect(waitForSeq).not.toHaveBeenCalled()
  })

  it('awaits settlement of every accepted seq (flicker-free overlay handoff)', async () => {
    const accepted = [
      { channel: 'todos', seq: 7 },
      { channel: 'lists', seq: 8 },
    ]
    const { client, waitForSeq } = mockClient(accepted)
    const persist = makePersist(client, bindings)

    await persist({
      transaction: {
        mutations: [
          { collection: todos, type: 'insert', modified: { id: 't1' } },
          { collection: lists, type: 'insert', modified: { id: 'l1' } },
        ],
      },
    })

    expect(waitForSeq).toHaveBeenCalledTimes(2)
    expect(waitForSeq).toHaveBeenCalledWith('todos', 7)
    expect(waitForSeq).toHaveBeenCalledWith('lists', 8)
  })
})

describe('makePersist rejection paths (what makes TanStack roll back)', () => {
  it('rejects with the server\'s own error instance, and never waits for a seq', async () => {
    const error = new Error('409: constraint')
    const { client, waitForSeq } = mockClient([], { send: error })
    const persist = makePersist(client, bindings)

    await expect(
      persist({ transaction: { mutations: [{ collection: todos, type: 'insert', modified: { id: 't1' } }] } }),
    ).rejects.toBe(error)
    expect(waitForSeq).not.toHaveBeenCalled()
  })

  it('rejects when one accepted seq never settles, after starting every wait', async () => {
    const error = new Error('write did not settle within 30000ms')
    const { client, waitForSeq } = mockClient(
      [
        { channel: 'todos', seq: 7 },
        { channel: 'lists', seq: 8 },
      ],
      { waitOn: ['lists', error] },
    )
    const persist = makePersist(client, bindings)

    await expect(
      persist({
        transaction: {
          mutations: [
            { collection: todos, type: 'insert', modified: { id: 't1' } },
            { collection: lists, type: 'insert', modified: { id: 'l1' } },
          ],
        },
      }),
    ).rejects.toBe(error)
    // Promise.all semantics: both waits were issued before the first rejection won
    expect(waitForSeq).toHaveBeenCalledTimes(2)
    expect(waitForSeq).toHaveBeenCalledWith('todos', 7)
    expect(waitForSeq).toHaveBeenCalledWith('lists', 8)
  })

  it('awaits every accepted seq even when the transaction also carries unmanaged mutations', async () => {
    const { client, send, waitForSeq } = mockClient([
      { channel: 'todos', seq: 3 },
      { channel: 'lists', seq: 4 },
    ])
    const persist = makePersist(client, bindings)
    const foreign = { name: 'foreign' } as any

    await persist({
      transaction: {
        mutations: [
          { collection: todos, type: 'insert', modified: { id: 't1' } },
          { collection: foreign, type: 'insert', modified: { id: 'f1' } },
          { collection: lists, type: 'insert', modified: { id: 'l1' } },
        ],
      },
    })

    expect((send.mock.calls[0][0] as WriteBatch[]).map((b) => b.channel)).toEqual(['todos', 'lists'])
    expect(waitForSeq).toHaveBeenCalledTimes(2)
    expect(waitForSeq).toHaveBeenCalledWith('todos', 3)
    expect(waitForSeq).toHaveBeenCalledWith('lists', 4)
  })
})
