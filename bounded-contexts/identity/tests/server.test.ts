import { describe, expect, it, vi } from "vitest";
import { resolveActorFromIdentityApi } from "../support/route-support/identity-request";

describe("identity server helpers", () => {
  it("resolves the current actor through the mounted identity api path", async () => {
    const fetch = vi.fn(async (input: RequestInfo | URL) => {
      expect(String(input)).toBe("http://localhost:6181/api/auth/session");

      return new Response(
        JSON.stringify({
          actor: {
            sessionId: "ses_1",
            tenantId: "tnt_1",
            userId: "usr_1",
            accountId: "acc_1",
            membershipId: "mbr_1",
            roleKey: "owner",
            permissions: ["catalog.view"],
          },
        }),
        {
          status: 200,
          headers: { "Content-Type": "application/json" },
        },
      );
    });

    const actor = await resolveActorFromIdentityApi({
      identityApiBaseUrl: "http://localhost:6181",
      request: new Request("http://localhost:6180/api/catalog/dimensions"),
      fetch,
    });

    expect(actor).toMatchObject({
      sessionId: "ses_1",
      userId: "usr_1",
      accountId: "acc_1",
      permissions: ["catalog.view"],
    });
  });
});
