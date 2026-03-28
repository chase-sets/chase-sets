import { describe, expect, it } from "vitest";
import type { IdentityServices } from "./services";
import { resolveActorFromSessionToken } from "./server";

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
});
