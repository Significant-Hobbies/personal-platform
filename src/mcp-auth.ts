import { AuthenticatedUser, HttpError } from "./contracts";
import { authenticate } from "./auth";

interface OAuthClaims {
  iss?: unknown;
  sub?: unknown;
  aud?: unknown;
  scope?: unknown;
  exp?: unknown;
  iat?: unknown;
  nbf?: unknown;
}

interface JsonWebKeySet {
  keys?: Array<JsonWebKey & { kid?: string; alg?: string }>;
}

export async function authenticateMcp(
  request: Request,
  env: Env,
  fetchImpl: typeof fetch = fetch,
): Promise<AuthenticatedUser> {
  if (String(env.AUTH_MODE) === "local-test") return authenticate(request, env);
  const authorization = request.headers.get("Authorization");
  if (!authorization?.startsWith("Bearer ")) {
    throw new HttpError(401, "unauthorized", "an OAuth bearer token is required");
  }
  const config = oauthConfig(env);
  const claims = await verifyJwt(authorization.slice("Bearer ".length), config, fetchImpl);
  if (claims.sub !== config.ownerSubject) {
    throw new HttpError(403, "forbidden", "the connected ChatGPT account is not approved");
  }
  return { id: config.personalUserId };
}

interface OAuthConfig {
  issuer: string;
  audience: string;
  scope: string;
  ownerSubject: string;
  personalUserId: string;
}

function oauthConfig(env: Env): OAuthConfig {
  const values = env as unknown as Record<string, unknown>;
  const issuer = String(values.AUTH0_ISSUER || "");
  const audience = String(values.PERSONAL_APPS_MCP_AUDIENCE || "");
  const ownerSubject = String(values.AUTH0_OWNER_USER_ID || "");
  const personalUserId = String(values.PERSONAL_OWNER_USER_ID || "");
  if (!issuer || !audience || !ownerSubject || !personalUserId) {
    throw new HttpError(503, "mcp_auth_not_configured", "Personal Apps OAuth is not configured");
  }
  const url = new URL(issuer);
  if (url.protocol !== "https:" || !url.hostname.endsWith(".auth0.com")) {
    throw new HttpError(503, "mcp_auth_not_configured", "Personal Apps OAuth issuer is invalid");
  }
  return {
    issuer: issuer.endsWith("/") ? issuer : `${issuer}/`,
    audience,
    scope: "personal-apps.read",
    ownerSubject,
    personalUserId,
  };
}

async function verifyJwt(
  token: string,
  config: OAuthConfig,
  fetchImpl: typeof fetch,
): Promise<OAuthClaims & { sub: string }> {
  const segments = token.split(".");
  if (segments.length !== 3) throw new HttpError(401, "unauthorized", "the OAuth token is invalid");
  const header = decodeJson(segments[0]) as { alg?: unknown; kid?: unknown };
  const claims = decodeJson(segments[1]) as OAuthClaims;
  if (header.alg !== "RS256" || typeof header.kid !== "string") {
    throw new HttpError(401, "unauthorized", "the OAuth token algorithm is invalid");
  }
  const response = await fetchImpl(new URL(".well-known/jwks.json", config.issuer));
  if (!response.ok) throw new HttpError(503, "oauth_unavailable", "OAuth signing keys are unavailable");
  const set = (await response.json()) as JsonWebKeySet;
  const jwk = set.keys?.find((key) => key.kid === header.kid && key.kty === "RSA");
  if (!jwk) throw new HttpError(401, "unauthorized", "the OAuth signing key is unknown");
  const key = await crypto.subtle.importKey(
    "jwk",
    jwk,
    { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" },
    false,
    ["verify"],
  );
  const valid = await crypto.subtle.verify(
    "RSASSA-PKCS1-v1_5",
    key,
    base64url(segments[2]),
    new TextEncoder().encode(`${segments[0]}.${segments[1]}`),
  );
  if (!valid) throw new HttpError(401, "unauthorized", "the OAuth token signature is invalid");

  const now = Math.floor(Date.now() / 1000);
  const audiences = Array.isArray(claims.aud) ? claims.aud : [claims.aud];
  const scopes = typeof claims.scope === "string" ? claims.scope.split(/\s+/u) : [];
  if (
    claims.iss !== config.issuer ||
    !audiences.includes(config.audience) ||
    !scopes.includes(config.scope) ||
    typeof claims.sub !== "string" ||
    typeof claims.exp !== "number" ||
    typeof claims.iat !== "number" ||
    claims.exp <= now ||
    claims.iat > now + 60 ||
    claims.exp - claims.iat > 3_600 ||
    (typeof claims.nbf === "number" && claims.nbf > now + 60)
  ) {
    throw new HttpError(401, "unauthorized", "the OAuth token claims are invalid");
  }
  return claims as OAuthClaims & { sub: string };
}

function decodeJson(segment: string | undefined): unknown {
  if (!segment) throw new HttpError(401, "unauthorized", "the OAuth token is invalid");
  try {
    return JSON.parse(new TextDecoder().decode(base64url(segment)));
  } catch {
    throw new HttpError(401, "unauthorized", "the OAuth token is invalid");
  }
}

function base64url(value: string | undefined): Uint8Array {
  if (!value) return new Uint8Array();
  const normalized = value.replaceAll("-", "+").replaceAll("_", "/");
  const padded = normalized.padEnd(Math.ceil(normalized.length / 4) * 4, "=");
  const binary = atob(padded);
  return Uint8Array.from(binary, (character) => character.charCodeAt(0));
}
