import Foundation
import Testing
@testable import PersonalSyncKit

private actor RuntimeTokenStore: PersonalBearerTokenStore {
    func load() -> String? { nil }
    func save(_: String) {}
    func delete() {}
}

@Test func runtimeCompactsRepeatedOfflineEditsWhileSignedOut() async throws {
    let directory = FileManager.default.temporaryDirectory
        .appending(path: UUID().uuidString, directoryHint: .isDirectory)
    let tokenStore = RuntimeTokenStore()
    let identity = PersonalIdentityClient(
        baseURL: URL(string: "https://identity.invalid")!,
        tokenStore: tokenStore
    )
    let runtime = try PersonalSyncRuntime(
        domain: .kith,
        deviceId: "test-device",
        supportDirectory: directory,
        identity: identity,
        client: PersonalSyncClient(baseURL: URL(string: "https://platform.invalid")!)
    )

    try await runtime.enqueue(
        recordId: "entry-1",
        occurredAt: "2026-08-21T06:00:00.000Z",
        record: JSONValue.object(["personId": JSONValue.string("person-1")])
    )
    try await runtime.enqueue(
        recordId: "entry-1",
        occurredAt: "2026-08-21T06:01:00.000Z",
        record: JSONValue.object(["personId": JSONValue.string("person-2")])
    )

    #expect(try await runtime.synchronize().isEmpty)
    let stored = try JSONDecoder().decode(
        [OutboxEntry].self,
        from: Data(contentsOf: directory.appending(path: "personal-sync-outbox.json"))
    )
    #expect(stored.count == 1)
    #expect(stored.first?.mutation.baseVersion == 0)
    #expect(stored.first?.mutation.record == .object(["personId": .string("person-2")]))
    #expect(stored.first?.mutation.idempotencyKey.isEmpty == false)
}

@Test func runtimeSkipsAnUnchangedBackfillRecord() async throws {
    let directory = FileManager.default.temporaryDirectory
        .appending(path: UUID().uuidString, directoryHint: .isDirectory)
    let identity = PersonalIdentityClient(
        baseURL: URL(string: "https://identity.invalid")!,
        tokenStore: RuntimeTokenStore()
    )
    let runtime = try PersonalSyncRuntime(
        domain: .anchor,
        deviceId: "test-device",
        supportDirectory: directory,
        identity: identity,
        client: PersonalSyncClient(baseURL: URL(string: "https://platform.invalid")!)
    )
    let record = JSONValue.object([
        "title": .string("Deep work"),
        "durationSeconds": .number(3_600),
    ])

    try await runtime.enqueue(
        recordId: "session-1",
        occurredAt: "2026-08-21T06:00:00.000Z",
        record: record
    )
    try await runtime.enqueue(
        recordId: "session-1",
        occurredAt: "2026-08-22T06:00:00.000Z",
        record: record
    )

    let stored = try JSONDecoder().decode(
        [OutboxEntry].self,
        from: Data(contentsOf: directory.appending(path: "personal-sync-outbox.json"))
    )
    #expect(stored.count == 1)
}
