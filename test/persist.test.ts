import { describe, it, expect, vi } from 'vitest'
import { toEvent, makePersist } from '../src/client/collection.ts'
import type { SyncClient } from '../src/client/sync-client.ts'
import type { WriteBatch } from '../src/protocol.ts'

describe('toEvent', () => {
  it('maps an insert mutation to an insert event carrying the new value', () => {
    expect(toEvent({ type: 'insert', modified: { id: 'a', text: 'hi' } })).toEqual({
      type: 'insert',
      value: { id: 'a', text: 'hi' },
    })
  })

  it('maps an update mutation, keeping the prior value for reconciliation', () => {
    expect(
      toEvent({ type: 'update', modified: { id: 'a', text: 'new' }, original: { id: 'a', text: 'old' } }),
    ).toEqual({
      type: 'update',
      value: { id: 'a', text: 'new' },
      previousValue: { id: 'a', text: 'old' },
    })
  })

  it('maps a delete mutation off the original value', () => {
    expect(toEvent({ type: 'delete', original: { id: 'a' } })).toEqual({
      type: 'delete',
      value: { id: 'a' },
    })
  })
})

// makePersist only touches `send` + `waitForSeq`, so a two-method stub stands in
// for the whole SyncClient.
function mockClient(accepted: { channel: string; seq: number }[]) {
  const send = vi.fn(async (_batches: WriteBatch[]) => ({ accepted }))
  const waitForSeq = vi.fn(async (_channel: string, _seq: number) => {})
  return { client: { send, waitForSeq } as unknown as SyncClient, send, waitForSeq }
}

// Stand-in "collections": identity is all channelOf keys off, so plain objects suffice.
const todos = { name: 'todos' } as any
const lists = { name: 'lists' } as any
const channelOf = new Map<any, string>([
  [todos, 'todos'],
  [lists, 'lists'],
])

describe('makePersist', () => {
  it('groups mutations by channel into one batch per collection', async () => {
    const { client, send } = mockClient([
      { channel: 'todos', seq: 1 },
      { channel: 'lists', seq: 2 },
    ])
    const persist = makePersist(client, channelOf)

    await persist({
      transaction: {
        mutations: [
          { collection: todos, type: 'insert', modified: { id: 't1' } },
          { collection: lists, type: 'insert', modified: { id: 'l1' } },
          { collection: todos, type: 'update', modified: { id: 't2' }, original: { id: 't2-' } },
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
    const persist = makePersist(client, channelOf)
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
    const persist = makePersist(client, channelOf)
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
    const persist = makePersist(client, channelOf)

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
