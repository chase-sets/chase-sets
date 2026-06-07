import { describe, expect, it } from "vitest";
import { resolveAdminWebNavItems, resolveAdminWebRouteConfigRecords, resolveAdminWebSectionNavItems } from "./host";

describe("admin web host context registry", () => {
  it("resolves top-level admin section navigation from visible section entries", () => {
    expect(
      resolveAdminWebSectionNavItems({
        permissions: ["commercial-terms.view", "platform-feedback.view", "security.manage", "support.manage"],
      }),
    ).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ key: "catalog", label: "Catalog", href: "/catalog/dimensions" }),
        expect.objectContaining({ key: "identity", label: "Identity", href: "/identity/accounts" }),
        expect.objectContaining({ key: "experience", label: "Experience", href: "/experience/platform-feedback" }),
        expect.objectContaining({ key: "operations", label: "Operations", href: "/operations/projections" }),
        expect.objectContaining({ key: "commercial", label: "Commercial Terms", href: "/commercial/terms/schedules" }),
      ]),
    );
  });

  it("keeps section navigation actor-visible", () => {
    expect(
      resolveAdminWebSectionNavItems({
        permissions: ["support.manage"],
      }),
    ).toContainEqual(expect.objectContaining({ key: "operations", href: "/operations/support-requests" }));
    expect(
      resolveAdminWebSectionNavItems({
        permissions: ["support.manage"],
      }),
    ).not.toContainEqual(expect.objectContaining({ key: "commercial" }));
    expect(
      resolveAdminWebSectionNavItems({
        permissions: ["commercial-terms.view"],
      }),
    ).toContainEqual(expect.objectContaining({ key: "commercial", href: "/commercial/terms/schedules" }));
    expect(
      resolveAdminWebSectionNavItems({
        permissions: ["commercial-terms.view"],
      }),
    ).not.toContainEqual(expect.objectContaining({ key: "operations" }));
    expect(
      resolveAdminWebNavItems(
        {
          permissions: ["commercial-terms.view"],
        },
        { section: "operations" },
      ),
    ).toEqual([]);
  });

  it("contributes Commercial Terms to the commercial section", () => {
    expect(resolveAdminWebRouteConfigRecords()).toContainEqual(
      expect.objectContaining({
        routeId: "commercial-terms-schedules",
        routePath: "commercial/terms/schedules",
        section: "commercial",
      }),
    );
    expect(resolveAdminWebRouteConfigRecords()).toContainEqual(
      expect.objectContaining({
        routeId: "commercial-terms-agreements",
        routePath: "commercial/terms/agreements",
        section: "commercial",
      }),
    );

    expect(
      resolveAdminWebNavItems(
        {
          permissions: ["commercial-terms.view"],
        },
        { section: "commercial" },
      ),
    ).toContainEqual(
      expect.objectContaining({
        href: "/commercial/terms/schedules",
        label: "Commercial Terms",
      }),
    );
  });

  it("contributes Platform Operations navigation to the operations section", () => {
    expect(
      resolveAdminWebNavItems(
        {
          permissions: ["security.manage"],
        },
        { section: "operations" },
      ),
    ).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          href: "/operations/projections",
          label: "Projection Operations",
        }),
        expect.objectContaining({
          href: "/operations/release-dashboard",
          label: "Release Dashboard",
        }),
        expect.objectContaining({
          href: "/operations/release-controls",
          label: "Release Controls",
        }),
      ]),
    );
  });

  it("contributes Support operations to the operations section", () => {
    expect(resolveAdminWebRouteConfigRecords()).toContainEqual(
      expect.objectContaining({
        routeId: "support-operations",
        routePath: "operations/support-requests",
      }),
    );
    expect(resolveAdminWebRouteConfigRecords()).toContainEqual(
      expect.objectContaining({
        routeId: "support-operations-detail",
        routePath: "operations/support-requests/:id",
      }),
    );

    expect(
      resolveAdminWebNavItems(
        {
          permissions: ["support.manage"],
        },
        { section: "operations" },
      ),
    ).toContainEqual(
      expect.objectContaining({
        href: "/operations/support-requests",
        label: "Support",
      }),
    );
  });

  it("contributes Google Shopping operations to the operations section", () => {
    expect(resolveAdminWebRouteConfigRecords()).toContainEqual(
      expect.objectContaining({
        routeId: "google-shopping-operations",
        routePath: "operations/google-shopping",
      }),
    );

    expect(
      resolveAdminWebNavItems(
        {
          permissions: ["security.manage"],
        },
        { section: "operations" },
      ),
    ).toContainEqual(
      expect.objectContaining({
        href: "/operations/google-shopping",
        label: "Google Shopping",
      }),
    );
  });

  it("contributes Ordering postage policies to the identity section", () => {
    expect(resolveAdminWebRouteConfigRecords()).toContainEqual(
      expect.objectContaining({
        routeId: "ordering-postage-policies",
        routePath: "identity/postage-policies",
      }),
    );
    expect(resolveAdminWebRouteConfigRecords()).toContainEqual(
      expect.objectContaining({
        routeId: "ordering-postage-policies-detail",
        routePath: "identity/postage-policies/:id",
      }),
    );

    expect(
      resolveAdminWebNavItems(
        {
          permissions: ["postage-policies.view"],
        },
        { section: "identity" },
      ),
    ).toContainEqual(
      expect.objectContaining({
        href: "/identity/postage-policies",
        label: "Postage Policies",
      }),
    );
  });
});
