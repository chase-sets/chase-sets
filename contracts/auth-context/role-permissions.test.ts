import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { PERMISSION_KEYS, PERMISSION_PRESETS, ROLE_PERMISSIONS } from "./index";

type PreMoveFixture = Readonly<{
  source: Readonly<{ commit: string; path: string; blob: string; export: string }>;
  rolePermissions: Readonly<Record<string, readonly string[]>>;
}>;

// Generated once from Auth's AUTH_ROLE_PERMISSIONS at the base commit of the
// move (#3467); `source` names the exact blob it was exported from.
const preMove: PreMoveFixture = JSON.parse(
  readFileSync(new URL("./pre-move-auth-role-permissions.fixture.json", import.meta.url), "utf8"),
);
const repoRoot = fileURLToPath(new URL("../..", import.meta.url));

function gitGrep(args: readonly string[]): readonly string[] {
  const result = spawnSync("git", ["grep", "--no-color", ...args], { cwd: repoRoot, encoding: "utf8" });
  if (result.status !== 0 && result.status !== 1) {
    throw new Error(`git grep failed: ${result.stderr || result.error?.message}`);
  }
  return result.stdout.split("\n").filter(Boolean);
}

function assertHistoricalPermissionsWithHold(roles: Readonly<Record<string, readonly string[]>>) {
  expect(roles).toEqual({
    ...preMove.rolePermissions,
    "platform-admin": ["payout-review-holds.manage", ...preMove.rolePermissions["platform-admin"]!],
  });
}

describe("canonical role-to-permission table", () => {
  it("canonical role table equals the pre-move Auth table plus the platform-admin hold grant", () => {
    expect(preMove.source).toEqual({
      commit: "15e1e56fc71665b8aabb699c8f00688233136be8",
      path: "bounded-contexts/auth/support/auth-support/constants.ts",
      blob: "0c4214790c27b9937e91f09e565c5c9f298bd8b1",
      export: "AUTH_ROLE_PERMISSIONS",
    });
    assertHistoricalPermissionsWithHold(ROLE_PERMISSIONS);
  });

  it.each(["deleted hold", "owner hold", "unrelated grant"] as const)(
    "rejects an unauthorized historical permission delta: %s",
    (change) => {
      const roles: Record<keyof typeof ROLE_PERMISSIONS, readonly string[]> = { ...ROLE_PERMISSIONS };
      if (change === "deleted hold") {
        roles["platform-admin"] = roles["platform-admin"].filter((key) => key !== "payout-review-holds.manage");
      } else if (change === "owner hold") {
        roles.owner = [...roles.owner, "payout-review-holds.manage"];
      } else {
        roles["platform-admin"] = [...roles["platform-admin"], "unrelated.manage"];
      }
      expect(() => assertHistoricalPermissionsWithHold(roles)).toThrow();
    },
  );

  it("is the only role-to-permission table and PermissionKey declaration", () => {
    expect(
      gitGrep(["-E", "ROLE_PERMISSIONS = |type PermissionKey =", "--", "bounded-contexts", "contracts", ":!*.test.*"]),
    ).toEqual([
      "contracts/auth-context/index.ts:export type PermissionKey = (typeof PERMISSION_KEYS)[number];",
      "contracts/auth-context/index.ts:export const ROLE_PERMISSIONS = {",
    ]);
  });

  it("declares each permission key once and grants only declared keys", () => {
    expect(new Set(PERMISSION_KEYS).size).toBe(PERMISSION_KEYS.length);
    const declared = new Set<string>(PERMISSION_KEYS);
    expect(
      [...Object.values(ROLE_PERMISSIONS), ...Object.values(PERMISSION_PRESETS)]
        .flat()
        .filter((permission) => !declared.has(permission)),
    ).toEqual([]);
  });

  it("declares the guest checkout cookie name only in this contract", () => {
    expect(
      gitGrep(["-F", '= "chase_sets_guest_checkout"', "--", "bounded-contexts/*.ts", "contracts/*.ts", ":!*.test.*"]),
    ).toEqual([
      'contracts/auth-context/index.ts:export const AUTH_GUEST_CHECKOUT_COOKIE_NAME = "chase_sets_guest_checkout";',
    ]);
  });
});

