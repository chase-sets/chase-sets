// @vitest-environment jsdom

import { act, render as renderWithoutRouter, screen, waitFor, within, type RenderOptions } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { ComponentProps, ReactElement, ReactNode } from "react";
import { renderToString } from "react-dom/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { RouteConfigEntry } from "@react-router/dev/routes";
import type { RouteObject } from "react-router";
import { resolveMarketplaceAccountMenuItems, resolveMarketplaceNavItems } from "../host";

const { mockUseLocation, mockUseMatches, mockUseNavigate, mockUseRouteLoaderData, marketplaceShellRouteIdentities } =
  vi.hoisted(() => ({
    mockUseLocation: vi.fn(),
    mockUseMatches: vi.fn(),
    mockUseNavigate: vi.fn(),
    mockUseRouteLoaderData: vi.fn(),
    marketplaceShellRouteIdentities: [] as Array<string | undefined>,
  }));

vi.mock("react-router", async () => {
  const actual = await vi.importActual<typeof import("react-router")>("react-router");

  return {
    ...actual,
    Outlet: () => <main>Marketplace content</main>,
    useLocation: mockUseLocation,
    useMatches: mockUseMatches,
    useNavigate: () => mockUseNavigate,
    useRouteLoaderData: mockUseRouteLoaderData,
  };
});

// Transparent seam over the real MarketplaceShell: records the routeIdentity the
// layout actually passes on every render, so route-change emission is counted
// from an instrumented log at the boundary that emits it, never inferred from
// the rendered phase.
vi.mock("@chase-sets/design-system", async () => {
  const actual = await vi.importActual<typeof import("@chase-sets/design-system")>("@chase-sets/design-system");

  return {
    ...actual,
    MarketplaceShell: (props: ComponentProps<typeof actual.MarketplaceShell>) => {
      marketplaceShellRouteIdentities.push(props.routeIdentity);
      return <actual.MarketplaceShell {...props} />;
    },
  };
});

