import { describe, expect, it } from "vitest";
import { authenticate } from "../src/auth";

describe("production authentication connector", () => {
  it("uses the Significant Hobbies identity contract", async () => {
    let forwarded: Request | undefined;
    const env = {
      AUTH_MODE: "production",
      LOCAL_AUTH_TOKEN: "",
      LOCAL_AUTH_USER_ID: "",
      AUTH_SERVICE: {
        async fetch(input: RequestInfo | URL, init?: RequestInit) {
          forwarded = new Request(input, init);
          return Response.json({
            userId: "shared-user",
            appleSubject: "apple-subject",
            email: "owner@example.com",
          });
        },
      },
    } as unknown as Env;

    await expect(
      authenticate(
        new Request("https://personal-platform.test/v1/life/today", {
          headers: { Authorization: "Bearer signed-session" },
        }),
        env,
      ),
    ).resolves.toEqual({
      id: "shared-user",
      appleSubject: "apple-subject",
      email: "owner@example.com",
    });
    expect(forwarded?.url).toBe(
      "https://personal-auth.internal/api/personal-platform/session",
    );
    expect(forwarded?.headers.get("Authorization")).toBe("Bearer signed-session");
  });

  it("distinguishes an invalid token from an unavailable identity service", async () => {
    const request = new Request("https://personal-platform.test/v1/life/today", {
      headers: { Authorization: "Bearer signed-session" },
    });
    const env = (status: number) =>
      ({
        AUTH_MODE: "production",
        LOCAL_AUTH_TOKEN: "",
        LOCAL_AUTH_USER_ID: "",
        AUTH_SERVICE: { fetch: async () => new Response(null, { status }) },
      }) as unknown as Env;

    await expect(authenticate(request.clone(), env(401))).rejects.toMatchObject({
      status: 401,
      code: "unauthorized",
    });
    await expect(authenticate(request.clone(), env(503))).rejects.toMatchObject({
      status: 502,
      code: "auth_service_unavailable",
    });
  });
});
