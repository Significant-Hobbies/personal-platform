import { AuthenticatedUser, HttpError } from "./contracts";

const AUTH_SERVICE_URL = "https://personal-auth.internal/api/personal-platform/session";

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
  if (response.status === 401) {
    throw new HttpError(401, "unauthorized", "the bearer token is invalid");
  }
  if (!response.ok) {
    throw new HttpError(502, "auth_service_unavailable", "auth service could not verify the token");
  }
  const body = (await response.json()) as Record<string, unknown>;
  if (typeof body.userId !== "string" || body.userId.length === 0) {
    throw new HttpError(502, "invalid_auth_response", "auth service returned no user ID");
  }
  return { id: body.userId };
}

export async function ensureUser(env: Env, user: AuthenticatedUser): Promise<void> {
  const now = new Date().toISOString();
  await env.DB.prepare(
    `INSERT INTO users (id, created_at, updated_at)
     VALUES (?1, ?2, ?2)
     ON CONFLICT(id) DO UPDATE SET updated_at = excluded.updated_at`,
  )
    .bind(user.id, now)
    .run();
}

export function optionalFetcher(env: Env, binding: string): Fetcher | undefined {
  const value = (env as unknown as Record<string, unknown>)[binding];
  if (value && typeof value === "object" && "fetch" in value) {
    return value as Fetcher;
  }
  return undefined;
}
