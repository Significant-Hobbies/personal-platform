#if canImport(AuthenticationServices) && canImport(CryptoKit) && canImport(Observation)
import AuthenticationServices
import CryptoKit
import Foundation
import Observation

@MainActor
@Observable
public final class PersonalAppleSignInModel {
    public private(set) var session: PersonalIdentitySession?
    public private(set) var isConnecting = false
    public private(set) var errorMessage: String?

    private let identity: PersonalIdentityClient
    private var rawNonce: String?

    public init(identity: PersonalIdentityClient) {
        self.identity = identity
    }

    public var isSignedIn: Bool { session != nil }

    public func restore() async {
        isConnecting = true
        defer { isConnecting = false }
        do {
            session = try await identity.restoreSession()
            errorMessage = nil
        } catch {
            session = nil
            errorMessage = error.localizedDescription
        }
    }

    public func prepare(_ request: ASAuthorizationAppleIDRequest) {
        let nonce = UUID().uuidString.replacingOccurrences(of: "-", with: "").lowercased()
        rawNonce = nonce
        request.requestedScopes = [.email, .fullName]
        request.nonce = Self.sha256(nonce)
    }

    public func complete(_ result: Result<ASAuthorization, Error>) async {
        isConnecting = true
        defer {
            isConnecting = false
            rawNonce = nil
        }
        do {
            let authorization = try result.get()
            guard
                let apple = authorization.credential as? ASAuthorizationAppleIDCredential,
                let identityToken = apple.identityToken.flatMap({ String(data: $0, encoding: .utf8) }),
                let nonce = rawNonce
            else {
                throw PersonalIdentityError.invalidResponse
            }
            session = try await identity.signInWithApple(
                PersonalAppleCredential(
                    identityToken: identityToken,
                    nonce: nonce,
                    email: apple.email,
                    firstName: apple.fullName?.givenName,
                    lastName: apple.fullName?.familyName
                )
            )
            errorMessage = nil
        } catch {
            session = nil
            errorMessage = error.localizedDescription
        }
    }

    public func signOut() async {
        await identity.signOut()
        session = nil
        errorMessage = nil
    }

    private static func sha256(_ value: String) -> String {
        SHA256.hash(data: Data(value.utf8)).map { String(format: "%02x", $0) }.joined()
    }
}
#endif
