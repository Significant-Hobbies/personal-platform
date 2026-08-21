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

@Test func outboxKeepsOnlyTheLatestOfflineMutationForARecord() async throws {
    let directory = FileManager.default.temporaryDirectory
        .appending(path: UUID().uuidString, directoryHint: .isDirectory)
    let outbox = try MutationOutbox(fileURL: directory.appending(path: "outbox.json"))
    let first = SyncMutation(
        id: "person-1",
        idempotencyKey: "first",
        operation: .upsert,
        baseVersion: 2,
        occurredAt: "2026-08-21T00:00:00Z",
        record: .object(["name": .string("Before")])
    )
    let latest = SyncMutation(
        id: "person-1",
        idempotencyKey: "latest",
        operation: .upsert,
        baseVersion: 2,
        occurredAt: "2026-08-21T00:01:00Z",
        record: .object(["name": .string("After")])
    )

    try await outbox.enqueue(OutboxEntry(domain: .kith, mutation: first))
    try await outbox.enqueue(OutboxEntry(domain: .kith, mutation: latest))

    #expect(await outbox.pending(for: .kith).map(\.mutation) == [latest])
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

@Test func versionsPersistPerRecordAndDomain() async throws {
    let directory = FileManager.default.temporaryDirectory
        .appending(path: UUID().uuidString, directoryHint: .isDirectory)
    let file = directory.appending(path: "versions.json")
    let store = try SyncVersionStore(fileURL: file)
    try await store.setVersion(3, for: "person-1", in: .kith)

    let reopened = try SyncVersionStore(fileURL: file)
    #expect(await reopened.version(for: "person-1", in: .kith) == 3)
    #expect(await reopened.version(for: "person-1", in: .journal) == 0)
}

@Test func fingerprintsAreStableAndPersistPerRecordAndDomain() async throws {
    let first = JSONValue.object(["b": .number(2), "a": .string("one")])
    let reordered = JSONValue.object(["a": .string("one"), "b": .number(2)])
    #expect(syncFingerprint(operation: .upsert, record: first) == syncFingerprint(operation: .upsert, record: reordered))
    #expect(syncFingerprint(operation: .delete, record: nil) != syncFingerprint(operation: .upsert, record: nil))

    let directory = FileManager.default.temporaryDirectory
        .appending(path: UUID().uuidString, directoryHint: .isDirectory)
    let file = directory.appending(path: "fingerprints.json")
    let store = try SyncFingerprintStore(fileURL: file)
    try await store.setFingerprint("abc", for: "entry-1", in: .journal)

    let reopened = try SyncFingerprintStore(fileURL: file)
    #expect(await reopened.fingerprint(for: "entry-1", in: .journal) == "abc")
    #expect(await reopened.fingerprint(for: "entry-1", in: .kith) == nil)
}