describe("role permission grants", () => {
  it("declares payout review hold management once and grants it only once to platform-admin, never a preset", () => {
    expect(PERMISSION_KEYS.filter((key) => key === "payout-review-holds.manage")).toEqual([
      "payout-review-holds.manage",
    ]);
    for (const [role, permissions] of Object.entries(ROLE_PERMISSIONS)) {
      expect(permissions.filter((permission) => permission === "payout-review-holds.manage")).toEqual(
        role === "platform-admin" ? ["payout-review-holds.manage"] : [],
      );
    }
    for (const permissions of Object.values(PERMISSION_PRESETS)) {
      expect(permissions).not.toContain("payout-review-holds.manage");
    }
  });

  it("grants reported-content operator authority to platform-admin only", () => {
    for (const [role, permissions] of Object.entries(ROLE_PERMISSIONS)) {
      expect(permissions.filter((permission) => permission === "reported-content.view")).toEqual(
        role === "platform-admin" ? ["reported-content.view"] : [],
      );
    }
    for (const permissions of Object.values(PERMISSION_PRESETS)) {
      expect(permissions).not.toContain("reported-content.view");
    }
  });

  it("grants platform payout reads once to platform-admin and never through a preset", () => {
    for (const [role, permissions] of Object.entries(ROLE_PERMISSIONS)) {
      expect(permissions.filter((permission) => permission === "payouts.platform.view")).toEqual(
        role === "platform-admin" ? ["payouts.platform.view"] : [],
      );
      const grants = new Set<string>(permissions);
      expect(grants.has("payouts.platform.view") && grants.has("payouts.reconcile")).toBe(false);
    }
    for (const permissions of Object.values(PERMISSION_PRESETS)) {
      expect(permissions).not.toContain("payouts.platform.view");
    }
  });

  it("grants commercial agreement management only to platform admins", () => {
    for (const [role, permissions] of Object.entries(ROLE_PERMISSIONS)) {
      expect(permissions.filter((permission) => permission === "commercial-terms.agreements.manage")).toEqual(
        role === "platform-admin" ? ["commercial-terms.agreements.manage"] : [],
      );
    }
  });

  it("grants provider connections only to platform admins", () => {
    for (const [role, permissions] of Object.entries(ROLE_PERMISSIONS)) {
      expect((permissions as readonly string[]).includes("provider-connections.view")).toBe(role === "platform-admin");
    }
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

  it("grants commercial terms, postage policy and projection operations authority to live account roles", () => {
    expect(ROLE_PERMISSIONS.owner).toEqual(
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
    expect(ROLE_PERMISSIONS.manager).toEqual(
      expect.arrayContaining([
        "commercial-terms.manage",
        "commercial-terms.view",
        "postage-policies.manage",
        "postage-policies.view",
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
    for (const permissions of Object.values(ROLE_PERMISSIONS)) {
      expect(permissions).not.toContain("wallet-adjustments.operate");
    }
    // Owner and manager hold payouts.manage, but that must never carry the
    // authority to post a cash-equivalent ledger entry to an arbitrary wallet.
    expect(ROLE_PERMISSIONS.owner).toContain("payouts.manage");
    expect(ROLE_PERMISSIONS.manager).toContain("payouts.manage");
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
    for (const [roleKey, permissions] of Object.entries(ROLE_PERMISSIONS)) {
      if (roleKey === "platform-admin") {
        continue;
      }
      for (const permission of walletAdjustmentPermissions) {
        expect(permissions).not.toContain(permission);
      }
    }
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

    for (const capability of operatorCapabilities) {
      expect(ROLE_PERMISSIONS["platform-admin"]).toContain(capability);
    }
    // Ordinary account roles never enumerate/export/mutate customer feedback --
    // submitting one's own experience feedback is an authenticated-subject
    // authority, not a role capability.
    for (const [roleKey, permissions] of Object.entries(ROLE_PERMISSIONS)) {
      if (roleKey === "platform-admin") {
        continue;
      }
      for (const capability of operatorCapabilities) {
        expect(permissions).not.toContain(capability);
      }
    }
    // Ordinary roles keep their non-feedback grants intact.
    expect(ROLE_PERMISSIONS.owner).toContain("support.manage");
    expect(ROLE_PERMISSIONS.fulfillment).toContain("support.manage");
    expect(ROLE_PERMISSIONS.viewer).toContain("support.view");
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

  it("grants account-scoped Channel Connection authority without granting platform-admin", () => {
    expect(ROLE_PERMISSIONS.owner).toEqual(expect.arrayContaining(["channels.view", "channels.manage"]));
    expect(ROLE_PERMISSIONS.manager).toEqual(expect.arrayContaining(["channels.view", "channels.manage"]));
    expect(ROLE_PERMISSIONS.fulfillment).toContain("channels.view");
    expect(ROLE_PERMISSIONS.viewer).toContain("channels.view");
    expect(ROLE_PERMISSIONS.fulfillment).not.toContain("channels.manage");
    expect(ROLE_PERMISSIONS.viewer).not.toContain("channels.manage");
    expect(ROLE_PERMISSIONS["platform-admin"]).not.toContain("channels.view");
    expect(ROLE_PERMISSIONS["platform-admin"]).not.toContain("channels.manage");
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
  // Sorted non-pricing sets, including the platform-admin-only reported-content grant.
  const predecessor = {
    "platform-admin": "783c68e9b946919206e54caa8767d024561c343adfc28b9752cffadb1083995f",
    owner: "2f44a3531ad460bb8c0e8813515adfccb5299c697e75d0c66afa5880566344d4",
    manager: "4f7bafd3ac8326d8486dcdc7ddeb5c4fe63c76f8615ce4c307f1438af27332c1",
    fulfillment: "968211cfdf02d5d689838226c846197ac9c41fdd96806aa5fe84bfb32b551248",
    viewer: "9b653b5afb093be2612860fcb672d437fc50eac3b929b20cb902c0fbe93a9caa",
  };
  it("grants pricing permissions to the intended account roles", () => {
    for (const [role, permissions] of Object.entries(ROLE_PERMISSIONS)) {
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
