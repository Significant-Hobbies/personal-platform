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
        if let index = entries.firstIndex(where: {
            $0.domain == entry.domain && $0.mutation.id == entry.mutation.id
        }) {
            entries[index] = entry
            try persist()
        } else {
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

public actor SyncVersionStore {
    private let fileURL: URL
    private var versions: [PersonalDomain: [String: Int]]

    public init(fileURL: URL) throws {
        self.fileURL = fileURL
        if FileManager.default.fileExists(atPath: fileURL.path) {
            versions = try JSONDecoder().decode(
                [PersonalDomain: [String: Int]].self,
                from: Data(contentsOf: fileURL)
            )
        } else {
            versions = [:]
        }
    }

    public func version(for recordId: String, in domain: PersonalDomain) -> Int {
        versions[domain]?[recordId] ?? 0
    }

    public func setVersion(_ version: Int, for recordId: String, in domain: PersonalDomain) throws {
        guard version >= 0 else { return }
        versions[domain, default: [:]][recordId] = version
        try persist()
    }

    private func persist() throws {
        try FileManager.default.createDirectory(
            at: fileURL.deletingLastPathComponent(),
            withIntermediateDirectories: true
        )
        try JSONEncoder().encode(versions).write(to: fileURL, options: .atomic)
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
    private let versions: SyncVersionStore

    public init(
        client: PersonalSyncClient,
        outbox: MutationOutbox,
        cursors: SyncCursorStore,
        versions: SyncVersionStore
    ) {
        self.client = client
        self.outbox = outbox
        self.cursors = cursors
        self.versions = versions
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
            for result in pushed.results {
                if let version = result.version {
                    try await versions.setVersion(version, for: result.id, in: domain)
                } else if let actualVersion = result.actualVersion {
                    try await versions.setVersion(actualVersion, for: result.id, in: domain)
                }
            }
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
            for change in page.changes {
                try await versions.setVersion(change.version, for: change.id, in: domain)
            }
            nextCursor = page.cursor
            if !page.hasMore { break }
        } while true
        try await cursors.setCursor(nextCursor, for: domain)
        return allChanges
    }
}
