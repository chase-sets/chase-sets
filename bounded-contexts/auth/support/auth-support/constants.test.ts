import { describe, expect, it } from "vitest";
import { AUTH_ROLE_PERMISSIONS } from "./constants";

describe("auth role permissions", () => {
  it("grants platform wallet-adjustment authority to no live actor role", () => {
    // The legacy operator wallet-mutation routes now require this dedicated
    // authority. It must never be resolved onto a live actor via a role until
    // the typed Wallet Adjustment lifecycle grants it deliberately, so no
    // owner/manager (or any other role) can post to an arbitrary wallet.
    for (const permissions of Object.values(AUTH_ROLE_PERMISSIONS)) {
      expect(permissions).not.toContain("wallet-adjustments.operate");
    }
    expect(AUTH_ROLE_PERMISSIONS.owner).toContain("payouts.manage");
    expect(AUTH_ROLE_PERMISSIONS.owner).not.toContain("wallet-adjustments.operate");
    expect(AUTH_ROLE_PERMISSIONS.manager).toContain("payouts.manage");
    expect(AUTH_ROLE_PERMISSIONS.manager).not.toContain("wallet-adjustments.operate");
  });

  it("grants platform admins the explicit admin-web surface permissions", () => {
    expect(AUTH_ROLE_PERMISSIONS["platform-admin"]).toEqual(
      expect.arrayContaining([
        "accounts.manage",
        "accounts.view",
        "catalog.manage",
        "catalog.view",
        "commercial-terms.manage",
        "commercial-terms.view",
        "memberships.manage",
        "memberships.view",
        "postage-policies.manage",
        "postage-policies.view",
        "projection-operations.operate",
        "projection-operations.rebuild",
        "projection-operations.view",
        "platform-feedback.manage",
        "platform-feedback.view",
        "public-presence.manage",
        "public-presence.view",
        "security.manage",
        "support.manage",
        "support.view",
      ]),
    );
  });

  it("mirrors commercial terms authority for live actor permissions", () => {
    expect(AUTH_ROLE_PERMISSIONS.owner).toEqual(
      expect.arrayContaining([
        "commercial-terms.manage",
        "commercial-terms.view",
        "postage-policies.manage",
        "postage-policies.view",
        "projection-operations.operate",
        "projection-operations.rebuild",
        "projection-operations.view",
      ]),
    );
    expect(AUTH_ROLE_PERMISSIONS.manager).toEqual(
      expect.arrayContaining([
        "commercial-terms.manage",
        "commercial-terms.view",
        "postage-policies.manage",
        "postage-policies.view",
      ]),
    );
  });
});
