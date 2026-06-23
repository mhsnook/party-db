// The slim DO-controlled server: a partyserver `Server` that serves BOTH the
// hibernatable WebSocket (down) and POST /write (up) for a room, using the DO's
// own SQLite as persistence.
//
// Super-simple contract: clients mint UUIDs and POST WriteEvents; the server
// records them (one JSON blob per row + an _oplog for ordering), assigns a seq,
// and fans out to every connected socket. No DDL per table, no RETURNING, no
// constraints — rows are stored as blobs keyed by PK, so the resolved row always
// equals the sent row. Validation, if any, rides on the shared schema.
//
// Subclass it and declare your collections:
//   export class Room extends PartyDbServer {
//     collections = [{ name: 'todos', key: 'id' }, { name: 'lists', key: 'id' }]
//   }

import { Server, type Connection, type ConnectionContext } from 'partyserver'
import type { SequencedBatch, WriteAck, WriteBatch } from '../protocol.ts'

export type TableDef = { name: string; key: string }

export class PartyDbServer<Env = unknown> extends Server<Env> {
  static options = { hibernate: true }
  collections: TableDef[] = []
  private tables = new Map<string, TableDef>()

  private get sql() {
    return this.ctx.storage.sql
  }

  private send(conn: Connection, batch: SequencedBatch) {
    conn.send(JSON.stringify(batch))
  }

  onStart() {
    this.sql.exec(
      `CREATE TABLE IF NOT EXISTS _oplog (
         seq INTEGER PRIMARY KEY AUTOINCREMENT,
         channel TEXT NOT NULL,
         ops TEXT NOT NULL
       )`,
    )
    for (const c of this.collections) {
      this.tables.set(c.name, c)
      this.sql.exec(`CREATE TABLE IF NOT EXISTS "${c.name}" (k TEXT PRIMARY KEY, data TEXT NOT NULL)`)
    }
  }

  // a reconnecting client passes ?since=<lastSeq> and gets only what it missed;
  // a fresh client gets a full snapshot. Both arrive as ordinary batches.
  onConnect(conn: Connection, ctx: ConnectionContext) {
    const since = new URL(ctx.request.url).searchParams.get('since')
    if (since !== null) this.replaySince(conn, Number(since))
    else this.snapshot(conn)
  }

  // delta reconnect: just the oplog entries after `since`, in order.
  private replaySince(conn: Connection, since: number) {
    const rows = this.sql
      .exec(`SELECT seq, channel, ops FROM _oplog WHERE seq > ? ORDER BY seq`, since)
      .toArray()
    for (const r of rows) {
      this.send(conn, {
        channel: r.channel as string,
        seq: Number(r.seq),
        ops: JSON.parse(r.ops as string),
      })
    }
  }

  // fresh connect: current state per collection, then ready.
  private snapshot(conn: Connection) {
    const seq = Number(this.sql.exec(`SELECT COALESCE(MAX(seq), 0) AS s FROM _oplog`).one().s)
    for (const c of this.collections) {
      const rows = this.sql.exec(`SELECT data FROM "${c.name}"`).toArray()
      const ops = rows.map((r) => ({ type: 'insert' as const, value: JSON.parse(r.data as string) }))
      this.send(conn, { channel: c.name, seq, ops, ready: true })
    }
  }

  // controlled mode writes come over HTTP, not the (hibernating) socket.
  async onRequest(req: Request): Promise<Response> {
    if (req.method !== 'POST') return new Response('not found', { status: 404 })
    const body = (await req.json()) as WriteBatch[]
    const ack: WriteAck = { accepted: [] }
    for (const batch of body) {
      const def = this.tables.get(batch.channel)
      if (!def) return new Response(`unknown channel: ${batch.channel}`, { status: 400 })
      const seq = this.accept(def, batch)
      // inline broadcast before responding: keeps broadcast order == seq order.
      this.broadcast(JSON.stringify({ ...batch, seq } satisfies SequencedBatch))
      ack.accepted.push({ channel: batch.channel, seq })
    }
    return Response.json(ack)
  }

  // apply one batch atomically and return its assigned seq.
  private accept(def: TableDef, batch: WriteBatch): number {
    let seq = 0
    this.ctx.storage.transactionSync(() => {
      for (const op of batch.ops) {
        const key = String((op.value as any)[def.key])
        if (op.type === 'delete') {
          this.sql.exec(`DELETE FROM "${def.name}" WHERE k = ?`, key)
        } else {
          this.sql.exec(
            `INSERT INTO "${def.name}" (k, data) VALUES (?, ?)
             ON CONFLICT(k) DO UPDATE SET data = excluded.data`,
            key,
            JSON.stringify(op.value),
          )
        }
      }
      // RETURNING gives us the assigned seq without a second round-trip.
      seq = Number(
        this.sql
          .exec(
            `INSERT INTO _oplog (channel, ops) VALUES (?, ?) RETURNING seq`,
            batch.channel,
            JSON.stringify(batch.ops),
          )
          .one().seq,
      )
    })
    return seq
  }
}
