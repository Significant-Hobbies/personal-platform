import Foundation
import Testing
@testable import PersonalSyncKit

private actor RuntimeTokenStore: PersonalBearerTokenStore {
    func load() -> String? { nil }
    func save(_: String) {}
    func delete() {}
}

@Test func runtimeQueuesStableIdempotencyKeysWhileSignedOut() async throws {
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

    #expect(try await runtime.synchronize().isEmpty)
    let stored = try JSONDecoder().decode(
        [OutboxEntry].self,
        from: Data(contentsOf: directory.appending(path: "personal-sync-outbox.json"))
    )
    #expect(stored.map(\.mutation.idempotencyKey) == ["kith:entry-1:v1"])
}
