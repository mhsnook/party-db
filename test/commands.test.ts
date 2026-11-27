import { describe, it } from 'vitest'

// Skeletons for docs/commands.md. Nothing here is built yet.

describe('defineCommand', () => {
  it.todo('puts a handle on tx only for the channels in reads and writes')
  it.todo('throws when run writes a channel it did not declare in writes')
  it.todo('lets a read see earlier writes in the same run')
})

describe('a command on the client', () => {
  it.todo('applies run to the local collections at the call, before any send')
  it.todo('sends { command, id, args, calledAt } and never the rows run wrote')
  it.todo('passes the now option to run as ctx.now')
  it.todo('settles when every acked seq arrives, dropping the overlay onto the synced rows')
  it.todo('rolls the overlay back when the room refuses with a WriteError')
  it.todo('skips the overlay but still sends when run throws on the client')
  it.todo('holds its overlay over a synced change to the same row until it settles')
})

describe('the send queue', () => {
  it.todo('sends the second of two quick commands only after the first is acked')
  it.todo('keeps CRUD writes and commands in one order')
  it.todo('does not wait for settlement before the next send')
  it.todo('retries a send that got no response with the same id once the socket reopens')
  it.todo('blocks later writes while the head is retrying')
  it.todo('rejects with the TransportError and rolls back after retryForMs')
})

describe('a command in the room', () => {
  it.todo('answers 400 for an unknown command name')
  it.todo('answers 400 with the schema message when args fail the schema')
  it.todo('refuses an anonymous call with 401 when auth is set and anonRole is not')
  it.todo('loads the declared channels, runs, and commits inside one serialized section')
  it.todo('sees a POST that was queued ahead of it, and is seen by one queued behind it')
  it.todo('answers 409 with the message and commits nothing when run throws')
  it.todo('leaves no _oplog entry when run throws')
  it.todo('fans its writes out under the read policy of each collection')
  it.todo('acks only the seqs the caller may read')
})

describe('running a command once', () => {
  it.todo('records the command id on every _oplog entry the command writes')
  it.todo('answers a repeated id with the original seqs and does not run again')
  it.todo('runs again when the first run wrote nothing')
  it.todo('treats _oplog entries without a command_id as matching no id')
})

describe('host runs', () => {
  it.todo('sequences and fans out a this.run call like a POSTed command')
  it.todo('never deduplicates a host run')
})
