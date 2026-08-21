import { describe, expect, it } from "vitest";
import { getLiveRecords, getLiveSummary } from "../src/live";

describe("Live connector", () => {
  it("forwards the verified family identity for summaries and records", async () => {
    const requests: Request[] = [];
    const env = {
      AUTH_SERVICE: {
        async fetch(input: RequestInfo | URL, init?: RequestInit) {
          requests.push(new Request(input, init));
          return Response.json({
            domain: "live",
            source: "significant-hobbies-service",
            activeCount: 2,
          });
        },
      },
    } as unknown as Env;
    const request = new Request("https://personal-platform.test/v1/life/today", {
      headers: { Authorization: "Bearer family-session" },
    });

    await getLiveSummary(request, env, { id: "owner-1" });
    await getLiveRecords(
      request,
      env,
      { id: "owner-1" },
      new URLSearchParams({ limit: "5" }),
    );

    expect(requests.map((item) => item.url)).toEqual([
      "https://personal-auth.internal/api/personal-platform/live/summary",
      "https://personal-auth.internal/api/personal-platform/live/records?limit=5",
    ]);
    expect(requests.every(
      (item) => item.headers.get("Authorization") === "Bearer family-session",
    )).toBe(true);
    expect(requests.every(
      (item) => item.headers.get("X-Personal-User-Id") === "owner-1",
    )).toBe(true);
  });
});
