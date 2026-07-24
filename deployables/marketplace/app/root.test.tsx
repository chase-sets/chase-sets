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
import { CHASE_SETS_INTERNAL_API_ORIGIN_ENV } from "@chase-sets/platform-runtime/http";
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

type LoaderDataResult<T> = Readonly<{
  type: string;
  data: T;
  init?: ResponseInit | null;
}>;

function isLoaderDataResult<T>(value: unknown): value is LoaderDataResult<T> {
  return (
    typeof value === "object" &&
    value !== null &&
    "type" in value &&
    (value as { type?: unknown }).type === "DataWithResponseInit" &&
    "data" in value
  );
}

function unwrapLoaderData<T>(value: T | LoaderDataResult<T>): T {
  return isLoaderDataResult<T>(value) ? value.data : value;
}

function loaderHeaders(value: unknown) {
  return isLoaderDataResult<unknown>(value) ? new Headers(value.init?.headers) : new Headers();
}

function requestPath(input: RequestInfo | URL) {
  return input instanceof Request ? new URL(input.url).pathname : new URL(String(input)).pathname;
}

describe("marketplace root layout", () => {
  beforeEach(() => {
    vi.stubEnv(CHASE_SETS_INTERNAL_API_ORIGIN_ENV, "https://marketplace.chasesets.com");
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

  it("falls back to a safe client layout when loader data is unavailable", () => {
    mockUseLoaderData.mockReturnValue(undefined);
    vi.stubGlobal("process", undefined);

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
    expect(html).toContain('name="robots" content="noindex,nofollow"');
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

  it("captures Result Set click hashes and rejects raw query text", async () => {
    vi.stubEnv("OBSERVABILITY_ENABLED", "false");
    const accepted = await itemDetailRailAnalyticsAction({
      request: new Request("https://marketplace.chasesets.com/analytics/item-detail-rail", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          event: "search_result_selected",
          surface: "search_results",
          position: 1,
          queryHash: "a".repeat(64),
          resultSetKey: "b".repeat(64),
        }),
      }),
      params: {},
      context: undefined,
    } as never);
    const rejected = await itemDetailRailAnalyticsAction({
      request: new Request("https://marketplace.chasesets.com/analytics/item-detail-rail", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          event: "search_result_selected",
          surface: "search_results",
          position: 1,
          queryHash: "private-pikachu-query",
          resultSetKey: "b".repeat(64),
        }),
      }),
      params: {},
      context: undefined,
    } as never);
    const rejectedStringPosition = await itemDetailRailAnalyticsAction({
      request: new Request("https://marketplace.chasesets.com/analytics/item-detail-rail", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          event: "search_result_selected",
          surface: "search_results",
          position: "1",
          queryHash: "a".repeat(64),
          resultSetKey: "b".repeat(64),
        }),
      }),
      params: {},
      context: undefined,
    } as never);

    expect(accepted.status).toBe(204);
    expect(rejected.status).toBe(400);
    expect(rejectedStringPosition.status).toBe(400);
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

  it("keeps public marketplace pages reachable without an extra launch gate", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(() =>
        Promise.resolve(new Response(JSON.stringify({ error: "Authentication required." }), { status: 401 })),
      ),
    );

    const data = unwrapLoaderData(
      await loader(createLoaderArgs("https://marketplace.chasesets.com/search?q=charizard")),
    );

    expect(data.actor).toBeNull();
    expect(data.origin).toBe("https://marketplace.chasesets.com");
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
        throw new Error("Guest checkout actors should not load the account cart.");
      }
      if (pathname === "/api/marketplace/guest/cart") {
        return Response.json({ items: [], count: 2 });
      }
      if (pathname === "/api/identity/current-actor-display") {
        throw new Error("Guest checkout actors should not load account display data.");
      }

      return Response.json({});
    });
    vi.stubGlobal("fetch", fetch);

    const data = unwrapLoaderData(
      await loader({
        ...createLoaderArgs("https://marketplace.chasesets.com/checkout/buy/session/chk_1"),
        request: new Request("https://marketplace.chasesets.com/checkout/buy/session/chk_1", {
          headers: { cookie: "chase_sets_anonymous_cart=anon_cart_1" },
        }),
      }),
    );

    expect(data.actor?.roleKey).toBe("guest-buyer");
    expect(data.actorDisplay).toBeNull();
    expect(data.cartCount).toBe(2);
    expect(fetch.mock.calls.map(([input]) => new URL(String(input)).pathname)).not.toContain(
      "/api/identity/current-actor-display",
    );
    expect(fetch.mock.calls.map(([input]) => new URL(String(input)).pathname)).not.toContain(
      "/api/marketplace/account/cart",
    );
  });

  it("resolves signed-in color mode from Identity preferences and refreshes the cookie mirror", async () => {
    const fetch = vi.fn(async (input: RequestInfo | URL) => {
      const pathname = requestPath(input);
      if (pathname === "/api/auth/session") {
        return Response.json({
          actor: {
            userId: "usr_alex",
            accountId: "acc_card_vault",
            tenantId: "acc_card_vault",
            sessionId: "ses_alex",
            membershipId: "mbr_card_vault_alex",
            roleKey: "manager",
            permissions: ["accounts.view"],
          },
        });
      }
      if (pathname === "/api/identity/current-actor-display") {
        return Response.json({
          account: { account_id: "acc_card_vault", display_name: "Card Vault", name: "Card Vault LLC", badges: [] },
          membership: { membership_id: "mbr_card_vault_alex", role_key: "manager" },
          user: { user_id: "usr_alex", display_name: "Alex Clerk", primary_email: "alex@example.com" },
        });
      }
      if (pathname === "/api/identity/preferences") {
        return Response.json({
          userId: "usr_alex",
          colorMode: "dark",
          density: "comfortable",
          reducedMotion: "user",
          locale: "en-US",
          timeZone: "America/Chicago",
        });
      }
      if (pathname === "/api/marketplace/account/cart") {
        return Response.json({ items: [], total: 0, count: 1 });
      }

      return Response.json({});
    });
    vi.stubGlobal("fetch", fetch);

    const result = await loader({
      ...createLoaderArgs("https://marketplace.chasesets.com/account"),
      request: new Request("https://marketplace.chasesets.com/account", {
        headers: { cookie: "chase_sets_color_mode=light" },
      }),
    });
    const data = unwrapLoaderData(result);

    expect(data.colorMode).toBe("dark");
    expect(data.viewer?.preferences?.colorMode).toBe("dark");
    expect(data.viewer?.preferences?.reducedMotion).toBe("user");
    expect(loaderHeaders(result).get("Set-Cookie")).toContain("chase_sets_color_mode=dark");
  });

  it("keeps signed-out first paint on system so localStorage fallback can apply after hydration", async () => {
    const fetch = vi.fn(async (input: RequestInfo | URL) => {
      const pathname = requestPath(input);
      if (pathname === "/api/auth/session") {
        return Response.json({ error: "Authentication required." }, { status: 401 });
      }
      if (pathname === "/api/identity/preferences") {
        throw new Error("Signed-out root loaders should not request Identity preferences.");
      }

      return Response.json({});
    });
    vi.stubGlobal("fetch", fetch);

    const result = await loader({
      ...createLoaderArgs("https://marketplace.chasesets.com/search"),
      request: new Request("https://marketplace.chasesets.com/search", {
        headers: { cookie: "chase_sets_color_mode=dark" },
      }),
    });
    const data = unwrapLoaderData(result);

    expect(data.actor).toBeNull();
    expect(data.colorMode).toBe("system");
    expect(loaderHeaders(result).get("Set-Cookie")).toBeNull();
  });
});
