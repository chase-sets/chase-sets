import { describe, expect, it } from "vitest";
import {
  catalogAdminAuthHostConfig,
  identityAdminAuthHostConfig,
  marketplaceAuthHostConfig,
} from "./host-config";

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
    expect(identityAdminAuthHostConfig).toMatchObject({
      requiredPermission: "security.manage",
      accountSelectionPath: "/identity/account-select",
      allowManualMagicLinkTokenEntry: false,
    });
  });
});
