// @vitest-environment jsdom

import { cleanup, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { createRoutesStub, useLocation, type ActionFunctionArgs } from "react-router";
import { CHASE_SETS_READ_TARGET_CONTEXT_HEADER } from "@chase-sets/http/responses";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import AccountNotificationsRoute, { loader } from "../../../routes/account-notifications";
import * as requestSupport from "../../../support/request-support/api-client";

vi.mock("../../../support/request-support/api-client", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../../support/request-support/api-client")>();
  return {
    ...actual,
    createNotificationCenterProductAlertsRequestClient: vi.fn(
      actual.createNotificationCenterProductAlertsRequestClient,
    ),
  };
});

const actor = {
  sessionId: "ses_1",
  tenantId: "tnt_identity",
  userId: "usr_1",
  accountId: "acc_1",
  membershipId: "mbr_1",
  roleKey: "owner",
  permissions: ["accounts.view"],
};

type Responder = () => Response | Promise<Response>;

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
}

function feedSnapshot(readAt: string | null, unread: number) {
  return {
    items: [
      {
        deliveryId: "del_1",
        messageType: "ordering.order.created",
        criticality: "commerce",
        title: "Order confirmed",
        body: "Your order is ready.",
        actionHref: "/account/purchases/ord_1",
        readAt,
        createdAt: "2026-05-13T00:00:00.000Z",
      },
    ],
    count: 1,
    unread,
  };
}

const emptyFeed = { items: [], count: 0, unread: 0 };
const productAlert = {
  alert_id: "pal_1",
  catalog_catalog_item_id: "cci_1",
  product_id: "prd_1",
  product_summary: "Charizard - Base Set - Holo",
  market_side: "listing",
  threshold_amount: "120.00",
  status: "active",
};

let responders: Record<string, Responder>;
let fetchCalls: Array<Readonly<{ url: string; method: string; headers: Headers; body: string | null }>>;

function respond(key: string, responder: Responder) {
  responders[key] = responder;
}

function requestKey(url: string, method: string) {
  const { pathname } = new URL(url, "http://localhost");
  return `${method} ${pathname}`;
}

beforeEach(() => {
  fetchCalls = [];
  responders = {
    "GET /api/auth/session": () => json({ actor }),
    "GET /api/notifications/center": () => json(feedSnapshot(null, 1)),
    "GET /api/notifications/preferences": () => json({ items: [{ key: "email", enabled: true }] }),
    "GET /api/marketplace/account/product-alerts": () => json({ items: [productAlert] }),
  };
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: string | URL | Request, init: RequestInit = {}) => {
      const url = input instanceof Request ? input.url : String(input);
      const method = (init.method ?? "GET").toUpperCase();
      fetchCalls.push({
        url,
        method,
        headers: new Headers(init.headers),
        body: typeof init.body === "string" ? init.body : null,
      });
      const responder = responders[requestKey(url, method)];
      if (!responder) {
        throw new Error(`Unexpected request ${method} ${url}`);
      }
      return responder();
    }),
  );
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.clearAllMocks();
});

const productAlertSubmissions: Array<Record<string, string>> = [];

async function productAlertAction({ request }: ActionFunctionArgs) {
  productAlertSubmissions.push(Object.fromEntries((await request.formData()).entries()) as Record<string, string>);
  return Response.redirect("http://localhost/account/notifications?view=settings&section=product-alerts", 302);
}

function CurrentLocation() {
  const location = useLocation();
  return <output data-testid="current-location">{`${location.pathname}${location.search}`}</output>;
}

function renderRoute(path = "/account/notifications") {
  const RouteStub = createRoutesStub([
    {
      path: "/account/notifications",
      Component: () => (
        <>
          <AccountNotificationsRoute />
          <CurrentLocation />
        </>
      ),
      loader,
    },
    { path: "/account/product-alerts", action: productAlertAction },
  ]);

  render(<RouteStub initialEntries={[path]} />);
}

