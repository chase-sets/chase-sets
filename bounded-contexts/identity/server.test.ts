import { describe, expect, it, vi } from "vitest";
import type { IdentityServices } from "./services";
import { resolveActorFromIdentityApi, resolveActorFromSessionToken } from "./server";

describe("identity server helpers", () => {
  it("resolves an active session token into an actor with permissions", async () => {
    const services = {
      auth: {
        hashSecret: (value: string) => `hash:${value}`,
      },
      db: {
        query: async () => ({
          rows: [
            {
              session_id: "ses_1",
              token_hash: "hash:session_token",
              expires_at: new Date(Date.now() + 60_000).toISOString(),
            },
          ],
          rowCount: 1,
        }),
      },
      sessions: {
        getSession: async () => ({
          session_id: "ses_1",
          user_id: "usr_1",
          account_id: "acc_1",
          available_account_ids: ["acc_1"],
          authentication_method: "password",
          status: "active",
          expires_at: new Date(Date.now() + 60_000).toISOString(),
          updated_at: new Date().toISOString(),
        }),
      },
      memberships: {
        getActiveMembershipForUserAccount: async () => ({
          membership_id: "mbr_1",
          user_id: "usr_1",
          account_id: "acc_1",
          role_key: "owner",
          role_permissions: ["accounts.view", "catalog.manage"],
          status: "active",
          updated_at: new Date().toISOString(),
        }),
      },
    } as unknown as IdentityServices;

    const actor = await resolveActorFromSessionToken(services, "session_token");

    expect(actor).toMatchObject({
      sessionId: "ses_1",
      userId: "usr_1",
      accountId: "acc_1",
      membershipId: "mbr_1",
      roleKey: "owner",
      permissions: ["accounts.view", "catalog.manage"],
    });
  });

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

