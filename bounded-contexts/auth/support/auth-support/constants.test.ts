import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { AUTH_ROLE_PERMISSIONS } from "./constants";

describe("auth role permissions", () => {
  it("keeps feedback operator authority on platform staff roles only", () => {
    for (const roleKey of ["owner", "manager", "fulfillment", "viewer"] as const) {
      expect(AUTH_ROLE_PERMISSIONS[roleKey]).not.toEqual(
        expect.arrayContaining(["platform-feedback.view", "platform-feedback.manage", "platform-feedback.export"]),
      );
    }
    expect(AUTH_ROLE_PERMISSIONS["platform-admin"]).toEqual(
      expect.arrayContaining(["platform-feedback.view", "platform-feedback.manage", "platform-feedback.export"]),
    );
  });
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

  it("restricts customer feedback operator capabilities to platform-staff, with export granted separately (#5145)", () => {
    // Must stay identical to Identity's ROLE_PERMISSIONS -- see the mirrored
    // assertion in
    // bounded-contexts/identity/features/memberships/read-model/constants.test.ts.
    const operatorCapabilities = [
      "platform-feedback.view",
      "platform-feedback.manage",
      "platform-feedback.export",
    ] as const;

    for (const capability of operatorCapabilities) {
      expect(AUTH_ROLE_PERMISSIONS["platform-admin"]).toContain(capability);
    }
    for (const [roleKey, permissions] of Object.entries(AUTH_ROLE_PERMISSIONS)) {
      if (roleKey === "platform-admin") {
        continue;
      }
      for (const capability of operatorCapabilities) {
        expect(permissions).not.toContain(capability);
      }
    }
    // Ordinary roles keep their non-feedback grants intact.
    expect(AUTH_ROLE_PERMISSIONS.owner).toContain("support.manage");
    expect(AUTH_ROLE_PERMISSIONS.fulfillment).toContain("support.manage");
    expect(AUTH_ROLE_PERMISSIONS.viewer).toContain("support.view");
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

  it("mirrors account-scoped Channel Connection authority without granting platform-admin", () => {
    expect(AUTH_ROLE_PERMISSIONS.owner).toEqual(expect.arrayContaining(["channels.view", "channels.manage"]));
    expect(AUTH_ROLE_PERMISSIONS.manager).toEqual(expect.arrayContaining(["channels.view", "channels.manage"]));
    expect(AUTH_ROLE_PERMISSIONS.fulfillment).toContain("channels.view");
    expect(AUTH_ROLE_PERMISSIONS.viewer).toContain("channels.view");
    expect(AUTH_ROLE_PERMISSIONS.fulfillment).not.toContain("channels.manage");
    expect(AUTH_ROLE_PERMISSIONS.viewer).not.toContain("channels.manage");
    expect(AUTH_ROLE_PERMISSIONS["platform-admin"]).not.toContain("channels.view");
    expect(AUTH_ROLE_PERMISSIONS["platform-admin"]).not.toContain("channels.manage");
  });
});

describe("pricing preset contract", () => {
  const expected: Record<string, readonly string[]> = {
    owner: ["pricing.manage", "pricing.view"],
    manager: ["pricing.manage", "pricing.view"],
    fulfillment: ["pricing.view"],
    viewer: ["pricing.view"],
    "platform-admin": [],
  };
  // Sorted non-pricing sets captured from the unchanged d33c1fdd predecessor.
  const predecessor = {
    "platform-admin": "199c5f4e9f3db17dd2dd5360dad547f08a6c836eae24942b4f0582a2b1f8ca53",
    owner: "2f44a3531ad460bb8c0e8813515adfccb5299c697e75d0c66afa5880566344d4",
    manager: "4f7bafd3ac8326d8486dcdc7ddeb5c4fe63c76f8615ce4c307f1438af27332c1",
    fulfillment: "968211cfdf02d5d689838226c846197ac9c41fdd96806aa5fe84bfb32b551248",
    viewer: "9b653b5afb093be2612860fcb672d437fc50eac3b929b20cb902c0fbe93a9caa",
  };
  it("grants pricing permissions to the intended account roles", () => {
    for (const [role, permissions] of Object.entries(AUTH_ROLE_PERMISSIONS)) {
      const pricing = permissions.filter((key) => key.startsWith("pricing.")).sort();
      expect(pricing).toEqual(expected[role as keyof typeof expected]);
      for (const key of ["pricing.view", "pricing.manage"]) {
        expect(new Set<string>(permissions).has(key), role + ":" + key).toBe(expected[role]!.includes(key));
      }
      const other = [...new Set(permissions.filter((key) => !key.startsWith("pricing.")))].sort();
      expect(createHash("sha256").update(JSON.stringify(other)).digest("hex")).toBe(
        predecessor[role as keyof typeof predecessor],
      );
    }
  });
});
