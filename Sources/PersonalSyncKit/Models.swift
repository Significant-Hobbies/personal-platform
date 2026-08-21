import Foundation

public enum PersonalDomain: String, Codable, CaseIterable, Sendable {
    case live
    case journal
    case habits
    case setline
    case kith
    case anchor
}

public enum MutationOperation: String, Codable, Sendable {
    case upsert
    case delete
}

public enum JSONValue: Codable, Equatable, Sendable {
    case string(String)
    case number(Double)
    case bool(Bool)
    case object([String: JSONValue])
    case array([JSONValue])
    case null

    public init(from decoder: Decoder) throws {
        let container = try decoder.singleValueContainer()
        if container.decodeNil() { self = .null }
        else if let value = try? container.decode(Bool.self) { self = .bool(value) }
        else if let value = try? container.decode(Double.self) { self = .number(value) }
        else if let value = try? container.decode(String.self) { self = .string(value) }
        else if let value = try? container.decode([String: JSONValue].self) { self = .object(value) }
        else if let value = try? container.decode([JSONValue].self) { self = .array(value) }
        else { throw DecodingError.dataCorruptedError(in: container, debugDescription: "Unsupported JSON value") }
    }

    public func encode(to encoder: Encoder) throws {
        var container = encoder.singleValueContainer()
        switch self {
        case let .string(value): try container.encode(value)
        case let .number(value): try container.encode(value)
        case let .bool(value): try container.encode(value)
        case let .object(value): try container.encode(value)
        case let .array(value): try container.encode(value)
        case .null: try container.encodeNil()
        }
    }
}

public struct SyncMutation: Codable, Equatable, Identifiable, Sendable {
    public let id: String
    public let idempotencyKey: String
    public let operation: MutationOperation
    public let baseVersion: Int
    public let occurredAt: String
    public let record: JSONValue?

    public init(
        id: String = UUID().uuidString.lowercased(),
        idempotencyKey: String = UUID().uuidString.lowercased(),
        operation: MutationOperation,
        baseVersion: Int,
        occurredAt: String,
        record: JSONValue? = nil
    ) {
        self.id = id
        self.idempotencyKey = idempotencyKey
        self.operation = operation
        self.baseVersion = baseVersion
        self.occurredAt = occurredAt
        self.record = record
    }
}

public struct OutboxEntry: Codable, Equatable, Identifiable, Sendable {
    public let id: String
    public let domain: PersonalDomain
    public let mutation: SyncMutation

    public init(domain: PersonalDomain, mutation: SyncMutation) {
        id = mutation.idempotencyKey
        self.domain = domain
        self.mutation = mutation
    }
}

struct PushEnvelope: Encodable, Sendable {
    let domain: PersonalDomain
    let deviceId: String
    let mutations: [SyncMutation]
}

public struct PushResponse: Decodable, Sendable {
    public let results: [PushResult]
}

public struct PushResult: Decodable, Sendable {
    public let id: String
    public let idempotencyKey: String
    public let status: String
    public let version: Int?
    public let cursor: Int?
    public let expectedVersion: Int?
    public let actualVersion: Int?
}

public struct PullResponse: Decodable, Sendable {
    public let changes: [SyncChange]
    public let cursor: Int
    public let hasMore: Bool
}

public struct SyncChange: Decodable, Sendable {
    public let cursor: Int
    public let changeId: String
    public let domain: PersonalDomain
    public let id: String
    public let operation: MutationOperation
    public let version: Int
    public let occurredAt: String
    public let recordedAt: String
    public let originDeviceId: String
    public let record: JSONValue
}

public protocol PersonalDomainAdapter: Sendable {
    associatedtype LocalRecord: Codable & Sendable
    var domain: PersonalDomain { get }
    func encode(_ record: LocalRecord) throws -> JSONValue
    func decode(_ value: JSONValue) throws -> LocalRecord
}

public extension PersonalDomainAdapter {
    func encode(_ record: LocalRecord) throws -> JSONValue {
        try JSONDecoder().decode(JSONValue.self, from: JSONEncoder().encode(record))
    }

    func decode(_ value: JSONValue) throws -> LocalRecord {
        try JSONDecoder().decode(LocalRecord.self, from: JSONEncoder().encode(value))
    }
}
