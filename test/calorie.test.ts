import { describe, expect, it } from "vitest";
import { forwardCalorie } from "../src/calorie";

describe("Calorie connector", () => {
  it("forwards through the service binding with verified identity", async () => {
    let forwarded: Request | undefined;
    const fetcher = {
      async fetch(input: RequestInfo | URL, init?: RequestInit) {
        forwarded = new Request(input, init);
        return Response.json({ protein: 82 });
      },
    };
    const env = { CALORIE_SERVICE: fetcher } as unknown as Env;
    const request = new Request("https://personal-platform.test/v1/domains/calorie/summary", {
      headers: { Authorization: "Bearer private-client-token" },
    });

    const response = await forwardCalorie(
      request,
      env,
      { id: "user-123" },
      "/v1/personal/summary",
    );

    expect(response.status).toBe(200);
    expect(forwarded?.url).toBe("https://calorie.internal/v1/personal/summary");
    expect(forwarded?.headers.get("X-Personal-User-Id")).toBe("user-123");
    expect(forwarded?.headers.get("Authorization")).toBeNull();
  });
});
