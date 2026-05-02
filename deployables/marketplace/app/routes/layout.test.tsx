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
      "Cart",
      "Purchases",
      "Sell",
      "Account",
    ]);
    expect(sellNav?.children?.map((item) => item.label)).toEqual([
      "Inventory",
      "Listings",
      "Offer Matches",
      "Sales",
      "Shipping",
      "Reviews",
      "Payouts",
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
      "Sell",
    ]);
    expect(html).toContain('href="/account/inventory"');
    expect(html).toContain('href="/account/cart"');
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
      "Cart",
      "Purchases",
      "Account",
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
});
