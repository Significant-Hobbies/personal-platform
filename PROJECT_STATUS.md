# personal-platform — PROJECT STATUS

Last updated: 2026-08-21

## Why / What

Provide one small signed-in Cloudflare synchronization and semantic API layer
for the Significant Hobbies personal app family while keeping every source app
standalone and local-first.

**Users:** the single owner of the personal app family.

**In scope:** shared identity verification, device sync, fresh server state for
Live, Journal, Habits, Setline, Kith, and Anchor, Hub summaries/actions, action
audit, life events, and a Calorie service connector.

**Out of scope:** a universal personal schema, direct access to Calorie's D1,
legacy-data import, and immediate CloudKit retirement.

## Dependencies

### External

- Cloudflare Workers and D1.
- Significant Hobbies' authenticated session verifier, reached through a
  Cloudflare service binding, maps native Better Auth sessions to one internal
  user ID.

### Internal

- Calorie's existing Worker for calorie reads and writes.
- Live, Journal, Habits, Setline, Kith, and Anchor local model adapters.
- Hub as a read/action client with no canonical domain storage.

## Timeline

- **2026-08-22:** Deployed the seven-domain read contracts, Live and Calorie
  connectors, privacy projections, and read-only MCP implementation from exact
  SHA `7b950a0d193af9d4b967a81c3bfedc0af36548ee` at 100% traffic. Production D1
  has no pending migrations and health returns 200. The MCP bearer boundary
  fails closed with 401; its Auth0 owner mapping remains intentionally inactive
  until the production OAuth values are supplied.
- **2026-08-21:** Added an explicit two-client Setline convergence check: a
  completed session pushed from an iPhone-origin device is accepted once,
  versioned, and pulled intact by a second client. All Worker integration tests
  and the native Setline record adapter pass without using CloudKit.
- **2026-08-21:** Deployed exact SHA
  `9e38ac985f2bbd505d929b00f4524813f39821cd` at 100% traffic after scoping
  Vitest discovery to the platform's three test files. The live health endpoint
  returns 200, private routes fail closed with 401, and D1 has no pending
  migrations.
- **2026-08-21:** Deployed the production Worker and D1 migration from a green,
  exact-SHA-tagged main revision. The `significanthobbies` and `calorie`
  service bindings are live, the health probe passes, and remote D1 reports no
  pending migrations.
- **2026-08-21:** Rolled PersonalSyncKit into Journal, Kith, Habits, Setline,
  and Anchor while preserving each local store and temporary CloudKit rollback.
  Journal 3, Kith 2, Habits 5, and Setline 2 completed internal TestFlight
  processing; Anchor's App Store Connect record exists and its Beta 5 package
  waits for Xcode personal-account authentication.
- **2026-08-21:** Built the local shared sync foundation: a typed Worker/D1
  API for six fresh domains, idempotent outbox push and cursor pull, semantic
  Hub actions with audit/undo, a fail-closed Calorie connector, and the
  multi-platform `PersonalSyncKit` package.
- **2026-08-21:** Created the repository and specified the shared Cloudflare
  sync foundation in GitHub issue #1.

## Products

- Live Cloudflare Worker `personal-platform` and D1 database
  `personal-platform`.
- `PersonalSyncKit` Swift package for iOS, iPadOS, macOS, and watchOS clients.

## Features (shipped)

- **Sync protocol:** client-generated IDs, typed domain validation, mutation
  idempotency, optimistic versions, deletion tombstones, ordered pull cursors,
  device freshness, and atomic domain/change/event receipts.
- **Domain services:** separate D1 tables and one semantic write action each for
  Live, Journal, Habits, Setline, Kith, and Anchor.
- **Hub surface:** Today aggregation, domain summaries, activity provenance,
  additive action audit, and single-action undo.
- **Calorie boundary:** service-binding-only connector with no Calorie table or
  direct access to Calorie's existing D1.
- **Native package:** Foundation-only Swift transport, typed JSON adapters,
  durable mutation outbox, per-domain cursor persistence, and a sync
  coordinator for iOS/iPadOS, macOS, and watchOS.
- **Safety:** authenticated routes fail closed through the production verifier;
  local tests provide the only test-token mode.

## Work queue

- [GitHub Issues](https://github.com/Significant-Hobbies/personal-platform/issues)
