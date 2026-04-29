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

  it("shows inventory access in the shell for signed-in actors", () => {
    mockUseLocation.mockReturnValue({
      pathname: "/account/listings",
      search: "",
    });
    mockUseRouteLoaderData.mockReturnValue({
      actor: {
        permissions: [
          "accounts.view",
          "fulfillment.view",
          "fulfillment.manage",
          "inventory.view",
          "listings.view",
          "offers.view",
          "reputation.view",
          "orders.view",
          "orders.manage",
        ],
      },
    });

    const html = renderToString(<MarketplaceLayoutRoute />);

    expect(
      resolveMarketplaceNavItems("top-nav", null).map((item) => item.href),
    ).toEqual([
      "/search",
      "/sign-in",
      "/register",
    ]);
    expect(html).toContain('href="/account/inventory"');
    expect(html).toContain('href="/account/cart"');
    expect(html).toContain('href="/account/listings"');
    expect(html).toContain('href="/account/market-offers"');
    expect(html).toContain('href="/account/offers"');
    expect(html).toContain('href="/account/shipments"');
    expect(html).toContain('href="/account/reputation"');
    expect(html).toContain('href="/account/orders"');
    expect(html).toContain('href="/account/fulfillment"');
    expect(html).toContain('href="/account/sales"');
    expect(html).toContain('href="/account"');
    expect(html).toContain('action="/sign-out"');
    expect(html).not.toContain("Verified");
    expect(html).not.toContain('href="/sign-in"');
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
