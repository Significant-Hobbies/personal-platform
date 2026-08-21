import Foundation
#if canImport(FoundationNetworking)
import FoundationNetworking
#endif
#if canImport(Security)
import Security
#endif

public struct PersonalAppleCredential: Equatable, Sendable {
    public let identityToken: String
    public let nonce: String
    public let email: String?
    public let firstName: String?
    public let lastName: String?

    public init(
        identityToken: String,
        nonce: String,
        email: String? = nil,
        firstName: String? = nil,
        lastName: String? = nil
    ) {
        self.identityToken = identityToken
        self.nonce = nonce
        self.email = email
        self.firstName = firstName
        self.lastName = lastName
    }
}

public struct PersonalIdentitySession: Codable, Equatable, Sendable {
    public let userId: String
    public let email: String
    public let appleSubject: String?
}

public enum PersonalIdentityError: LocalizedError, Equatable, Sendable {
    case missingSession
    case invalidResponse
    case server(status: Int, message: String)
    case keychain(status: Int32)

    public var errorDescription: String? {
        switch self {
        case .missingSession: "Sign in again to connect this app."
        case .invalidResponse: "The personal account service returned an invalid response."
        case let .server(_, message): message
        case .keychain: "The secure account session could not be accessed."
        }
    }
}

public protocol PersonalBearerTokenStore: Sendable {
    func load() async throws -> String?
    func save(_ token: String) async throws
    func delete() async throws
}

#if canImport(Security)
public actor KeychainBearerTokenStore: PersonalBearerTokenStore {
    private let service: String
    private let account: String

    public init(service: String, account: String = "better-auth-bearer") {
        self.service = service
        self.account = account
    }

    public func load() throws -> String? {
        let query: [String: Any] = [
            kSecClass as String: kSecClassGenericPassword,
            kSecAttrService as String: service,
            kSecAttrAccount as String: account,
            kSecReturnData as String: true,
            kSecMatchLimit as String: kSecMatchLimitOne,
        ]
        var result: CFTypeRef?
        let status = SecItemCopyMatching(query as CFDictionary, &result)
        if status == errSecItemNotFound { return nil }
        guard status == errSecSuccess, let data = result as? Data,
              let token = String(data: data, encoding: .utf8)
        else { throw PersonalIdentityError.keychain(status: status) }
        return token
    }

    public func save(_ token: String) throws {
        let identity: [String: Any] = [
            kSecClass as String: kSecClassGenericPassword,
            kSecAttrService as String: service,
            kSecAttrAccount as String: account,
        ]
        let attributes: [String: Any] = [
            kSecValueData as String: Data(token.utf8),
            kSecAttrAccessible as String: kSecAttrAccessibleAfterFirstUnlockThisDeviceOnly,
        ]
        let status = SecItemUpdate(identity as CFDictionary, attributes as CFDictionary)
        if status == errSecItemNotFound {
            var insertion = identity
            insertion.merge(attributes) { _, replacement in replacement }
            let insertionStatus = SecItemAdd(insertion as CFDictionary, nil)
            guard insertionStatus == errSecSuccess else {
                throw PersonalIdentityError.keychain(status: insertionStatus)
            }
        } else if status != errSecSuccess {
            throw PersonalIdentityError.keychain(status: status)
        }
    }

    public func delete() throws {
        let status = SecItemDelete([
            kSecClass as String: kSecClassGenericPassword,
            kSecAttrService as String: service,
            kSecAttrAccount as String: account,
        ] as CFDictionary)
        guard status == errSecSuccess || status == errSecItemNotFound else {
            throw PersonalIdentityError.keychain(status: status)
        }
    }
}
#endif

