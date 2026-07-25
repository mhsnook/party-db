// The JS-layer access-control module (issue #33). Eventually this is where the
// portable, JS-authored access rules live — the "poor-man's RLS" that runs in our
// code (server enforcement + client-side prediction), the SQLite/D1 story and an
// opt-in alternative to Postgres-native RLS (#30).
//
// Today it holds only a startup GUARD. The `access` / `ownerColumn` fields on a
// collection are declared surface but NOT enforced yet, so a server that sets them
// without an enforcer would silently serve everything — a security-shaped config
// that does nothing. Pre-alpha stance: that footgun is allowed (fuck around in dev
// all you like), it just isn't allowed to be QUIET. We warn loudly at startup; we
// do NOT throw — declaring a policy isn't a hard error while enforcement is still
// being designed, it's a "this does nothing yet" heads-up.

import type { PartyCollection } from '../schema.ts'

// Names of the collections that declare an access policy (`access` or
// `ownerColumn`) which nothing currently enforces. Split out from the warning so
// tests can assert the classification without spying on the console.
export function unenforcedAccessCollections(collections: PartyCollection<any>[]): string[] {
  return collections.filter((c) => c.access !== undefined || c.ownerColumn !== undefined).map((c) => c.name)
}

// Emit one loud startup warning naming every collection whose declared access
// policy is not being enforced. No-op when there are none.
export function warnUnenforcedAccess(collections: PartyCollection<any>[]): void {
  const names = unenforcedAccessCollections(collections)
  if (!names.length) return
  console.warn(
    `party-db: collection(s) ${names.map((n) => `"${n}"`).join(', ')} declare an access policy ` +
      `(access/ownerColumn), but access enforcement is NOT implemented yet — these rules do NOTHING and ` +
      `MUST NOT be relied on for security. Track it: https://github.com/mhsnook/party-db/issues/33`,
  )
}
