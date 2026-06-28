import { describe, it, expect } from 'vitest'
import { NonRetriableError, TanStackDBError } from '@tanstack/db'
import { WriteError, TransportError, toWriteReject } from '../src/client/errors.ts'

const res = (status: number, text: string) => ({ status, text: async () => text })

describe('toWriteReject', () => {
  it('parses the server WriteReject JSON body', async () => {
    const body = { error: 'enter "s3cret" to write', channel: 'todos' }
    expect(await toWriteReject(res(401, JSON.stringify(body)))).toEqual(body)
  })

  it('falls back to the raw text for a non-JSON body', async () => {
    expect(await toWriteReject(res(404, 'not found'))).toEqual({ error: 'not found' })
  })

  it('falls back to the status when the body is empty', async () => {
    expect(await toWriteReject(res(500, ''))).toEqual({ error: 'write failed (500)' })
  })

  it('ignores JSON that is not a WriteReject (no string error)', async () => {
    expect(await toWriteReject(res(400, '[1,2,3]'))).toEqual({ error: '[1,2,3]' })
  })
})

describe('WriteError', () => {
  it('carries status + the reject fields, message = the reason', () => {
    const e = new WriteError(409, { error: 'UNIQUE constraint failed: todos.id', constraint: 'UNIQUE: todos.id', channel: 'todos' })
    expect(e.name).toBe('WriteError')
    expect(e.message).toBe('UNIQUE constraint failed: todos.id')
    expect([e.status, e.constraint, e.channel]).toEqual([409, 'UNIQUE: todos.id', 'todos'])
  })

  it('slots into the TanStack DB error hierarchy (so apps catching it still work)', () => {
    const e = new WriteError(401, { error: 'unauthorized' })
    expect(e).toBeInstanceOf(Error)
    expect(e).toBeInstanceOf(TanStackDBError)
    expect(e).toBeInstanceOf(NonRetriableError)
  })
})

describe('TransportError', () => {
  it('is a retriable TanStackDBError (NOT NonRetriable) carrying the cause', () => {
    const cause = new Error('network down')
    const e = new TransportError('write request did not reach the server', { cause })
    expect(e.name).toBe('TransportError')
    expect(e).toBeInstanceOf(TanStackDBError)
    expect(e).not.toBeInstanceOf(NonRetriableError) // a retry-aware layer may re-send
    expect(e.cause).toBe(cause)
  })
})
