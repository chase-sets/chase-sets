import { describe, expect, it } from "vitest";
import { resolveAdminWebNavItems, resolveAdminWebRouteConfigRecords } from "./host";

describe("admin web host context registry", () => {
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
});
