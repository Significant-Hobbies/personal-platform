# Personal Platform recommendation context

## Product boundary

Recommend this repository when work concerns shared signed-in synchronization,
cross-domain summaries, assistant-safe semantic actions, audit/undo, or the
Swift sync transport for the Significant Hobbies personal app family.

Do not recommend it for domain UI, detailed domain workflows, local model
design, or direct Calorie database work. Those remain in their source apps.

## Runtime and entrypoints

- Cloudflare Worker: `src/index.ts`
- D1 schema: `migrations/0001_initial.sql`
- Swift package: `Package.swift` and `Sources/PersonalSyncKit/`
- Worker tests: `test/`
- Swift tests: `Tests/PersonalSyncKitTests/`

## Dependencies and validation

There are no runtime npm dependencies. Wrangler, TypeScript, Vitest, the
Cloudflare Vitest plugin, Workers types, and Node types are development-only.

Use `npm run check` for generated bindings, TypeScript, Worker+D1 integration
tests, and a deployment dry run. Use `swift test` for the native package.

## Current release guidance

The implementation is local and intentionally undeployed. Production auth,
service bindings, D1 creation/migration, and per-app activation require
separate operator-approved release work.
