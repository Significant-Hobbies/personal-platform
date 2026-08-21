import Foundation

/// Small composition root shared by native apps. Apps keep applying changes to
/// their own local store; this type only owns authentication, the durable
/// mutation outbox, the pull cursor, and transport.
public struct PersonalPlatformConnection: Sendable {
    public let identity: PersonalIdentityClient
    public let sync: PersonalSyncRuntime

    #if canImport(Security)
    public init(
        domain: PersonalDomain,
        keychainService: String,
        supportDirectory: URL,
        deviceId: String,
        platformURL: URL = URL(string: "https://personal-platform.sarthakagrawal.workers.dev")!,
        identityURL: URL = URL(string: "https://significanthobbies.com")!
    ) throws {
        let identity = PersonalIdentityClient(
            baseURL: identityURL,
            tokenStore: KeychainBearerTokenStore(service: keychainService)
        )
        self.identity = identity
        sync = try PersonalSyncRuntime(
            domain: domain,
            deviceId: deviceId,
            supportDirectory: supportDirectory,
            identity: identity,
            client: PersonalSyncClient(baseURL: platformURL)
        )
    }
    #endif
}

public actor PersonalSyncRuntime {
    public let domain: PersonalDomain
    private let deviceId: String
    private let identity: PersonalIdentityClient
    private let outbox: MutationOutbox
    private let coordinator: SyncCoordinator

    public init(
        domain: PersonalDomain,
        deviceId: String,
        supportDirectory: URL,
        identity: PersonalIdentityClient,
        client: PersonalSyncClient
    ) throws {
        self.domain = domain
        self.deviceId = deviceId
        self.identity = identity
        let outbox = try MutationOutbox(fileURL: supportDirectory.appending(path: "personal-sync-outbox.json"))
        self.outbox = outbox
        coordinator = SyncCoordinator(
            client: client,
            outbox: outbox,
            cursors: try SyncCursorStore(fileURL: supportDirectory.appending(path: "personal-sync-cursors.json"))
        )
    }

    public func enqueue(
        recordId: String,
        operation: MutationOperation = .upsert,
        baseVersion: Int = 0,
        occurredAt: String,
        record: JSONValue? = nil,
        idempotencyKey: String? = nil
    ) async throws {
        let mutation = SyncMutation(
            id: recordId,
            idempotencyKey: idempotencyKey ?? "\(domain.rawValue):\(recordId):v\(baseVersion + 1)",
            operation: operation,
            baseVersion: baseVersion,
            occurredAt: occurredAt,
            record: record
        )
        try await outbox.enqueue(OutboxEntry(domain: domain, mutation: mutation))
    }

    /// Returns immediately with no changes while signed out. Network failures
    /// are surfaced to the app, while the durable outbox remains intact.
    public func synchronize() async throws -> [SyncChange] {
        guard let bearerToken = try await identity.bearerToken() else { return [] }
        return try await coordinator.synchronize(
            domain: domain,
            deviceId: deviceId,
            bearerToken: bearerToken
        )
    }
}
