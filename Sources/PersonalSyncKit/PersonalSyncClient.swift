import Foundation
#if canImport(FoundationNetworking)
import FoundationNetworking
#endif

public enum PersonalSyncError: Error, Equatable, Sendable {
    case invalidResponse
    case server(status: Int, message: String)
}

public struct PersonalSyncClient: Sendable {
    public let baseURL: URL
    private let session: URLSession
    private let encoder = JSONEncoder()
    private let decoder = JSONDecoder()

    public init(baseURL: URL, session: URLSession = .shared) {
        self.baseURL = baseURL
        self.session = session
    }

    public func push(
        domain: PersonalDomain,
        deviceId: String,
        mutations: [SyncMutation],
        bearerToken: String
    ) async throws -> PushResponse {
        var request = URLRequest(url: baseURL.appending(path: "v1/sync/push"))
        request.httpMethod = "POST"
        request.setValue("Bearer \(bearerToken)", forHTTPHeaderField: "Authorization")
        request.setValue("application/json", forHTTPHeaderField: "Content-Type")
        request.httpBody = try encoder.encode(
            PushEnvelope(domain: domain, deviceId: deviceId, mutations: mutations)
        )
        return try await send(request, as: PushResponse.self)
    }

    public func pull(
        domain: PersonalDomain,
        cursor: Int,
        bearerToken: String
    ) async throws -> PullResponse {
        var components = URLComponents(
            url: baseURL.appending(path: "v1/sync/pull"),
            resolvingAgainstBaseURL: false
        )
        components?.queryItems = [
            URLQueryItem(name: "domain", value: domain.rawValue),
            URLQueryItem(name: "cursor", value: String(cursor)),
        ]
        guard let url = components?.url else { throw PersonalSyncError.invalidResponse }
        var request = URLRequest(url: url)
        request.setValue("Bearer \(bearerToken)", forHTTPHeaderField: "Authorization")
        return try await send(request, as: PullResponse.self)
    }

    private func send<T: Decodable & Sendable>(
        _ request: URLRequest,
        as type: T.Type
    ) async throws -> T {
        let (data, response) = try await session.data(for: request)
        guard let http = response as? HTTPURLResponse else {
            throw PersonalSyncError.invalidResponse
        }
        guard (200..<300).contains(http.statusCode) else {
            let message = String(data: data, encoding: .utf8) ?? "HTTP \(http.statusCode)"
            throw PersonalSyncError.server(status: http.statusCode, message: message)
        }
        return try decoder.decode(type, from: data)
    }
}
