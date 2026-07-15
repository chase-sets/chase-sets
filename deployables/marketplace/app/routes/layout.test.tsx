// @vitest-environment jsdom

import { render as renderWithoutRouter, screen, waitFor, within, type RenderOptions } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { ReactElement, ReactNode } from "react";
import { renderToString } from "react-dom/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
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

import { MemoryRouter } from "react-router";
import MarketplaceLayoutRoute, { loader } from "./layout";

// DiscoveryShellLayout registers the DS RouterLinkAdapter, so rendering it requires
// router context — exactly as it has in the production app tree.
function ssr(ui: ReactElement) {
  return renderToString(<MemoryRouter>{ui}</MemoryRouter>);
}

function render(ui: ReactNode, options?: RenderOptions) {
  return renderWithoutRouter(ui, { wrapper: MemoryRouter, ...options });
}

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
    document.documentElement.removeAttribute("data-theme");
    document.documentElement.removeAttribute("data-theme-preference");
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("redirects legacy seller links before mounting their old route modules", () => {
    const cases = [
      ["https://marketplace.test/account/inventory/items/item-9", "/account/desk/inventory/item-9"],
      ["https://marketplace.test/account/listings/listing-7", "/account/desk/listings/listing-7"],
      ["https://marketplace.test/account/sales/shipments", "/account/desk/shipments"],
      ["https://marketplace.test/account/payouts?status=blocked", "/account/desk/money?status=blocked&view=payouts"],
      ["https://marketplace.test/account/sell-list", "/account/desk/offers"],
    ] as const;

    for (const [href, expected] of cases) {
      const response = loader({ request: new Request(href) } as never) as Response;
      expect(response.status).toBe(302);
      expect(response.headers.get("Location")).toBe(expected);
    }
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

    const html = ssr(<MarketplaceLayoutRoute />);
    const topNav = resolveMarketplaceNavItems("top-nav", actor);
    const sellerDeskNav = topNav.find((item) => item.key === "seller-desk");
    const accountMenuItems = resolveMarketplaceAccountMenuItems(actor);

    expect(resolveMarketplaceNavItems("top-nav", null).map((item) => item.href)).toEqual([
      "/search",
      "/sign-in",
      "/register",
    ]);
    expect(topNav.map((item) => item.label)).toEqual([
      "Browse",
      "Seller Desk",
      "Purchases",
      "Notifications",
      "Support",
      "Buy Cart",
    ]);
    expect(sellerDeskNav?.href).toBe("/account/desk");
    expect(sellerDeskNav?.children).toBeUndefined();
    expect(accountMenuItems.map((item) => item.label)).toEqual(["Account", "Submitted Offers", "Reviews"]);
    expect(resolveMarketplaceNavItems("bottom-nav", actor).map((item) => item.label)).toEqual([
      "Browse",
      "Seller Desk",
      "Buy Cart",
      "Alerts",
      "Account",
    ]);
    expect(html).toContain('href="/account/desk"');
    expect(html).not.toContain('href="/account/inventory"');
    expect(html).not.toContain('href="/account/inventory/imports"');
    expect(html).not.toContain('href="/account/inventory/restock-decisions"');
    expect(html).toContain('href="/account/cart"');
    expect(html).not.toContain('href="/account/product-alerts"');
    expect(html).not.toContain('href="/account/notifications"');
    expect(html).toContain('href="/account/support"');
    expect(html).not.toContain('href="/account/listings"');
    expect(html).not.toContain('href="/account/offers/matches"');
    expect(html).not.toContain('href="/account/settlement"');
    expect(html).toContain('href="/account/purchases"');
    expect(html).not.toContain('href="/account/sales"');
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

  it("opens a combined account menu with user context, theme controls, account links, and sign out", async () => {
    const user = userEvent.setup({ document });
    const fetch = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const request = input instanceof Request ? input : null;
      const url = new URL(input instanceof Request ? input.url : String(input), "http://localhost");
      if (url.pathname === "/api/identity/preferences") {
        expect(init?.method ?? request?.method).toBe("PUT");
        expect(JSON.parse(String(init?.body ?? (request ? await request.clone().text() : "")))).toEqual({
          colorMode: "dark",
        });
        return Response.json({
          preferences: {
            colorMode: "dark",
          },
        });
      }

      return Response.json({});
    });
    const actor = {
      permissions: ["accounts.view", "offers.view", "orders.view", "orders.manage", "payouts.view", "reputation.view"],
    };
    vi.stubGlobal("fetch", fetch);
    mockUseRouteLoaderData.mockReturnValue({
      actor,
      actorDisplay,
      colorMode: "system",
      viewer: {
        actor,
        preferences: { colorMode: "system", reducedMotion: "user" },
      },
    });

    render(<MarketplaceLayoutRoute />);

    await user.click(screen.getByRole("button", { name: "Account menu" }));

    const accountMenu = await screen.findByRole("menu", { name: "Account menu" });

    expect(within(accountMenu).getByText("Alex Clerk")).toBeTruthy();
    expect(within(accountMenu).getByRole("menuitem", { name: "Account" }).getAttribute("href")).toBe("/account");
    expect(within(accountMenu).queryByRole("menuitem", { name: "Wallet" })).toBeNull();
    expect(within(accountMenu).queryByRole("menuitem", { name: "Payouts" })).toBeNull();
    expect(within(accountMenu).getByRole("group", { name: "Color theme" })).toBeTruthy();
    expect(within(accountMenu).getByRole("radio", { name: "System" })).toBeTruthy();
    await user.click(within(accountMenu).getByRole("radio", { name: "Dark" }));
    await waitFor(() => expect(fetch).toHaveBeenCalledTimes(1));
    expect(document.querySelector('[data-color-mode="dark"]')).toBeTruthy();
    expect(within(accountMenu).getByRole("menuitem", { name: "Sign Out" }).getAttribute("form")).toBe(
      "marketplace-account-menu-sign-out",
    );
    const signOutForm = document.getElementById("marketplace-account-menu-sign-out");
    expect(signOutForm?.tagName).toBe("FORM");
    expect(signOutForm?.getAttribute("method")).toBe("post");
    expect(signOutForm?.getAttribute("action")).toBe("/sign-out");
    expect(screen.queryByText("Acting as")).toBeNull();
    expect(screen.queryByText("Signed in as")).toBeNull();
  });

  it("keeps account access for signed-in actors without selling workflow permissions", () => {
    const actor = {
      permissions: ["accounts.view", "offers.view", "orders.view", "orders.manage"],
    };

    const topNav = resolveMarketplaceNavItems("top-nav", actor);
    const accountNav = topNav.find((item) => item.key === "account");

    expect(topNav.map((item) => item.label)).toEqual([
      "Browse",
      "Seller Desk",
      "Purchases",
      "Notifications",
      "Buy Cart",
    ]);
    expect(accountNav).toBeUndefined();
    expect(resolveMarketplaceAccountMenuItems(actor).map((item) => item.label)).toEqual([
      "Account",
      "Submitted Offers",
    ]);
    expect(resolveMarketplaceNavItems("bottom-nav", actor).map((item) => item.label)).toEqual([
      "Browse",
      "Seller Desk",
      "Buy Cart",
      "Alerts",
      "Account",
    ]);
  });

  it("replaces legacy seller navigation with the single Seller Desk entry", () => {
    const actor = {
      permissions: ["accounts.view", "listings.view", "offers.view", "orders.view", "orders.manage"],
    };

    const topNav = resolveMarketplaceNavItems("top-nav", actor);

    expect(topNav.filter((item) => item.key === "seller-desk")).toHaveLength(1);
    expect(topNav.find((item) => item.key === "seller-desk")?.href).toBe("/account/desk");
    expect(topNav.find((item) => item.key === "selling-workspace")).toBeUndefined();
  });

  it("routes payout-only accounts through Seller Desk instead of legacy wallet navigation", () => {
    const actor = {
      permissions: ["accounts.view", "orders.view", "orders.manage", "payouts.view"],
    };

    const accountMenuItems = resolveMarketplaceAccountMenuItems(actor);
    const bottomAccountNav = resolveMarketplaceNavItems("bottom-nav", actor).find((item) => item.key === "account");
    const sellerDeskNav = resolveMarketplaceNavItems("bottom-nav", actor).find((item) => item.key === "seller-desk");

    expect(accountMenuItems.map((item) => item.label)).toEqual(["Account"]);
    expect(sellerDeskNav?.href).toBe("/account/desk");
    expect(bottomAccountNav?.children?.map((item) => item.label)).toEqual(["Account"]);
    expect(resolveMarketplaceNavItems("bottom-nav", actor).map((item) => item.label)).toEqual([
      "Browse",
      "Seller Desk",
      "Buy Cart",
      "Alerts",
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

    const html = ssr(<MarketplaceLayoutRoute />);

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

  it("applies the root color mode on first paint", () => {
    mockUseRouteLoaderData.mockReturnValue({
      actor: null,
      cartCount: 0,
      colorMode: "dark",
    });

    const html = ssr(<MarketplaceLayoutRoute />);

    expect(html).toContain('data-color-mode="dark"');
  });

  it("honors the Identity reduced-motion preference at the shell root", () => {
    mockUseRouteLoaderData.mockReturnValue({
      actor: { permissions: ["accounts.view"] },
      cartCount: 0,
      colorMode: "dark",
      viewer: {
        preferences: {
          colorMode: "dark",
          reducedMotion: "always",
        },
      },
    });

    const html = ssr(<MarketplaceLayoutRoute />);

    expect(html).toContain('data-color-mode="dark"');
    expect(html).toContain('data-reduced-motion="true"');
  });

  it("keeps signed-out guest cart access visible when cart has items", () => {
    mockUseRouteLoaderData.mockReturnValue({
      actor: null,
      cartCount: 2,
    });

    const html = ssr(<MarketplaceLayoutRoute />);

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

  it("renders guest checkout actors without account-only shell chrome", () => {
    const actor = {
      roleKey: "guest-buyer",
      permissions: ["guest-checkout.manage"],
    };
    mockUseRouteLoaderData.mockReturnValue({
      actor,
      actorDisplay,
      cartCount: 2,
    });

    const html = ssr(<MarketplaceLayoutRoute />);

    expect(resolveMarketplaceNavItems("top-nav", actor, { cartCount: 2 }).map((item) => item.href)).toEqual([
      "/search",
      "/account/cart",
    ]);
    expect(resolveMarketplaceNavItems("bottom-nav", actor, { cartCount: 2 }).map((item) => item.href)).toEqual([
      "/search",
      "/account/cart",
    ]);
    expect(resolveMarketplaceNavItems("top-nav", actor, { cartCount: 0 }).map((item) => item.href)).toEqual([
      "/search",
      "/account/cart",
    ]);
    expect(resolveMarketplaceAccountMenuItems(actor)).toEqual([]);
    expect(html).toContain('action="/guest-checkout/exit"');
    expect(html).toContain("Exit guest checkout");
    expect(html).not.toContain('action="/sign-out"');
    expect(html).not.toContain("Account menu");
    expect(html).not.toContain("Card Vault");
    expect(html).not.toContain("Notifications");
    expect(html).not.toContain('href="/sign-in"');
    expect(html).not.toContain('href="/register"');
    expect(html).not.toContain('href="/account/listings"');
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

    const html = ssr(<MarketplaceLayoutRoute />);

    expect(html).toContain("Add a passkey to secure your account");
    expect(html).toContain("Passkeys help protect your account");
  });

  it("keeps guest checkout exit as a post form after migration", () => {
    const actor = {
      roleKey: "guest-buyer",
      permissions: ["guest-checkout.manage"],
    };
    mockUseRouteLoaderData.mockReturnValue({
      actor,
      actorDisplay,
      cartCount: 2,
    });

    render(<MarketplaceLayoutRoute />);

    const exitButton = screen.getByRole("button", { name: "Exit guest checkout" });
    const form = exitButton.closest("form");

    expect(form?.getAttribute("method")).toBe("post");
    expect(form?.getAttribute("action")).toBe("/guest-checkout/exit");
  });
});
