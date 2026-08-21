import { AuthenticatedUser, HttpError } from "./contracts";
import { optionalFetcher } from "./auth";

const CALORIE_ORIGIN = "https://calorie.internal";

export async function forwardCalorie(
  request: Request,
  env: Env,
  user: AuthenticatedUser,
  endpoint: string,
): Promise<Response> {
  const service = optionalFetcher(env, "CALORIE_SERVICE");
  if (!service) {
    throw new HttpError(
      503,
      "calorie_connector_unavailable",
      "the Calorie service binding is not configured",
    );
  }
  const headers = new Headers();
  headers.set("X-Personal-User-Id", user.id);
  headers.set("Accept", "application/json");
  const contentType = request.headers.get("Content-Type");
  if (contentType) headers.set("Content-Type", contentType);
  const idempotencyKey = request.headers.get("Idempotency-Key");
  if (idempotencyKey) headers.set("Idempotency-Key", idempotencyKey);

  const body = request.method === "GET" || request.method === "HEAD" ? undefined : request.body;
  return service.fetch(`${CALORIE_ORIGIN}${endpoint}`, {
    method: request.method,
    headers,
    body,
  });
}
