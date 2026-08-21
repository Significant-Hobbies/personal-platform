import { authenticate, ensureUser } from "./auth";
import { forwardCalorie, getCalorieRecords, getCalorieToday } from "./calorie";
import { HttpError, isDomain, parsePushRequest, requireInteger, requireString } from "./contracts";
import {
  executeAction,
  getActivity,
  getAvailableActions,
  getDomainSummary,
  getToday,
  undoAction,
} from "./domains";
import { getLiveRecords, getLiveSummary } from "./live";
import { authenticateMcp } from "./mcp-auth";
import { handleMcp } from "./mcp";
import { getDomainRecords, getLifeEvents, parseReadQuery } from "./reads";
import { errorResponse, json, preflight, readJson, withCors } from "./http";
import { pullChanges, pushMutations } from "./sync";

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    if (request.method === "OPTIONS") return preflight(request, env);
    try {
      const response = await route(request, env);
      return withCors(request, response, env);
    } catch (error) {
      return withCors(request, errorResponse(error), env);
    }
  },
} satisfies ExportedHandler<Env>;

async function route(request: Request, env: Env): Promise<Response> {
  const url = new URL(request.url);
  if (request.method === "GET" && url.pathname === "/health") {
    return json({ status: "ok", service: "personal-platform" });
  }

  if (url.pathname === "/mcp") {
    const user = await authenticateMcp(request, env);
    await ensureUser(env, user);
    return handleMcp(request, env, user);
  }

  const user = await authenticate(request, env);
  await ensureUser(env, user);

  if (request.method === "POST" && url.pathname === "/v1/sync/push") {
    const push = parsePushRequest(await readJson(request));
    return json({ results: await pushMutations(env, user.id, push) });
  }

  if (request.method === "GET" && url.pathname === "/v1/sync/pull") {
    const domain = url.searchParams.get("domain");
    if (!isDomain(domain)) throw new HttpError(400, "invalid_domain", "domain is not supported");
    const cursor = parseCursor(url.searchParams.get("cursor"));
    return json(await pullChanges(env, user.id, domain, cursor));
  }

  if (request.method === "GET" && url.pathname === "/v1/life/today") {
    const [today, live, calorie] = await Promise.all([
      getToday(env, user.id),
      getLiveSummary(request, env, user),
      getCalorieToday(request, env, user),
    ]);
    return json({
      ...today,
      summaries: [live, ...today.summaries, calorie],
    });
  }

  if (request.method === "GET" && url.pathname === "/v1/life/events") {
    return json(await getLifeEvents(env, user.id, url));
  }

  if (request.method === "GET" && url.pathname === "/v1/activity") {
    return json({ actions: await getActivity(env, user.id) });
  }

  const domainMatch = url.pathname.match(
    /^\/v1\/domains\/([^/]+)\/(summary|records|actions)(?:\/([^/]+))?$/,
  );
  if (domainMatch) {
    const domain = domainMatch[1];
    const resource = domainMatch[2];
    const action = domainMatch[3];
    if (domain === "calorie") {
      if (resource === "summary" && request.method === "GET") {
        return forwardCalorie(request, env, user, "/v1/personal/summary");
      }
      if (resource === "records" && request.method === "GET") {
        return getCalorieRecords(request, env, user, url.searchParams);
      }
      if (resource === "actions" && action && request.method === "POST") {
        return forwardCalorie(request, env, user, `/v1/personal/actions/${action}`);
      }
      throw new HttpError(404, "not_found", "Calorie endpoint was not found");
    }
    if (!isDomain(domain)) throw new HttpError(404, "unknown_domain", "domain was not found");
    if (domain === "live") {
      if (resource === "summary" && request.method === "GET") {
        return json(await getLiveSummary(request, env, user));
      }
      if (resource === "records" && request.method === "GET") {
        return getLiveRecords(request, env, user, url.searchParams);
      }
    }
    if (resource === "summary" && request.method === "GET") {
      return json(await getDomainSummary(env, user.id, domain));
    }
    if (resource === "records" && request.method === "GET") {
      return json(await getDomainRecords(env, user.id, domain, parseReadQuery(url)));
    }
    if (resource === "actions" && !action && request.method === "GET") {
      return json({ domain, actions: getAvailableActions(domain) });
    }
    if (resource === "actions" && action && request.method === "POST") {
      return json(await executeAction(env, user.id, domain, action, await readJson(request)));
    }
  }

  const undoMatch = url.pathname.match(/^\/v1\/actions\/([^/]+)\/undo$/);
  if (undoMatch && request.method === "POST") {
    return json(await undoAction(env, user.id, requireString(undoMatch[1], "actionId", 128)));
  }

  throw new HttpError(404, "not_found", "route was not found");
}

function parseCursor(value: string | null): number {
  if (value === null || value === "") return 0;
  const number = Number(value);
  return requireInteger(number, "cursor");
}
