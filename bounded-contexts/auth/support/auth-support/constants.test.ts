import { describe, expect, it } from "vitest";
import { AUTH_ROLE_PERMISSIONS } from "./constants";

describe("auth role permissions", () => {
  it("grants the legacy operator wallet-mutation authority to no live actor role", () => {
    // The legacy operator wallet-mutation routes still require this dedicated
    // authority. It must never be resolved onto a live actor via a role until
    // those routes retire in favor of the typed Wallet Adjustment lifecycle, so
    // no owner/manager (or any other role) can post to an arbitrary wallet.
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

  it("grants the platform Wallet Adjustment authority (ADR 0020) to platform-admin only", () => {
    // Must stay identical to Identity's ROLE_PERMISSIONS platform-admin entry
    // -- see the mirrored assertion in
    // bounded-contexts/identity/features/memberships/read-model/constants.test.ts
    // -- so Auth's cached role-permission snapshot never grants this authority
    // to a role Identity's canonical map withholds it from, or vice versa.
    const walletAdjustmentPermissions = [
      "wallet-adjustments.approve",
      "wallet-adjustments.create",
      "wallet-adjustments.reverse",
      "wallet-adjustments.view",
    ] as const;

    for (const permission of walletAdjustmentPermissions) {
      expect(AUTH_ROLE_PERMISSIONS["platform-admin"]).toContain(permission);
    }
    for (const [roleKey, permissions] of Object.entries(AUTH_ROLE_PERMISSIONS)) {
      if (roleKey === "platform-admin") {
        continue;
      }
      for (const permission of walletAdjustmentPermissions) {
        expect(permissions).not.toContain(permission);
      }
    }
    expect(AUTH_ROLE_PERMISSIONS.owner).toContain("payouts.manage");
    expect(AUTH_ROLE_PERMISSIONS.manager).toContain("payouts.manage");
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

  it("mirrors Listing Evidence Policy authority into live actors", () => {
    expect(AUTH_ROLE_PERMISSIONS["platform-admin"]).toEqual(
      expect.arrayContaining([
        "listing-evidence-policy.view",
        "listing-evidence-policy.draft",
        "listing-evidence-policy.validate",
        "listing-evidence-policy.activate",
      ]),
    );
    expect(AUTH_ROLE_PERMISSIONS.owner).toContain("listing-evidence-policy.view");
    expect(AUTH_ROLE_PERMISSIONS.manager).toContain("listing-evidence-policy.view");
    expect(AUTH_ROLE_PERMISSIONS.owner).not.toContain("listing-evidence-policy.activate");
    expect(AUTH_ROLE_PERMISSIONS.manager).not.toContain("listing-evidence-policy.validate");
  });
});
