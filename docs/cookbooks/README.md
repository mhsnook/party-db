# Cookbooks

Short recipes showing party-db in use. The theme: party-db is a transport — it
doesn't own your validation, auth, or database, it just leaves a clean seam for each.

1. **[Cross-collection atomic writes](./01-atomic-writes.md)** — `createTransaction({ mutationFn: persist })`. One POST, one commit, all-or-nothing.
2. **[Custom server validation logic](./02-server-validation.md)** — add a Zod `.refine()` to your schema. That's it.
3. **[A shared board on external auth](./03-external-auth-workos.md)** — hand the `authorize` seam to WorkOS.
4. **[Public read, private write](./04-public-read-private-write.md)** — one `authorize`, split by read vs. write.
5. **[Public catalog + per-user collections](./05-public-and-private-collections.md)** 🚧 — `ownerColumn` + `access` on the collection, `auth` on the server: roughshod RLS, even on SQLite.
6. **[Friends-only posts](./06-friends-only-posts.md)** 🚧 — `read` as an *expression* over a cached per-viewer context, compiled to one SQL `WHERE` + one predicate: RLS that depends on the friend graph, not just the row.

✅ = works today. 🚧 = the seam exists but this use is proposed, not shipped
([`../unspecified.md`](../unspecified.md)).
