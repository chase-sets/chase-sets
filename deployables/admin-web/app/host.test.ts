import { describe, expect, it } from "vitest";
import {
  resolveAdminWebNavItems,
  resolveAdminWebRouteConfigRecords,
  resolveAdminWebRouteFallbackPermission,
  resolveAdminWebSectionNavItems,
} from "./host";

describe("admin web host context registry", () => {
  const allSectionsActor = {
    permissions: [
      "accounts.view",
      "catalog.view",
      "commercial-terms.view",
      "google-shopping.view",
      "platform-feedback.view",
      "postage-policies.view",
      "projection-operations.view",
      "public-presence.view",
      "security.manage",
      "support.manage",
    ],
  };

  it("resolves top-level admin section navigation from visible section entries", () => {
    expect(resolveAdminWebSectionNavItems(allSectionsActor)).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ key: "access", label: "Access", href: "/access" }),
        expect.objectContaining({ key: "catalog", label: "Catalog", href: "/catalog" }),
        expect.objectContaining({ key: "commerce", label: "Commerce", href: "/commerce" }),
        expect.objectContaining({ key: "growth", label: "Growth", href: "/growth" }),
        expect.objectContaining({ key: "support", label: "Support", href: "/support" }),
        expect.objectContaining({ key: "platform", label: "Platform", href: "/platform" }),
      ]),
    );
  });

  it("keeps section navigation actor-visible", () => {
    expect(resolveAdminWebSectionNavItems({ permissions: ["support.manage"] })).toContainEqual(
      expect.objectContaining({ key: "support", href: "/support" }),
    );
    expect(resolveAdminWebSectionNavItems({ permissions: ["support.manage"] })).not.toContainEqual(
      expect.objectContaining({ key: "commerce" }),
    );
    expect(resolveAdminWebSectionNavItems({ permissions: ["commercial-terms.view"] })).toContainEqual(
      expect.objectContaining({ key: "commerce", href: "/commerce" }),
    );
    expect(resolveAdminWebSectionNavItems({ permissions: ["commercial-terms.view"] })).not.toContainEqual(
      expect.objectContaining({ key: "platform" }),
    );
    expect(resolveAdminWebNavItems({ permissions: ["commercial-terms.view"] }, { section: "platform" })).toEqual([]);
  });

  it("contributes admin sign-in routes from access and catalog hosts", () => {
    expect(resolveAdminWebRouteConfigRecords()).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          routeId: "sign-in",
          routePath: "access/sign-in",
          section: "access",
        }),
        expect.objectContaining({
          routeId: "catalog-sign-in",
          routePath: "catalog/sign-in",
          section: "catalog",
        }),
      ]),
    );
  });

  it("contributes Catalog integrations as a nested admin nav group with section-prefixed child routes", () => {
    expect(resolveAdminWebNavItems({ permissions: ["catalog.view"] }, { section: "catalog" })).toContainEqual({
      key: "integrations",
      label: "Integrations",
      icon: "rocket",
      children: [
        { key: "integrations-import", label: "Import", icon: "refreshCcw", href: "/catalog/integrations" },
        {
          key: "integrations-providers",
          label: "Provider setup",
          icon: "settings",
          href: "/catalog/integrations/providers",
        },
        {
          key: "integrations-settings",
          label: "Settings",
          icon: "shield",
          href: "/catalog/integrations/settings",
        },
        {
          key: "integrations-health",
          label: "Integration health",
          icon: "checkCircle",
          href: "/catalog/integrations/health",
        },
      ],
    });
  });

  it("contributes Commercial Terms and postage policies to Commerce", () => {
    expect(resolveAdminWebRouteConfigRecords()).toContainEqual(
      expect.objectContaining({
        routeId: "commercial-terms-schedules",
        routePath: "commerce/terms/schedules",
        section: "commerce",
      }),
    );
    expect(resolveAdminWebRouteConfigRecords()).toContainEqual(
      expect.objectContaining({
        routeId: "ordering-postage-policies",
        routePath: "commerce/postage-policies",
        section: "commerce",
      }),
    );
    expect(resolveAdminWebNavItems({ permissions: ["postage-policies.view"] }, { section: "commerce" })).toContainEqual(
      expect.objectContaining({
        href: "/commerce/postage-policies",
        label: "Postage Policies",
      }),
    );
  });

  it("contributes Growth surfaces to Growth", () => {
    expect(resolveAdminWebRouteConfigRecords()).toContainEqual(
      expect.objectContaining({
        routeId: "google-shopping",
        routePath: "growth/google-shopping",
        section: "growth",
      }),
    );
    expect(resolveAdminWebNavItems({ permissions: ["google-shopping.view"] }, { section: "growth" })).toContainEqual(
      expect.objectContaining({
        href: "/growth/google-shopping",
        label: "Google Shopping",
      }),
    );
  });

  it("contributes support request and feedback surfaces to Support", () => {
    expect(resolveAdminWebRouteConfigRecords()).toContainEqual(
      expect.objectContaining({
        routeId: "support-requests",
        routePath: "support/requests",
        section: "support",
      }),
    );
    expect(resolveAdminWebRouteConfigRecords()).toContainEqual(
      expect.objectContaining({
        routeId: "platform-feedback",
        routePath: "support/platform-feedback",
        section: "support",
      }),
    );
  });

  it("contributes Platform Operations navigation to Platform", () => {
    expect(resolveAdminWebNavItems({ permissions: ["projection-operations.view"] }, { section: "platform" })).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          href: "/platform/projections",
          label: "Projection Operations",
        }),
      ]),
    );
  });

  it("separates Access security from Platform operations navigation", () => {
    const sectionItems = resolveAdminWebSectionNavItems({ permissions: ["security.manage"] });

    expect(sectionItems).toEqual(expect.arrayContaining([expect.objectContaining({ key: "access", href: "/access" })]));
    expect(sectionItems).not.toEqual(expect.arrayContaining([expect.objectContaining({ key: "platform" })]));
    expect(resolveAdminWebNavItems({ permissions: ["security.manage"] }, { section: "access" })).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ href: "/access/users", label: "Users" }),
        expect.objectContaining({ href: "/access/api-keys", label: "API Keys" }),
        expect.objectContaining({ href: "/access/sessions", label: "Sessions" }),
      ]),
    );
  });

  it.each([
    ["access", "/access/users", "accounts.view", "security.manage"],
    ["access", "/access/api-keys/key_1", "accounts.view", "security.manage"],
    ["access", "/access/sessions", "accounts.view", "security.manage"],
    ["access", "/access/memberships/member_1", "accounts.view", "memberships.view"],
    ["access", "/access/invitations/inv_1", "accounts.view", "memberships.view"],
    ["growth", "/growth/waitlist", "google-shopping.view", "public-presence.view"],
    ["growth", "/growth/promo-bar", "google-shopping.view", "public-presence.view"],
    ["commerce", "/commerce/terms/schedules/schedule_1", "commercial-terms.view", "commercial-terms.view"],
    ["commerce", "/commerce/postage-policies/policy_1", "commercial-terms.view", "postage-policies.view"],
    ["support", "/support/platform-feedback/pfb_1", "support.manage", "platform-feedback.view"],
    ["support", "/support/requests/request_1", "support.manage", "support.manage"],
  ] as const)(
    "resolves %s direct route %s to its route-specific fallback permission",
    (section, pathname, defaultPermission, expectedPermission) => {
      expect(resolveAdminWebRouteFallbackPermission(section, pathname, defaultPermission)).toBe(expectedPermission);
    },
  );
});
