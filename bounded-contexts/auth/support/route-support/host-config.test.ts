import { describe, expect, it } from "vitest";
import { accessAdminAuthHostConfig, catalogAdminAuthHostConfig, marketplaceAuthHostConfig } from "./host-config";

describe("auth host config", () => {
  it("keeps host-specific success, sign-out, and permission rules explicit", () => {
    expect(marketplaceAuthHostConfig).toMatchObject({
      signInPath: "/sign-in",
      fallbackPath: "/account",
      signedOutReturnTo: "/search",
      allowManualMagicLinkTokenEntry: false,
    });
    expect(catalogAdminAuthHostConfig).toMatchObject({
      requiredPermission: "catalog.view",
      defaultSuccessPath: "/catalog/dimensions",
      allowManualMagicLinkTokenEntry: false,
    });
    expect(accessAdminAuthHostConfig).toMatchObject({
      hostLabel: "Admin",
      requiredPermission: "accounts.view",
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
