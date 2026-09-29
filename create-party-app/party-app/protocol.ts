/** One frame down the realtime socket: the rows a write committed, for one collection. */
export type Frame = {
  channel: string
  upsert?: object[]
  delete?: Array<string | number>
}
