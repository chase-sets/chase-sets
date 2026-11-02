// @vitest-environment jsdom

import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { isDeepStrictEqual } from "node:util";
import {
  act,
  render as renderWithoutRouter,
  screen,
  waitFor,
  within,
  type RenderOptions,
} from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { ComponentProps, ReactElement, ReactNode } from "react";
import { renderToString } from "react-dom/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AccountMenuItem, NavigationItem } from "@chase-sets/design-system";
import { DiscoveryShellLayout } from "@chase-sets/discovery/web";
import { resolveWebHostActiveKey } from "@chase-sets/platform-runtime/web";
import { toRouteConfigEntry } from "@chase-sets/platform-runtime/web-route-config";
import { webContextRegistry } from "../context-registry";
import {
  resolveMarketplaceAccountMenuItems,
  resolveMarketplaceActiveKey,
  resolveMarketplaceNavItems,
  resolveMarketplaceRouteConfigRecords,
} from "../host";

const preferenceDefaults = { density: "comfortable", reducedMotion: "user", locale: "en", timeZone: "UTC" };

const {
  mockUseLocation,
  mockUseMatches,
  mockUseNavigate,
  mockUseRouteLoaderData,
  marketplaceShellRouteIdentities,
  realRouterMode,
} = vi.hoisted(() => ({
  mockUseLocation: vi.fn(),
  mockUseMatches: vi.fn(),
  mockUseNavigate: vi.fn(),
  mockUseRouteLoaderData: vi.fn(),
  marketplaceShellRouteIdentities: [] as Array<string | undefined>,
  realRouterMode: { enabled: false },
}));

vi.mock("react-router", async () => {
  const actual = await vi.importActual<typeof import("react-router")>("react-router");

  return {
    ...actual,
    Outlet: (props: Parameters<typeof actual.Outlet>[0]) =>
      realRouterMode.enabled ? <actual.Outlet {...props} /> : <main>Marketplace content</main>,
    useLocation: (...args: Parameters<typeof actual.useLocation>) =>
      realRouterMode.enabled ? actual.useLocation(...args) : mockUseLocation(),
    useMatches: (...args: Parameters<typeof actual.useMatches>) =>
      realRouterMode.enabled ? actual.useMatches(...args) : mockUseMatches(),
    useNavigate: (...args: Parameters<typeof actual.useNavigate>) =>
      realRouterMode.enabled ? actual.useNavigate(...args) : () => mockUseNavigate(),
    useRouteLoaderData: (...args: Parameters<typeof actual.useRouteLoaderData>) =>
      realRouterMode.enabled ? actual.useRouteLoaderData(...args) : mockUseRouteLoaderData(),
  };
});

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

import { createMemoryRouter, MemoryRouter, RouterProvider } from "react-router";
import { index as routeIndex, route as routeConfig } from "@react-router/dev/routes";
import MarketplaceLayoutRoute, { loader, marketplaceSearchRouteId } from "./layout";
import {
  observeSearchRowEvents,
  type SearchRowObservation,
} from "../../../../packages/design-system/src/patterns/app-shells/search-row-phase";

// DiscoveryShellLayout registers the DS RouterLinkAdapter, so rendering it requires
// router context — exactly as it has in the production app tree.
function ssr(ui: ReactElement) {
  return renderToString(<MemoryRouter>{ui}</MemoryRouter>);
}

function render(ui: ReactNode, options?: RenderOptions) {
  return renderWithoutRouter(ui, { wrapper: MemoryRouter, ...options });
}

