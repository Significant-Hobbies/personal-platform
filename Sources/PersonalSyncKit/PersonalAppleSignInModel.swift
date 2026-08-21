#if canImport(AuthenticationServices) && (os(iOS) || os(macOS))
@available(*, deprecated, renamed: "PersonalAccountModel")
public typealias PersonalAppleSignInModel = PersonalAccountModel
#endif
