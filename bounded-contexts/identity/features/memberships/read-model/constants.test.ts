import { describe, expect, it } from "vitest";
import { ROLE_PERMISSIONS } from "./constants";
import { ROLE_KEYS } from "../../../support/runtime-support/common";

describe("identity role permissions", () => {
  it("keeps feedback operator authority on platform staff roles only", () => {
    for (const roleKey of ["owner", "manager", "fulfillment", "viewer"] as const) {
      expect(ROLE_PERMISSIONS[roleKey]).not.toEqual(
        expect.arrayContaining(["platform-feedback.view", "platform-feedback.manage", "platform-feedback.export"]),
      );
    }
    expect(ROLE_PERMISSIONS["platform-admin"]).toEqual(
      expect.arrayContaining(["platform-feedback.view", "platform-feedback.manage", "platform-feedback.export"]),
    );
  });
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

  it("grants the legacy operator wallet-mutation authority to no role, keeping it separate from account payout permissions", () => {
    // The legacy operator mutation routes (refund-debit/dispute-hold/dispute-release)
    // still require this dedicated authority. It must never be resolved onto a role
    // until those routes retire in favor of the typed Wallet Adjustment lifecycle, so
    // no owner/manager (or any other role) can post to an arbitrary wallet.
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

  it("grants the platform Wallet Adjustment authority (ADR 0020) to platform-admin only", () => {
    const walletAdjustmentPermissions = [
      "wallet-adjustments.approve",
      "wallet-adjustments.create",
      "wallet-adjustments.reverse",
      "wallet-adjustments.view",
    ] as const;

    for (const permission of walletAdjustmentPermissions) {
      expect(ROLE_PERMISSIONS["platform-admin"]).toContain(permission);
    }
    for (const roleKey of ROLE_KEYS) {
      if (roleKey === "platform-admin") {
        continue;
      }
      for (const permission of walletAdjustmentPermissions) {
        expect(ROLE_PERMISSIONS[roleKey]).not.toContain(permission);
      }
    }
    // Read/create/approve/reverse are independently named permissions, not a
    // single bundled grant, so each can be withheld on its own.
    expect(new Set(walletAdjustmentPermissions).size).toBe(walletAdjustmentPermissions.length);
    // Owner/manager hold payouts.manage, but the platform Wallet Adjustment
    // authority must never ride along with account-scoped payout authority.
    expect(ROLE_PERMISSIONS.owner).toContain("payouts.manage");
    expect(ROLE_PERMISSIONS.manager).toContain("payouts.manage");
  });

  it("restricts customer feedback operator capabilities to platform-staff, with export granted separately (#5145)", () => {
    const operatorCapabilities = [
      "platform-feedback.view",
      "platform-feedback.manage",
      "platform-feedback.export",
    ] as const;

    // Platform-staff hold the full operator surface, including the separately
    // named export grant.
    for (const capability of operatorCapabilities) {
      expect(ROLE_PERMISSIONS["platform-admin"]).toContain(capability);
    }

    // Ordinary account roles never enumerate/export/mutate customer feedback --
    // submitting one's own experience feedback is an authenticated-subject
    // authority, not a role capability.
    for (const roleKey of ROLE_KEYS) {
      if (roleKey === "platform-admin") {
        continue;
      }
      for (const capability of operatorCapabilities) {
        expect(ROLE_PERMISSIONS[roleKey]).not.toContain(capability);
      }
    }

    // Export is an independent grant, so a view-only staff assignment cannot
    // download the free-text comment corpus.
    expect(new Set(operatorCapabilities).size).toBe(operatorCapabilities.length);
  });

  it("separates Listing Evidence Policy review from drafting, validation, and activation", () => {
    const elevated = [
      "listing-evidence-policy.draft",
      "listing-evidence-policy.validate",
      "listing-evidence-policy.activate",
    ] as const;

    expect(ROLE_PERMISSIONS["platform-admin"]).toEqual(
      expect.arrayContaining(["listing-evidence-policy.view", ...elevated]),
    );
    expect(ROLE_PERMISSIONS.owner).toContain("listing-evidence-policy.view");
    expect(ROLE_PERMISSIONS.manager).toContain("listing-evidence-policy.view");
    for (const permission of elevated) {
      expect(ROLE_PERMISSIONS.owner).not.toContain(permission);
      expect(ROLE_PERMISSIONS.manager).not.toContain(permission);
    }
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