function renderWithRealRouter(initialEntry: string) {
  realRouterMode.enabled = true;
  const searchRouteRecord = resolveMarketplaceRouteConfigRecords().find((record) => record.routeId === "search");
  expect(searchRouteRecord).toBeDefined();
  const registeredSearchRoute = toRouteConfigEntry(searchRouteRecord!, {
    index: routeIndex,
    route: routeConfig,
  });
  expect(registeredSearchRoute.id).toBe(marketplaceSearchRouteId);
  const router = createMemoryRouter(
    [
      {
        id: "root",
        path: "/",
        loader: () => ({ actor: null, cartCount: 0 }),
        element: <MarketplaceLayoutRoute />,
        children: [
          {
            id: registeredSearchRoute.id,
            path: registeredSearchRoute.path,
            element: <div>Search route</div>,
          },
          { id: "routes/not-found", path: "*", element: <div>Not found route</div> },
        ],
      },
    ],
    { initialEntries: [initialEntry] },
  );
  const view = renderWithoutRouter(<RouterProvider router={router} />);
  return { router, view };
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
  it.each([
    [400, null, "Preferences were not sent"],
    [401, null, "Sign in to confirm preferences"],
    [403, null, "Sign in to confirm preferences"],
    [409, null, "Preferences changed"],
    [503, "light", "Preferences changed"],
    [503, "dark", "Preferences saved"],
    [503, null, "Preferences could not be confirmed"],
    [503, "invalid", "Preferences could not be confirmed"],
  ] as const)(
    "marketplace-preference-recovery-route-states PUT %s authority %s",
    async (status, authority, heading) => {
      const root = {
        actor: { userId: "usr_alex", permissions: [] },
        actorDisplay,
        viewer: { preferences: { colorMode: "system" } },
      };
      mockUseRouteLoaderData.mockReturnValue(root);
      const methods: string[] = [];
      let dispatch!: (response: Response) => void;
      let confirm!: (response: Response) => void;
      const pending = new Promise<Response>((resolve) => {
        dispatch = resolve;
      });
      const checking = new Promise<Response>((resolve) => {
        confirm = resolve;
      });
      vi.stubGlobal(
        "fetch",
        vi.fn(async (_input, init) => {
          methods.push(init.method);
          return init.method === "PUT" ? pending : checking;
        }),
      );
      const view = render(<MarketplaceLayoutRoute />);
      const user = userEvent.setup({ document });
      await user.click(screen.getByRole("button", { name: "Account menu" }));
      expect(screen.queryByRole("status")).toBeNull();
      await user.click(screen.getByRole("radio", { name: "Dark" }));
      expect(screen.getByRole("heading", { name: "Saving preferences" })).toBeTruthy();
      expect(screen.getByRole("radio", { name: "Dark" }).matches(":disabled")).toBe(true);
      dispatch(
        Response.json({ preferences: { userId: "usr_alex", colorMode: "light", ...preferenceDefaults } }, { status }),
      );
      if (status === 503) {
        await screen.findByRole("heading", { name: "Checking preferences" });
        expect(screen.getByRole("radio", { name: "Dark" }).matches(":disabled")).toBe(true);
        confirm(
          authority === null
            ? Response.json({}, { status: 503 })
            : Response.json(
                authority === "invalid" ? {} : { userId: "usr_alex", colorMode: authority, ...preferenceDefaults },
              ),
        );
      }
      const result = await screen.findByRole("heading", { name: heading });
      expect(document.activeElement).toBe(result);
      const announcement = result.closest('[role="status"]');
      expect(announcement?.getAttribute("aria-live")).toBe("polite");
      expect(screen.getByRole("radio", { name: "Dark" }).matches(":disabled")).toBe(false);
      expect(methods).toEqual(status === 503 ? ["PUT", "GET"] : ["PUT"]);
      if (heading !== "Preferences saved")
        expect(screen.queryByRole("heading", { name: "Preferences saved" })).toBeNull();
      if (heading === "Preferences could not be confirmed") {
        mockUseRouteLoaderData.mockReturnValue({
          ...root,
          colorMode: "dark",
          viewer: { preferences: { colorMode: "dark" } },
        });
        view.rerender(<MarketplaceLayoutRoute />);
        expect(screen.getByRole("heading", { name: heading })).toBeTruthy();
        expect(screen.queryByRole("heading", { name: "Preferences saved" })).toBeNull();
        expect(methods).toEqual(["PUT", "GET"]);
      }
    },
  );
  it("marketplace-preference-recovery-route-states", async () => {
    mockUseRouteLoaderData.mockReturnValue({
      actor: { userId: "usr_alex", permissions: [] },
      actorDisplay,
      viewer: { preferences: { colorMode: "system" } },
    });
    const fetch = vi
      .fn()
      .mockResolvedValueOnce(Response.json({}, { status: 503 }))
      .mockResolvedValueOnce(Response.json({ userId: "usr_alex", colorMode: "dark", ...preferenceDefaults }));
    vi.stubGlobal("fetch", fetch);
    render(<MarketplaceLayoutRoute />);
    const user = userEvent.setup({ document });
    await user.click(screen.getByRole("button", { name: "Account menu" }));
    await user.click(screen.getByRole("radio", { name: "Dark" }));
    await waitFor(() => expect(screen.getByRole("heading", { name: "Preferences saved" })).toBeTruthy());
    expect(fetch.mock.calls.map(([, init]) => init.method)).toEqual(["PUT", "GET"]);
    expect(document.activeElement).toBe(screen.getByRole("heading", { name: "Preferences saved" }));
  });
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
    realRouterMode.enabled = false;
    vi.unstubAllGlobals();
  });

  describe("buyer-account-destinations", () => {
    const destinations = [
      { key: "payment-methods", label: "Payment methods", href: "/account/payment-methods" },
      { key: "security", label: "Security", href: "/account/security" },
      { key: "consents", label: "Consent History", href: "/account/consents" },
    ];

    it.each([true, false])("opens authenticated destinations with security.manage=%s", async (canManageSecurity) => {
      const user = userEvent.setup({ document });
      const actor = { roleKey: "buyer", permissions: canManageSecurity ? ["security.manage"] : [] };
      mockUseRouteLoaderData.mockReturnValue({
        actor,
        actorDisplay: { ...actorDisplay, membership: { ...actorDisplay.membership, role_key: "buyer" } },
      });

      const items = resolveMarketplaceAccountMenuItems(actor);
      render(<MarketplaceLayoutRoute />);
      await user.click(screen.getByRole("button", { name: "Account menu" }));
      const menu = await screen.findByRole("menu", { name: "Account menu" });

      for (const destination of destinations) {
        if (destination.key === "security" && !canManageSecurity) {
          expect(items.some((item) => item.href === destination.href)).toBe(false);
          expect(within(menu).queryByRole("menuitem", { name: destination.label })).toBeNull();
          continue;
        }
        expect(items.filter((item) => item.href === destination.href)).toEqual([expect.objectContaining(destination)]);
        const links = within(menu).getAllByRole("menuitem", { name: destination.label });
        expect(links).toHaveLength(1);
        expect(links[0].tagName).toBe("A");
        expect(links[0].getAttribute("href")).toBe(destination.href);
      }
      expect(within(menu).getByRole("group", { name: "Color theme" })).toBeTruthy();
      expect(within(menu).getByRole("menuitem", { name: "Sign Out" })).toBeTruthy();
    });

    it.each([
      { name: "signed-out", actor: null },
      { name: "guest-buyer", actor: { roleKey: "guest-buyer", permissions: ["guest-checkout.manage"] } },
    ])("excludes destinations for $name actors", ({ actor }) => {
      mockUseRouteLoaderData.mockReturnValue({ actor, actorDisplay });

      expect(resolveMarketplaceAccountMenuItems(actor)).toEqual([]);
      const { container } = render(<MarketplaceLayoutRoute />);

      expect(screen.queryByRole("button", { name: "Account menu" })).toBeNull();
      for (const { href } of destinations) {
        expect(container.querySelector(`a[href="${href}"]`)).toBeNull();
      }
    });
  });

  describe("seller-money-navigation", () => {
    it.each(["top-nav", "bottom-nav"] as const)("preserves money identity and permission gating in %s", (slot) => {
      const actor = { permissions: ["accounts.view", "orders.view", "orders.manage", "payouts.view"] };
      const withoutPayouts = { permissions: actor.permissions.filter((permission) => permission !== "payouts.view") };

      expect(resolveMarketplaceNavItems(slot, actor).filter((item) => item.key === "money")).toEqual([
        expect.objectContaining({ key: "money", label: "Seller money", href: "/account/desk/money" }),
      ]);
      const hiddenItems = resolveMarketplaceNavItems(slot, withoutPayouts);
      expect(hiddenItems.some((item) => item.key === "money" || item.href === "/account/desk/money")).toBe(false);
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
      "Seller money",
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
    expect(accountMenuItems.map((item) => item.label)).toEqual([
      "Account",
      "Payment methods",
      "Consent History",
      "Submitted Offers",
      "Reviews",
    ]);
    expect(resolveMarketplaceNavItems("bottom-nav", actor).map((item) => item.label)).toEqual([
      "Browse",
      "Buy Cart",
      "Alerts",
      "Sell",
      "Seller money",
    ]);
    expect(html).toContain('href="/account/inventory"');
    expect(html).toContain('href="/account/inventory/imports"');
    expect(html).toContain('href="/account/inventory/restock-decisions"');
    expect(html).toContain('href="/account/cart"');
    expect(html).not.toContain('href="/account/product-alerts"');
    expect(html).toContain('href="/account/notifications"');
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

  it.each(["desktop", "mobile"] as const)(
    "opens the %s account menu with user context, theme controls, account links, and sign out",
    async (viewport) => {
      vi.stubGlobal(
        "matchMedia",
        vi.fn((query: string) => ({
          matches: viewport === "desktop" && query.includes("min-width"),
          media: query,
          addEventListener: vi.fn(),
          removeEventListener: vi.fn(),
        })),
      );
      const linkRole = viewport === "desktop" ? "menuitem" : "link";
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
              ...preferenceDefaults,
              userId: "usr_alex",
              colorMode: "dark",
            },
          });
        }

        return Response.json({});
      });
      const actor = {
        userId: "usr_alex",
        permissions: [
          "accounts.view",
          "offers.view",
          "orders.view",
          "orders.manage",
          "payouts.view",
          "reputation.view",
          "security.manage",
        ],
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

      const accountMenu = await screen.findByRole(viewport === "desktop" ? "menu" : "dialog", { name: "Account menu" });

      expect(within(accountMenu).getByText("Alex Clerk")).toBeTruthy();
      expect(within(accountMenu).getByRole(linkRole, { name: "Account" }).getAttribute("href")).toBe("/account");
      expect(within(accountMenu).getByRole(linkRole, { name: "Submitted Offers" }).getAttribute("href")).toBe(
        "/account/offers/submitted",
      );
      expect(within(accountMenu).getByRole(linkRole, { name: "Reviews" }).getAttribute("href")).toBe(
        "/account/reviews",
      );
      for (const [label, href] of [
        ["Payment methods", "/account/payment-methods"],
        ["Security", "/account/security"],
        ["Consent History", "/account/consents"],
      ]) {
        const links = within(accountMenu).getAllByRole(linkRole, { name: label });
        expect(links).toHaveLength(1);
        expect(links[0].getAttribute("href")).toBe(href);
      }
      expect(within(accountMenu).getByRole("group", { name: "Color theme" })).toBeTruthy();
      expect(within(accountMenu).getByRole("radio", { name: "System" })).toBeTruthy();
      await user.click(within(accountMenu).getByRole("radio", { name: "Dark" }));
      await waitFor(() => expect(fetch).toHaveBeenCalledTimes(1));
      expect(document.querySelector('[data-color-mode="dark"]')).toBeTruthy();
      expect(
        within(accountMenu)
          .getByRole(viewport === "desktop" ? "menuitem" : "button", { name: "Sign Out" })
          .getAttribute("form"),
      ).toBe("marketplace-account-menu-sign-out");
      const signOutForm = document.getElementById("marketplace-account-menu-sign-out");
      expect(signOutForm?.tagName).toBe("FORM");
      expect(signOutForm?.getAttribute("method")).toBe("post");
      expect(signOutForm?.getAttribute("action")).toBe("/sign-out");
      expect(screen.queryByText("Acting as")).toBeNull();
      expect(screen.queryByText("Signed in as")).toBeNull();
    },
  );

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
      "Payment methods",
      "Consent History",
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
    const bottomAccountNav = resolveMarketplaceNavItems("bottom-nav", actor).find(
      (item) => item.key === "account-menu",
    );
    const bottomMoneyNav = resolveMarketplaceNavItems("bottom-nav", actor).find((item) => item.key === "money");

    expect(accountMenuItems.map((item) => item.label)).toEqual(["Account", "Payment methods", "Consent History"]);
    expect(bottomMoneyNav?.href).toBe("/account/desk/money");
    expect(bottomAccountNav?.children?.map((item) => item.label)).toEqual(["Account"]);
    expect(resolveMarketplaceNavItems("bottom-nav", actor).map((item) => item.label)).toEqual([
      "Browse",
      "Buy Cart",
      "Alerts",
      "Seller money",
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

type NavigationSlot = "top-nav" | "bottom-nav" | "account-menu";
type NavigationActor = Readonly<{ roleKey?: string | null; permissions: readonly string[] }> | null;
type NavigationSnapshot = Readonly<{
  "top-nav": readonly NavigationItem[];
  "bottom-nav": readonly NavigationItem[];
  "account-menu": readonly AccountMenuItem[];
}>;
type ParityRow = Readonly<{ cohort: string; actor: NavigationActor; cartCount: number; slots: NavigationSnapshot }>;

const navigationSlots = ["top-nav", "bottom-nav", "account-menu"] as const satisfies readonly NavigationSlot[];
// Frozen capture of the unmodified host and layout (#9551 scope fence); never regenerate it from changed code.
const parityFixture = JSON.parse(
  readFileSync(resolve(__dirname, "./layout.navigation-parity.fixture.json"), "utf8"),
) as Readonly<{ captureSha: string; captureSources: Readonly<Record<string, string>>; rows: readonly ParityRow[] }>;

function git(...args: string[]) {
  const result = spawnSync("git", args, { encoding: "utf8" });
  return { status: result.status, stdout: result.stdout.trim() };
}

function cohortActor(cohort: string): NavigationActor {
  const row = parityFixture.rows.find((candidate) => candidate.cohort === cohort);
  if (!row) throw new Error(`unknown navigation cohort ${cohort}`);
  return row.actor;
}

function actualNavigation(actor: NavigationActor, cartCount: number): NavigationSnapshot {
  return {
    "top-nav": resolveMarketplaceNavItems("top-nav", actor, { cartCount }),
    "bottom-nav": resolveMarketplaceNavItems("bottom-nav", actor, { cartCount }),
    "account-menu": resolveMarketplaceAccountMenuItems(actor),
  };
}

function withoutHref(item: NavigationItem): NavigationItem {
  return Object.fromEntries(Object.entries(item).filter(([field]) => field !== "href")) as NavigationItem;
}

// The only two normalizations #9551 permits: (1) the populated bottom Account parent is renamed
// `account` -> `account-menu` (its `account` leaf keeps `/account`); (2) populated groups drop href,
// because shipped TopNav/BottomNav render them as disclosures either way.
function normalizeFixtureSlot(slot: NavigationSlot, items: readonly NavigationItem[]): NavigationItem[] {
  return items.map((item) => {
    if (!item.children?.length) return item;
    const group = withoutHref(item);
    return slot === "bottom-nav" && group.key === "account" ? { ...group, key: "account-menu" } : group;
  });
}

function expectedNavigation(row: ParityRow): NavigationSnapshot {
  return {
    "top-nav": normalizeFixtureSlot("top-nav", row.slots["top-nav"]),
    "bottom-nav": normalizeFixtureSlot("bottom-nav", row.slots["bottom-nav"]),
    "account-menu": row.slots["account-menu"],
  };
}

function matchesFixture(row: ParityRow, actual: NavigationSnapshot) {
  return isDeepStrictEqual(actual, expectedNavigation(row));
}

function flattenKeys(items: readonly (NavigationItem | AccountMenuItem)[]): string[] {
  return items.flatMap((item) => [item.key, ...flattenKeys("children" in item ? (item.children ?? []) : [])]);
}

function mapItems(
  items: readonly NavigationItem[],
  update: (item: NavigationItem) => NavigationItem,
): NavigationItem[] {
  return items.map((item) => update(item.children ? { ...item, children: mapItems(item.children, update) } : item));
}

function renderLayoutAt(
  actor: NavigationActor,
  location: Readonly<{ pathname: string; search?: string; hash?: string }>,
  cartCount = 0,
) {
  mockUseLocation.mockReturnValue({ search: "", hash: "", ...location });
  mockUseRouteLoaderData.mockReturnValue({ actor, actorDisplay: actor ? actorDisplay : null, cartCount });
  return render(<MarketplaceLayoutRoute />);
}

function navigationRegions(container: HTMLElement) {
  const navs = [...container.querySelectorAll("nav")];
  const top = navs.find((nav) => nav.getAttribute("aria-label") === "Primary navigation");
  const bottom = navs.find((nav) => nav !== top);
  if (!top) throw new Error("TopNav did not render");
  return { top, bottom };
}

function topLevelBottomItems(bottom: HTMLElement | undefined) {
  return [...(bottom?.querySelectorAll("a, summary, button") ?? [])].filter(
    (element) => element.closest("details > div") === null,
  );
}

function renderedSelection(container: HTMLElement) {
  const { top, bottom } = navigationRegions(container);
  const text = (element: Element) => element.textContent?.trim() ?? "";
  return {
    top: [...top.querySelectorAll('a[aria-current="page"]')].map(text),
    topGroup: [...top.querySelectorAll("button")]
      .filter((button) => button.classList.contains("text-accent"))
      .map(text),
    bottom: topLevelBottomItems(bottom)
      .filter((element) => element.classList.contains("text-accent"))
      .map(text),
    bottomAriaCurrent: topLevelBottomItems(bottom).filter((element) => element.hasAttribute("aria-current")).length,
  };
}

describe("marketplace-navigation-parity", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("binds the fixture to an unmodified capture commit that is an ancestor of this head", () => {
    expect(git("cat-file", "-t", parityFixture.captureSha)).toEqual({ status: 0, stdout: "commit" });
    expect(git("merge-base", "--is-ancestor", parityFixture.captureSha, "HEAD").status).toBe(0);
    expect(Object.keys(parityFixture.captureSources).sort()).toEqual([
      "deployables/marketplace/app/host.ts",
      "deployables/marketplace/app/routes/layout.tsx",
    ]);
    for (const [path, blob] of Object.entries(parityFixture.captureSources)) {
      expect(git("rev-parse", `${parityFixture.captureSha}:${path}`), path).toEqual({ status: 0, stdout: blob });
    }
    expect(
      git("show", `${parityFixture.captureSha}:deployables/marketplace/app/host.ts`).stdout,
      "the capture predates the cutover",
    ).toContain("function buildMarketplaceBottomNav");
  });

  it("covers every claimed cohort at Cart 0 and 2", () => {
    const cohorts = [
      "anonymous",
      "guest-buyer",
      "buyer-with-security",
      "buyer-without-security",
      "sparse-account",
      "money-capable",
      "seller-without-inventory",
      "seller-every-contribution",
    ];
    for (const cohort of cohorts) {
      expect(
        parityFixture.rows.filter((row) => row.cohort === cohort).map((row) => row.cartCount),
        cohort,
      ).toEqual(expect.arrayContaining([0, 2]));
    }
    expect(cohortActor("buyer-with-security")?.permissions).toContain("security.manage");
    expect(cohortActor("buyer-without-security")?.permissions).not.toContain("security.manage");
    expect(cohortActor("seller-without-inventory")?.permissions).not.toContain("inventory.view");
    expect(cohortActor("guest-buyer")?.roleKey).toBe("guest-buyer");
  });

  it.each(parityFixture.rows.map((row) => [`${row.cohort} cart ${row.cartCount}`, row] as const))(
    "matches all three slots for %s",
    (_name, row) => {
      const actual = actualNavigation(row.actor, row.cartCount);

      expect(actual).toEqual(expectedNavigation(row));
      expect(matchesFixture(row, actual)).toBe(true);
      expect(actual["bottom-nav"].some((item) => item.key === "account")).toBe(false);
      if (row.slots["bottom-nav"].some((item) => item.key === "account" && item.children?.length)) {
        const accountMenu = actual["bottom-nav"].find((item) => item.key === "account-menu");
        expect(accountMenu?.href).toBeUndefined();
        expect(accountMenu?.children?.find((child) => child.key === "account")?.href).toBe("/account");
      }
      expect(actual["bottom-nav"].length).toBeLessThanOrEqual(5);
    },
  );

  it.each(["seller-every-contribution", "buyer-without-security", "seller-without-inventory"])(
    "renders %s populated groups as disclosures, not links",
    (cohort) => {
      const actor = cohortActor(cohort);
      const { container } = renderLayoutAt(actor, { pathname: "/search" });
      const { top, bottom } = navigationRegions(container);
      const groups = (["top-nav", "bottom-nav"] as const).flatMap((slot) =>
        resolveMarketplaceNavItems(slot, actor)
          .filter((item) => item.children?.length)
          .map((item) => ({ slot, item })),
      );

      expect(groups.length).toBeGreaterThan(0);
      for (const { slot, item } of groups) {
        const region = slot === "top-nav" ? top : bottom;
        const triggers = [...(region?.querySelectorAll(slot === "top-nav" ? "button" : "details > summary") ?? [])];
        expect(
          triggers.filter((trigger) => trigger.textContent?.trim() === item.label),
          `${slot} ${item.key}`,
        ).toHaveLength(1);
        expect(
          [...(region?.querySelectorAll("a") ?? [])].filter(
            (link) => link.textContent?.trim() === item.label && link.closest("details > div") === null,
          ),
          `${slot} ${item.key} is not a link`,
        ).toHaveLength(0);
      }
      for (const details of bottom?.querySelectorAll("details") ?? []) {
        expect(details.querySelectorAll(":scope > div a").length).toBeGreaterThan(0);
      }
    },
  );

  it("declares no slot record the base never shows", () => {
    const declared = new Set(
      webContextRegistry.flatMap((entry) =>
        (entry.manifest.shellContributions ?? [])
          .filter((contribution) => contribution.deployable === "marketplace-web")
          .flatMap((contribution) =>
            (contribution.placements?.length ? contribution.placements : [contribution.slot]).map(
              (slot) => `${slot}:${contribution.key}`,
            ),
          ),
      ),
    );
    const rendered = new Set(
      parityFixture.rows.flatMap((row) => {
        const actual = actualNavigation(row.actor, row.cartCount);
        return navigationSlots.flatMap((slot) => flattenKeys(actual[slot]).map((key) => `${slot}:${key}`));
      }),
    );

    expect([...declared].filter((record) => !rendered.has(record))).toEqual([]);
    for (const key of ["wallet", "payouts", "orders", "shipments"]) {
      expect(
        [...declared].some((record) => record.endsWith(`:${key}`)),
        key,
      ).toBe(false);
    }
  });

  describe("rejects drifted output", () => {
    const sellerRow = parityFixture.rows.find(
      (row) => row.cohort === "seller-every-contribution" && row.cartCount === 2,
    )!;
    const buyerRow = parityFixture.rows.find((row) => row.cohort === "buyer-with-security" && row.cartCount === 2)!;
    const mutate = (
      row: ParityRow,
      slot: NavigationSlot,
      update: (items: readonly NavigationItem[]) => readonly NavigationItem[],
    ): NavigationSnapshot => {
      const actual = actualNavigation(row.actor, row.cartCount);
      return { ...actual, [slot]: update(actual[slot] as readonly NavigationItem[]) };
    };
    const updateKey =
      (key: string, update: (item: NavigationItem) => NavigationItem) => (items: readonly NavigationItem[]) =>
        mapItems(items, (item) => (item.key === key ? update(item) : item));

    it("accepts the unmutated output", () => {
      expect(matchesFixture(sellerRow, actualNavigation(sellerRow.actor, sellerRow.cartCount))).toBe(true);
      expect(matchesFixture(buyerRow, actualNavigation(buyerRow.actor, buyerRow.cartCount))).toBe(true);
    });

    it.each([
      [
        "an actual bottom parent named account",
        buyerRow,
        "bottom-nav",
        (items: readonly NavigationItem[]) =>
          items.map((item) => (item.key === "account-menu" ? { ...item, key: "account" } : item)),
      ],
      [
        "a changed Account child key",
        buyerRow,
        "bottom-nav",
        updateKey("account", (item) => ({ ...item, key: "home" })),
      ],
      [
        "a changed Account child href",
        buyerRow,
        "bottom-nav",
        updateKey("account", (item) => ({ ...item, href: "/account/home" })),
      ],
      [
        "a lost #8787 Security link",
        buyerRow,
        "account-menu",
        (items: readonly NavigationItem[]) => items.filter((item) => item.key !== "security"),
      ],
      ["a lost Seller money label", sellerRow, "top-nav", updateKey("money", (item) => ({ ...item, label: "Money" }))],
      [
        "a changed group label",
        sellerRow,
        "top-nav",
        updateKey("selling-workspace", (item) => ({ ...item, label: "Selling" })),
      ],
      [
        "a changed group order",
        sellerRow,
        "top-nav",
        updateKey("selling-workspace", (item) => ({ ...item, children: [...(item.children ?? [])].reverse() })),
      ],
      [
        "a changed group membership",
        sellerRow,
        "bottom-nav",
        updateKey("selling-workspace", (item) => ({
          ...item,
          children: item.children?.filter((child) => child.key !== "sale-shipments"),
        })),
      ],
      [
        "a sixth bottom item",
        sellerRow,
        "bottom-nav",
        (items: readonly NavigationItem[]) => [
          ...items,
          { key: "purchases", label: "Purchases", icon: "bag", href: "/account/purchases" } satisfies NavigationItem,
        ],
      ],
      ["sheet-shaped Notifications", buyerRow, "top-nav", updateKey("notifications", withoutHref)],
    ] as const)("on %s", (_name, row, slot, update) => {
      expect(matchesFixture(row, mutate(row, slot, update))).toBe(false);
    });

    it("on 4648a8d1-shaped output", () => {
      // At 4648a8d1 Notifications was an href-less sheet trigger, money read `Money`, and the #8787
      // account destinations were absent from the account menu.
      const actual = actualNavigation(sellerRow.actor, sellerRow.cartCount);
      const accountDestinations = new Set(["payment-methods", "security", "consents"]);
      const shaped: NavigationSnapshot = {
        "top-nav": updateKey("money", (item) => ({ ...item, label: "Money" }))(
          updateKey("notifications", withoutHref)(actual["top-nav"]),
        ),
        "bottom-nav": actual["bottom-nav"],
        "account-menu": actual["account-menu"].filter((item) => !accountDestinations.has(item.key)),
      };

      expect(matchesFixture(sellerRow, shaped)).toBe(false);
    });
  });
});

describe("marketplace-route-cart-matrix", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("navigates Notifications as a route in both slots by pointer and keyboard with no sheet", async () => {
    const user = userEvent.setup({ document });
    const actor = cohortActor("buyer-without-security");
    const { container } = renderLayoutAt(actor, { pathname: "/search" });
    const { top, bottom } = navigationRegions(container);

    for (const slot of ["top-nav", "bottom-nav"] as const) {
      const notifications = resolveMarketplaceNavItems(slot, actor).find((item) => item.key === "notifications");
      expect(notifications).toEqual(
        expect.objectContaining({
          href: "/account/notifications",
          label: slot === "top-nav" ? "Notifications" : "Alerts",
        }),
      );
      expect(notifications?.children).toBeUndefined();
    }
    const topLink = within(top).getByRole("link", { name: "Notifications" });
    const bottomLink = within(bottom!).getByRole("link", { name: "Alerts" });
    for (const link of [topLink, bottomLink]) {
      expect(link.tagName).toBe("A");
      expect(link.getAttribute("href")).toBe("/account/notifications");
      expect(link.hasAttribute("aria-haspopup")).toBe(false);
    }
    await user.click(topLink);
    expect(screen.queryByRole("dialog")).toBeNull();
    bottomLink.focus();
    await user.keyboard("{Enter}");
    expect(screen.queryByRole("dialog")).toBeNull();
  });

  it.each([
    ["http://localhost/search?notifications=feed", "/account/notifications"],
    ["http://localhost/?notifications=settings", "/account/notifications?view=settings"],
    [
      "http://localhost/account/listings?notifications=settings&notificationSection=product-alerts",
      "/account/notifications?view=settings&section=product-alerts",
    ],
    [
      "http://localhost/search?notifications=settings&notificationSection=bogus",
      "/account/notifications?view=settings",
    ],
    ["http://localhost/search?notifications=other", null],
    ["http://localhost/account/notifications", null],
  ] as const)("redirects retired sheet link %s as at the base", (url, location) => {
    const response = loader({ request: new Request(url), params: {}, context: {} } as Parameters<typeof loader>[0]);

    if (location === null) {
      expect(response).toBeNull();
    } else {
      expect(response).toBeInstanceOf(Response);
      expect((response as Response).headers.get("Location")).toBe(location);
    }
  });

  it.each([
    ["anonymous", 0, null],
    ["anonymous", 2, "2"],
    ["anonymous", 100, "99+"],
    ["guest-buyer", 0, undefined],
    ["guest-buyer", 2, "2"],
    ["guest-buyer", 100, "99+"],
    ["buyer-without-security", 0, undefined],
    ["buyer-without-security", 2, "2"],
    ["buyer-without-security", 100, "99+"],
    ["seller-every-contribution", 0, undefined],
    ["seller-every-contribution", 2, "2"],
    ["seller-every-contribution", 100, "99+"],
  ] as const)("shows %s Cart %s with badge %s in both slots", (cohort, cartCount, badge) => {
    const actor = cohortActor(cohort);
    for (const slot of ["top-nav", "bottom-nav"] as const) {
      const cart = resolveMarketplaceNavItems(slot, actor, { cartCount }).filter((item) => item.key === "cart");
      if (badge === null) {
        expect(cart, slot).toEqual([]);
        continue;
      }
      expect(cart, slot).toEqual([
        expect.objectContaining({
          label: "Buy Cart",
          href: "/account/cart",
          placement: "utility",
          ...(badge === undefined ? {} : { badge }),
        }),
      ]);
      expect(Object.hasOwn(cart[0]!, "badge"), slot).toBe(badge !== undefined);
    }
  });

  type CartStep = readonly [detail: Readonly<{ count?: number; countDelta?: number }>, badge: string | null];
  it.each<readonly [string, readonly CartStep[]]>([
    [
      "anonymous",
      [
        [{ count: 3 }, "3"],
        [{ countDelta: -3 }, null],
        [{ count: 120 }, "99+"],
      ],
    ],
    [
      "guest-buyer",
      [
        [{ count: 3 }, "3"],
        [{ countDelta: -3 }, ""],
        [{ countDelta: 2 }, "2"],
      ],
    ],
    [
      "buyer-without-security",
      [
        [{ count: 120 }, "99+"],
        [{ countDelta: -119 }, "1"],
        [{ count: 0 }, ""],
      ],
    ],
  ])("updates %s Cart live from chase-sets:cart-count-changed", (cohort, steps) => {
    const { container } = renderLayoutAt(cohortActor(cohort), { pathname: "/search" });
    const cartLinks = () => [...container.querySelectorAll('nav a[href="/account/cart"]')];

    expect(cartLinks()).toHaveLength(cohort === "anonymous" ? 0 : 2);
    for (const [detail, badge] of steps) {
      act(() => {
        window.dispatchEvent(new CustomEvent("chase-sets:cart-count-changed", { detail }));
      });
      if (badge === null) {
        expect(cartLinks(), JSON.stringify(detail)).toHaveLength(0);
        continue;
      }
      expect(cartLinks(), JSON.stringify(detail)).toHaveLength(2);
      for (const link of cartLinks()) {
        // TopNav prints the badge once; BottomNav prints it visually and again as screen-reader text.
        const copies = link.closest('nav[aria-label="Primary navigation"]') ? 1 : 2;
        expect(link.textContent, JSON.stringify(detail)).toContain("Buy Cart");
        expect(link.textContent?.replace("Buy Cart", "").replace(/\s+/g, ""), JSON.stringify(detail)).toBe(
          badge.repeat(copies),
        );
      }
    }
  });
});