describe("notification center route", () => {
  it("read failure renders the error state", async () => {
    const user = userEvent.setup();
    respond("GET /api/notifications/center", () => json({ error: "unavailable" }, 500));

    renderRoute();

    const banner = await screen.findByRole("alert");
    expect(within(banner).getByText("Notifications could not load")).toBeTruthy();
    expect(within(banner).getByText("Try again in a moment.")).toBeTruthy();
    expect(screen.queryByText("No notifications")).toBeNull();
    expect(screen.queryByText("Recent updates")).toBeNull();

    // Retry revalidates the route; the pending state renders the loading skeleton until the
    // feed read settles, then the recovered feed replaces the banner.
    let releaseFeed: (response: Response) => void = () => undefined;
    respond("GET /api/notifications/center", () => new Promise<Response>((resolve) => (releaseFeed = resolve)));
    await user.click(within(banner).getByRole("button", { name: "Try again" }));

    expect(await screen.findByRole("status", { name: "Loading notifications" })).toBeTruthy();
    releaseFeed(json(feedSnapshot(null, 1)));

    expect(await screen.findByText("Order confirmed")).toBeTruthy();
    expect(screen.queryByRole("alert")).toBeNull();
    expect(screen.queryByRole("status", { name: "Loading notifications" })).toBeNull();
  });

  it("empty feed renders the empty state", async () => {
    respond("GET /api/notifications/center", () => json(emptyFeed));

    renderRoute();

    expect(await screen.findByText("No notifications")).toBeTruthy();
    expect(screen.getByText("Order, shipment, and Product alert updates will appear here.")).toBeTruthy();
    expect(screen.getByText("Recent updates")).toBeTruthy();
    expect(screen.getByText("0 unread")).toBeTruthy();
    expect(screen.queryByRole("alert")).toBeNull();
    expect(screen.queryByText("Notifications could not load")).toBeNull();
    expect((screen.getByRole("button", { name: "Mark all read" }) as HTMLButtonElement).disabled).toBe(true);
  });

  it("renders a populated feed without reading Product alerts", async () => {
    renderRoute();

    expect(await screen.findByText("Order confirmed")).toBeTruthy();
    expect(screen.getByText("Your order is ready.")).toBeTruthy();
    expect(screen.getByText("Orders")).toBeTruthy();
    expect(screen.getByText("1 unread")).toBeTruthy();
    expect(screen.getByText("New")).toBeTruthy();
    expect(screen.getByRole("link", { name: "Open" }).getAttribute("href")).toBe("/account/purchases/ord_1");
    expect(fetchCalls.some((call) => call.url.includes("/api/marketplace/account/product-alerts"))).toBe(false);
    expect(requestSupport.createNotificationCenterProductAlertsRequestClient).not.toHaveBeenCalled();
  });

  it("product-alert summary uses the Marketplace request client", async () => {
    renderRoute("/account/notifications?view=settings&section=product-alerts");

    expect(await screen.findByText("Charizard - Base Set - Holo")).toBeTruthy();
    expect(screen.getByText("Listings - at or below $120.00")).toBeTruthy();
    expect(screen.getByText("active")).toBeTruthy();
    expect(screen.getByRole("link", { name: "View product" }).getAttribute("href")).toBe("/items/cci_1");

    expect(requestSupport.createNotificationCenterProductAlertsRequestClient).toHaveBeenCalledTimes(1);
    const [request] = vi.mocked(requestSupport.createNotificationCenterProductAlertsRequestClient).mock.calls[0]!;
    expect(new URL(request.url).pathname).toBe("/account/notifications");

    const productAlertRead = fetchCalls.find((call) => call.url.endsWith("/api/marketplace/account/product-alerts"));
    expect(productAlertRead).toMatchObject({
      method: "GET",
      url: "http://localhost/api/marketplace/account/product-alerts",
    });
    expect(productAlertRead?.headers.get(CHASE_SETS_READ_TARGET_CONTEXT_HEADER)).toBe("discovery");
  });

  it("fails the settings load when the Product alerts read fails instead of showing empty alerts", async () => {
    const user = userEvent.setup();
    respond("GET /api/marketplace/account/product-alerts", () => json({ error: "unavailable" }, 503));

    renderRoute("/account/notifications?view=settings");

    const banner = await screen.findByRole("alert");
    expect(within(banner).getByText("Notifications could not load")).toBeTruthy();
    expect(screen.queryByText("No Product alerts yet")).toBeNull();
    expect(screen.queryByText("Delivery settings")).toBeNull();

    // Control: a genuinely empty Product alerts response renders the empty state after retry.
    respond("GET /api/marketplace/account/product-alerts", () => json({ items: [] }));
    await user.click(within(banner).getByRole("button", { name: "Try again" }));

    expect(await screen.findByText("No Product alerts yet")).toBeTruthy();
    expect(screen.getByText("Delivery settings")).toBeTruthy();
    expect(screen.getByRole("switch", { name: /Email notifications/ })).toBeTruthy();
    expect(screen.queryByRole("alert")).toBeNull();
  });

  it("fails the settings load when the preferences read fails", async () => {
    respond("GET /api/notifications/preferences", () => json({ error: "unavailable" }, 500));

    renderRoute("/account/notifications?view=settings");

    expect(await screen.findByText("Notifications could not load")).toBeTruthy();
    expect(screen.queryByText("Delivery settings")).toBeNull();
    expect(screen.queryByText("Charizard - Base Set - Holo")).toBeNull();
  });

  it("submits Product alert controls to the Discovery account action and follows its return", async () => {
    const user = userEvent.setup();
    productAlertSubmissions.length = 0;

    renderRoute("/account/notifications?view=settings");
    await screen.findByText("Charizard - Base Set - Holo");

    respond("GET /api/marketplace/account/product-alerts", () =>
      json({ items: [{ ...productAlert, status: "paused" }] }),
    );
    await user.click(screen.getByRole("button", { name: "Pause" }));

    await waitFor(() =>
      expect(screen.getByTestId("current-location").textContent).toBe(
        "/account/notifications?view=settings&section=product-alerts",
      ),
    );
    expect(await screen.findByText("paused")).toBeTruthy();
    expect(screen.getByRole("button", { name: "Resume" })).toBeTruthy();

    await user.click(screen.getByRole("button", { name: "Resume" }));
    await waitFor(() => expect(productAlertSubmissions).toHaveLength(2));
    await user.click(screen.getByRole("button", { name: "Delete" }));
    await waitFor(() => expect(productAlertSubmissions).toHaveLength(3));

    expect(productAlertSubmissions).toEqual([
      { intent: "pause", alertId: "pal_1" },
      { intent: "resume", alertId: "pal_1" },
      { intent: "delete", alertId: "pal_1" },
    ]);
    expect(fetchCalls.filter((call) => call.method === "POST")).toEqual([]);
  });

  it("reconciles notification read actions from the committed mutation snapshot", async () => {
    const user = userEvent.setup();
    respond("POST /api/notifications/center/del_1/read", () =>
      json({ status: "read", feed: feedSnapshot("2026-05-13T00:05:00.000Z", 0) }),
    );

    renderRoute();
    await screen.findByText("1 unread");

    await user.click(screen.getByRole("button", { name: "Mark read" }));

    expect(await screen.findByText("0 unread")).toBeTruthy();
    expect(screen.getByText("Read")).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Mark read" })).toBeNull();
    expect(fetchCalls.filter((call) => call.url.includes("/api/notifications/center?"))).toHaveLength(1);
  });

  it.each([
    ["Mark read", "POST /api/notifications/center/del_1/read"],
    ["Mark all read", "POST /api/notifications/center/read-all"],
  ])(
    "reports a failed %s, keeps the current feed snapshot, and clears after a committed repeat",
    async (label, key) => {
      const user = userEvent.setup();
      const feedWrites: Responder[] = [
        () => json({ error: "unavailable" }, 500),
        () => json({ status: "read", feed: feedSnapshot("2026-05-13T00:05:00.000Z", 0) }),
      ];
      respond(key, () => feedWrites.shift()!());

      renderRoute();
      await screen.findByText("1 unread");

      await user.click(screen.getByRole("button", { name: label }));

      const banner = await screen.findByRole("alert");
      expect(within(banner).getByText("Try again in a moment.")).toBeTruthy();
      expect(within(banner).queryByText("Notifications could not load")).toBeNull();
      expect(screen.getByText("1 unread")).toBeTruthy();
      expect(screen.getByText("New")).toBeTruthy();
      expect(screen.getByText("Order confirmed")).toBeTruthy();

      await user.click(screen.getByRole("button", { name: label }));

      expect(await screen.findByText("0 unread")).toBeTruthy();
      expect(screen.getByText("Read")).toBeTruthy();
      expect(screen.queryByRole("alert")).toBeNull();
      expect(fetchCalls.filter((call) => requestKey(call.url, call.method) === key)).toHaveLength(2);
    },
  );

  it("reconciles preferences from saved snapshots and reports failed writes without changing state", async () => {
    const user = userEvent.setup();
    const preferenceWrites: Responder[] = [
      () => json({ item: { key: "email", enabled: false } }),
      () => json({ error: "unavailable" }, 500),
      () => json({ item: { key: "email", enabled: true } }),
    ];
    respond("POST /api/notifications/preferences/email", () => preferenceWrites.shift()!());

    renderRoute("/account/notifications?view=settings");
    const emailSwitch = await screen.findByRole("switch", { name: /Email notifications/ });
    expect(emailSwitch.getAttribute("aria-checked")).toBe("true");

    await user.click(emailSwitch);
    await waitFor(() => expect(emailSwitch.getAttribute("aria-checked")).toBe("false"));

    expect(screen.queryByRole("alert")).toBeNull();

    await user.click(emailSwitch);
    const banner = await screen.findByRole("alert");
    expect(within(banner).getByText("Try again in a moment.")).toBeTruthy();
    expect(within(banner).queryByText("Notifications could not load")).toBeNull();
    expect(emailSwitch.getAttribute("aria-checked")).toBe("false");

    await user.click(emailSwitch);
    await waitFor(() => expect(emailSwitch.getAttribute("aria-checked")).toBe("true"));
    expect(screen.queryByRole("alert")).toBeNull();
    expect(preferenceWrites).toHaveLength(0);
    expect(fetchCalls.filter((call) => call.url.includes("/api/notifications/preferences/email"))).toEqual([
      expect.objectContaining({ method: "POST", body: JSON.stringify({ enabled: false }) }),
      expect.objectContaining({ method: "POST", body: JSON.stringify({ enabled: true }) }),
      expect.objectContaining({ method: "POST", body: JSON.stringify({ enabled: true }) }),
    ]);
  });
});
