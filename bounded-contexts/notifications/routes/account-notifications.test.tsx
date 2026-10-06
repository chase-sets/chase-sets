// @vitest-environment jsdom

import { cleanup, render, screen } from "@testing-library/react";
import { createRoutesStub, type LoaderFunctionArgs } from "react-router";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { CHASE_SETS_READ_TARGET_CONTEXT_HEADER } from "@chase-sets/http/responses";
import { resolveLegacyNotificationCenterHref } from "../web";
import AccountNotificationsRoute, { loader } from "./account-notifications";

const accountViewer = {
  sessionId: "ses_1",
  tenantId: "tnt_identity",
  userId: "usr_1",
  accountId: "acc_1",
  membershipId: "mbr_1",
  roleKey: "owner",
  permissions: ["accounts.view"],
};

const populatedFeed = {
  items: [
    {
      deliveryId: "del_1",
      messageType: "fulfillment.shipment.dispatched",
      criticality: "commerce",
      title: "Shipment on the way",
      body: "Your order shipped.",
      actionHref: "/account/purchases/ord_1",
      readAt: null,
      createdAt: "2026-05-13T00:00:00.000Z",
    },
    {
      deliveryId: "del_2",
      messageType: "ordering.order.created",
      criticality: "commerce",
      title: "Order confirmed",
      body: "Your order is ready.",
      actionHref: null,
      readAt: "2026-05-12T00:00:00.000Z",
      createdAt: "2026-05-12T00:00:00.000Z",
    },
  ],
  count: 2,
  unread: 1,
};

function loaderArgs(request: Request): LoaderFunctionArgs {
  return { request, params: {}, context: {}, url: new URL(request.url), pattern: "/account/notifications" };
}

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
}

let sessionActor: typeof accountViewer | null;
let fetchCalls: Array<Readonly<{ url: string; headers: Headers }>>;

beforeEach(() => {
  sessionActor = accountViewer;
  fetchCalls = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: string | URL | Request, init: RequestInit = {}) => {
      const url = input instanceof Request ? input.url : String(input);
      fetchCalls.push({ url, headers: new Headers(init.headers) });
      const { pathname } = new URL(url, "http://localhost");
      if (pathname === "/api/auth/session") return json({ actor: sessionActor });
      if (pathname === "/api/notifications/center") return json(populatedFeed);
      if (pathname === "/api/notifications/preferences") return json({ items: [{ key: "web", enabled: true }] });
      if (pathname === "/api/marketplace/account/product-alerts") return json({ items: [] });
      throw new Error(`Unexpected request ${url}`);
    }),
  );
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe("account notifications route", () => {
  it("renders the notification center from the real loader with a populated feed", async () => {
    const RouteStub = createRoutesStub([
      { path: "/account/notifications", Component: AccountNotificationsRoute, loader },
    ]);

    render(<RouteStub initialEntries={["/account/notifications"]} />);

    expect(await screen.findByRole("heading", { level: 1, name: "Notifications" })).toBeTruthy();
    expect(screen.getByText("Review marketplace updates from the notification center.")).toBeTruthy();
    expect(screen.getByRole("heading", { level: 2, name: "Recent updates" })).toBeTruthy();
    expect(screen.getByText("Shipment on the way")).toBeTruthy();
    expect(screen.getByText("Shipments")).toBeTruthy();
    expect(screen.getByText("Order confirmed")).toBeTruthy();
    expect(screen.getByText("1 unread")).toBeTruthy();
    expect(screen.getAllByRole("button", { name: "Mark read" })).toHaveLength(1);
    expect(screen.getByRole("link", { name: "Feed" }).getAttribute("aria-current")).toBe("page");
    expect(screen.getByRole("link", { name: "Settings" }).getAttribute("href")).toBe(
      "/account/notifications?view=settings",
    );
    expect(screen.queryByText("No notifications")).toBeNull();
    expect(screen.queryByRole("alert")).toBeNull();
    expect(fetchCalls.find((call) => call.url.includes("/api/notifications/center"))?.url).toBe(
      "http://localhost/api/notifications/center?limit=25&includeRead=true",
    );
  });

  it("forwards the signed-in request's credentials and read targets to each read", async () => {
    const request = new Request("https://marketplace.test/account/notifications?view=settings", {
      headers: { cookie: "chase_sets_session=ses_1", authorization: "Bearer token_1" },
    });

    const data = await loader(loaderArgs(request));

    expect(data).toMatchObject({
      view: "settings",
      section: "preferences",
      settings: {
        status: "loaded",
        value: { preferences: [{ key: "web", enabled: true }], productAlerts: { items: [] } },
      },
    });
    const reads = fetchCalls.filter((call) => !call.url.includes("/api/auth/session"));
    expect(
      reads.map((call) => [new URL(call.url).pathname, call.headers.get(CHASE_SETS_READ_TARGET_CONTEXT_HEADER)]),
    ).toEqual(
      expect.arrayContaining([
        ["/api/notifications/preferences", "notifications"],
        ["/api/marketplace/account/product-alerts", "discovery"],
      ]),
    );
    for (const call of reads) {
      expect(call.headers.get("cookie")).toBe("chase_sets_session=ses_1");
      expect(call.headers.get("authorization")).toBe("Bearer token_1");
    }
  });

  it("keeps accounts.view authorization in front of every notification read", async () => {
    sessionActor = null;
    const signedOut = await loader(
      loaderArgs(new Request("http://localhost/account/notifications?view=settings")),
    ).catch((error: unknown) => error);

    expect(signedOut).toBeInstanceOf(Response);
    expect((signedOut as Response).status).toBe(302);
    expect((signedOut as Response).headers.get("location")).toBe(
      "/sign-in?returnTo=%2Faccount%2Fnotifications%3Fview%3Dsettings",
    );

    sessionActor = { ...accountViewer, permissions: [] };
    const forbidden = await loader(loaderArgs(new Request("http://localhost/account/notifications"))).catch(
      (error: unknown) => error,
    );

    expect((forbidden as Response).status).toBe(403);
    expect(fetchCalls.every((call) => call.url.includes("/api/auth/session"))).toBe(true);
  });
});

