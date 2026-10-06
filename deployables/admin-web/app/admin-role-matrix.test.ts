import { beforeAll, describe, expect, it } from "vitest";
import { resolveAdminWebNavItems, resolveAdminWebSectionNavItems } from "./host";
import { resolveActorFromSessionId } from "@chase-sets/auth/server";

const ROLE_KEYS = ["platform-admin", "owner", "manager", "fulfillment", "viewer"] as const;
type RoleKey = (typeof ROLE_KEYS)[number];
type Actor = NonNullable<Awaited<ReturnType<typeof resolveActorFromSessionId>>>;
const actors = new Map<RoleKey, Actor>();

beforeAll(async () => {
  for (const roleKey of ROLE_KEYS) {
    // Empty stored grants exercise AUTH_ROLE_PERMISSIONS through Auth's public resolver.
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
            role_permissions: [],
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
  it.each([
    ["platform-admin", ["access", "catalog", "commerce", "growth", "platform", "support"]],
    ["owner", ["access", "catalog", "commerce", "growth", "platform", "support"]],
    ["manager", ["access", "catalog", "commerce", "growth", "platform", "support"]],
    ["fulfillment", ["access", "commerce", "growth", "support"]],
    // The Customer Feedback attention surface is visible with support.view;
    // Support Requests still requires support.manage.
    ["viewer", ["access", "growth", "support"]],
  ] as const)("role %s sees exactly its authorized top-level sections", (roleKey, expectedSections) => {
    expect(visibleSectionKeys(roleKey)).toEqual([...expectedSections].sort());
  });

  it.each([
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

    // owner and manager both carry payouts.reconcile and see the full Commerce surface.
    for (const roleKey of ["owner", "manager"] as const) {
      const commerceItems = resolveAdminWebNavItems(actorForRole(roleKey), { section: "commerce" });
      expect(commerceItems).toContainEqual(expect.objectContaining({ href: "/commerce/money-health" }));
      expect(commerceItems).toContainEqual(expect.objectContaining({ href: "/commerce/payout-operations" }));
    }
  });

  it.each(ROLE_KEYS)("shows each payout page once only to supported role %s", (role) => {
    const items = resolveAdminWebNavItems(actorForRole(role), { section: "commerce" });
    for (const href of ["/commerce/money-health", "/commerce/payout-operations"]) {
      expect(items.filter((item) => item.href === href)).toHaveLength(
        ["platform-admin", "owner", "manager"].includes(role) ? 1 : 0,
      );
    }
  });

  it("shows each payout page once when stored and role grants include both permissions", () => {
    const actor = { permissions: [...actorForRole("platform-admin").permissions, "payouts.reconcile"] };
    const items = resolveAdminWebNavItems(actor, { section: "commerce" });
    for (const href of ["/commerce/money-health", "/commerce/payout-operations"]) {
      expect(items.filter((item) => item.href === href)).toHaveLength(1);
    }
  });

  it("keeps manager's Platform visibility distinct from its Projection Operations access", () => {
    // manager sees the Platform section (platform-policy.view, insights-dashboards.view) but lacks
    // projection-operations.view, so Projection Operations must not resolve as a shortcut.
    const managerPlatformItems = resolveAdminWebNavItems(actorForRole("manager"), { section: "platform" });
    expect(managerPlatformItems).toContainEqual(expect.objectContaining({ href: "/platform/policy-console" }));
    expect(managerPlatformItems).not.toContainEqual(expect.objectContaining({ href: "/platform/projections" }));
  });
});
