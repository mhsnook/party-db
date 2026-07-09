import { describe, it, expect } from 'vitest'
import { SELF } from 'cloudflare:test'
import type { WriteReject } from '../../src/protocol.ts'
import { insert, partyUrl, roomHeader } from './helpers.ts'

// The 409/500 split: a constraint rejection is the database's verdict on the
// data and travels back faithfully (covered in sync.test.ts); an internal fault
// must NOT — it becomes a generic 500 with the detail logged server-side. The
// `Faulty` party's `untabled` collection has a schema but no table, so a write
// to it is a reliably-internal failure.
const post = (room: string, body: unknown) =>
  SELF.fetch(partyUrl('faulty', room), {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...roomHeader(room) },
    body: JSON.stringify(body),
  })

describe('internal write failures are a generic 500, not an echoed 409', () => {
  it('hides the schema detail and keeps serving healthy channels', async () => {
    const room = 'internal-error'
    const res = await post(room, [{ channel: 'untabled', ops: [{ type: 'insert', value: { id: 'a' } }] }])
    expect(res.status).toBe(500)
    const body = (await res.json()) as WriteReject
    // the leak this guards against: no table name, no SQLite phrasing
    expect(body.error).not.toMatch(/untabled/)
    expect(body.error).not.toMatch(/no such table/)
    expect(body.error).toBe('internal error applying write')
    expect(body.constraint).toBeUndefined()

    // the same DO still serves a healthy write afterwards
    expect((await post(room, insert('ok', 'still works'))).status).toBe(200)
  })
})
