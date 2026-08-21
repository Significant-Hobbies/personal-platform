import { AuthenticatedUser, HttpError } from "./contracts";
import { optionalFetcher } from "./auth";

const LIVE_ORIGIN = "https://personal-auth.internal";

export async function getLiveSummary(
  request: Request,
  env: Env,
  user: AuthenticatedUser,
) {
  const response = await fetchLive(request, env, user, "/api/personal-platform/live/summary");
  if (!response) return unavailableSummary("connector_not_configured");
  if (!response.ok) return unavailableSummary(`upstream_${response.status}`);
  return response.json();
}

export async function getLiveRecords(
  request: Request,
  env: Env,
  user: AuthenticatedUser,
  query: URLSearchParams,
): Promise<Response> {
  const path = `/api/personal-platform/live/records${query.size ? `?${query}` : ""}`;
  const response = await fetchLive(request, env, user, path);
  if (!response) {
    throw new HttpError(
      503,
      "live_connector_unavailable",
      "the Live service binding is not configured",
    );
  }
  return response;
}

async function fetchLive(
  request: Request,
  env: Env,
  user: AuthenticatedUser,
  path: string,
): Promise<Response | null> {
  const service = optionalFetcher(env, "AUTH_SERVICE");
  if (!service) return null;
  const authorization = request.headers.get("Authorization");
  const headers = new Headers({
    Accept: "application/json",
    "X-Personal-User-Id": user.id,
  });
  if (authorization) headers.set("Authorization", authorization);
  return service.fetch(`${LIVE_ORIGIN}${path}`, { headers });
}

function unavailableSummary(reason: string) {
  return {
    domain: "live",
    source: "significant-hobbies-service",
    status: "unavailable",
    reason,
    activeCount: null,
    lastUpdatedAt: null,
  };
}
