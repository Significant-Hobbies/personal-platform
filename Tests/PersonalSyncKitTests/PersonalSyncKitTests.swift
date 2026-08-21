import Foundation
import Testing
@testable import PersonalSyncKit

@Test func jsonValueRoundTripsDomainRecords() throws {
    struct Journal: Codable, Equatable, Sendable {
        let body: String
        let occurredOn: String
    }
    struct JournalAdapter: PersonalDomainAdapter {
        let domain = PersonalDomain.journal
        typealias LocalRecord = Journal
    }

    let adapter = JournalAdapter()
    let journal = Journal(body: "Today was clear.", occurredOn: "2026-08-21")
    let encoded = try adapter.encode(journal)
    #expect(try adapter.decode(encoded) == journal)
}

@Test func outboxPersistsAndAcknowledgesIdempotently() async throws {
    let directory = FileManager.default.temporaryDirectory
        .appending(path: UUID().uuidString, directoryHint: .isDirectory)
    let file = directory.appending(path: "outbox.json")
    let mutation = SyncMutation(
        id: "entry-1",
        idempotencyKey: "mutation-1",
        operation: .upsert,
        baseVersion: 0,
        occurredAt: "2026-08-21T00:00:00Z",
        record: .object(["title": .string("Visit Kyoto")])
    )
    let outbox = try MutationOutbox(fileURL: file)
    try await outbox.enqueue(OutboxEntry(domain: .live, mutation: mutation))
    try await outbox.enqueue(OutboxEntry(domain: .live, mutation: mutation))
    #expect(await outbox.pending(for: .live).count == 1)

    let reopened = try MutationOutbox(fileURL: file)
    #expect(await reopened.pending(for: .live).count == 1)
    try await reopened.acknowledge(idempotencyKeys: ["mutation-1"])
    #expect(await reopened.pending(for: .live).isEmpty)
}

@Test func cursorsPersistPerDomain() async throws {
    let directory = FileManager.default.temporaryDirectory
        .appending(path: UUID().uuidString, directoryHint: .isDirectory)
    let file = directory.appending(path: "cursors.json")
    let store = try SyncCursorStore(fileURL: file)
    try await store.setCursor(42, for: .kith)

    let reopened = try SyncCursorStore(fileURL: file)
    #expect(await reopened.cursor(for: .kith) == 42)
    #expect(await reopened.cursor(for: .anchor) == 0)
}