public actor PersonalIdentityClient {
    private let baseURL: URL
    private let session: URLSession
    private let tokenStore: any PersonalBearerTokenStore
    private let decoder = JSONDecoder()
    private let encoder = JSONEncoder()

    public init(
        baseURL: URL = URL(string: "https://significanthobbies.com")!,
        session: URLSession = .shared,
        tokenStore: any PersonalBearerTokenStore
    ) {
        self.baseURL = baseURL
        self.session = session
        self.tokenStore = tokenStore
    }

    public func signInWithApple(_ credential: PersonalAppleCredential) async throws
        -> PersonalIdentitySession
    {
        var request = URLRequest(url: endpoint("api/auth/sign-in/social"))
        request.httpMethod = "POST"
        request.setValue("application/json", forHTTPHeaderField: "Content-Type")
        request.httpBody = try encoder.encode(AppleSignInRequest(credential: credential))
        let (_, response) = try await send(request)
        guard let token = response.value(forHTTPHeaderField: "set-auth-token"), !token.isEmpty else {
            throw PersonalIdentityError.missingSession
        }
        try await tokenStore.save(token)
        return try await identitySession(bearerToken: token)
    }

    public func linkApple(_ credential: PersonalAppleCredential) async throws
        -> PersonalIdentitySession
    {
        guard let token = try await tokenStore.load() else {
            throw PersonalIdentityError.missingSession
        }
        var request = URLRequest(url: endpoint("api/auth/link-social"))
        request.httpMethod = "POST"
        request.setValue("Bearer \(token)", forHTTPHeaderField: "Authorization")
        request.setValue("application/json", forHTTPHeaderField: "Content-Type")
        request.httpBody = try encoder.encode(AppleSignInRequest(credential: credential))
        _ = try await send(request)
        return try await identitySession(bearerToken: token)
    }

    public func restoreSession() async throws -> PersonalIdentitySession? {
        guard let token = try await tokenStore.load() else { return nil }
        do {
            return try await identitySession(bearerToken: token)
        } catch let error as PersonalIdentityError {
            if case .server(status: 401, message: _) = error {
                try? await tokenStore.delete()
            }
            throw error
        }
    }

    public func bearerToken() async throws -> String? {
        try await tokenStore.load()
    }

    /// Adopts the one-use native browser handoff returned by the existing
    /// Better Auth service. This is the shared sign-in path for bundle IDs that
    /// are not the Journal app's native Apple client.
    public func adoptBearerToken(_ token: String) async throws -> PersonalIdentitySession {
        guard !token.isEmpty else { throw PersonalIdentityError.missingSession }
        try await tokenStore.save(token)
        do {
            return try await identitySession(bearerToken: token)
        } catch {
            try? await tokenStore.delete()
            throw error
        }
    }

    /// Exchanges the one-use code returned by the native browser handoff and
    /// persists the resulting Significant Hobbies bearer session.
    public func exchangeBrowserHandoff(_ code: String) async throws -> PersonalIdentitySession {
        guard !code.isEmpty else { throw PersonalIdentityError.invalidResponse }
        var request = URLRequest(url: endpoint("api/native/auth/exchange"))
        request.httpMethod = "POST"
        request.setValue("application/json", forHTTPHeaderField: "Content-Type")
        request.httpBody = try encoder.encode(HandoffRequest(code: code))
        let (data, _) = try await send(request)
        let response = try decoder.decode(HandoffResponse.self, from: data)
        return try await adoptBearerToken(response.token)
    }

    public func signOut() async {
        if let token = try? await tokenStore.load() {
            var request = URLRequest(url: endpoint("api/auth/sign-out"))
            request.httpMethod = "POST"
            request.setValue("Bearer \(token)", forHTTPHeaderField: "Authorization")
            request.setValue("application/json", forHTTPHeaderField: "Content-Type")
            request.httpBody = Data("{}".utf8)
            _ = try? await send(request)
        }
        try? await tokenStore.delete()
    }

    private func identitySession(bearerToken: String) async throws -> PersonalIdentitySession {
        var request = URLRequest(url: endpoint("api/personal-platform/session"))
        request.setValue("Bearer \(bearerToken)", forHTTPHeaderField: "Authorization")
        let (data, _) = try await send(request)
        return try decoder.decode(PersonalIdentitySession.self, from: data)
    }

    private func endpoint(_ path: String) -> URL {
        baseURL.appending(path: path)
    }

    private func send(_ request: URLRequest) async throws -> (Data, HTTPURLResponse) {
        let (data, response) = try await session.data(for: request)
        guard let http = response as? HTTPURLResponse else {
            throw PersonalIdentityError.invalidResponse
        }
        guard (200..<300).contains(http.statusCode) else {
            let body = try? decoder.decode(ServerError.self, from: data)
            throw PersonalIdentityError.server(
                status: http.statusCode,
                message: body?.message ?? "Personal account request failed."
            )
        }
        return (data, http)
    }
}

private struct AppleSignInRequest: Encodable {
    let provider = "apple"
    let idToken: AppleIDToken

    init(credential: PersonalAppleCredential) {
        idToken = AppleIDToken(credential: credential)
    }
}

private struct HandoffRequest: Encodable { let code: String }
private struct HandoffResponse: Decodable { let token: String }

private struct AppleIDToken: Encodable {
    let token: String
    let nonce: String
    let user: AppleUser?

    init(credential: PersonalAppleCredential) {
        token = credential.identityToken
        nonce = credential.nonce
        let name = AppleName(firstName: credential.firstName, lastName: credential.lastName)
        user = credential.email == nil && name.isEmpty ? nil : AppleUser(email: credential.email, name: name)
    }
}

private struct AppleUser: Encodable {
    let email: String?
    let name: AppleName
}

private struct AppleName: Encodable {
    let firstName: String?
    let lastName: String?
    var isEmpty: Bool { firstName == nil && lastName == nil }
}

private struct ServerError: Decodable {
    let message: String
}
