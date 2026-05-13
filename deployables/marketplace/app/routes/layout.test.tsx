import { renderToString } from "react-dom/server";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { resolveMarketplaceNavItems } from "../host";

const { mockUseLocation, mockUseRouteLoaderData } = vi.hoisted(() => ({
  mockUseLocation: vi.fn(),
  mockUseRouteLoaderData: vi.fn(),
}));

vi.mock("react-router", async () => {
  const actual = await vi.importActual<typeof import("react-router")>("react-router");

  return {
    ...actual,
    Outlet: () => <main>Marketplace content</main>,
    useLocation: mockUseLocation,
    useRouteLoaderData: mockUseRouteLoaderData,
  };
});

import MarketplaceLayoutRoute from "./layout";

describe("marketplace route layout", () => {
  beforeEach(() => {
    mockUseLocation.mockReturnValue({
      pathname: "/search",
      search: "",
    });
  });

  it("presents a simplified trader navigation tree for signed-in actors", () => {
    mockUseLocation.mockReturnValue({
      pathname: "/account/listings",
      search: "",
    });
    const actor = {
      permissions: [
        "accounts.view",
        "fulfillment.view",
        "fulfillment.manage",
        "inventory.view",
        "listings.view",
        "offers.view",
        "payouts.view",
        "reputation.view",
        "orders.view",
        "orders.manage",
        "support.view",
        "support.manage",
      ],
    };
    mockUseRouteLoaderData.mockReturnValue({
      actor,
    });

    const html = renderToString(<MarketplaceLayoutRoute />);
    const topNav = resolveMarketplaceNavItems("top-nav", actor);
    const sellNav = topNav.find((item) => item.key === "selling-workspace");
    const accountNav = topNav.find((item) => item.key === "account");

    expect(
      resolveMarketplaceNavItems("top-nav", null).map((item) => item.href),
    ).toEqual([
      "/search",
      "/sign-in",
      "/register",
    ]);
    expect(topNav.map((item) => item.label)).toEqual([
      "Browse",
      "Purchases",
      "Product Alerts",
      "Notifications",
      "Support",
      "Sell",
      "Account",
      "Cart",
    ]);
    expect(sellNav?.children?.map((item) => item.label)).toEqual([
      "Inventory",
      "Import",
      "Listings",
      "Offer Matches",
      "Sales",
      "Shipping",
      "Payouts",
    ]);
    expect(accountNav?.children?.map((item) => item.label)).toEqual([
      "Account",
      "Submitted Offers",
      "Reviews",
    ]);
    expect(
      resolveMarketplaceNavItems("bottom-nav", actor).map((item) => item.label),
    ).toEqual([
      "Browse",
      "Cart",
      "Purchases",
      "Sell",
      "Account",
    ]);
    expect(html).toContain('href="/account/inventory"');
    expect(html).toContain('href="/account/inventory/imports"');
    expect(html).toContain('href="/account/cart"');
    expect(html).toContain('href="/account/product-alerts"');
    expect(html).toContain('href="/account/notifications"');
    expect(html).toContain('href="/account/support"');
    expect(html).toContain('href="/account/listings"');
    expect(html).toContain('href="/account/offers/matches"');
    expect(html).toContain('href="/account/offers/submitted"');
    expect(html).toContain('href="/account/payouts"');
    expect(html).toContain('href="/account/reviews"');
    expect(html).toContain('href="/account/purchases"');
    expect(html).toContain('href="/account/sales"');
    expect(html).toContain('href="/account"');
    expect(html).not.toContain('href="/account/shipments"');
    expect(html).toContain('action="/sign-out"');
    expect(html).not.toContain("Verified");
    expect(html).not.toContain('href="/sign-in"');
  });

  it("keeps account access for signed-in actors without selling workflow permissions", () => {
    const actor = {
      permissions: [
        "accounts.view",
        "offers.view",
        "orders.view",
        "orders.manage",
      ],
    };

    const topNav = resolveMarketplaceNavItems("top-nav", actor);
    const accountNav = topNav.find((item) => item.key === "account");

    expect(topNav.map((item) => item.label)).toEqual([
      "Browse",
      "Purchases",
      "Product Alerts",
      "Notifications",
      "Account",
      "Cart",
    ]);
    expect(accountNav?.children?.map((item) => item.label)).toEqual([
      "Account",
      "Submitted Offers",
    ]);
    expect(
      resolveMarketplaceNavItems("bottom-nav", actor).map((item) => item.label),
    ).toEqual([
      "Browse",
      "Cart",
      "Purchases",
      "Account",
    ]);
  });

  it("keeps sign-in and registration entry points for signed-out actors", () => {
    mockUseRouteLoaderData.mockReturnValue({
      actor: null,
      cartCount: 0,
    });

    const html = renderToString(<MarketplaceLayoutRoute />);

    expect(
      resolveMarketplaceNavItems("bottom-nav", null).map((item) => item.href),
    ).toEqual([
      "/search",
      "/sign-in",
      "/register",
    ]);
    expect(html).toContain('href="/sign-in"');
    expect(html).toContain('href="/register"');
    expect(html).not.toContain('action="/sign-out"');
    expect(html).not.toContain('href="/account/inventory"');
    expect(html).not.toContain("Verified");
  });

  it("keeps signed-out guest cart access visible when cart has items", () => {
    mockUseRouteLoaderData.mockReturnValue({
      actor: null,
      cartCount: 2,
    });

    const html = renderToString(<MarketplaceLayoutRoute />);

    expect(
      resolveMarketplaceNavItems("top-nav", null, { cartCount: 2 }).map((item) => item.href),
    ).toEqual([
      "/search",
      "/sign-in",
      "/register",
      "/account/cart",
    ]);
    expect(
      resolveMarketplaceNavItems("top-nav", null, { cartCount: 2 }).find((item) => item.key === "cart")?.placement,
    ).toBe("utility");
    expect(html).toContain('href="/account/cart"');
    expect(html).toContain("Cart");
    expect(html).toContain("2");
    expect(html.indexOf('href="/register"')).toBeLessThan(
      html.indexOf('href="/account/cart"'),
    );
  });

  it("prompts signed-in users to add a passkey after fallback registration", () => {
    mockUseLocation.mockReturnValue({
      pathname: "/account",
      search: "?authPrompt=add-passkey",
    });
    mockUseRouteLoaderData.mockReturnValue({
      actor: { permissions: ["accounts.view"] },
    });

    const html = renderToString(<MarketplaceLayoutRoute />);

    expect(html).toContain("Add a passkey to secure your account");
    expect(html).toContain("Passkeys help protect your account");
  });
});
