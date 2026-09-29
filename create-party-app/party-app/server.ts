import { getServerByName, Server } from 'partyserver'
import type { Frame } from './protocol'

/** One room per audience. Everything a room's sockets may read, and nothing else, is published to it. */
export class RealtimeServer<E extends Cloudflare.Env = Cloudflare.Env> extends Server<E> {
  static options = { hibernate: true }

  publish(frame: Frame) {
    this.broadcast(JSON.stringify(frame))
  }
}

/**
 * Push the rows a write committed to every socket in `room`.
 * Await it before answering the request: two writes from one handler then reach the room in commit order.
 */
export async function publish(ns: DurableObjectNamespace<RealtimeServer>, room: string, frame: Frame) {
  const stub = await getServerByName(ns, room)
  await stub.publish(frame)
}