type ActiveRow = Readonly<{
  path: string;
  search?: string;
  hash?: string;
  cohort: string;
  /** Key the retired coarse `getActiveKey` route-family chain returned. */
  oldKey: string;
  newKey: string | undefined;
  top: readonly string[];
  topGroup: readonly string[];
  bottom: readonly string[];
  slots: readonly NavigationSlot[];
}>;

const S = "seller-every-contribution";
const B = "buyer-without-security";
const BS = "buyer-with-security";
const A = "anonymous";
const G = "guest-buyer";
const sell = { top: [], topGroup: ["Sell"], bottom: ["Sell"], slots: ["top-nav", "bottom-nav"] } as const;
const accountOnly = { top: [], topGroup: [], bottom: [], slots: ["account-menu"] } as const;
const accountWithBottom = {
  top: [],
  topGroup: [],
  bottom: ["Account"],
  slots: ["bottom-nav", "account-menu"],
} as const;
const nothing = { top: [], topGroup: [], bottom: [], slots: [] } as const;
const topOnly = (label: string) => ({ top: [label], topGroup: [], bottom: [], slots: ["top-nav"] }) as const;
const bothBars = (top: string, bottom = top) =>
  ({ top: [top], topGroup: [], bottom: [bottom], slots: ["top-nav", "bottom-nav"] }) as const;

