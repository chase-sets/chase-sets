// @vitest-environment jsdom

import { cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { createRoutesStub, Outlet, useLocation } from "react-router";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import AccountProductAlertsRoute, {
  action as productAlertsAction,
  loader as productAlertsLoader,
} from "@chase-sets/discovery/routes/account-product-alerts";
import AccountNotificationsRoute, {
  loader as accountNotificationsLoader,
} from "@chase-sets/notifications/routes/account-notifications";
import { loader as layoutLoader } from "./layout";

const accountViewer = {
  sessionId: "ses_1",
  tenantId: "tnt_identity",
  userId: "usr_1",
  accountId: "acc_1",
  membershipId: "mbr_1",
  roleKey: "owner",
  permissions: ["accounts.view"],
};

const productAlert = {
  alert_id: "pal_1",
  catalog_catalog_item_id: "cci_1",
  product_id: "prd_1",
  product_summary: "Charizard - Base Set - Holo",
  market_side: "offer",
  threshold_amount: null,
  status: "active",
};

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
}

let sessionActor: typeof accountViewer | null;
let alertStatus: "active" | "paused";
let requests: string[];

beforeEach(() => {
  sessionActor = accountViewer;
  alertStatus = "active";
  requests = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: string | URL | Request, init: RequestInit = {}) => {
      const url = input instanceof Request ? input.url : String(input);
      const method = (init.method ?? (input instanceof Request ? input.method : "GET")).toUpperCase();
      const { pathname } = new URL(url, "http://localhost");
      requests.push(`${method} ${pathname}`);
      if (pathname === "/api/auth/session") return json({ actor: sessionActor });
      if (pathname === "/api/notifications/center") return json({ items: [], count: 0, unread: 0 });
      if (pathname === "/api/notifications/preferences") return json({ items: [{ key: "email", enabled: true }] });
      if (pathname === "/api/marketplace/account/product-alerts") {
        return json({ items: [{ ...productAlert, status: alertStatus }] });
      }
      if (method === "POST" && pathname === "/api/marketplace/account/product-alerts/pal_1/pause") {
        alertStatus = "paused";
        return json({ alert_id: "pal_1", status: "paused", version: 2 });
      }
      throw new Error(`Unexpected request ${method} ${url}`);
    }),
  );
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

function MarketplaceLayoutStub() {
  const location = useLocation();
  return (
    <>
      <Outlet />
      <output data-testid="current-location">{`${location.pathname}${location.search}`}</output>
    </>
  );
}

function renderMarketplace(initialPath: string) {
  const RouteStub = createRoutesStub([
    {
      path: "/",
      Component: MarketplaceLayoutStub,
      loader: layoutLoader,
      children: [
        { index: true, Component: () => <p>Browse home</p> },
        { path: "search", Component: () => <p>Search results</p> },
        { path: "sign-in", Component: () => <p>Sign in page</p> },
        { path: "account/listings", Component: () => <p>Listings page</p> },
        { path: "account/notifications", Component: AccountNotificationsRoute, loader: accountNotificationsLoader },
        {
          path: "account/product-alerts",
          Component: AccountProductAlertsRoute,
          loader: productAlertsLoader,
          action: productAlertsAction,
        },
      ],
    },
  ]);

  render(<RouteStub initialEntries={[initialPath]} />);
}

async function expectLocation(path: string) {
  await waitFor(() => expect(screen.getByTestId("current-location").textContent).toBe(path));
}

describe("marketplace layout notification-center compatibility", () => {
  it("redirects the Search feed deep link to the rendered notification center", async () => {
    renderMarketplace("/search?notifications=feed");

    await expectLocation("/account/notifications");
    expect(await screen.findByText("No notifications")).toBeTruthy();
    expect(screen.queryByText("Search results")).toBeNull();
  });

  it("redirects the transactional-email settings link to the settings view", async () => {
    renderMarketplace("/?notifications=settings");

    await expectLocation("/account/notifications?view=settings");
    expect(await screen.findByText("Delivery settings")).toBeTruthy();
    expect(screen.queryByText("Browse home")).toBeNull();
  });

  it("follows the Discovery Product alerts redirect chain to the Product alerts settings section", async () => {
    renderMarketplace("/account/product-alerts");

    await expectLocation("/account/notifications?view=settings&section=product-alerts");
    expect(await screen.findByText("Charizard - Base Set - Holo")).toBeTruthy();
    expect(screen.getByText("Offers - all new matches")).toBeTruthy();
  });

  it("leaves pages without a recognized sheet state untouched", async () => {
    renderMarketplace("/account/listings?notifications=open");

    await expectLocation("/account/listings?notifications=open");
    expect(screen.getByText("Listings page")).toBeTruthy();
    expect(requests).not.toContain("GET /api/notifications/center");
  });

  it("pauses a Product alert through the existing Discovery action and returns to refreshed settings", async () => {
    const user = userEvent.setup();
    renderMarketplace("/account/notifications?view=settings&section=product-alerts");
    await screen.findByText("Charizard - Base Set - Holo");

    await user.click(screen.getByRole("button", { name: "Pause" }));

    expect(await screen.findByRole("button", { name: "Resume" })).toBeTruthy();
    expect(screen.getByText("paused")).toBeTruthy();
    await expectLocation("/account/notifications?view=settings&section=product-alerts");
    expect(requests).toContain("POST /api/marketplace/account/product-alerts/pal_1/pause");
  });

  it("grants no access through the redirect for a signed-out visitor", async () => {
    sessionActor = null;
    renderMarketplace("/?notifications=settings");

    await waitFor(() =>
      expect(screen.getByTestId("current-location").textContent).toBe(
        "/sign-in?returnTo=%2Faccount%2Fnotifications%3Fview%3Dsettings",
      ),
    );
    expect(requests.filter((request) => !request.endsWith("/api/auth/session"))).toEqual([]);
  });
});
