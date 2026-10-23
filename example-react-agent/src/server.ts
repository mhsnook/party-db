import { Agent, routeAgentRequest, type AgentContext, type Connection, type ConnectionContext, type WSMessage } from 'agents'
import { PartyDbCore, SqliteAdapter, isPartyDbRequest, type SqlEngine } from '../../src/server/index.ts'
import { collections, type BoardState, type Task } from './schema.ts'
import type { SequencedBatch } from '../../src/protocol.ts'

type Env = { Board: DurableObjectNamespace<Board> }

const STEPS = ['Read the task twice.', 'Sketched a plan: one step, then another.', 'Checked it off.']

// A Cloudflare Agents SDK agent that holds a party-db core. `Agent` extends
// `DurableObject`, not partyserver's `Server`, so it cannot be a `PartyDbServer`;
// it composes the core instead (architecture §15). Browsers read and write the
// `tasks` and `notes` collections through party-db, and the agent writes into
// the same collections through `this.db.commit()`. The Agents SDK's own
// protocol (state sync, RPC) stays on its own sockets.
export class Board extends Agent<Env, BoardState> {
  initialState: BoardState = { working: null, triaged: 0 }
  db: PartyDbCore
  ready: Promise<void>

  // The core is built in the constructor, not `onStart`: the SDK runs
  // `onFiberRecovered` BEFORE `onStart`, and a recovered fiber commits rows.
  constructor(ctx: AgentContext, env: Env) {
    super(ctx, env)
    // your tables, as ever. party-db only CRUDs over them and owns `_oplog`.
    ctx.storage.sql.exec(
      `CREATE TABLE IF NOT EXISTS tasks (
         id TEXT PRIMARY KEY,
         text TEXT NOT NULL,
         status TEXT NOT NULL DEFAULT 'open'
       )`,
    )
    ctx.storage.sql.exec(
      `CREATE TABLE IF NOT EXISTS notes (
         id TEXT PRIMARY KEY,
         task_id TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
         body TEXT NOT NULL
       )`,
    )
    const engine: SqlEngine = {
      exec: (query, ...bindings) => ctx.storage.sql.exec(query, ...bindings),
      transaction: (fn) => ctx.storage.transactionSync(fn),
    }
    this.db = new PartyDbCore({
      collections,
      adapter: new SqliteAdapter(engine, collections),
      // the host owns the sockets: fan out only to the ones tagged party-db, and
      // let the agent see every committed batch, since it is a subscriber too.
      broadcast: (message) => {
        for (const conn of this.getConnections('party-db')) conn.send(message)
        this.observe(JSON.parse(message) as SequencedBatch)
      },
    })
    this.ready = this.db.init()
  }

  // every socket and request waits on this; a recovered fiber awaits it itself.
  onStart() {
    return this.ready
  }

  // --- the three forwarding seams, plus the one that keeps the sockets clean ---

  // tag party-db connects so the broadcast above finds them after hibernation
  getConnectionTags(_conn: Connection, ctx: ConnectionContext): string[] {
    return isPartyDbRequest(ctx.request) ? ['party-db'] : []
  }

  // The Agents SDK sends its identity, state and MCP frames to every socket on
  // connect and on every setState. A party-db socket must never see them.
  shouldSendProtocolMessages(_conn: Connection, ctx: ConnectionContext): boolean {
    return !isPartyDbRequest(ctx.request)
  }

  onConnect(conn: Connection, ctx: ConnectionContext) {
    const url = new URL(ctx.request.url)
    if (isPartyDbRequest(url)) return this.db.connect((m) => conn.send(m), url)
  }

  // The SDK consumes its own state and RPC frames before this runs; party-db's
  // one up-frame (`{ snapshot }`) reaches here untouched.
  onMessage(conn: Connection, message: WSMessage) {
    if (conn.tags.includes('party-db')) return this.db.handleMessage((m) => conn.send(m), message)
  }

  onRequest(req: Request) {
    if (isPartyDbRequest(req)) return this.db.handleWrite(req)
    return new Response('not found', { status: 404 })
  }

  // --- the agent: it reacts to rows humans write, and answers in rows ---

  // every batch the room commits passes through here, host writes included.
  private observe(batch: SequencedBatch) {
    if (batch.channel !== 'tasks' || batch.reset) return
    for (const op of batch.ops) {
      const task = op.value as Task
      if (op.type === 'insert' && task.status === 'open') void this.triage(task.id, 0)
    }
  }

  // `runFiber` records the fiber before the first step; after an eviction the
  // SDK calls `onFiberRecovered` with the last stash and we pick up from there.
  private triage(taskId: string, from: number) {
    return this.runFiber(`triage:${taskId}`, async (fiber) => {
      this.setState({ ...this.state, working: taskId })
      try {
        if (from === 0) await this.update(taskId, 'working')
        for (let step = from; step < STEPS.length; step++) {
          await new Promise((r) => setTimeout(r, 900))
          // a deterministic id, so a step that committed before the crash is a
          // constraint rejection on recovery, not a second note.
          await this.db.commit([{ channel: 'notes', ops: [{ type: 'insert', value: { id: `${taskId}:${step}`, task_id: taskId, body: STEPS[step] } }] }]).catch(swallowDuplicate)
          fiber.stash({ taskId, step: step + 1 })
        }
        await this.update(taskId, 'done')
        this.setState({ working: null, triaged: this.state.triaged + 1 })
      } catch (e) {
        // the task was deleted under us: a zero-row update is a rejection (§16)
        this.setState({ ...this.state, working: null })
        console.warn(`triage ${taskId} stopped:`, e)
      }
    })
  }

  async onFiberRecovered(ctx: { name: string; snapshot: unknown }) {
    await this.ready
    const stash = ctx.snapshot as { taskId: string; step: number } | null
    const taskId = stash?.taskId ?? ctx.name.replace(/^triage:/, '')
    await this.triage(taskId, stash?.step ?? 0)
  }

  // a host write: the same seq, `_oplog` entry and fan-out a client POST gets.
  private update(taskId: string, status: Task['status']) {
    return this.db.commit([{ channel: 'tasks', ops: [{ type: 'update', value: { id: taskId, status } }] }])
  }
}

function swallowDuplicate(e: unknown) {
  if (String(e).includes('UNIQUE')) return
  throw e
}

export default {
  async fetch(req: Request, env: Env): Promise<Response> {
    return (
      // party-db's client dials `/parties/board/<room>` (partysocket's shape);
      // `useAgent` dials `/agents/board/<room>`. Both land on the same Board.
      (await routeAgentRequest(req, env, { prefix: 'parties' })) ??
      (await routeAgentRequest(req, env)) ??
      new Response('not found', { status: 404 })
    )
  },
}
