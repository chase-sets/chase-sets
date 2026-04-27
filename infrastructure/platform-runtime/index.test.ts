import { describe, expect, it } from "vitest";
import {
  createApiHost,
  getApiHostContextNames,
  getApiHostSeedOrder,
} from "./api";
import {
  getWebHostSections,
  resolveWebHostNavItems,
  resolveWebHostRouteRecords,
} from "./web";
import { apiContextRegistry } from "../../deployables/platform-api/src/generated/api-context-registry";
import { webContextRegistry as adminWebContextRegistry } from "../../deployables/admin-web/app/generated/web-context-registry";
import { webContextRegistry as marketplaceWebContextRegistry } from "../../deployables/marketplace/app/generated/web-context-registry";

describe("platform host api registry", () => {
  it("derives platform-api contexts from the deployable-owned registry", () => {
    expect(getApiHostContextNames(apiContextRegistry, "platform-api")).toEqual([
      "auth",
      "catalog",
      "commercial-terms",
      "discovery",
      "fulfillment",
      "identity",
      "inventory",
      "marketplace",
      "ordering",
      "payments",
      "pricing",
      "reputation",
      "settlement",
    ]);
  });

  it("orders seeds by manifest dependencies", () => {
    const seedOrder = getApiHostSeedOrder(apiContextRegistry, "platform-api");

    expect(seedOrder.indexOf("identity")).toBeLessThan(seedOrder.indexOf("auth"));
    expect(seedOrder.indexOf("catalog")).toBeLessThan(seedOrder.indexOf("discovery"));
    expect(seedOrder.indexOf("inventory")).toBeLessThan(seedOrder.indexOf("marketplace"));
  });

  it("throws when a required pool is missing", () => {
    expect(() =>
      createApiHost(apiContextRegistry, "platform-api", {
        pools: {},
      }),
    ).toThrow(/missing a pool/);
  });
});

describe("platform host web registry", () => {
  it("merges admin routes under catalog and identity sections from the admin host registry", () => {
    const routes = resolveWebHostRouteRecords(adminWebContextRegistry, "admin-web");

    expect(routes.some((route) => route.routePath === "catalog/sign-in")).toBe(true);
    expect(routes.some((route) => route.routePath === "identity/accounts")).toBe(true);
    expect(getWebHostSections("admin-web")).toEqual(["catalog", "identity"]);
  });

  it("builds marketplace nav items from the marketplace host registry", () => {
    const navItems = resolveWebHostNavItems(
      marketplaceWebContextRegistry,
      "marketplace-web",
      "top-nav",
      {
      permissions: ["inventory.view", "accounts.view"],
      },
    );

    expect(navItems.some((item) => item.href === "/search")).toBe(true);
    expect(navItems.some((item) => item.href === "/account")).toBe(true);
  });

  it("prefixes admin nav items by section", () => {
    const navItems = resolveWebHostNavItems(
      adminWebContextRegistry,
      "admin-web",
      "primary-nav",
      { permissions: [] },
      { section: "catalog" },
    );

    expect(navItems.some((item) => item.href === "/catalog/dimensions")).toBe(true);
    expect(
      navItems.every((item) => (item.href ?? "").startsWith("/catalog/")),
    ).toBe(true);
  });
});
