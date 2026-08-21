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
production deployment, remote migrations, legacy-data import, and immediate
CloudKit retirement.

## Dependencies

### External

- Cloudflare Workers and D1.
- A production auth verifier to map Apple/Better Auth sessions to one internal
  user ID before deployment.

### Internal

- Calorie's existing Worker for calorie reads and writes.
- Live, Journal, Habits, Setline, Kith, and Anchor local model adapters.
- Hub as a read/action client with no canonical domain storage.

## Timeline

- **2026-08-21:** Built the local shared sync foundation: a typed Worker/D1
  API for six fresh domains, idempotent outbox push and cursor pull, semantic
  Hub actions with audit/undo, a fail-closed Calorie connector, and the
  multi-platform `PersonalSyncKit` package. Production resources remain
  intentionally uncreated and undeployed.
- **2026-08-21:** Created the repository and specified the shared Cloudflare
  sync foundation in GitHub issue #1.

## Products

- Cloudflare Worker source and local D1 migration (not deployed).
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
- **Safety:** authenticated routes fail closed until the production verifier is
  bound; local tests provide the only test-token mode.

## Work queue

- [GitHub Issues](https://github.com/Significant-Hobbies/personal-platform/issues)
