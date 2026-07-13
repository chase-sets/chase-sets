import { describe, expect, it } from "vitest";
import { ROLE_PERMISSIONS } from "./constants";
import { ROLE_KEYS } from "../../../support/runtime-support/common";

describe("identity role permissions", () => {
  it("has permissions for every runtime role key", () => {
    expect(Object.keys(ROLE_PERMISSIONS).sort()).toEqual([...ROLE_KEYS].sort());
  });

  it("grants platform admins the explicit admin-web surface permissions", () => {
    expect(ROLE_PERMISSIONS["platform-admin"]).toEqual(
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

  it("grants owner authority for buying and selling workflows by default", () => {
    expect(ROLE_PERMISSIONS.owner).toEqual(
      expect.arrayContaining([
        "inventory.manage",
        "inventory.view",
        "commercial-terms.manage",
        "commercial-terms.view",
        "postage-policies.manage",
        "postage-policies.view",
        "listings.manage",
        "listings.view",
        "offers.manage",
        "offers.view",
        "orders.manage",
        "orders.view",
        "payouts.view",
      ]),
    );
  });

  it("restricts platform-policy.manage to platform-admin (m110 #4291 policy console)", () => {
    expect(ROLE_PERMISSIONS["platform-admin"]).toContain("platform-policy.manage");
    expect(ROLE_PERMISSIONS.owner).not.toContain("platform-policy.manage");
    expect(ROLE_PERMISSIONS.manager).not.toContain("platform-policy.manage");
    expect(ROLE_PERMISSIONS.fulfillment).not.toContain("platform-policy.manage");
    expect(ROLE_PERMISSIONS.viewer).not.toContain("platform-policy.manage");

    expect(ROLE_PERMISSIONS["platform-admin"]).toContain("platform-policy.view");
    expect(ROLE_PERMISSIONS.owner).toContain("platform-policy.view");
    expect(ROLE_PERMISSIONS.manager).toContain("platform-policy.view");
    expect(ROLE_PERMISSIONS.fulfillment).not.toContain("platform-policy.view");
    expect(ROLE_PERMISSIONS.viewer).not.toContain("platform-policy.view");
  });

  it("grants platform wallet-adjustment authority to no role, keeping it separate from account payout permissions", () => {
    for (const roleKey of ROLE_KEYS) {
      expect(ROLE_PERMISSIONS[roleKey]).not.toContain("wallet-adjustments.operate");
    }
    // Owner and manager hold payouts.manage, but that must never carry the
    // authority to post a cash-equivalent ledger entry to an arbitrary wallet.
    expect(ROLE_PERMISSIONS.owner).toContain("payouts.manage");
    expect(ROLE_PERMISSIONS.owner).not.toContain("wallet-adjustments.operate");
    expect(ROLE_PERMISSIONS.manager).toContain("payouts.manage");
    expect(ROLE_PERMISSIONS.manager).not.toContain("wallet-adjustments.operate");
    // Acquiring any payout permission does not grant the wallet-adjustment authority.
    expect(ROLE_PERMISSIONS["platform-admin"]).not.toContain("wallet-adjustments.operate");
  });

  it("keeps payout scheduling as an authority permission instead of an account capability", () => {
    expect(ROLE_PERMISSIONS.owner).toContain("payouts.manage");
    expect(ROLE_PERMISSIONS.owner).toContain("payouts.reconcile");
    expect(ROLE_PERMISSIONS.owner).toContain("payouts.request");
    expect(ROLE_PERMISSIONS.owner).toContain("payouts.setup");
    expect(ROLE_PERMISSIONS.viewer).toContain("payouts.view");
    expect(ROLE_PERMISSIONS.viewer).not.toContain("payouts.manage");
    expect(ROLE_PERMISSIONS.viewer).not.toContain("payouts.reconcile");
    expect(ROLE_PERMISSIONS.viewer).not.toContain("payouts.request");
    expect(ROLE_PERMISSIONS.viewer).not.toContain("payouts.setup");
  });
});
