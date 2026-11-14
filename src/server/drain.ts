// Read a request's body to the end, keeping none of it, before answering a POST
// you refuse. Answering while the upload is still arriving crashes workerd
// intermittently: the next request on that isolate gets a 503. Cancelling the
// stream does not prevent it; reading it does. Chunks are dropped as they arrive,
// so draining a body refused for its size still holds none of it in memory.
export async function drain(req: Request): Promise<void> {
  const reader = req.body?.getReader()
  if (!reader) return
  while (!(await reader.read()).done) {}
}