// Hand-authored: oldKey transcribes the base layout's getActiveKey branches; never generate rows from a resolver.
const activeMatrix: readonly ActiveRow[] = [
  { path: "/search", cohort: S, oldKey: "search", newKey: "search", ...bothBars("Browse") },
  { path: "/", cohort: A, oldKey: "search", newKey: "search", ...bothBars("Browse") },
  { path: "/items/charizard", cohort: G, oldKey: "search", newKey: "search", ...bothBars("Browse") },
  { path: "/account/purchases", cohort: B, oldKey: "purchases", newKey: "purchases", ...bothBars("Purchases") },
  { path: "/account/purchases", cohort: S, oldKey: "purchases", newKey: "purchases", ...topOnly("Purchases") },
  { path: "/account/purchases", cohort: A, oldKey: "purchases", newKey: undefined, ...nothing },
  {
    path: "/account/notifications",
    cohort: B,
    oldKey: "notifications",
    newKey: "notifications",
    ...bothBars("Notifications", "Alerts"),
  },
  { path: "/account/desk", cohort: S, oldKey: "account", newKey: "seller-desk", ...topOnly("Seller Desk") },
  { path: "/account/sell-list", cohort: B, oldKey: "account", newKey: "sell-list", ...topOnly("Sell List") },
  { path: "/account/repricing", cohort: S, oldKey: "account", newKey: "repricing", ...topOnly("Pricing") },
  { path: "/account/channels", cohort: S, oldKey: "account", newKey: "channels-publication", ...topOnly("Channels") },
  { path: "/account/desk/money", cohort: S, oldKey: "account", newKey: "money", ...bothBars("Seller money") },
  { path: "/account/support", cohort: S, oldKey: "account", newKey: "support", ...topOnly("Support") },
  { path: "/account/sessions", cohort: BS, oldKey: "account", newKey: "account-sessions", ...topOnly("Sessions") },
  { path: "/account/agents", cohort: BS, oldKey: "account", newKey: "account-agents", ...topOnly("Connected agents") },
  { path: "/account/inventory", cohort: S, oldKey: "inventory", newKey: "inventory", ...sell },
  { path: "/account/inventory/imports", cohort: S, oldKey: "inventory", newKey: "inventory-imports", ...sell },
  {
    path: "/account/inventory/restock-decisions",
    cohort: S,
    oldKey: "inventory",
    newKey: "inventory-restock-decisions",
    ...sell,
  },
  { path: "/account/listings", cohort: S, oldKey: "listings", newKey: "listings", ...sell },
  { path: "/account/offers/matches", cohort: S, oldKey: "offer-matches", newKey: "offer-matches", ...sell },
  { path: "/account/sales", cohort: S, oldKey: "sales", newKey: "sales", ...sell },
  { path: "/account/sales/shipments", cohort: S, oldKey: "sales", newKey: "sale-shipments", ...sell },
  { path: "/account/cart", cohort: B, oldKey: "cart", newKey: "cart", ...bothBars("Buy Cart") },
  { path: "/account/cart", cohort: A, oldKey: "cart", newKey: undefined, ...nothing },
  { path: "/sign-in", cohort: A, oldKey: "sign-in", newKey: "sign-in", ...bothBars("Sign In") },
  { path: "/register", cohort: A, oldKey: "register", newKey: "register", ...bothBars("Register") },
  { path: "/account", cohort: B, oldKey: "account", newKey: "account", ...accountWithBottom },
  { path: "/account", cohort: S, oldKey: "account", newKey: "account", ...accountOnly },
  { path: "/account/payment-methods", cohort: B, oldKey: "account", newKey: "payment-methods", ...accountOnly },
  { path: "/account/security", cohort: BS, oldKey: "account", newKey: "security", ...accountOnly },
  { path: "/account/security", cohort: B, oldKey: "account", newKey: undefined, ...nothing },
  { path: "/account/consents", cohort: B, oldKey: "account", newKey: "consents", ...accountOnly },
  {
    path: "/account/offers/submitted",
    cohort: B,
    oldKey: "submitted-offers",
    newKey: "submitted-offers",
    ...accountWithBottom,
  },
  {
    path: "/account/offers/submitted",
    cohort: S,
    oldKey: "submitted-offers",
    newKey: "submitted-offers",
    ...accountOnly,
  },
  { path: "/account/reviews", cohort: B, oldKey: "reviews", newKey: "reviews", ...accountWithBottom },
  { path: "/account/shipments", cohort: S, oldKey: "shipments", newKey: "account", ...accountOnly },
  { path: "/account/payouts", cohort: B, oldKey: "payouts", newKey: "account", ...accountWithBottom },
  { path: "/account/settlement", cohort: B, oldKey: "wallet", newKey: "account", ...accountWithBottom },
  { path: "/account/product-alerts", cohort: B, oldKey: "product-alerts", newKey: "account", ...accountWithBottom },
  { path: "/account/offers", cohort: B, oldKey: "account", newKey: "account", ...accountWithBottom },
  { path: "/account/listings/lst_seed_1", cohort: S, oldKey: "listings", newKey: "listings", ...sell },
  { path: "/account/listings/", cohort: S, oldKey: "listings", newKey: "listings", ...sell },
  {
    path: "/account/listings",
    search: "?status=draft",
    hash: "#rows",
    cohort: S,
    oldKey: "listings",
    newKey: "listings",
    ...sell,
  },
  { path: "/account/cart", hash: "#summary", cohort: B, oldKey: "cart", newKey: "cart", ...bothBars("Buy Cart") },
  { path: "/account/listings-archive", cohort: S, oldKey: "listings", newKey: "account", ...accountOnly },
  { path: "/account/cartx", cohort: B, oldKey: "cart", newKey: "account", ...accountWithBottom },
  { path: "/account/notificationsx", cohort: B, oldKey: "notifications", newKey: "account", ...accountWithBottom },
  { path: "/searchx", cohort: A, oldKey: "search", newKey: "search", ...bothBars("Browse") },
  { path: "/sign-inx", cohort: A, oldKey: "sign-in", newKey: "search", ...bothBars("Browse") },
];

