import Foundation
import Testing
@testable import PersonalSyncKit

actor MemoryBearerStore: PersonalBearerTokenStore {
    private var token: String?

    func load() -> String? { token }
    func save(_ token: String) { self.token = token }
    func delete() { token = nil }
}

final class IdentityURLProtocol: URLProtocol, @unchecked Sendable {
    nonisolated(unsafe) static var handler: ((URLRequest) throws -> (HTTPURLResponse, Data))?

    override class func canInit(with request: URLRequest) -> Bool { true }
    override class func canonicalRequest(for request: URLRequest) -> URLRequest { request }

    override func startLoading() {
        do {
            guard let handler = Self.handler else {
                throw PersonalIdentityError.invalidResponse
            }
            let (response, data) = try handler(request)
            client?.urlProtocol(self, didReceive: response, cacheStoragePolicy: .notAllowed)
            client?.urlProtocol(self, didLoad: data)
            client?.urlProtocolDidFinishLoading(self)
        } catch {
            client?.urlProtocol(self, didFailWithError: error)
        }
    }

    override func stopLoading() {}
}

@Suite(.serialized)
struct PersonalIdentityClientTests {
    @Test
    func appleSignInStoresAndReusesBearerSession() async throws {
        IdentityURLProtocol.handler = { request in
            let path = request.url?.path
            if path == "/api/auth/sign-in/social" {
                #expect(request.httpMethod == "POST")
                #expect(request.value(forHTTPHeaderField: "Content-Type") == "application/json")
                return (try response(request, status: 200, headers: ["set-auth-token": "bearer-1"]), Data("{}".utf8))
            }
            #expect(path == "/api/personal-platform/session")
            #expect(request.value(forHTTPHeaderField: "Authorization") == "Bearer bearer-1")
            return (
                try response(request, status: 200),
                Data(#"{"userId":"shared-user","email":"owner@example.com","appleSubject":"apple-subject"}"#.utf8)
            )
        }

        let store = MemoryBearerStore()
        let client = PersonalIdentityClient(
            baseURL: try #require(URL(string: "https://identity.test")),
            session: testSession(),
            tokenStore: store
        )
        let identity = try await client.signInWithApple(
            PersonalAppleCredential(identityToken: "apple-jwt", nonce: "nonce")
        )

        #expect(identity.userId == "shared-user")
        #expect(try await client.bearerToken() == "bearer-1")
        #expect(try await client.restoreSession() == identity)
    }

    @Test
    func invalidRestoredSessionIsRemoved() async throws {
        let store = MemoryBearerStore()
        await store.save("expired")
        IdentityURLProtocol.handler = { request in
            (try response(request, status: 401), Data(#"{"message":"Sign in again."}"#.utf8))
        }
        let client = PersonalIdentityClient(
            baseURL: try #require(URL(string: "https://identity.test")),
            session: testSession(),
            tokenStore: store
        )

        await #expect(throws: PersonalIdentityError.self) {
            try await client.restoreSession()
        }
        #expect(await store.load() == nil)
    }

    @Test
    func appleLinkKeepsTheExistingBearerIdentity() async throws {
        let store = MemoryBearerStore()
        await store.save("existing-bearer")
        IdentityURLProtocol.handler = { request in
            if request.url?.path == "/api/auth/link-social" {
                #expect(request.httpMethod == "POST")
                #expect(
                    request.value(forHTTPHeaderField: "Authorization")
                        == "Bearer existing-bearer"
                )
                return (try response(request, status: 200), Data("{}".utf8))
            }
            #expect(request.url?.path == "/api/personal-platform/session")
            return (
                try response(request, status: 200),
                Data(#"{"userId":"shared-user","email":"owner@example.com","appleSubject":"apple-subject"}"#.utf8)
            )
        }
        let client = PersonalIdentityClient(
            baseURL: try #require(URL(string: "https://identity.test")),
            session: testSession(),
            tokenStore: store
        )

        let identity = try await client.linkApple(
            PersonalAppleCredential(identityToken: "apple-jwt", nonce: "nonce")
        )

        #expect(identity.appleSubject == "apple-subject")
        #expect(await store.load() == "existing-bearer")
    }

    @Test
    func nativeBrowserHandoffIsValidatedAndPersisted() async throws {
        IdentityURLProtocol.handler = { request in
            #expect(request.url?.path == "/api/personal-platform/session")
            #expect(request.value(forHTTPHeaderField: "Authorization") == "Bearer handoff-token")
            return (
                try response(request, status: 200),
                Data(#"{"userId":"shared-user","email":"owner@example.com","appleSubject":null}"#.utf8)
            )
        }
        let store = MemoryBearerStore()
        let client = PersonalIdentityClient(
            baseURL: try #require(URL(string: "https://identity.test")),
            session: testSession(),
            tokenStore: store
        )

        let identity = try await client.adoptBearerToken("handoff-token")

        #expect(identity.userId == "shared-user")
        #expect(await store.load() == "handoff-token")
    }
}

private func testSession() -> URLSession {
    let configuration = URLSessionConfiguration.ephemeral
    configuration.protocolClasses = [IdentityURLProtocol.self]
    return URLSession(configuration: configuration)
}

private func response(
    _ request: URLRequest,
    status: Int,
    headers: [String: String] = [:]
) throws -> HTTPURLResponse {
    guard let url = request.url,
          let response = HTTPURLResponse(
              url: url,
              statusCode: status,
              httpVersion: nil,
              headerFields: headers
          )
    else { throw PersonalIdentityError.invalidResponse }
    return response
}
