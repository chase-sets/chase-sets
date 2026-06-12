import { renderToString } from "react-dom/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { mockUseLoaderData, mockUseLocation } = vi.hoisted(() => ({
  mockUseLoaderData: vi.fn(),
  mockUseLocation: vi.fn(),
}));

vi.mock("react-router", async () => {
  const actual = await vi.importActual<typeof import("react-router")>("react-router");

  return {
    ...actual,
    Links: () => null,
    Meta: () => null,
    Outlet: () => null,
    Scripts: () => null,
    ScrollRestoration: () => null,
    useLoaderData: mockUseLoaderData,
    useLocation: mockUseLocation,
  };
});

import {
  action as itemDetailRailAnalyticsAction,
  loader as itemDetailRailAnalyticsLoader,
} from "./routes/item-detail-rail-analytics";
import { Layout, itemDetailRailAnalyticsBridgeScript, loader } from "./root";

function createLoaderArgs(url: string): Parameters<typeof loader>[0] {
  return {
    request: new Request(url),
    params: {},
    context: {},
    url: new URL(url),
    pattern: "*",
  };
}

describe("marketplace root layout", () => {
  beforeEach(() => {
    mockUseLocation.mockReturnValue({
      pathname: "/search",
      search: "?search=charizard",
    });
  });

  afterEach(() => {
    vi.clearAllMocks();
    vi.unstubAllEnvs();
    vi.unstubAllGlobals();
  });

  it("falls back to a safe origin when loader data is unavailable", () => {
    mockUseLoaderData.mockReturnValue(undefined);

    const html = renderToString(
      <Layout>
        <main>Marketplace Search</main>
      </Layout>,
    );

    expect(html).toContain('href="http://localhost');
    expect(html).toContain('/search?search=charizard"');
    expect(html).toContain('rel="manifest" href="/manifest.webmanifest"');
    expect(html).toContain('rel="icon" href="/favicon.svg"');
    expect(html).toContain('rel="alternate icon" href="/favicon.ico"');
    expect(html).toContain("Marketplace Search");
  });

  it("uses the loader origin when it is available", () => {
    mockUseLoaderData.mockReturnValue({
      actor: null,
      origin: "https://marketplace.example",
      shouldIndex: true,
    });

    const html = renderToString(
      <Layout>
        <main>Marketplace Search</main>
      </Layout>,
    );

    expect(html).toContain('href="https://marketplace.example/search?search=charizard"');
  });

  it("can noindex staging through environment configuration", () => {
    vi.stubEnv("CHASE_SETS_MARKETPLACE_INDEXING", "false");
    mockUseLoaderData.mockReturnValue({
      actor: null,
      origin: "https://marketplace.staging.chasesets.com",
      shouldIndex: false,
    });

    const html = renderToString(
      <Layout>
        <main>Marketplace Search</main>
      </Layout>,
    );

    expect(html).toContain('name="robots" content="noindex,nofollow"');
  });

  it("installs a bounded item-detail rail analytics bridge script", () => {
    expect(itemDetailRailAnalyticsBridgeScript).toContain("chase-sets:item-detail-rail-analytics");
    expect(itemDetailRailAnalyticsBridgeScript).toContain("/analytics/item-detail-rail");
    expect(itemDetailRailAnalyticsBridgeScript).toContain("reference_info_opened");
    expect(itemDetailRailAnalyticsBridgeScript).toContain("registration_gate_shown");
    expect(itemDetailRailAnalyticsBridgeScript).not.toContain("email");
    expect(itemDetailRailAnalyticsBridgeScript).not.toContain("price_amount");
  });

  it("captures bounded item-detail rail analytics events", async () => {
    vi.stubEnv("OBSERVABILITY_ENABLED", "false");
    const response = await itemDetailRailAnalyticsAction({
      request: new Request("https://marketplace.chasesets.com/analytics/item-detail-rail", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          event: "payout_preview_shown",
          intent: "sell",
          workflow: "selected_offer",
          selection: "explicit",
          topic: "estimated_payout",
          outcome: "shown",
          viewer: "guest",
          surface: "action_rail",
        }),
      }),
      params: {},
      context: undefined,
    } as never);

    expect(response.status).toBe(204);
  });

  it("rejects unsupported or unbounded rail analytics events before logging", async () => {
    vi.stubEnv("OBSERVABILITY_ENABLED", "false");
    const unsupported = await itemDetailRailAnalyticsAction({
      request: new Request("https://marketplace.chasesets.com/analytics/item-detail-rail", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ event: "email_submitted", email: "seller@example.com" }),
      }),
      params: {},
      context: undefined,
    } as never);
    const unbounded = await itemDetailRailAnalyticsAction({
      request: new Request("https://marketplace.chasesets.com/analytics/item-detail-rail", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          event: "reference_info_opened",
          topic: "seller@example.com",
          surface: "action rail",
        }),
      }),
      params: {},
      context: undefined,
    } as never);

    expect(unsupported.status).toBe(400);
    expect(unbounded.status).toBe(400);
    expect(
      itemDetailRailAnalyticsLoader({
        request: new Request("https://marketplace.chasesets.com/analytics/item-detail-rail"),
        params: {},
        context: undefined,
      } as never).status,
    ).toBe(405);
  });

  it("redirects anonymous production proof marketplace requests to sign-in", async () => {
    vi.stubEnv("CHASE_SETS_MARKETPLACE_PROOF_ACCESS_REQUIRED", "true");
    vi.stubGlobal(
      "fetch",
      vi.fn(() =>
        Promise.resolve(new Response(JSON.stringify({ error: "Authentication required." }), { status: 401 })),
      ),
    );

    let thrown: unknown;
    try {
      await loader(createLoaderArgs("https://marketplace.chasesets.com/search?q=charizard"));
    } catch (error) {
      thrown = error;
    }

    expect(thrown).toBeInstanceOf(Response);
    expect((thrown as Response).status).toBe(302);
    expect((thrown as Response).headers.get("Location")).toBe("/sign-in?returnTo=%2Fsearch%3Fq%3Dcharizard");
  });

  it("allows proof sign-in and guest checkout exit routes to render before an actor exists", async () => {
    vi.stubEnv("CHASE_SETS_MARKETPLACE_PROOF_ACCESS_REQUIRED", "true");
    vi.stubGlobal(
      "fetch",
      vi.fn(() =>
        Promise.resolve(new Response(JSON.stringify({ error: "Authentication required." }), { status: 401 })),
      ),
    );

    const data = await loader(createLoaderArgs("https://marketplace.chasesets.com/sign-in?returnTo=%2F"));
    const guestExitData = await loader(createLoaderArgs("https://marketplace.chasesets.com/guest-checkout/exit"));

    expect(data.actor).toBeNull();
    expect(data.origin).toBe("https://marketplace.chasesets.com");
    expect(guestExitData.actor).toBeNull();
  });

  it("does not request account display data for guest checkout actors", async () => {
    const fetch = vi.fn(async (input: RequestInfo | URL) => {
      const pathname = new URL(String(input)).pathname;
      if (pathname === "/api/auth/session") {
        return Response.json({
          actor: {
            userId: "usr_guest_checkout",
            accountId: "acc_guest",
            tenantId: "acc_guest",
            sessionId: "guest_checkout",
            roleKey: "guest-buyer",
            permissions: ["guest-checkout.manage"],
          },
        });
      }
      if (pathname === "/api/marketplace/account/cart") {
        return Response.json({ items: [], count: 2 });
      }
      if (pathname === "/api/identity/current-actor-display") {
        throw new Error("Guest checkout actors should not load account display data.");
      }

      return Response.json({});
    });
    vi.stubGlobal("fetch", fetch);

    const data = await loader(createLoaderArgs("https://marketplace.chasesets.com/checkout/buy/session/chk_1"));

    expect(data.actor?.roleKey).toBe("guest-buyer");
    expect(data.actorDisplay).toBeNull();
    expect(data.cartCount).toBe(2);
    expect(fetch.mock.calls.map(([input]) => new URL(String(input)).pathname)).not.toContain(
      "/api/identity/current-actor-display",
    );
  });

  it("does not expose sitemap routes before proof access is authenticated", async () => {
    vi.stubEnv("CHASE_SETS_MARKETPLACE_PROOF_ACCESS_REQUIRED", "true");
    vi.stubGlobal(
      "fetch",
      vi.fn(() =>
        Promise.resolve(new Response(JSON.stringify({ error: "Authentication required." }), { status: 401 })),
      ),
    );

    let thrown: unknown;
    try {
      await loader(createLoaderArgs("https://marketplace.chasesets.com/sitemap.xml"));
    } catch (error) {
      thrown = error;
    }

    expect(thrown).toBeInstanceOf(Response);
    expect((thrown as Response).status).toBe(302);
    expect((thrown as Response).headers.get("Location")).toBe("/sign-in?returnTo=%2Fsitemap.xml");
  });

  it("requires the proof access permission for signed-in production proof actors", async () => {
    vi.stubEnv("CHASE_SETS_MARKETPLACE_PROOF_ACCESS_REQUIRED", "true");
    vi.stubGlobal(
      "fetch",
      vi.fn(() =>
        Promise.resolve(
          Response.json({
            actor: {
              userId: "usr_1",
              accountId: "acc_1",
              tenantId: "acc_1",
              sessionId: "ses_1",
              permissions: ["accounts.view"],
            },
          }),
        ),
      ),
    );

    let thrown: unknown;
    try {
      await loader(createLoaderArgs("https://marketplace.chasesets.com/search"));
    } catch (error) {
      thrown = error;
    }

    expect(thrown).toBeInstanceOf(Response);
    expect((thrown as Response).status).toBe(403);
  });
});
