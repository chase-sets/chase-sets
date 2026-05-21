// @vitest-environment jsdom

import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { renderToString } from "react-dom/server";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { resolveMarketplaceAccountMenuItems, resolveMarketplaceNavItems } from "../host";

const { mockUseLocation, mockUseNavigate, mockUseRouteLoaderData } = vi.hoisted(() => ({
  mockUseLocation: vi.fn(),
  mockUseNavigate: vi.fn(),
  mockUseRouteLoaderData: vi.fn(),
}));

vi.mock("react-router", async () => {
  const actual = await vi.importActual<typeof import("react-router")>("react-router");

  return {
    ...actual,
    Outlet: () => <main>Marketplace content</main>,
    useLocation: mockUseLocation,
    useNavigate: () => mockUseNavigate,
    useRouteLoaderData: mockUseRouteLoaderData,
  };
});

import MarketplaceLayoutRoute from "./layout";

const actorDisplay = {
  account: {
    account_id: "acc_card_vault",
    display_name: "Card Vault",
    name: "Card Vault LLC",
    badges: [],
  },
  membership: {
    membership_id: "mbr_card_vault_alex",
    role_key: "manager",
  },
  user: {
    user_id: "usr_alex",
    display_name: "Alex Clerk",
    primary_email: "alex@example.com",
  },
};

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
      actorDisplay,
    });

    const html = renderToString(<MarketplaceLayoutRoute />);
    const topNav = resolveMarketplaceNavItems("top-nav", actor);
    const sellNav = topNav.find((item) => item.key === "selling-workspace");
    const accountMenuItems = resolveMarketplaceAccountMenuItems(actor);

    expect(resolveMarketplaceNavItems("top-nav", null).map((item) => item.href)).toEqual([
      "/search",
      "/sign-in",
      "/register",
    ]);
    expect(topNav.map((item) => item.label)).toEqual([
      "Browse",
      "Purchases",
      "Notifications",
      "Sell List",
      "Support",
      "Sell",
      "Buy Cart",
    ]);
    expect(sellNav?.children?.map((item) => item.label)).toEqual(["Listings", "Offer Matches", "Sales", "Shipping"]);
    expect(accountMenuItems.map((item) => item.label)).toEqual([
      "Account",
      "Wallet",
      "Payouts",
      "Submitted Offers",
      "Reviews",
    ]);
    expect(resolveMarketplaceNavItems("bottom-nav", actor).map((item) => item.label)).toEqual([
      "Browse",
      "Buy Cart",
      "Notifications",
      "Sell",
      "Wallet",
    ]);
    expect(html).not.toContain('href="/account/inventory"');
    expect(html).not.toContain('href="/account/inventory/imports"');
    expect(html).toContain('href="/account/cart"');
    expect(html).not.toContain('href="/account/product-alerts"');
    expect(html).not.toContain('href="/account/notifications"');
    expect(html).toContain('href="/account/support"');
    expect(html).toContain('href="/account/listings"');
    expect(html).toContain('href="/account/offers/matches"');
    expect(html).toContain('href="/account/settlement"');
    expect(html).toContain('href="/account/purchases"');
    expect(html).toContain('href="/account/sales"');
    expect(html).not.toContain('href="/account/shipments"');
    expect(html).toContain('action="/sign-out"');
    expect(html).toContain("Account menu");
    expect(html).toContain("Card Vault");
    expect(html).toContain("Manager");
    expect(html).not.toContain("Acting as");
    expect(html).not.toContain("Signed in as");
    expect(html).not.toContain("Verified");
    expect(html).not.toContain('href="/sign-in"');
  });

  it("opens a combined account menu with user context, account links, and sign out", async () => {
    const user = userEvent.setup({ document });
    const actor = {
      permissions: ["accounts.view", "offers.view", "orders.view", "orders.manage", "payouts.view", "reputation.view"],
    };
    mockUseRouteLoaderData.mockReturnValue({
      actor,
      actorDisplay,
    });

    render(<MarketplaceLayoutRoute />);

    await user.click(screen.getByRole("button", { name: "Account menu" }));

    expect(await screen.findByText("Alex Clerk")).toBeTruthy();
    expect(screen.getByRole("link", { name: "Account" }).getAttribute("href")).toBe("/account");
    expect(screen.getByRole("link", { name: "Wallet" }).getAttribute("href")).toBe("/account/settlement");
    expect(screen.getByRole("link", { name: "Payouts" }).getAttribute("href")).toBe("/account/payouts");
    expect(screen.getByRole("button", { name: "Sign Out" }).getAttribute("form")).toBe(
      "marketplace-account-menu-sign-out",
    );
    expect(screen.queryByText("Acting as")).toBeNull();
    expect(screen.queryByText("Signed in as")).toBeNull();
  });

  it("keeps account access for signed-in actors without selling workflow permissions", () => {
    const actor = {
      permissions: ["accounts.view", "offers.view", "orders.view", "orders.manage"],
    };

    const topNav = resolveMarketplaceNavItems("top-nav", actor);
    const accountNav = topNav.find((item) => item.key === "account");

    expect(topNav.map((item) => item.label)).toEqual(["Browse", "Purchases", "Notifications", "Sell List", "Buy Cart"]);
    expect(accountNav).toBeUndefined();
    expect(resolveMarketplaceAccountMenuItems(actor).map((item) => item.label)).toEqual([
      "Account",
      "Submitted Offers",
    ]);
    expect(resolveMarketplaceNavItems("bottom-nav", actor).map((item) => item.label)).toEqual([
      "Browse",
      "Buy Cart",
      "Purchases",
      "Notifications",
      "Account",
    ]);
  });

  it("keeps wallet discoverable through account navigation without selling workflow permissions", () => {
    const actor = {
      permissions: ["accounts.view", "orders.view", "orders.manage", "payouts.view"],
    };

    const accountMenuItems = resolveMarketplaceAccountMenuItems(actor);
    const bottomAccountNav = resolveMarketplaceNavItems("bottom-nav", actor).find((item) => item.key === "account");
    const bottomWalletNav = resolveMarketplaceNavItems("bottom-nav", actor).find((item) => item.key === "wallet");

    expect(accountMenuItems.map((item) => item.label)).toEqual(["Account", "Wallet", "Payouts"]);
    expect(bottomWalletNav?.href).toBe("/account/settlement");
    expect(bottomAccountNav?.children?.map((item) => item.label)).toEqual(["Account", "Wallet", "Payouts"]);
    expect(resolveMarketplaceNavItems("bottom-nav", actor).map((item) => item.label)).toEqual([
      "Browse",
      "Buy Cart",
      "Notifications",
      "Wallet",
      "Account",
    ]);
  });

  it("keeps cart access for signed-in buyers without order-management permissions", () => {
    const actor = {
      permissions: ["accounts.view"],
    };

    expect(resolveMarketplaceNavItems("top-nav", actor).map((item) => item.label)).toContain("Buy Cart");
    expect(resolveMarketplaceNavItems("bottom-nav", actor).map((item) => item.label)).toContain("Buy Cart");
  });

  it("keeps sign-in and registration entry points for signed-out actors", () => {
    mockUseRouteLoaderData.mockReturnValue({
      actor: null,
      cartCount: 0,
    });

    const html = renderToString(<MarketplaceLayoutRoute />);

    expect(resolveMarketplaceNavItems("bottom-nav", null).map((item) => item.href)).toEqual([
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

    expect(resolveMarketplaceNavItems("top-nav", null, { cartCount: 2 }).map((item) => item.href)).toEqual([
      "/search",
      "/sign-in",
      "/register",
      "/account/cart",
    ]);
    expect(
      resolveMarketplaceNavItems("top-nav", null, { cartCount: 2 }).find((item) => item.key === "cart")?.placement,
    ).toBe("utility");
    expect(html).toContain('href="/account/cart"');
    expect(html).toContain("Buy Cart");
    expect(html).toContain("2");
    expect(html.indexOf('href="/register"')).toBeLessThan(html.indexOf('href="/account/cart"'));
  });

  it("prompts signed-in users to add a passkey after fallback registration", () => {
    mockUseLocation.mockReturnValue({
      pathname: "/account",
      search: "?authPrompt=add-passkey",
    });
    mockUseRouteLoaderData.mockReturnValue({
      actor: { permissions: ["accounts.view"] },
      actorDisplay,
    });

    const html = renderToString(<MarketplaceLayoutRoute />);

    expect(html).toContain("Add a passkey to secure your account");
    expect(html).toContain("Passkeys help protect your account");
  });
});
