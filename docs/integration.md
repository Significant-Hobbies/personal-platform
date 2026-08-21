# Application integration

Personal Platform is the signed-in synchronization and semantic API layer. It
does not replace any app's local store or domain service.

## Ownership map

| Product | Immediate local store | Signed-in authority | Platform path |
| --- | --- | --- | --- |
| Hub | Read cache only | None | Reads summaries and invokes semantic actions |
| Live | Existing browser/native store | Personal Platform D1 | `live` adapter |
| Journal | Existing browser/native store | Personal Platform D1 | `journal` adapter |
| Habits | SwiftData | Personal Platform D1 | `habits` adapter |
| Setline | Local JSON | Personal Platform D1 | `setline` adapter |
| Kith | Local JSON | Personal Platform D1 | `kith` adapter |
| Anchor | SwiftData | Personal Platform D1 | `anchor` adapter |
| Calorie | IndexedDB/native local store | Existing Calorie D1 | Calorie service binding only |

Existing non-Calorie records do not require migration. The first signed-in
release may begin with fresh server state while each app keeps its immediate
local-first behavior. Calorie's existing D1 remains untouched.

## Native adapter sequence

Each native app adds the root `PersonalSyncKit` Swift package, then provides one
small adapter around its current models:

1. Apply a user write to the existing local JSON or SwiftData store.
2. Convert the changed model to the domain's typed JSON contract.
3. Add an `OutboxEntry` using a client-generated record ID and idempotency key.
4. Call `SyncCoordinator.synchronize` after an online write, launch,
   foreground, allowed background refresh, or manual refresh.
5. Apply pulled changes to the existing store using the record version.
6. Persist conflicts for visible user resolution; never silently replace a
   newer local record.

An app must remain useful without a token or network connection. Signing out
stops remote sync; it does not delete the immediate local store.

## Domain contracts

| Domain | Record fields | Initial semantic action |
| --- | --- | --- |
| Live | title, status, targetDate, notes | `live.add_item` |
| Journal | body, occurredOn, mood | `journal.add_entry` |
| Habits | habitId, name, occurredOn, status | `habits.check_in` |
| Setline | title, occurredOn, minutes, notes | `setline.record_activity` |
| Kith | personId, personName, kind, occurredAt, note, followUpAt | `kith.record_interaction` |
| Anchor | title, startedAt, endedAt, durationSeconds, interruptionCount | `anchor.record_session` |

These contracts are intentionally specific. Adding a domain field requires a
compatible server validator and a matching app adapter; it does not require a
universal personal entity.

## Hub

Hub calls `GET /v1/life/today` for its dashboard, individual summary endpoints
for detail, semantic action endpoints for simple writes, and `GET /v1/activity`
for provenance and undo. Hub owns no canonical domain table.

## Calorie

Personal Platform expects a Cloudflare service binding named
`CALORIE_SERVICE`. It forwards the verified internal user ID to:

- `GET /v1/personal/summary`
- `POST /v1/personal/actions/:action`

The connector deliberately has no D1 binding for Calorie. Until the binding and
Calorie-side routes are configured, calorie calls fail with
`calorie_connector_unavailable`; they never fall back to new empty tables.

## Authentication activation

Production personal routes fail closed until an `AUTH_SERVICE` binding verifies
the bearer token and returns the permanent internal `userId`. Local tests use a
test-only token supplied by the Vitest harness. Do not put Apple secrets or
Better Auth secrets in Wrangler configuration.

Before production activation:

1. Bind the existing identity service as `AUTH_SERVICE`.
2. Bind the existing Calorie Worker as `CALORIE_SERVICE`.
3. Replace the placeholder D1 ID with a newly created Personal Platform D1.
4. Apply `migrations/0001_initial.sql` remotely only after explicit approval.
5. Integrate and verify one app adapter at a time before disabling its CloudKit
   transport.
