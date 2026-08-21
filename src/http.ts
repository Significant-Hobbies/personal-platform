import { HttpError } from "./contracts";

export async function readJson(request: Request): Promise<unknown> {
  const maximumBytes = 1_000_000;
  const contentType = request.headers.get("Content-Type") ?? "";
  if (!contentType.toLowerCase().includes("application/json")) {
    throw new HttpError(415, "unsupported_media_type", "Content-Type must be application/json");
  }
  const declaredLength = Number(request.headers.get("Content-Length") ?? "0");
  if (Number.isFinite(declaredLength) && declaredLength > maximumBytes) {
    throw new HttpError(413, "payload_too_large", "request body exceeds 1 MB");
  }
  try {
    const body = await request.text();
    if (new TextEncoder().encode(body).byteLength > maximumBytes) {
      throw new HttpError(413, "payload_too_large", "request body exceeds 1 MB");
    }
    return JSON.parse(body) as unknown;
  } catch (error) {
    if (error instanceof HttpError) throw error;
    throw new HttpError(400, "invalid_json", "request body is not valid JSON");
  }
}

export function json(value: unknown, init: ResponseInit = {}): Response {
  const headers = new Headers(init.headers);
  headers.set("Content-Type", "application/json; charset=utf-8");
  headers.set("Cache-Control", "no-store");
  return new Response(JSON.stringify(value), { ...init, headers });
}

export function errorResponse(error: unknown): Response {
  if (error instanceof HttpError) {
    return json(
      {
        error: {
          code: error.code,
          message: error.message,
          ...(error.details === undefined ? {} : { details: error.details }),
        },
      },
      { status: error.status },
    );
  }
  const message = error instanceof Error ? error.message : "unknown error";
  console.error(JSON.stringify({ event: "request_failed", message }));
  return json(
    { error: { code: "internal_error", message: "the request could not be completed" } },
    { status: 500 },
  );
}

export function withCors(request: Request, response: Response, env: Env): Response {
  const origin = request.headers.get("Origin");
  if (!origin) return response;
  const allowed = env.ALLOWED_ORIGINS.split(",").map((value) => value.trim());
  if (!allowed.includes(origin)) return response;
  const headers = new Headers(response.headers);
  headers.set("Access-Control-Allow-Origin", origin);
  headers.set("Access-Control-Allow-Headers", "Authorization, Content-Type, Idempotency-Key");
  headers.set("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
  headers.set("Vary", "Origin");
  return new Response(response.body, { status: response.status, statusText: response.statusText, headers });
}

export function preflight(request: Request, env: Env): Response {
  return withCors(request, new Response(null, { status: 204 }), env);
}
