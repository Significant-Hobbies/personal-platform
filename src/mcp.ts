import { AuthenticatedUser, Domain, HttpError, isDomain, requireObject } from "./contracts";
import { getCalorieRecords, getCalorieToday } from "./calorie";
import { getToday } from "./domains";
import { getLiveRecords, getLiveSummary } from "./live";
import { getDomainRecords, getLifeEvents, parseReadQuery } from "./reads";

interface McpRequest {
  jsonrpc?: unknown;
  id?: unknown;
  method?: unknown;
  params?: unknown;
}

const DOMAIN_TOOLS: Readonly<Record<string, Domain | "calorie">> = {
  live_search_items: "live",
  journal_search_entries: "journal",
  habits_get_history: "habits",
  calorie_get_history: "calorie",
  setline_get_workouts: "setline",
  kith_get_relationships: "kith",
  anchor_get_sessions: "anchor",
};

const COMMON_PROPERTIES = {
  q: { type: "string", maxLength: 200 },
  start: { type: "string", description: "Inclusive ISO-8601 date or timestamp." },
  end: { type: "string", description: "Inclusive ISO-8601 date or timestamp." },
  limit: { type: "integer", minimum: 1, maximum: 50, default: 20 },
  offset: { type: "integer", minimum: 0, maximum: 1_000_000, default: 0 },
};

const TOOLS = [
  tool("life_get_today", "Get a privacy-safe current summary from all seven personal domains."),
  tool("life_search_events", "Search bounded cross-domain activity with provenance.", {
    ...COMMON_PROPERTIES,
    domain: { type: "string", enum: ["live", "journal", "habits", "calorie", "setline", "kith", "anchor"] },
  }),
  tool("live_search_items", "Search private bucket-list items and their current status.", {
    ...COMMON_PROPERTIES,
    includeSensitive: explicitSensitive("Include item descriptions only when the question requires them."),
  }),
  tool("journal_search_entries", "Search private journal entries by date and optional text.", {
    ...COMMON_PROPERTIES,
    includeSensitive: explicitSensitive("Include journal text only when the question explicitly asks about writing."),
  }),
  tool("habits_get_history", "Read bounded Habits check-in and completed-trade history.", COMMON_PROPERTIES),
  tool("calorie_get_history", "Read bounded Calorie nutrition and daily-care history.", COMMON_PROPERTIES, ["start", "end"]),
  tool("setline_get_workouts", "Read bounded completed workout history.", COMMON_PROPERTIES),
  tool("kith_get_relationships", "Read bounded people and interaction records.", {
    ...COMMON_PROPERTIES,
    includeSensitive: explicitSensitive("Include relationship notes only when the question explicitly requires them."),
  }),
  tool("anchor_get_sessions", "Read bounded finished focus-session timing and interruption counts.", COMMON_PROPERTIES),
] as const;

export async function handleMcp(
  request: Request,
  env: Env,
  user: AuthenticatedUser,
): Promise<Response> {
  if (request.method !== "POST") return mcpError(null, -32600, "Use POST for MCP requests", 405);
  const body = (await request.json().catch(() => null)) as McpRequest | null;
  if (!body || body.jsonrpc !== "2.0" || typeof body.method !== "string") {
    return mcpError(body?.id ?? null, -32600, "Invalid JSON-RPC request", 400);
  }
  if (body.method === "notifications/initialized") return new Response(null, { status: 202 });
  if (body.method === "initialize") {
    return mcpResult(body.id, {
      protocolVersion: "2025-06-18",
      capabilities: { tools: { listChanged: false } },
      serverInfo: { name: "significant-hobbies-personal-apps", version: "1.0.0" },
      instructions: "Read-only access to the owners seven personal applications. Never claim to mutate source data.",
    });
  }
  if (body.method === "tools/list") return mcpResult(body.id, { tools: TOOLS });
  if (body.method === "tools/call") {
    try {
      const params = requireObject(body.params, "params");
      const name = typeof params.name === "string" ? params.name : "";
      const args = params.arguments ? requireObject(params.arguments, "params.arguments") : {};
      const result = await callTool(name, args, request, env, user);
      return mcpResult(body.id, {
        content: [{ type: "text", text: JSON.stringify(result) }],
        structuredContent: result,
        isError: false,
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : "Tool call failed";
      return mcpResult(body.id, {
        content: [{ type: "text", text: message }],
        isError: true,
      });
    }
  }
  return mcpError(body.id, -32601, "Method not found", 404);
}

async function callTool(
  name: string,
  args: Record<string, unknown>,
  request: Request,
  env: Env,
  user: AuthenticatedUser,
): Promise<unknown> {
  if (name === "life_get_today") {
    const [today, live, calorie] = await Promise.all([
      getToday(env, user.id),
      getLiveSummary(request, env, user),
      getCalorieToday(request, env, user),
    ]);
    return { ...today, summaries: [live, ...today.summaries, calorie] };
  }
  const url = toolUrl(args);
  if (name === "life_search_events") return getLifeEvents(env, user.id, url);
  const domain = DOMAIN_TOOLS[name];
  if (!domain) throw new HttpError(404, "unknown_tool", "Tool is not available");
  if (domain === "live") return responseJson(await getLiveRecords(request, env, user, url.searchParams));
  if (domain === "calorie") return responseJson(await getCalorieRecords(request, env, user, url.searchParams));
  if (!isDomain(domain)) throw new HttpError(404, "unknown_domain", "Domain is not available");
  return getDomainRecords(env, user.id, domain, parseReadQuery(url));
}

function toolUrl(args: Record<string, unknown>): URL {
  const url = new URL("https://personal-platform.internal/read");
  for (const key of ["q", "start", "end", "domain", "limit", "offset", "includeSensitive"]) {
    const value = args[key];
    if (typeof value === "string" || typeof value === "number" || typeof value === "boolean") {
      url.searchParams.set(key, String(value));
    }
  }
  return url;
}

async function responseJson(response: Response): Promise<unknown> {
  const body = await response.json().catch(() => null);
  if (!response.ok) throw new HttpError(response.status, "upstream_failed", JSON.stringify(body));
  return body;
}

function tool(
  name: string,
  description: string,
  properties: Record<string, unknown> = {},
  required: readonly string[] = [],
) {
  return {
    name,
    title: name.split("_").map((part) => part[0]?.toUpperCase() + part.slice(1)).join(" "),
    description,
    inputSchema: { type: "object", properties, required, additionalProperties: false },
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  };
}

function explicitSensitive(description: string) {
  return { type: "boolean", default: false, description };
}

function mcpResult(id: unknown, result: unknown): Response {
  return protocolJson({ jsonrpc: "2.0", id: id ?? null, result });
}

function mcpError(id: unknown, code: number, message: string, status: number): Response {
  return protocolJson({ jsonrpc: "2.0", id: id ?? null, error: { code, message } }, status);
}

function protocolJson(payload: unknown, status = 200): Response {
  return Response.json(payload, {
    status,
    headers: {
      "Cache-Control": "no-store",
      "Content-Type": "application/json",
      "X-Content-Type-Options": "nosniff",
    },
  });
}