describe("retired notification sheet links", () => {
  it.each([
    ["/search?notifications=feed", "/account/notifications"],
    ["/?notifications=feed", "/account/notifications"],
    ["/account/listings?notifications=feed&notificationSection=product-alerts", "/account/notifications"],
    ["/search?notifications=settings", "/account/notifications?view=settings"],
    ["/?notifications=settings", "/account/notifications?view=settings"],
    [
      "/search?notifications=settings&notificationSection=product-alerts",
      "/account/notifications?view=settings&section=product-alerts",
    ],
    [
      "/account/cart?notifications=settings&notificationSection=preferences",
      "/account/notifications?view=settings&section=preferences",
    ],
    ["/search?notifications=settings&notificationSection=history", "/account/notifications?view=settings"],
    ["/search?q=charizard&notifications=feed&returnTo=https%3A%2F%2Fevil.test", "/account/notifications"],
    ["/account/notifications?notifications=feed", "/account/notifications"],
  ])("redirects %s to %s", (from, to) => {
    expect(resolveLegacyNotificationCenterHref(new URL(from, "https://marketplace.test"))).toBe(to);
  });

  it.each([
    "/search",
    "/search?q=charizard",
    "/search?notifications=open",
    "/search?notificationSection=product-alerts",
    "/account/notifications",
    "/account/notifications?view=settings&section=product-alerts",
  ])("leaves %s untouched", (path) => {
    expect(resolveLegacyNotificationCenterHref(new URL(path, "https://marketplace.test"))).toBeNull();
  });

  it("consumes the legacy parameter once so the canonical destination never redirects again", () => {
    const first = resolveLegacyNotificationCenterHref(
      new URL("/search?notifications=settings&notificationSection=product-alerts", "https://marketplace.test"),
    );

    expect(first).toBe("/account/notifications?view=settings&section=product-alerts");
    expect(resolveLegacyNotificationCenterHref(new URL(first!, "https://marketplace.test"))).toBeNull();
  });
});
