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
  const authorization = request.headers.get("Authorization");
  if (authorization) headers.set("Authorization", authorization);
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

export async function getCalorieToday(
  request: Request,
  env: Env,
  user: AuthenticatedUser,
) {
  const service = optionalFetcher(env, "CALORIE_SERVICE");
  if (!service) return unavailableSummary("connector_not_configured");
  try {
    const timezone = String(env.OWNER_TIMEZONE || "UTC");
    const date = new Intl.DateTimeFormat("en-CA", {
      timeZone: timezone,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
    }).format(Date.now());
    const url = new URL(`${CALORIE_ORIGIN}/v1/personal/summary`);
    url.searchParams.set("date", date);
    url.searchParams.set("timezone", timezone);
    const response = await service.fetch(url, {
      headers: {
        Authorization: request.headers.get("Authorization") ?? "",
        "X-Personal-User-Id": user.id,
        Accept: "application/json",
      },
    });
    if (!response.ok) return unavailableSummary(`upstream_${response.status}`);
    return {
      domain: "calorie",
      source: "calorie-service",
      status: "connected",
      summary: await response.json(),
    };
  } catch {
    return unavailableSummary("upstream_unreachable");
  }
}

export async function getCalorieRecords(
  request: Request,
  env: Env,
  user: AuthenticatedUser,
  query: URLSearchParams,
): Promise<Response> {
  const start = query.get("start");
  const end = query.get("end");
  if (!start || !end) {
    throw new HttpError(400, "invalid_range", "Calorie history requires start and end");
  }
  if (!/^\d{4}-\d{2}-\d{2}$/.test(start) || !/^\d{4}-\d{2}-\d{2}$/.test(end) || start > end) {
    throw new HttpError(400, "invalid_range", "Choose a valid Calorie history range");
  }
  const upstream = new URL("/v1/personal/history", CALORIE_ORIGIN);
  upstream.searchParams.set("start", start);
  upstream.searchParams.set("end", end);
  upstream.searchParams.set("timezone", String(env.OWNER_TIMEZONE || "UTC"));
  for (const key of ["limit", "offset"]) {
    const value = query.get(key);
    if (value) upstream.searchParams.set(key, value);
  }
  const service = optionalFetcher(env, "CALORIE_SERVICE");
  if (!service) {
    throw new HttpError(
      503,
      "calorie_connector_unavailable",
      "the Calorie service binding is not configured",
    );
  }
  const headers = new Headers({
    Accept: "application/json",
    "X-Personal-User-Id": user.id,
  });
  const authorization = request.headers.get("Authorization");
  if (authorization) headers.set("Authorization", authorization);
  return service.fetch(upstream, { headers });
}

function unavailableSummary(reason: string) {
  return {
    domain: "calorie",
    source: "calorie-service",
    status: "unavailable",
    reason,
    lastUpdatedAt: null,
  };
}
