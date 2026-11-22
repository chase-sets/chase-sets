import { beforeAll, describe, expect, it } from "vitest";
import { resolveAdminWebNavItems, resolveAdminWebSectionNavItems } from "./host";
import { resolveActorFromSessionId } from "@chase-sets/auth/server";

const ROLE_KEYS = ["platform-admin", "owner", "manager", "fulfillment", "viewer"] as const;
type RoleKey = (typeof ROLE_KEYS)[number];
type Actor = NonNullable<Awaited<ReturnType<typeof resolveActorFromSessionId>>>;
const actors = new Map<RoleKey, Actor>();

beforeAll(async () => {
  for (const roleKey of ROLE_KEYS) {
    // Include old platform grants to prove navigation uses resolved authority, not the snapshot.
    const actor = await resolveActorFromSessionId(
      {
        sessions: {
          readAuthenticatedSession: async () => ({
            state: {
              id: "ses_synthetic_role_matrix",
              userId: "usr_synthetic_role_matrix",
              accountId: "acc_synthetic_role_matrix",
              availableAccountIds: ["acc_synthetic_role_matrix"],
              authenticationMethod: "password",
              status: "active",
              expiresAt: new Date(Date.now() + 60_000).toISOString(),
            },
            authenticatedAt: new Date().toISOString(),
          }),
          getSession: async () => null,
        },
        identity: {
          getActiveMembershipForUserAccount: async () => ({
            membership_id: "mbr_synthetic_role_matrix",
            role_key: roleKey,
            role_permissions: [
              "catalog.manage",
              "catalog.view",
              "payouts.reconcile",
              "public-presence.view",
              "platform-policy.view",
            ],
            status: "active",
          }),
          getUser: async () => ({ primary_email: null, contact_methods: [] }),
        },
      } as unknown as Parameters<typeof resolveActorFromSessionId>[0],
      "ses_synthetic_role_matrix",
    );
    expect(actor).not.toBeNull();
    actors.set(roleKey, actor!);
  }
});

function actorForRole(roleKey: RoleKey) {
  return actors.get(roleKey)!;
}

function visibleSectionKeys(roleKey: RoleKey) {
  return resolveAdminWebSectionNavItems(actorForRole(roleKey))
    .map((item) => item.key)
    .sort();
}

describe("admin RBAC matrix (role fixtures)", () => {
  it("exposes reported-content operator surfaces only to platform-admin", () => {
    for (const roleKey of ROLE_KEYS) {
      const items = resolveAdminWebNavItems(actorForRole(roleKey), { section: "support" });
      for (const href of ["/support/reported-content", "/support/risk-alerts"]) {
        expect(items.filter((item) => item.href === href)).toHaveLength(roleKey === "platform-admin" ? 1 : 0);
      }
    }
    expect(resolveAdminWebNavItems({ permissions: [] }, { section: "support" })).toEqual([]);
  });
  it.each([
    ["platform-admin", ["access", "catalog", "commerce", "growth", "platform", "support"]],
    ["owner", ["access", "support"]],
    ["manager", ["access", "support"]],
    ["fulfillment", ["access", "commerce", "support"]],
    // The Customer Feedback attention surface is visible with support.view;
    // Support Requests still requires support.manage.
    ["viewer", ["access", "support"]],
  ] as const)("role %s sees exactly its authorized top-level sections", (roleKey, expectedSections) => {
    expect(visibleSectionKeys(roleKey)).toEqual([...expectedSections].sort());
  });

  it.each([
    ["owner", "catalog"],
    ["owner", "commerce"],
    ["owner", "growth"],
    ["owner", "platform"],
    ["manager", "catalog"],
    ["manager", "commerce"],
    ["manager", "growth"],
    ["manager", "platform"],
    ["fulfillment", "catalog"],
    ["fulfillment", "platform"],
    ["viewer", "catalog"],
    ["viewer", "commerce"],
    ["viewer", "platform"],
  ] as const)("role %s has no navigable shortcut into the unauthorized %s section", (roleKey, section) => {
    expect(resolveAdminWebNavItems(actorForRole(roleKey), { section })).toEqual([]);
  });

  it("limits fulfillment's Commerce shortcuts to its existing Return Intake authority", () => {
    expect(
      resolveAdminWebNavItems(actorForRole("fulfillment"), { section: "commerce" }).map((item) => item.href),
    ).toEqual(["/commerce/return-intake"]);
  });

  it("records the platform-admin Support Requests visibility decision alongside the other role fixtures", () => {
    // platform-admin, owner, manager, and fulfillment all carry support.manage and see Support Requests.
    // viewer carries only support.view (no support.manage) and does not.
    for (const roleKey of ["platform-admin", "owner", "manager", "fulfillment"] as const) {
      expect(resolveAdminWebNavItems(actorForRole(roleKey), { section: "support" })).toContainEqual(
        expect.objectContaining({ href: "/support/requests" }),
      );
    }

    expect(resolveAdminWebNavItems(actorForRole("viewer"), { section: "support" })).not.toContainEqual(
      expect.objectContaining({ href: "/support/requests" }),
    );
  });

  it("gates Commerce's payout surfaces separately from the Commerce section itself", () => {
    const platformAdminCommerceItems = resolveAdminWebNavItems(actorForRole("platform-admin"), {
      section: "commerce",
    });
    expect(platformAdminCommerceItems).toContainEqual(expect.objectContaining({ href: "/commerce/postage-policies" }));
    expect(platformAdminCommerceItems).toContainEqual(expect.objectContaining({ href: "/commerce/money-health" }));
    expect(platformAdminCommerceItems).toContainEqual(expect.objectContaining({ href: "/commerce/payout-operations" }));
  });

  it.each(ROLE_KEYS)("shows each payout page once only to supported role %s", (role) => {
    const items = resolveAdminWebNavItems(actorForRole(role), { section: "commerce" });
    for (const href of ["/commerce/money-health", "/commerce/payout-operations"]) {
      expect(items.filter((item) => item.href === href)).toHaveLength(role === "platform-admin" ? 1 : 0);
    }
  });

  it("retains the platform policy and projection shortcuts for platform-admin", () => {
    const platformItems = resolveAdminWebNavItems(actorForRole("platform-admin"), { section: "platform" });
    expect(platformItems).toContainEqual(expect.objectContaining({ href: "/platform/policy-console" }));
    expect(platformItems).toContainEqual(expect.objectContaining({ href: "/platform/projections" }));
  });
});
