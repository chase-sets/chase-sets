import { afterEach, describe, expect, it, vi } from "vitest";
import { defineAuthHost } from "@chase-sets/auth/server";
import { marketplaceAuthHostConfig } from "@chase-sets/auth/host-config";
import { requireMarketplaceActor, resolveMarketplaceActor } from "./auth.server";

describe("marketplace auth host", () => {
  const marketplaceAuthHost = defineAuthHost(marketplaceAuthHostConfig);
  const signedInMembership = {
    membershipId: "mem_1",
    accountId: "acc_1",
    roleKey: "seller",
    status: "active",
    rolePermissions: ["accounts.view"],
  } as const;

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("redirects to the safe return target and sets a secure session cookie", () => {
    const response = marketplaceAuthHost.completeAuthentication(
      new Request("https://marketplace.test/sign-in?returnTo=/orders"),
      {
        type: "session-started",
        userId: "usr_1",
        sessionId: "ses_1",
        sessionToken: "session_token",
        session: {
          session_id: "ses_1",
          user_id: "usr_1",
          account_id: "acc_1",
          available_account_ids: ["acc_1"],
          authentication_method: "password",
          status: "active",
          expires_at: new Date(Date.now() + 60_000).toISOString(),
          updated_at: new Date().toISOString(),
        },
        memberships: [signedInMembership],
      },
    );

    expect(response.status).toBe(302);
    expect(response.headers.get("Location")).toBe("/orders");
    expect(response.headers.get("Set-Cookie")).toContain("chase_sets_session=session_token");
    expect(response.headers.get("Set-Cookie")).not.toContain("Domain=");
    expect(response.headers.get("Set-Cookie")).toContain("Secure");
  });

  it("falls back to the configured success path for unsafe return targets", () => {
    const response = marketplaceAuthHost.completeAuthentication(
      new Request("http://marketplace.test/sign-in?returnTo=//evil.test"),
      {
        type: "account-selection-required",
        userId: "usr_1",
        selectionToken: "selection_token",
        selectionExpiresAt: new Date(Date.now() + 60_000).toISOString(),
        memberships: [
          signedInMembership,
          {
            ...signedInMembership,
            membershipId: "mem_2",
            accountId: "acc_2",
          },
        ],
      },
    );

    expect(response.status).toBe(302);
    expect(response.headers.get("Location")).toBe("/account/select?returnTo=%2Faccount");
    expect(response.headers.get("Set-Cookie")).toContain("chase_sets_account_selection=selection_token");
  });

  it("treats transient auth gateway failures as unauthenticated for optional actor resolution", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(() => Promise.resolve(new Response(null, { status: 502 }))),
    );

    await expect(resolveMarketplaceActor(new Request("http://localhost/search"))).resolves.toBeNull();
  });

  it("redirects protected routes to sign-in when actor resolution has a transient gateway failure", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(() => Promise.resolve(new Response(null, { status: 502 }))),
    );

    let thrown: unknown;
    try {
      await requireMarketplaceActor(new Request("http://localhost/account/listings"));
    } catch (error) {
      thrown = error;
    }

    expect(thrown).toBeInstanceOf(Response);
    expect((thrown as Response).status).toBe(302);
    expect((thrown as Response).headers.get("Location")).toBe("/sign-in?returnTo=%2Faccount%2Flistings");
  });
});
