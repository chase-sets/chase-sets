import { describe, expect, it } from "vitest";
import { marketplaceAuthHost } from "../../../bounded-contexts/auth/host-config";

describe("marketplace auth host", () => {
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
        memberships: [{ accountId: "acc_1" }],
      },
    );

    expect(response.status).toBe(302);
    expect(response.headers.get("Location")).toBe("/orders");
    expect(response.headers.get("Set-Cookie")).toContain("chase_sets_session=session_token");
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
          { accountId: "acc_1" },
          { accountId: "acc_2" },
        ],
      },
    );

    expect(response.status).toBe(302);
    expect(response.headers.get("Location")).toBe("/account/select?returnTo=%2Faccount");
    expect(response.headers.get("Set-Cookie")).toContain(
      "chase_sets_account_selection=selection_token",
    );
  });
});
