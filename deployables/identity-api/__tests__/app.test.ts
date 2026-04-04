import { describe, expect, it } from "vitest";
import { buildIdentityApp } from "../src/app";

function createHostServices() {
  let revokedSessionId: string | null = null;

  const services = {
    auth: {
      projectors: [],
      db: {
        query: async (sql: string) => {
          if (sql.includes("FROM identity_session_tokens")) {
            return {
              rows: [
                {
                  session_id: "ses_1",
                  token_hash: "hash:session_token",
                  expires_at: new Date(Date.now() + 60_000).toISOString(),
                },
              ],
              rowCount: 1,
            };
          }

          return {
            rows: [],
            rowCount: 0,
          };
        },
      },
      auth: {
        hashSecret: (value: string) => `hash:${value}`,
        issueChallenge: () => "challenge_123",
      },
      identity: {
        bootstrapTenantId: "tnt_identity",
        createBootstrapContext: () => ({
          tenantId: "tnt",
          audit: {
            performedByUserId: "usr_bootstrap",
            forAccountId: "acc_bootstrap",
          },
          trace: {},
        }),
        getUserByEmail: async () => null,
        getActiveMembershipForUserAccount: async () => ({
          membership_id: "mbr_1",
          role_key: "owner",
          role_permissions: ["accounts.view"],
        }),
      },
      sessions: {
        getSession: async (sessionId: string) => ({
          session_id: sessionId,
          user_id: "usr_1",
          account_id: "acc_1",
          available_account_ids: ["acc_1"],
          authentication_method: "password",
          status: "active",
          expires_at: new Date(Date.now() + 60_000).toISOString(),
          updated_at: new Date().toISOString(),
        }),
        commandHandler: async ({ streamId }: { streamId: string }) => {
          revokedSessionId = streamId.replace("auth.session-", "");
          return {
            version: 2,
            state: { status: "revoked" },
          };
        },
      },
    },
    identity: {
      projectors: [],
    },
  } as any;

  return {
    services,
    getRevokedSessionId: () => revokedSessionId,
  };
}

describe("identity api host app", () => {
  it("mounts health plus the identity and auth APIs", async () => {
    const { services } = createHostServices();
    const app = buildIdentityApp(services);

    const healthResponse = await app.fetch(new Request("http://identity.test/health"));
    expect(healthResponse.status).toBe(200);

    const legacyResponse = await app.fetch(new Request("http://identity.test/api/accounts"));
    expect(legacyResponse.status).toBe(404);

    const protectedResponse = await app.fetch(new Request("http://identity.test/api/identity/accounts"));
    expect(protectedResponse.status).toBe(401);

    const publicResponse = await app.fetch(
      new Request("http://identity.test/api/auth/passkeys/challenge", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ purpose: "passkey-sign-in" }),
      }),
    );

    expect(publicResponse.status).toBe(200);
    await expect(publicResponse.json()).resolves.toMatchObject({
      challenge: "challenge_123",
    });
  });

  it("allows an authenticated actor to sign out the current session", async () => {
    const { services, getRevokedSessionId } = createHostServices();
    const app = buildIdentityApp(services);

    const response = await app.fetch(
      new Request("http://identity.test/api/auth/sign-out", {
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
    expect(getRevokedSessionId()).toBe("ses_1");
  });
});
