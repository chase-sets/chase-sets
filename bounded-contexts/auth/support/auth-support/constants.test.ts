import { describe, expect, it, vi } from "vitest";
import type { PgQueryable } from "@chase-sets/event-core-postgres";
import { buildTransportEvent } from "@chase-sets/event-core/test-support";
import { buildAuthIdentityMembershipProjectionHandlers } from "./identity-projection";
import { AUTH_ROLE_PERMISSIONS } from "./constants";

describe("reported-content grant projection callers", () => {
  it("projects the platform-admin-only grant on membership creation and role change", async () => {
    const query = vi.fn(async (_sql: string, _params?: readonly unknown[]) => ({
      rows: [{ user_id: "usr_synthetic_grant", account_id: "acc_synthetic_grant", status: "active" }],
    }));
    const handlers = buildAuthIdentityMembershipProjectionHandlers({ query } as unknown as PgQueryable);
    for (const roleKey of ["platform-admin", "owner", "manager", "fulfillment", "viewer"]) {
      for (const eventType of ["identity.membership.granted", "identity.membership.role-changed"]) {
        query.mockClear();
        await handlers[eventType]!(
          buildTransportEvent(
            eventType,
            {
              membershipId: "mbr_synthetic_grant",
              userId: "usr_synthetic_grant",
              accountId: "acc_synthetic_grant",
              roleKey,
            },
            {
              streamId: "identity.membership-mbr_synthetic_grant",
              timing: { occurredAt: "2026-08-31T00:00:00.000Z", recordedAt: "2026-08-31T00:00:00.000Z" },
            },
          ),
        );
        const write = query.mock.calls.find(([sql]) =>
          /(?:INSERT INTO|UPDATE)\s+"?auth_identity_memberships"?\s/.test(sql),
        );
        expect(write, `${eventType}: ${roleKey}`).toBeDefined();
        const permissionJson = write![1]!.find((value) => typeof value === "string" && value.startsWith("["));
        expect(typeof permissionJson).toBe("string");
        expect(
          (JSON.parse(permissionJson as string) as string[]).includes("reported-content.view"),
          `${eventType}: ${roleKey}`,
        ).toBe(roleKey === "platform-admin");
      }
    }
  });
});

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

  it("grants reported-content operator authority to platform-admin only", () => {
    // AUTH_ROLE_PERMISSIONS is the current request-time grantability authority:
    // resolveRolePermissions() in
    // bounded-contexts/auth/support/runtime-support/services.ts unions a
    // membership's stored projection permissions with the current preset for
    // its role, so this table decides what an active actor can actually reach.
    //
    // The granting role set asserted here is pinned as an exact set, and the
    // mirrored assertion in
    // bounded-contexts/identity/features/memberships/read-model/constants.test.ts
    // pins the identical exact set against Identity's ROLE_PERMISSIONS. Two
    // exact-set assertions over the same literal are what makes the two new
    // role sets provably identical without either context importing the other.
    //
    // Despite the `.view` name this key also gates reported-content moderation
    // writes and risk-alert action recording (acknowledge,
    // request-manual-payout-review), so granting it to an ordinary account role
    // would hand out settlement-adjacent operator write authority.
    const grantingRoles = Object.entries(AUTH_ROLE_PERMISSIONS)
      .filter(([, permissions]) => (permissions as readonly string[]).includes("reported-content.view"))
      .map(([roleKey]) => roleKey)
      .sort();

    expect(grantingRoles).toEqual(["platform-admin"]);

    expect(AUTH_ROLE_PERMISSIONS["platform-admin"]).toContain("reported-content.view");
    for (const roleKey of ["owner", "manager", "fulfillment", "viewer"] as const) {
      expect(AUTH_ROLE_PERMISSIONS[roleKey]).not.toContain("reported-content.view");
    }

    // Ordinary roles keep their unrelated grants intact -- this slice adds one
    // key and takes none away.
    expect(AUTH_ROLE_PERMISSIONS.owner).toContain("support.manage");
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
});