import { MemoryRouter } from "react-router";
import routesConfig from "../routes";
import MarketplaceLayoutRoute, { marketplaceSearchRouteId } from "./layout";

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
    mockUseMatches.mockReturnValue([]);
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
      "Seller Desk",
      "Sell List",
      "Money",
      "Support",
      "Sell",
      "Buy Cart",
    ]);
    expect(sellNav?.children?.map((item) => item.label)).toEqual([
      "Inventory",
      "Import",
      "Restock",
      "Listings",
      "Offer Matches",
      "Sales",
      "Shipping",
    ]);
    expect(sellNav?.children?.map((item) => item.href)).toEqual([
      "/account/inventory",
      "/account/inventory/imports",
      "/account/inventory/restock-decisions",
      "/account/listings",
      "/account/offers/matches",
      "/account/sales",
      "/account/sales/shipments",
    ]);
    expect(accountMenuItems.map((item) => item.label)).toEqual(["Account", "Submitted Offers", "Reviews"]);
    expect(resolveMarketplaceNavItems("bottom-nav", actor).map((item) => item.label)).toEqual([
      "Browse",
      "Buy Cart",
      "Alerts",
      "Sell",
      "Money",
    ]);
    expect(html).toContain('href="/account/inventory"');
    expect(html).toContain('href="/account/inventory/imports"');
    expect(html).toContain('href="/account/inventory/restock-decisions"');
    expect(html).toContain('href="/account/cart"');
    expect(html).not.toContain('href="/account/product-alerts"');
    expect(html).not.toContain('href="/account/notifications"');
    expect(html).toContain('href="/account/support"');
    expect(html).toContain('href="/account/listings"');
    expect(html).toContain('href="/account/offers/matches"');
    expect(html).toContain('href="/account/desk/money"');
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
    expect(within(accountMenu).getByRole("menuitem", { name: "Submitted Offers" }).getAttribute("href")).toBe(
      "/account/offers/submitted",
    );
    expect(within(accountMenu).getByRole("menuitem", { name: "Reviews" }).getAttribute("href")).toBe(
      "/account/reviews",
    );
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
      "Alerts",
      "Account",
    ]);
  });

  it("keeps inventory workflows permission-scoped inside seller navigation", () => {
    const actor = {
      permissions: ["accounts.view", "listings.view", "offers.view", "orders.view", "orders.manage"],
    };

    const sellNav = resolveMarketplaceNavItems("top-nav", actor).find((item) => item.key === "selling-workspace");

    expect(sellNav?.children?.map((item) => item.label)).toEqual(["Listings", "Offer Matches", "Sales"]);
    expect(sellNav?.children?.map((item) => item.href)).not.toContain("/account/inventory");
    expect(sellNav?.children?.map((item) => item.href)).not.toContain("/account/inventory/imports");
  });

  it("keeps money discoverable outside the account menu without selling workflow permissions", () => {
    const actor = {
      permissions: ["accounts.view", "orders.view", "orders.manage", "payouts.view"],
    };

    const accountMenuItems = resolveMarketplaceAccountMenuItems(actor);
    const bottomAccountNav = resolveMarketplaceNavItems("bottom-nav", actor).find((item) => item.key === "account");
    const bottomMoneyNav = resolveMarketplaceNavItems("bottom-nav", actor).find((item) => item.key === "money");

    expect(accountMenuItems.map((item) => item.label)).toEqual(["Account"]);
    expect(bottomMoneyNav?.href).toBe("/account/desk/money");
    expect(bottomAccountNav?.children?.map((item) => item.label)).toEqual(["Account"]);
    expect(resolveMarketplaceNavItems("bottom-nav", actor).map((item) => item.label)).toEqual([
      "Browse",
      "Buy Cart",
      "Alerts",
      "Money",
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

describe("marketplace search-row route identity", () => {
  const itemPath = "/items/charizard-base-set-4-102-holo-rare-seed-charizard-base-set-xsr3yp";

  function setWindowMetric(name: "innerWidth" | "scrollY", value: number) {
    Object.defineProperty(window, name, { configurable: true, writable: true, value });
  }

  function driveScroll(to: number) {
    setWindowMetric("scrollY", to);
    act(() => {
      window.dispatchEvent(new Event("scroll"));
    });
  }

  function routeEntryId(entry: RouteConfigEntry): string {
    return entry.id ?? entry.file.replace(/\.[jt]sx?$/, "");
  }

  // The marketplace route tree assembled from the exact registration routes.ts
  // exports, with framework-mode id derivation for entries that do not pin one.
  function toDataRoutes(entries: readonly RouteConfigEntry[]): RouteObject[] {
    return entries.map((entry): RouteObject => {
      const id = routeEntryId(entry);
      const Component = entry.file === "routes/layout.tsx" ? MarketplaceLayoutRoute : () => null;
      if (entry.index) {
        return { id, index: true, Component };
      }
      return {
        id,
        path: entry.path,
        caseSensitive: entry.caseSensitive,
        Component,
        children: entry.children ? toDataRoutes(entry.children) : undefined,
      };
    });
  }

  function collectRoutes(routes: readonly RouteObject[]): RouteObject[] {
    return routes.flatMap((route) => [route, ...(route.children ? collectRoutes(route.children) : [])]);
  }

  function identityChangeCount(log: ReadonlyArray<string | undefined>): number {
    let changes = 0;
    for (let index = 1; index < log.length; index += 1) {
      if (log[index] !== log[index - 1]) {
        changes += 1;
      }
    }
    return changes;
  }

  function shellOuter(container: HTMLElement) {
    const outer = container.querySelector('div[class*="--shell-header-height"]');
    expect(outer).not.toBeNull();
    return outer!;
  }

  async function useRealRouterHooks() {
    const actual = await vi.importActual<typeof import("react-router")>("react-router");
    mockUseLocation.mockImplementation(actual.useLocation);
    mockUseMatches.mockImplementation(actual.useMatches);
    mockUseRouteLoaderData.mockReturnValue({ actor: null, cartCount: 0 });
    return actual;
  }

  it("derives canonical search identity from the active matched route for every registered alias", async () => {
    const actual = await useRealRouterHooks();
    setWindowMetric("innerWidth", 390);
    const dataRoutes = toDataRoutes(routesConfig);

    // The layout's search-route-id constant is the id the route configuration
    // actually registers, so a rename fails here rather than silently
    // reverting every alias to collapsible.
    const registeredSearchRoutes = collectRoutes(dataRoutes).filter((route) => route.path === "search");
    expect(registeredSearchRoutes).toHaveLength(1);
    expect(registeredSearchRoutes[0]!.id).toBe(marketplaceSearchRouteId);

    const table = [
      { input: "/search", leaf: marketplaceSearchRouteId, identity: "/search", phase: "expanded" },
      { input: "/SEARCH", leaf: marketplaceSearchRouteId, identity: "/search", phase: "expanded" },
      { input: "/Search", leaf: marketplaceSearchRouteId, identity: "/search", phase: "expanded" },
      { input: "/search/", leaf: marketplaceSearchRouteId, identity: "/search", phase: "expanded" },
      { input: "/search//", leaf: marketplaceSearchRouteId, identity: "/search", phase: "expanded" },
      { input: "/%73earch", leaf: marketplaceSearchRouteId, identity: "/search", phase: "expanded" },
      { input: "/search/x", leaf: "routes/not-found", identity: "/search/x", phase: "collapsed" },
      { input: "/search%2Fx", leaf: "routes/not-found", identity: "/search%2Fx", phase: "collapsed" },
    ] as const;

    for (const row of table) {
      // Matcher level: raw spelling is not identity; the active match is.
      const matched = actual.matchRoutes(dataRoutes, row.input);
      expect(matched, `match ${row.input}`).not.toBeNull();
      expect(matched!.at(-1)!.route.id, `leaf for ${row.input}`).toBe(row.leaf);

      // Rendered layout: the emitted identity plus the resolved phase under the
      // armed high-scroll unfocused environment.
      marketplaceShellRouteIdentities.length = 0;
      setWindowMetric("scrollY", 2000);
      const router = actual.createMemoryRouter(dataRoutes, { initialEntries: [row.input] });
      const view = renderWithoutRouter(<actual.RouterProvider router={router} />);
      expect(marketplaceShellRouteIdentities.at(-1), `identity for ${row.input}`).toBe(row.identity);
      expect(shellOuter(view.container).getAttribute("data-search-row-state"), `phase for ${row.input}`).toBe(
        row.phase,
      );
      view.unmount();
    }
  });

  it("emits no route change for a same-pathname query or dimension navigation", async () => {
    const actual = await useRealRouterHooks();
    setWindowMetric("innerWidth", 390);
    const dataRoutes = toDataRoutes(routesConfig);

    // A dimension.* commit on the pinned collapsible item route, first driven
    // to expanded by 24px of upward travel so a re-initialization would be
    // observable as a phase change.
    marketplaceShellRouteIdentities.length = 0;
    setWindowMetric("scrollY", 2000);
    const router = actual.createMemoryRouter(dataRoutes, { initialEntries: [itemPath] });
    const view = renderWithoutRouter(<actual.RouterProvider router={router} />);
    const outer = shellOuter(view.container);
    expect(outer.getAttribute("data-search-row-state")).toBe("collapsed");
    driveScroll(1976);
    expect(outer.getAttribute("data-search-row-state")).toBe("expanded");

    const changesBefore = identityChangeCount(marketplaceShellRouteIdentities);
    await act(async () => {
      await router.navigate(`${itemPath}?dimension.condition=raw`);
    });
    expect(router.state.location.pathname).toBe(itemPath);
    expect(router.state.location.search).toBe("?dimension.condition=raw");
    expect(identityChangeCount(marketplaceShellRouteIdentities)).toBe(changesBefore);
    expect(outer.getAttribute("data-search-row-state")).toBe("expanded");
    view.unmount();

    // Separately: a debounced ?q= commit on /search changes only
    // location.search and emits nothing.
    marketplaceShellRouteIdentities.length = 0;
    setWindowMetric("scrollY", 2000);
    const searchRouter = actual.createMemoryRouter(dataRoutes, { initialEntries: ["/search?q=charizard"] });
    const searchView = renderWithoutRouter(<actual.RouterProvider router={searchRouter} />);
    const searchOuter = shellOuter(searchView.container);
    expect(searchOuter.getAttribute("data-search-row-state")).toBe("expanded");
    const searchChangesBefore = identityChangeCount(marketplaceShellRouteIdentities);
    await act(async () => {
      await searchRouter.navigate("/search?q=pikachu", { replace: true });
    });
    expect(searchRouter.state.location.search).toBe("?q=pikachu");
    expect(identityChangeCount(marketplaceShellRouteIdentities)).toBe(searchChangesBefore);
    expect(searchOuter.getAttribute("data-search-row-state")).toBe("expanded");
    searchView.unmount();
  });
});
