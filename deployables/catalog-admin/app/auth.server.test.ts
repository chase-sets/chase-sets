import { describe, expect, it } from "vitest";
import { catalogAdminAuthHost } from "../../../bounded-contexts/auth/host-config";

describe("catalog admin auth host", () => {
  it("routes account selection through the catalog admin path", () => {
    const response = catalogAdminAuthHost.completeAuthentication(
      new Request("http://catalog.test/sign-in"),
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
    expect(response.headers.get("Location")).toBe("/account-select?returnTo=%2Fdimensions");
  });
});
