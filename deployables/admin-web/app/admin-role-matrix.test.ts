import { describe, expect, it } from "vitest";
import { resolveAdminWebNavItems, resolveAdminWebSectionNavItems } from "./host";

/**
 * Local regression evidence for the admin-qa role-fixture RBAC matrix (see
 * docs/runbooks/admin-workflows-staging-qa.md Actor Matrix). These permission sets mirror the exact
 * grants Auth resolves into an admin actor session for each grantable role
 * (bounded-contexts/auth/support/auth-support/constants.ts AUTH_ROLE_PERMISSIONS) -- the source that
 * actually authorizes the admin-web shell, not the display-only mirror in the Identity membership
 * read model. Keep this literal list in sync with that source when role grants change; this suite
 * exists to catch drift between a role's granted permissions and the admin sections/routes that
 * grant actually unlocks, ahead of deployed staging RBAC QA.
 */
const ROLE_PERMISSIONS = {
  "platform-admin": [
    "accounts.manage",
    "accounts.view",
    "catalog.manage",
    "catalog.view",
    "commercial-terms.manage",
    "commercial-terms.view",
    "google-shopping.manage",
    "google-shopping.view",
    "insights-dashboards.view",
    "memberships.manage",
    "memberships.view",
    "postage-policies.manage",
    "postage-policies.view",
    "projection-operations.operate",
    "projection-operations.rebuild",
    "projection-operations.view",
    "platform-feedback.export",
    "platform-feedback.manage",
    "platform-feedback.view",
    "platform-policy.manage",
    "platform-policy.view",
    "public-presence.manage",
    "public-presence.view",
    "security.manage",
    "support.manage",
    "support.view",
  ],
  owner: [
    "accounts.manage",
    "accounts.view",
    "catalog.manage",
    "catalog.view",
    "commercial-terms.manage",
    "commercial-terms.view",
    "fulfillment.manage",
    "fulfillment.view",
    "google-shopping.manage",
    "google-shopping.view",
    "insights-dashboards.view",
    "memberships.manage",
    "memberships.view",
    "inventory.manage",
    "inventory.view",
    "listings.manage",
    "listings.view",
    "offers.manage",
    "offers.view",
    "orders.manage",
    "orders.view",
    "postage-policies.manage",
    "postage-policies.view",
    "projection-operations.operate",
    "projection-operations.rebuild",
    "projection-operations.view",
    "payouts.manage",
    "payouts.reconcile",
    "payouts.request",
    "payouts.setup",
    "payouts.view",
    "platform-policy.view",
    "public-presence.manage",
    "public-presence.view",
    "reputation.manage",
    "reputation.view",
    "support.manage",
    "support.view",
    "security.manage",
  ],
  manager: [
    "accounts.view",
    "catalog.manage",
    "catalog.view",
    "commercial-terms.manage",
    "commercial-terms.view",
    "fulfillment.manage",
    "fulfillment.view",
    "google-shopping.manage",
    "google-shopping.view",
    "insights-dashboards.view",
    "memberships.manage",
    "memberships.view",
    "inventory.manage",
    "inventory.view",
    "listings.manage",
    "listings.view",
    "offers.manage",
    "offers.view",
    "orders.manage",
    "orders.view",
    "postage-policies.manage",
    "postage-policies.view",
    "payouts.manage",
    "payouts.reconcile",
    "payouts.request",
    "payouts.setup",
    "payouts.view",
    "platform-policy.view",
    "public-presence.manage",
    "public-presence.view",
    "reputation.manage",
    "reputation.view",
    "support.manage",
    "support.view",
  ],
  fulfillment: [
    "accounts.view",
    "fulfillment.manage",
    "fulfillment.view",
    "memberships.view",
    "inventory.view",
    "listings.view",
    "offers.view",
    "orders.view",
    "public-presence.view",
    "reputation.view",
    "support.manage",
    "support.view",
  ],
  viewer: [
    "accounts.view",
    "fulfillment.view",
    "memberships.view",
    "inventory.view",
    "listings.view",
    "offers.view",
    "orders.view",
    "payouts.view",
    "public-presence.view",
    "reputation.view",
    "support.view",
  ],
} as const satisfies Readonly<Record<string, readonly string[]>>;

type RoleKey = keyof typeof ROLE_PERMISSIONS;

function actorForRole(roleKey: RoleKey) {
  return { permissions: ROLE_PERMISSIONS[roleKey] };
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
    ["fulfillment", ["access", "growth", "support"]],
    // viewer no longer sees Support: its only Support-section nav contribution
    // was the customer-feedback operator surface, removed by #5145. support.view
    // alone unlocks no navigable Support surface (Support Requests needs
    // support.manage), so viewer correctly loses the section.
    ["viewer", ["access", "growth"]],
  ] as const)("role %s sees exactly its authorized top-level sections", (roleKey, expectedSections) => {
    expect(visibleSectionKeys(roleKey)).toEqual([...expectedSections].sort());
  });

  it.each([
    ["fulfillment", "catalog"],
    ["fulfillment", "commerce"],
    ["fulfillment", "platform"],
    ["viewer", "catalog"],
    ["viewer", "commerce"],
    ["viewer", "platform"],
  ] as const)("role %s has no navigable shortcut into the unauthorized %s section", (roleKey, section) => {
    expect(resolveAdminWebNavItems(actorForRole(roleKey), { section })).toEqual([]);
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
    // platform-admin sees Commerce (commercial-terms.view, postage-policies.view) but lacks
    // payouts.reconcile, so Money Health and Payout Operations must not resolve as shortcuts.
    const platformAdminCommerceItems = resolveAdminWebNavItems(actorForRole("platform-admin"), {
      section: "commerce",
    });
    expect(platformAdminCommerceItems).toContainEqual(expect.objectContaining({ href: "/commerce/postage-policies" }));
    expect(platformAdminCommerceItems).not.toContainEqual(expect.objectContaining({ href: "/commerce/money-health" }));
    expect(platformAdminCommerceItems).not.toContainEqual(
      expect.objectContaining({ href: "/commerce/payout-operations" }),
    );

    // owner and manager both carry payouts.reconcile and see the full Commerce surface.
    for (const roleKey of ["owner", "manager"] as const) {
      const commerceItems = resolveAdminWebNavItems(actorForRole(roleKey), { section: "commerce" });
      expect(commerceItems).toContainEqual(expect.objectContaining({ href: "/commerce/money-health" }));
      expect(commerceItems).toContainEqual(expect.objectContaining({ href: "/commerce/payout-operations" }));
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