function renderedSlotsFor(key: string | undefined, actor: NavigationActor) {
  if (key === undefined) return [];
  const actual = actualNavigation(actor, 0);
  return navigationSlots.filter((slot) => flattenKeys(actual[slot]).includes(key));
}

describe("marketplace-active-matrix", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("covers every base getActiveKey branch and every contribution href", () => {
    const baseBranches = [
      "offer-matches",
      "submitted-offers",
      "shipments",
      "reviews",
      "payouts",
      "wallet",
      "purchases",
      "notifications",
      "product-alerts",
      "sales",
      "cart",
      "listings",
      "inventory",
      "account",
      "sign-in",
      "register",
      "search",
    ];
    expect(baseBranches.filter((key) => !activeMatrix.some((row) => row.oldKey === key))).toEqual([]);
    const hrefs = new Set(
      webContextRegistry.flatMap((entry) =>
        (entry.manifest.shellContributions ?? [])
          .filter((contribution) => contribution.deployable === "marketplace-web" && contribution.href)
          .map((contribution) => contribution.href!),
      ),
    );
    expect([...hrefs].filter((href) => !activeMatrix.some((row) => row.path === href))).toEqual([]);
  });

  it.each(
    activeMatrix.map((row) => [`${row.path}${row.search ?? ""}${row.hash ?? ""} as ${row.cohort}`, row] as const),
  )("selects %s", (_name, row) => {
    const actor = cohortActor(row.cohort);
    const { container } = renderLayoutAt(actor, { pathname: row.path, search: row.search, hash: row.hash });

    expect(resolveMarketplaceActiveKey(row.path, actor, { cartCount: 0 })).toBe(row.newKey);
    expect(renderedSlotsFor(row.newKey, actor)).toEqual(row.slots);
    const selection = renderedSelection(container);
    expect({ top: selection.top, topGroup: selection.topGroup, bottom: selection.bottom }).toEqual({
      top: row.top,
      topGroup: row.topGroup,
      bottom: row.bottom,
    });
    expect(selection.bottomAriaCurrent, "BottomNav claims no aria-current").toBe(0);
  });

  it("rejects a top-first Search fallback", () => {
    const actor = cohortActor(B);
    const topFirst = resolveWebHostActiveKey(
      webContextRegistry,
      "marketplace-web",
      "top-nav",
      "/account/offers/submitted",
      actor,
      { defaultKey: "search" },
    );

    expect(topFirst).toBe("search");
    expect(resolveMarketplaceActiveKey("/account/offers/submitted", actor)).toBe("submitted-offers");
  });

  it("rejects a bottom-first ancestor fallback", () => {
    const actor = cohortActor(B);
    const bottomFirst = resolveWebHostActiveKey(
      webContextRegistry,
      "marketplace-web",
      "bottom-nav",
      "/account/security",
      actor,
      { limit: 5 },
    );

    expect(bottomFirst).toBe("account");
    expect(resolveMarketplaceActiveKey("/account/security", actor)).toBeUndefined();
    const { container } = renderLayoutAt(actor, { pathname: "/account/security" });
    expect(renderedSelection(container)).toMatchObject({ top: [], topGroup: [], bottom: [] });
  });

  it("rejects undefined becoming Search", () => {
    const { container } = render(
      <DiscoveryShellLayout
        topNavItems={resolveMarketplaceNavItems("top-nav", null)}
        bottomNavItems={resolveMarketplaceNavItems("bottom-nav", null)}
      >
        <p>content</p>
      </DiscoveryShellLayout>,
    );

    expect(renderedSelection(container)).toMatchObject({ top: [], topGroup: [], bottom: [] });
    const hidden = renderLayoutAt(cohortActor(A), { pathname: "/account/purchases" });
    expect(renderedSelection(hidden.container)).toMatchObject({ top: [], topGroup: [], bottom: [] });
  });
});

