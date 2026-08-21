#if canImport(AuthenticationServices) && (os(iOS) || os(macOS))
import AuthenticationServices
import CryptoKit
import Foundation
import Observation
#if os(iOS)
import UIKit
#elseif os(macOS)
import AppKit
#endif

@MainActor
@Observable
public final class PersonalAccountModel: NSObject,
    ASWebAuthenticationPresentationContextProviding
{
    public private(set) var session: PersonalIdentitySession?
    public private(set) var isConnecting = false
    public private(set) var errorMessage: String?

    private let identity: PersonalIdentityClient
    private let callbackScheme: String
    private let identityURL: URL
    private var webSession: ASWebAuthenticationSession?
    private var rawAppleNonce: String?

    public init(
        identity: PersonalIdentityClient,
        callbackScheme: String,
        identityURL: URL = URL(string: "https://significanthobbies.com")!
    ) {
        self.identity = identity
        self.callbackScheme = callbackScheme
        self.identityURL = identityURL
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

    public func connectWithGoogle() async {
        guard !isConnecting else { return }
        isConnecting = true
        defer { isConnecting = false }
        do {
            let code = try await authenticateInBrowser()
            let token = try await exchange(code: code)
            session = try await identity.adoptBearerToken(token)
            errorMessage = nil
        } catch let error as ASWebAuthenticationSessionError
            where error.code == .canceledLogin {
            errorMessage = nil
        } catch {
            session = nil
            errorMessage = error.localizedDescription
        }
    }

    public func connect() async {
        await connectWithGoogle()
    }

    public func prepareApple(_ request: ASAuthorizationAppleIDRequest) {
        let nonce = UUID().uuidString.replacingOccurrences(of: "-", with: "").lowercased()
        rawAppleNonce = nonce
        request.requestedScopes = [.email, .fullName]
        request.nonce = Self.sha256(nonce)
    }

    public func completeApple(_ result: Result<ASAuthorization, Error>) async {
        isConnecting = true
        defer {
            isConnecting = false
            rawAppleNonce = nil
        }
        do {
            let authorization = try result.get()
            guard
                let apple = authorization.credential as? ASAuthorizationAppleIDCredential,
                let identityToken = apple.identityToken.flatMap({ String(data: $0, encoding: .utf8) }),
                let nonce = rawAppleNonce
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
        } catch let error as ASAuthorizationError where error.code == .canceled {
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

    public func presentationAnchor(for _: ASWebAuthenticationSession) -> ASPresentationAnchor {
        #if os(iOS)
        return UIApplication.shared.connectedScenes
            .compactMap { $0 as? UIWindowScene }
            .flatMap(\.windows)
            .first(where: \.isKeyWindow) ?? ASPresentationAnchor()
        #elseif os(macOS)
        return NSApplication.shared.keyWindow ?? NSWindow()
        #endif
    }

    private func authenticateInBrowser() async throws -> String {
        var components = URLComponents(
            url: identityURL.appending(path: "api/native/auth/google/start"),
            resolvingAgainstBaseURL: false
        )!
        components.queryItems = [
            URLQueryItem(name: "callback", value: "\(callbackScheme)://auth"),
        ]
        let url = components.url!
        return try await withCheckedThrowingContinuation { continuation in
            let session = ASWebAuthenticationSession(url: url, callbackURLScheme: callbackScheme) {
                callbackURL, error in
                if let error {
                    continuation.resume(throwing: error)
                    return
                }
                guard let callbackURL,
                      callbackURL.scheme == self.callbackScheme,
                      callbackURL.host == "auth",
                      let code = URLComponents(url: callbackURL, resolvingAgainstBaseURL: false)?
                        .queryItems?.first(where: { $0.name == "code" })?.value
                else {
                    continuation.resume(throwing: PersonalIdentityError.invalidResponse)
                    return
                }
                continuation.resume(returning: code)
            }
            session.presentationContextProvider = self
            session.prefersEphemeralWebBrowserSession = false
            webSession = session
            guard session.start() else {
                continuation.resume(throwing: PersonalIdentityError.invalidResponse)
                return
            }
        }
    }

    private func exchange(code: String) async throws -> String {
        var request = URLRequest(url: identityURL.appending(path: "api/native/auth/exchange"))
        request.httpMethod = "POST"
        request.setValue("application/json", forHTTPHeaderField: "Content-Type")
        request.httpBody = try JSONEncoder().encode(HandoffRequest(code: code))
        let (data, response) = try await URLSession.shared.data(for: request)
        guard let http = response as? HTTPURLResponse,
              (200..<300).contains(http.statusCode),
              let token = try? JSONDecoder().decode(HandoffResponse.self, from: data).token,
              !token.isEmpty
        else { throw PersonalIdentityError.invalidResponse }
        return token
    }

    private static func sha256(_ value: String) -> String {
        SHA256.hash(data: Data(value.utf8)).map { String(format: "%02x", $0) }.joined()
    }
}

@available(*, deprecated, renamed: "PersonalAccountModel")
public typealias PersonalWebSignInModel = PersonalAccountModel

private struct HandoffRequest: Encodable { let code: String }
private struct HandoffResponse: Decodable { let token: String }
#endif
