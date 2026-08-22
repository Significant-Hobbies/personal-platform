import { exports } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import { authenticateMcp } from "../src/mcp-auth";

const AUTHORIZATION = "Bearer test-token";

async function mcp(method: string, params: Record<string, unknown> = {}, id = 1) {
  return exports.default.fetch("https://personal-platform.test/mcp", {
    method: "POST",
    headers: { Authorization: AUTHORIZATION, "Content-Type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id, method, params }),
  });
}

describe("Personal Apps MCP", () => {
  it("advertises one read-only tool set with all seven domains", async () => {
    const initialized = await mcp("initialize");
    expect(initialized.status).toBe(200);
    expect(await initialized.json()).toMatchObject({
      result: { serverInfo: { name: "significant-hobbies-personal-apps" } },
    });

    const listed = await mcp("tools/list");
    const body = await listed.json<{
      result: { tools: Array<{ name: string; annotations: Record<string, unknown> }> };
    }>();
    expect(body.result.tools.map((tool) => tool.name)).toEqual([
      "life_get_today",
      "life_search_events",
      "live_search_items",
      "journal_search_entries",
      "habits_get_history",
      "calorie_get_history",
      "setline_get_workouts",
      "kith_get_relationships",
      "anchor_get_sessions",
    ]);
    expect(body.result.tools.every((tool) => tool.annotations.readOnlyHint === true)).toBe(true);
    expect(body.result.tools.some((tool) => /add|edit|delete|log|complete/u.test(tool.name))).toBe(false);
  });

  it("returns privacy-safe domain records through tool calls", async () => {
    await exports.default.fetch("https://personal-platform.test/v1/sync/push", {
      method: "POST",
      headers: { Authorization: AUTHORIZATION, "Content-Type": "application/json" },
      body: JSON.stringify({
        domain: "journal",
        deviceId: "journal-test",
        mutations: [{
          id: "mcp-journal-entry",
          idempotencyKey: "mcp-journal-entry-v1",
          operation: "upsert",
          baseVersion: 0,
          occurredAt: "2026-08-21T10:00:00.000Z",
          record: {
            sourceId: "mcp-journal-entry",
            body: "Private full writing",
            occurredOn: "2026-08-21T10:00:00.000Z",
            mood: "calm",
          },
        }],
      }),
    });

    const response = await mcp("tools/call", {
      name: "journal_search_entries",
      arguments: { start: "2026-08-21", end: "2026-08-22" },
    });
    const body = await response.json<Record<string, unknown>>();
    expect(JSON.stringify(body)).toContain("mcp-journal-entry");
    expect(JSON.stringify(body)).not.toContain("Private full writing");
  });

  it("returns the complete seven-domain Today projection through MCP", async () => {
    const response = await mcp("tools/call", {
      name: "life_get_today",
      arguments: {},
    });
    const body = await response.json<{
      result: {
        isError: boolean;
        structuredContent: {
          summaries: Array<{ domain: string; source: string }>;
        };
      };
    }>();

    expect(body.result.isError).toBe(false);
    expect(body.result.structuredContent.summaries.map((summary) => summary.domain)).toEqual([
      "live",
      "journal",
      "habits",
      "setline",
      "kith",
      "anchor",
      "calorie",
    ]);
    expect(
      body.result.structuredContent.summaries.every((summary) => Boolean(summary.source)),
    ).toBe(true);
  });
});

describe("Personal Apps OAuth verifier", () => {
  it("verifies an audience-bound owner token and maps it to the family user", async () => {
    const pair = await crypto.subtle.generateKey(
      { name: "RSASSA-PKCS1-v1_5", modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: "SHA-256" },
      true,
      ["sign", "verify"],
    ) as CryptoKeyPair;
    const publicJwk = await crypto.subtle.exportKey("jwk", pair.publicKey) as JsonWebKey & {
      kid?: string;
      alg?: string;
    };
    publicJwk.kid = "test-key";
    publicJwk.alg = "RS256";
    const now = Math.floor(Date.now() / 1000);
    const token = await signedToken(pair.privateKey, {
      iss: "https://owner.auth0.com/",
      sub: "auth0|owner",
      aud: "https://mcp.significanthobbies.com/personal-apps/mcp",
      scope: "personal-apps.read",
      iat: now,
      exp: now + 600,
    });
    const env = {
      AUTH_MODE: "production",
      AUTH0_ISSUER: "https://owner.auth0.com/",
      AUTH0_OWNER_USER_ID: "auth0|owner",
      PERSONAL_OWNER_USER_ID: "family-owner",
      PERSONAL_APPS_MCP_AUDIENCE: "https://mcp.significanthobbies.com/personal-apps/mcp",
    } as unknown as Env;
    const request = new Request("https://personal-platform.test/mcp", {
      headers: { Authorization: `Bearer ${token}` },
    });
    const fetchKeys = async () => Response.json({ keys: [publicJwk] });

    await expect(authenticateMcp(request, env, fetchKeys)).resolves.toEqual({ id: "family-owner" });
  });
});

async function signedToken(privateKey: CryptoKey, claims: Record<string, unknown>) {
  const header = encode({ alg: "RS256", typ: "JWT", kid: "test-key" });
  const payload = encode(claims);
  const signingInput = `${header}.${payload}`;
  const signature = await crypto.subtle.sign(
    "RSASSA-PKCS1-v1_5",
    privateKey,
    new TextEncoder().encode(signingInput),
  );
  return `${signingInput}.${base64url(new Uint8Array(signature))}`;
}

function encode(value: unknown) {
  return base64url(new TextEncoder().encode(JSON.stringify(value)));
}

function base64url(value: Uint8Array) {
  let binary = "";
  for (const byte of value) binary += String.fromCharCode(byte);
  return btoa(binary).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/u, "");
}
