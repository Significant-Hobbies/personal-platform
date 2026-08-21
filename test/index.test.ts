import { exports } from "cloudflare:workers";
import { describe, expect, it } from "vitest";

const AUTHORIZATION = "Bearer test-token";

function api(path: string, init: RequestInit = {}): Promise<Response> {
  const headers = new Headers(init.headers);
  headers.set("Authorization", AUTHORIZATION);
  if (init.body) headers.set("Content-Type", "application/json");
  return exports.default.fetch(`https://personal-platform.test${path}`, { ...init, headers });
}

function mutationBody(overrides: Record<string, unknown> = {}) {
  return {
    domain: "live",
    deviceId: "iphone-test",
    mutations: [
      {
        id: crypto.randomUUID(),
        idempotencyKey: crypto.randomUUID(),
        operation: "upsert",
        baseVersion: 0,
        occurredAt: "2026-08-21T06:00:00.000Z",
        record: { title: "Visit Kyoto", status: "planned" },
      },
    ],
    ...overrides,
  };
}

describe("Personal Platform Worker", () => {
  it("serves health without authentication and fails closed elsewhere", async () => {
    const health = await exports.default.fetch("https://personal-platform.test/health");
    expect(health.status).toBe(200);
    expect(await health.json()).toEqual({ status: "ok", service: "personal-platform" });

    const unauthorized = await exports.default.fetch(
      "https://personal-platform.test/v1/life/today",
    );
    expect(unauthorized.status).toBe(401);
  });

  it("pushes once, returns the same cursor on retry, and pulls by cursor", async () => {
    const body = mutationBody();
    const first = await api("/v1/sync/push", { method: "POST", body: JSON.stringify(body) });
    expect(first.status).toBe(200);
    const firstJson = (await first.json()) as { results: Array<Record<string, unknown>> };
    expect(firstJson.results[0]?.status).toBe("accepted");
    const cursor = firstJson.results[0]?.cursor;

    const retry = await api("/v1/sync/push", { method: "POST", body: JSON.stringify(body) });
    const retryJson = (await retry.json()) as { results: Array<Record<string, unknown>> };
    expect(retryJson.results[0]).toMatchObject({ status: "duplicate", cursor });

    const pull = await api("/v1/sync/pull?domain=live&cursor=0");
    const pullJson = (await pull.json()) as { changes: Array<Record<string, unknown>>; cursor: number };
    const matching = pullJson.changes.filter(
      (change) => change.id === body.mutations[0]?.id,
    );
    expect(matching).toHaveLength(1);
    expect(matching[0]?.record).toEqual({ title: "Visit Kyoto", status: "planned" });

    const empty = await api(`/v1/sync/pull?domain=live&cursor=${pullJson.cursor}`);
    expect(((await empty.json()) as { changes: unknown[] }).changes).toEqual([]);
  });

  it("rejects an optimistic edit from a stale version", async () => {
    const id = crypto.randomUUID();
    const create = mutationBody({
      mutations: [
        {
          id,
          idempotencyKey: crypto.randomUUID(),
          operation: "upsert",
          baseVersion: 0,
          occurredAt: "2026-08-21T07:00:00.000Z",
          record: { title: "Learn pottery", status: "planned" },
        },
      ],
    });
    await api("/v1/sync/push", { method: "POST", body: JSON.stringify(create) });
    const stale = mutationBody({
      mutations: [
        {
          id,
          idempotencyKey: crypto.randomUUID(),
          operation: "upsert",
          baseVersion: 0,
          occurredAt: "2026-08-21T07:05:00.000Z",
          record: { title: "Learn pottery", status: "completed" },
        },
      ],
    });
    const response = await api("/v1/sync/push", {
      method: "POST",
      body: JSON.stringify(stale),
    });
    const result = (await response.json()) as { results: Array<Record<string, unknown>> };
    expect(result.results[0]).toMatchObject({
      status: "conflict",
      expectedVersion: 0,
      actualVersion: 1,
    });
  });

  it("executes one typed action for every fresh domain and builds Today", async () => {
    const actions = [
      ["live", "add_item", { title: "See the northern lights" }],
      ["journal", "add_entry", { body: "A clear day.", occurredOn: "2026-08-21" }],
      [
        "habits",
        "check_in",
        { habitId: "walk", name: "Walk", occurredOn: "2026-08-21" },
      ],
      [
        "setline",
        "record_activity",
        { title: "Strength", occurredOn: "2026-08-21", minutes: 40 },
      ],
      [
        "kith",
        "record_interaction",
        {
          personId: "rahul",
          personName: "Rahul",
          occurredAt: "2026-08-21T08:00:00.000Z",
        },
      ],
      [
        "anchor",
        "record_session",
        {
          title: "Write",
          startedAt: "2026-08-21T09:00:00.000Z",
          endedAt: "2026-08-21T09:30:00.000Z",
          durationSeconds: 1800,
          interruptionCount: 1,
        },
      ],
    ] as const;

    for (const [domain, action, input] of actions) {
      const response = await api(`/v1/domains/${domain}/actions/${action}`, {
        method: "POST",
        body: JSON.stringify({
          idempotencyKey: crypto.randomUUID(),
          deviceId: "hub-test",
          originalInstruction: `Test ${domain}`,
          input,
        }),
      });
      expect(response.status, `${domain}.${action}`).toBe(200);
      expect(await response.json()).toMatchObject({ status: "completed" });
    }

    const today = await api("/v1/life/today");
    const todayJson = (await today.json()) as { summaries: Array<Record<string, unknown>> };
    expect(todayJson.summaries).toHaveLength(7);
    const freshDomains = todayJson.summaries.filter(
      (summary) => summary.domain !== "calorie" && summary.domain !== "live",
    );
    expect(freshDomains.every((summary) => Number(summary.activeCount) >= 1)).toBe(true);
    expect(todayJson.summaries[0]).toMatchObject({
      domain: "live",
      source: "significant-hobbies-service",
      status: "unavailable",
    });
    expect(todayJson.summaries.at(-1)).toMatchObject({
      domain: "calorie",
      source: "calorie-service",
      status: "unavailable",
    });

    const activity = await api("/v1/activity");
    expect(((await activity.json()) as { actions: unknown[] }).actions.length).toBeGreaterThanOrEqual(6);
  });

  it("undoes an additive assistant action once", async () => {
    const idempotencyKey = crypto.randomUUID();
    const response = await api("/v1/domains/kith/actions/record_interaction", {
      method: "POST",
      body: JSON.stringify({
        idempotencyKey,
        deviceId: "hub-test",
        originalInstruction: "Record that I spoke to Rahul",
        input: {
          personId: "rahul",
          personName: "Rahul",
          occurredAt: "2026-08-21T10:00:00.000Z",
        },
      }),
    });
    const action = (await response.json()) as { actionId: string };

    const actionRetry = await api("/v1/domains/kith/actions/record_interaction", {
      method: "POST",
      body: JSON.stringify({
        idempotencyKey,
        deviceId: "hub-test",
        originalInstruction: "Record that I spoke to Rahul",
        input: {
          personId: "rahul",
          personName: "Rahul",
          occurredAt: "2026-08-21T10:00:00.000Z",
        },
      }),
    });
    expect(await actionRetry.json()).toMatchObject({
      actionId: action.actionId,
      status: "completed",
      duplicate: true,
    });

    const undo = await api(`/v1/actions/${action.actionId}/undo`, { method: "POST" });
    expect(await undo.json()).toMatchObject({ actionId: action.actionId, status: "undone" });

    const retry = await api(`/v1/actions/${action.actionId}/undo`, { method: "POST" });
    expect(await retry.json()).toMatchObject({
      actionId: action.actionId,
      status: "undone",
      duplicate: true,
    });
  });

  it("syncs Kith people as well as interactions", async () => {
    const response = await api("/v1/sync/push", {
      method: "POST",
      body: JSON.stringify({
        domain: "kith",
        deviceId: "iphone",
        mutations: [{
          id: "person-rahul",
          idempotencyKey: "kith-person-rahul-v1",
          operation: "upsert",
          baseVersion: 0,
          occurredAt: "2026-08-21T06:00:00.000Z",
          record: {
            recordType: "person",
            personId: "person-rahul",
            personName: "Rahul",
            circle: "friends",
            closeness: 4,
            hue: "clay",
            createdAt: "2026-08-21T06:00:00.000Z",
          },
        }],
      }),
    });
    expect(response.status).toBe(200);

    const pull = await api("/v1/sync/pull?domain=kith&cursor=0");
    const body = await pull.json<Record<string, unknown>>();
    expect(JSON.stringify(body)).toContain('\"recordType\":\"person\"');
    expect(JSON.stringify(body)).toContain('\"personName\":\"Rahul\"');
  });

  it("preserves Journal source identity and structured writing", async () => {
    const response = await api("/v1/sync/push", {
      method: "POST",
      body: JSON.stringify({
        domain: "journal",
        deviceId: "iphone",
        mutations: [{
          id: "entry-1-version-1",
          idempotencyKey: "journal-entry-1-version-1",
          operation: "upsert",
          baseVersion: 0,
          occurredAt: "2026-08-21T06:00:00.000Z",
          record: {
            sourceId: "entry-1",
            body: "A clear day.",
            occurredOn: "2026-08-21T06:00:00.000Z",
            morningReflection: "Begin quietly.",
            eveningReflection: "The walk helped.",
            newThing: "Tried a new route.",
          },
        }],
      }),
    });
    expect(response.status).toBe(200);

    const pull = await api("/v1/sync/pull?domain=journal&cursor=0");
    const body = await pull.json<{ changes: Array<{ record: Record<string, unknown> }> }>();
    expect(body.changes.some((change) => change.record.sourceId === "entry-1")).toBe(true);
    expect(body.changes.some(
      (change) => change.record.morningReflection === "Begin quietly.",
    )).toBe(true);

    const safe = await api("/v1/domains/journal/records?limit=10");
    const safeBody = await safe.json<{
      items: Array<{ record: Record<string, unknown> }>;
    }>();
    const safeRecord = safeBody.items.find((item) => item.record.sourceId === "entry-1")?.record;
    expect(safeRecord).toEqual({
      sourceId: "entry-1",
      occurredOn: "2026-08-21T06:00:00.000Z",
    });

    const explicit = await api(
      "/v1/domains/journal/records?q=clear&includeSensitive=true&limit=10",
    );
    const explicitBody = await explicit.json<{
      items: Array<{ record: Record<string, unknown> }>;
    }>();
    expect(explicitBody.items.some((item) => item.record.body === "A clear day.")).toBe(true);
  });

  it("returns bounded privacy-safe life events", async () => {
    const response = await api("/v1/life/events?domain=journal&limit=1");
    expect(response.status).toBe(200);
    const body = await response.json<{
      items: Array<Record<string, unknown>>;
      page: { limit: number; total: number };
    }>();
    expect(body.page.limit).toBe(1);
    expect(body.page.total).toBeGreaterThanOrEqual(1);
    expect(body.items[0]).toMatchObject({ domain: "journal", actor: "application" });
    expect(JSON.stringify(body)).not.toContain("A clear day.");
  });

  it("converges a Setline session from an iPhone mutation into a second client", async () => {
    const sessionId = crypto.randomUUID();
    const push = await api("/v1/sync/push", {
      method: "POST",
      body: JSON.stringify({
        domain: "setline",
        deviceId: "setline-iphone",
        mutations: [{
          id: sessionId,
          idempotencyKey: `setline-${sessionId}-v1`,
          operation: "upsert",
          baseVersion: 0,
          occurredAt: "2026-08-21T06:30:00.000Z",
          record: {
            title: "Lower strength",
            occurredOn: "2026-08-21T06:30:00.000Z",
            minutes: 31,
            notes: "12 steps completed",
          },
        }],
      }),
    });
    expect(push.status).toBe(200);
    expect(await push.json()).toMatchObject({
      results: [{ id: sessionId, status: "accepted", version: 1 }],
    });

    const pull = await api("/v1/sync/pull?domain=setline&cursor=0", {
      headers: { "X-Personal-Device-ID": "setline-second-client" },
    });
    expect(pull.status).toBe(200);
    const body = await pull.json<{
      changes: Array<{ id: string; originDeviceId: string; record: Record<string, unknown> }>;
    }>();
    expect(body.changes).toContainEqual(expect.objectContaining({
      id: sessionId,
      originDeviceId: "setline-iphone",
      record: {
        title: "Lower strength",
        occurredOn: "2026-08-21T06:30:00.000Z",
        minutes: 31,
        notes: "12 steps completed",
      },
    }));
  });

  it("does not fall back to Personal Platform D1 for Calorie", async () => {
    const response = await api("/v1/domains/calorie/summary");
    expect(response.status).toBe(503);
    expect(await response.json()).toMatchObject({
      error: { code: "calorie_connector_unavailable" },
    });
  });
});
