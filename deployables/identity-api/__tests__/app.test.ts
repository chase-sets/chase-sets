import { describe, expect, it } from "vitest";
import type { IdentityServices } from "@chase-sets/identity";
import { buildIdentityApp } from "../src/app";

describe("identity api host app", () => {
  it("mounts health and the identity API under /api/identity", async () => {
    const app = buildIdentityApp({
      auth: {
        issueChallenge: () => "challenge",
      },
      db: {
        query: async () => ({ rows: [], rowCount: 0 }),
      },
    } as unknown as IdentityServices);

    const healthResponse = await app.fetch(new Request("http://identity.test/health"));
    expect(healthResponse.status).toBe(200);

    const legacyResponse = await app.fetch(new Request("http://identity.test/api/accounts"));
    expect(legacyResponse.status).toBe(404);

    const protectedResponse = await app.fetch(new Request("http://identity.test/api/identity/accounts"));
    expect(protectedResponse.status).toBe(401);

    const publicResponse = await app.fetch(
      new Request("http://identity.test/api/identity/auth/passkeys/challenge", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ purpose: "passkey-sign-in" }),
      }),
    );
    expect(publicResponse.status).not.toBe(401);
  });

  it("allows an authenticated actor to sign out the current session", async () => {
    let revokedSessionId: string | null = null;

    const app = buildIdentityApp({
      auth: {
        issueChallenge: () => "challenge",
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
      memberships: {
        getActiveMembershipForUserAccount: async () => ({
          membership_id: "mbr_1",
          user_id: "usr_1",
          account_id: "acc_1",
          role_key: "owner",
          role_permissions: ["accounts.view"],
          status: "active",
          updated_at: new Date().toISOString(),
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
        commandHandler: async ({ streamId }: { streamId: string }) => {
          revokedSessionId = streamId.replace("identity.session-", "");
          return {
            version: 2,
            state: { status: "revoked" },
          };
        },
      },
      projectors: [],
    } as unknown as IdentityServices);

    const response = await app.fetch(
      new Request("http://identity.test/api/identity/auth/sign-out", {
        method: "POST",
        headers: {
          cookie: "chase_sets_session=session_token",
        },
      }),
    );

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      id: "ses_1",
      status: "revoked",
    });
    expect(revokedSessionId).toBe("ses_1");
  });
});
