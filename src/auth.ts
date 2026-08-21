import { AuthenticatedUser, HttpError } from "./contracts";

const AUTH_SERVICE_URL = "https://personal-auth.internal/v1/session";

export async function authenticate(request: Request, env: Env): Promise<AuthenticatedUser> {
  const authorization = request.headers.get("Authorization");
  if (!authorization?.startsWith("Bearer ")) {
    throw new HttpError(401, "unauthorized", "a bearer token is required");
  }

  const token = authorization.slice("Bearer ".length);
  if (
    String(env.AUTH_MODE) === "local-test" &&
    env.LOCAL_AUTH_TOKEN.length > 0 &&
    token === env.LOCAL_AUTH_TOKEN &&
    env.LOCAL_AUTH_USER_ID.length > 0
  ) {
    return { id: env.LOCAL_AUTH_USER_ID };
  }

  const authService = optionalFetcher(env, "AUTH_SERVICE");
  if (!authService) {
    throw new HttpError(
      503,
      "auth_not_configured",
      "production authentication is not configured",
    );
  }

  const response = await authService.fetch(AUTH_SERVICE_URL, {
    headers: { Authorization: authorization },
  });
  if (!response.ok) {
    throw new HttpError(401, "unauthorized", "the bearer token is invalid");
  }
  const body = (await response.json()) as Record<string, unknown>;
  if (typeof body.userId !== "string" || body.userId.length === 0) {
    throw new HttpError(502, "invalid_auth_response", "auth service returned no user ID");
  }
  return {
    id: body.userId,
    appleSubject: typeof body.appleSubject === "string" ? body.appleSubject : undefined,
    email: typeof body.email === "string" ? body.email : undefined,
  };
}

export async function ensureUser(env: Env, user: AuthenticatedUser): Promise<void> {
  const now = new Date().toISOString();
  await env.DB.prepare(
    `INSERT INTO users (id, apple_subject, email, created_at, updated_at)
     VALUES (?1, ?2, ?3, ?4, ?4)
     ON CONFLICT(id) DO UPDATE SET
       apple_subject = COALESCE(excluded.apple_subject, users.apple_subject),
       email = COALESCE(excluded.email, users.email),
       updated_at = excluded.updated_at`,
  )
    .bind(user.id, user.appleSubject ?? null, user.email ?? null, now)
    .run();
}

export function optionalFetcher(env: Env, binding: string): Fetcher | undefined {
  const value = (env as unknown as Record<string, unknown>)[binding];
  if (value && typeof value === "object" && "fetch" in value) {
    return value as Fetcher;
  }
  return undefined;
}
