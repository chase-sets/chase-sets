import { describe, expect, it } from "vitest";
import { adminAuthHostConfig, marketplaceAuthHostConfig } from "./host-config";

describe("auth host config", () => {
  it("keeps host-specific success, sign-out, and permission rules explicit", () => {
    expect(marketplaceAuthHostConfig).toMatchObject({
      signInPath: "/sign-in",
      fallbackPath: "/account",
      signedOutReturnTo: "/search",
      allowManualMagicLinkTokenEntry: false,
    });
    expect(adminAuthHostConfig).toMatchObject({
      hostLabel: "Admin",
      defaultSuccessPath: "/",
      accountSelectionPath: "/access/account-select",
      allowManualMagicLinkTokenEntry: false,
      titles: expect.objectContaining({
        signIn: "Sign In | Admin",
        accountSelection: "Select Account | Admin",
        sessions: "Sessions | Access Admin",
      }),
    });
  });
});