describe("marketplace-thin-host source-shape check", () => {
  const source = (relative: string) => readFileSync(resolve(__dirname, relative), "utf8");
  const host = source("../host.ts");
  const layout = source("./layout.tsx");

  it("keeps no navigation rule in the Marketplace host or layout", () => {
    for (const forbidden of [
      "traderNavOverrides",
      "buildMarketplaceBottomNav",
      "groupMarketplaceTopNav",
      "withCartNavigation",
      "getActiveKey",
      "marketplace.app.host.",
      "@chase-sets/localization",
      "new Set(",
      ".sort(",
      ".slice(",
      ".filter(",
      "children",
      "placement",
      "label:",
      "icon:",
      '"/account',
      "guest-buyer",
    ]) {
      expect(host, forbidden).not.toContain(forbidden);
    }
    expect(layout).not.toContain("getActiveKey");
    expect(layout).not.toContain("startsWith(");
    expect(source("../../../../bounded-contexts/discovery/support/shell-support/layout.tsx")).not.toMatch(
      /activeKey\s*=\s*"/,
    );
    expect(source("../../../../contracts/localization/locales/en/marketplace.ts")).not.toContain(
      "marketplace.app.host.",
    );
  });

  it("names no contribution key except the Search default", () => {
    const keys = new Set(
      webContextRegistry.flatMap((entry) =>
        (entry.manifest.shellContributions ?? [])
          .filter((contribution) => contribution.deployable === "marketplace-web")
          .map((contribution) => contribution.key),
      ),
    );
    const literals = (text: string) => [...text.matchAll(/"([^"\n]+)"/g)].map((match) => match[1]!);

    expect([
      ...new Set(
        [...literals(host), ...literals(layout)].filter(
          (value) => keys.has(value) && !(navigationSlots as readonly string[]).includes(value),
        ),
      ),
    ]).toEqual(["search"]);
  });

  it("keeps registry membership unchanged", () => {
    expect(webContextRegistry.map((entry) => entry.contextName)).toEqual([
      "auth",
      "channels",
      "checkout",
      "discovery",
      "fulfillment",
      "identity",
      "inventory",
      "marketplace",
      "notifications",
      "ordering",
      "payments",
      "platform-operations",
      "pricing",
      "settlement",
    ]);
  });

  it("keeps the legacy notification redirect and authPrompt byte-for-byte", () => {
    const base = git("show", `${parityFixture.captureSha}:deployables/marketplace/app/routes/layout.tsx`).stdout;
    const loaderBlock = (text: string) => text.match(/\/\/ Retired notification-sheet links[\s\S]*?\n}\n/)?.[0];
    const authPrompt = (text: string) =>
      text.split("\n").filter((line) => line.includes("authPrompt") || line.includes("showAddPasskeyPrompt ="));

    expect(loaderBlock(layout)).toBeDefined();
    expect(loaderBlock(layout)).toBe(loaderBlock(base));
    expect(authPrompt(layout)).toEqual(authPrompt(base));
  });
});

