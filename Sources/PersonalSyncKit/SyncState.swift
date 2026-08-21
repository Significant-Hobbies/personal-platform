import Foundation

public actor MutationOutbox {
    private let fileURL: URL
    private var entries: [OutboxEntry]

    public init(fileURL: URL) throws {
        self.fileURL = fileURL
        if FileManager.default.fileExists(atPath: fileURL.path) {
            entries = try JSONDecoder().decode([OutboxEntry].self, from: Data(contentsOf: fileURL))
        } else {
            entries = []
        }
    }

    public func enqueue(_ entry: OutboxEntry) throws {
        if !entries.contains(where: { $0.id == entry.id }) {
            entries.append(entry)
            try persist()
        }
    }

    public func pending(for domain: PersonalDomain) -> [OutboxEntry] {
        entries.filter { $0.domain == domain }
    }

    public func acknowledge(idempotencyKeys: Set<String>) throws {
        entries.removeAll { idempotencyKeys.contains($0.mutation.idempotencyKey) }
        try persist()
    }

    private func persist() throws {
        try FileManager.default.createDirectory(
            at: fileURL.deletingLastPathComponent(),
            withIntermediateDirectories: true
        )
        try JSONEncoder().encode(entries).write(to: fileURL, options: .atomic)
    }
}

public actor SyncCursorStore {
    private let fileURL: URL
    private var cursors: [PersonalDomain: Int]

    public init(fileURL: URL) throws {
        self.fileURL = fileURL
        if FileManager.default.fileExists(atPath: fileURL.path) {
            cursors = try JSONDecoder().decode(
                [PersonalDomain: Int].self,
                from: Data(contentsOf: fileURL)
            )
        } else {
            cursors = [:]
        }
    }

    public func cursor(for domain: PersonalDomain) -> Int {
        cursors[domain, default: 0]
    }

    public func setCursor(_ cursor: Int, for domain: PersonalDomain) throws {
        cursors[domain] = cursor
        try FileManager.default.createDirectory(
            at: fileURL.deletingLastPathComponent(),
            withIntermediateDirectories: true
        )
        try JSONEncoder().encode(cursors).write(to: fileURL, options: .atomic)
    }
}

public actor SyncCoordinator {
    private let client: PersonalSyncClient
    private let outbox: MutationOutbox
    private let cursors: SyncCursorStore

    public init(
        client: PersonalSyncClient,
        outbox: MutationOutbox,
        cursors: SyncCursorStore
    ) {
        self.client = client
        self.outbox = outbox
        self.cursors = cursors
    }

    public func synchronize(
        domain: PersonalDomain,
        deviceId: String,
        bearerToken: String
    ) async throws -> [SyncChange] {
        let queued = await outbox.pending(for: domain)
        if !queued.isEmpty {
            let pushed = try await client.push(
                domain: domain,
                deviceId: deviceId,
                mutations: queued.map(\.mutation),
                bearerToken: bearerToken
            )
            let acknowledged = Set(
                pushed.results
                    .filter { $0.status == "accepted" || $0.status == "duplicate" }
                    .map(\.idempotencyKey)
            )
            try await outbox.acknowledge(idempotencyKeys: acknowledged)
        }

        let currentCursor = await cursors.cursor(for: domain)
        var allChanges: [SyncChange] = []
        var nextCursor = currentCursor
        repeat {
            let page = try await client.pull(
                domain: domain,
                cursor: nextCursor,
                bearerToken: bearerToken
            )
            allChanges.append(contentsOf: page.changes)
            nextCursor = page.cursor
            if !page.hasMore { break }
        } while true
        try await cursors.setCursor(nextCursor, for: domain)
        return allChanges
    }
}
