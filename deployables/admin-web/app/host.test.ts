import { describe, expect, it } from "vitest";
import { resolveAdminWebNavItems, resolveAdminWebRouteConfigRecords, resolveAdminWebSectionNavItems } from "./host";

describe("admin web host context registry", () => {
  const allSectionsActor = {
    permissions: [
      "accounts.view",
      "catalog.view",
      "commercial-terms.view",
      "google-shopping.view",
      "platform-feedback.view",
      "postage-policies.view",
      "public-presence.view",
      "security.manage",
      "support.manage",
    ],
  };

  it("resolves top-level admin section navigation from visible section entries", () => {
    expect(resolveAdminWebSectionNavItems(allSectionsActor)).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ key: "access", label: "Access", href: "/access/accounts" }),
        expect.objectContaining({ key: "catalog", label: "Catalog", href: "/catalog/dimensions" }),
        expect.objectContaining({ key: "commerce", label: "Commerce", href: "/commerce/terms/schedules" }),
        expect.objectContaining({ key: "growth", label: "Growth", href: "/growth/google-shopping" }),
        expect.objectContaining({ key: "support", label: "Support", href: "/support/requests" }),
        expect.objectContaining({ key: "platform", label: "Platform", href: "/platform/projections" }),
      ]),
    );
  });

  it("keeps section navigation actor-visible", () => {
    expect(resolveAdminWebSectionNavItems({ permissions: ["support.manage"] })).toContainEqual(
      expect.objectContaining({ key: "support", href: "/support/requests" }),
    );
    expect(resolveAdminWebSectionNavItems({ permissions: ["support.manage"] })).not.toContainEqual(
      expect.objectContaining({ key: "commerce" }),
    );
    expect(resolveAdminWebSectionNavItems({ permissions: ["commercial-terms.view"] })).toContainEqual(
      expect.objectContaining({ key: "commerce", href: "/commerce/terms/schedules" }),
    );
    expect(resolveAdminWebSectionNavItems({ permissions: ["commercial-terms.view"] })).not.toContainEqual(
      expect.objectContaining({ key: "platform" }),
    );
    expect(resolveAdminWebNavItems({ permissions: ["commercial-terms.view"] }, { section: "platform" })).toEqual([]);
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
    expect(resolveAdminWebNavItems({ permissions: ["security.manage"] }, { section: "platform" })).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          href: "/platform/projections",
          label: "Projection Operations",
        }),
        expect.objectContaining({
          href: "/platform/release-dashboard",
          label: "Release Dashboard",
        }),
        expect.objectContaining({
          href: "/platform/release-controls",
          label: "Release Controls",
        }),
      ]),
    );
  });
});