describe("marketplace search-row route identity", () => {
  it("uses the registered search match and ignores same-pathname query changes", () => {
    mockUseRouteLoaderData.mockReturnValue({ actor: null, cartCount: 0 });
    mockUseLocation.mockReturnValue({ pathname: "/search", search: "?q=charizard", hash: "" });
    mockUseMatches.mockReturnValue([{ id: marketplaceSearchRouteId }]);
    marketplaceShellRouteIdentities.length = 0;
    const view = render(<MarketplaceLayoutRoute />);
    expect(marketplaceShellRouteIdentities.at(-1)).toBe("/search");

    mockUseLocation.mockReturnValue({ pathname: "/search", search: "?q=pikachu", hash: "#results" });
    view.rerender(<MarketplaceLayoutRoute />);
    expect(marketplaceShellRouteIdentities.at(-1)).toBe("/search");

    mockUseMatches.mockReturnValue([{ id: "routes/not-found" }]);
    mockUseLocation.mockReturnValue({ pathname: "/search/x", search: "", hash: "" });
    view.rerender(<MarketplaceLayoutRoute />);
    expect(marketplaceShellRouteIdentities.at(-1)).toBe("/search/x");
    view.unmount();
  });

  it("emits no route change for a same-pathname query or dimension navigation", async () => {
    Object.defineProperty(window, "innerWidth", { configurable: true, value: 390 });
    Object.defineProperty(window, "innerHeight", { configurable: true, value: 844 });
    Object.defineProperty(window, "scrollY", { configurable: true, writable: true, value: 2000 });
    const observations: SearchRowObservation[] = [];
    const stopObserving = observeSearchRowEvents((observation) => observations.push(observation));
    const pinned = renderWithRealRouter("/items/pinned-card");
    try {
      const input = await screen.findByRole("combobox");
      act(() => input.focus());
      await waitFor(() =>
        expect(pinned.view.container.querySelector('[data-search-row-state="expanded"]')).toBeTruthy(),
      );
      const before = observations.at(-1)?.state;
      expect(before).toMatchObject({ phase: "expanded", lastScrollY: 2000 });
      observations.length = 0;

      await act(async () => {
        await pinned.router.navigate("?dimension.condition=raw");
      });
      expect(observations.filter((observation) => observation.event.type === "routechange")).toHaveLength(0);
      expect(pinned.view.container.querySelector('[data-search-row-state="expanded"]')).toBeTruthy();
      await act(() => window.dispatchEvent(new Event("scroll")));
      expect(observations.at(-1)?.state).toEqual(before);
    } finally {
      pinned.view.unmount();
      stopObserving();
    }

    Object.defineProperty(window, "scrollY", { configurable: true, writable: true, value: 2000 });
    const searchObservations: SearchRowObservation[] = [];
    const stopSearchObserving = observeSearchRowEvents((observation) => searchObservations.push(observation));
    const search = renderWithRealRouter("/search?q=before");
    try {
      await waitFor(() => expect(search.view.container.querySelector("[data-search-row-state]")).toBeTruthy());
      const beforeSearch = searchObservations.at(-1)?.state;
      searchObservations.length = 0;
      await act(async () => {
        await search.router.navigate("?q=after");
      });
      expect(searchObservations.filter((observation) => observation.event.type === "routechange")).toHaveLength(0);
      expect(search.view.container.querySelector('[data-search-row-state="expanded"]')).toBeTruthy();
      expect(beforeSearch).toMatchObject({ phase: "expanded", lastScrollY: 2000 });
      await act(() => window.dispatchEvent(new Event("scroll")));
      expect(searchObservations.at(-1)?.state).toEqual(beforeSearch);
    } finally {
      search.view.unmount();
      stopSearchObserving();
    }
  });

  it.each([
    ["/search", "/search", "expanded"],
    ["/SEARCH", "/search", "expanded"],
    ["/Search", "/search", "expanded"],
    ["/search/", "/search", "expanded"],
    ["/search//", "/search", "expanded"],
    ["/%73earch", "/search", "expanded"],
    ["/search/x", "/search/x", "collapsed"],
    ["/search%2Fx", "/search%2Fx", "collapsed"],
  ] as const)(
    "derives canonical search identity from the active matched route for %s",
    async (entry, expectedIdentity, expectedPhase) => {
      Object.defineProperty(window, "innerWidth", { configurable: true, value: 390 });
      Object.defineProperty(window, "innerHeight", { configurable: true, value: 844 });
      Object.defineProperty(window, "scrollY", { configurable: true, writable: true, value: 2000 });
      marketplaceShellRouteIdentities.length = 0;
      const { view } = renderWithRealRouter(entry);
      try {
        await waitFor(() =>
          expect(view.container.querySelector(`[data-search-row-state="${expectedPhase}"]`)).toBeTruthy(),
        );
        expect(marketplaceShellRouteIdentities.at(-1)).toBe(expectedIdentity);
      } finally {
        view.unmount();
      }
    },
  );
});
