import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import ts from "@chase-sets/typescript-compiler-api";
import { renderToString } from "react-dom/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const {
  mockUseLoaderData,
  mockUseLocation,
  mockUseRouteError,
  mockAnalyticsCounter,
  mockAnalyticsLog,
  mockStartObservability,
} = vi.hoisted(() => ({
  mockUseLoaderData: vi.fn(),
  mockUseLocation: vi.fn(),
  mockUseRouteError: vi.fn(),
  mockAnalyticsCounter: vi.fn(),
  mockAnalyticsLog: vi.fn(),
  mockStartObservability: vi.fn(),
}));

vi.mock("@chase-sets/observability", async () => ({
  ...(await vi.importActual<typeof import("@chase-sets/observability")>("@chase-sets/observability")),
  recordItemDetailRailAnalytics: mockAnalyticsCounter,
  startObservability: mockStartObservability,
}));
vi.mock("@chase-sets/platform-runtime/web-entry-server", () => ({ default: vi.fn(), streamTimeout: 5000 }));

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
    useRouteError: mockUseRouteError,
  };
});

import { action as itemDetailRailAnalyticsAction } from "@chase-sets/discovery/routes/item-detail-rail-analytics";
import { registerItemDetailRailAnalyticsRecorder } from "@chase-sets/platform-runtime/analytics-recorder";
import { resolveMarketplaceRouteConfigRecords } from "./host";
import routes from "./routes";
import type { RouteConfigEntry } from "@react-router/dev/routes";
import { itemDetailRailAnalyticsEventNames } from "@chase-sets/discovery/web";
import { marketplaceHostRouteInventory } from "./host-route-inventory";
import { t } from "@chase-sets/localization";
import { CHASE_SETS_INTERNAL_API_ORIGIN_ENV } from "@chase-sets/platform-runtime/http";
import { ErrorBoundary, Layout, itemDetailRailAnalyticsBridgeScript, loader } from "./root";

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

function rootPolicyViolations(source: string) {
  const violations: string[] = [];
  const policyNames = new Set(["resolveCartCount", "resolveCurrentActorDisplay", "resolveMarketplaceRootTheme"]);
  const visit = (node: ts.Node) => {
    if (
      ts.isStringLiteralLike(node) &&
      (node.text === "guest-buyer" || node.text === "guest-checkout.manage")
    ) {
      violations.push(node.text);
    }
    if (
      (ts.isFunctionDeclaration(node) || ts.isVariableDeclaration(node)) &&
      node.name &&
      ts.isIdentifier(node.name) &&
      policyNames.has(node.name.text)
    ) {
      violations.push(node.name.text);
    }
    ts.forEachChild(node, visit);
  };
  visit(ts.createSourceFile("root.tsx", source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX));
  return violations;
}

describe("marketplace root holds no checkout or identity policy", () => {
  it("contains no owner policy literals or local resolver definitions", () => {
    expect(rootPolicyViolations(readFileSync(resolve(process.cwd(), "app/root.tsx"), "utf8"))).toEqual([]);
  });

  it.each([
    ['const role = "guest-buyer";', "guest-buyer"],
    ['const permission = "guest-checkout.manage";', "guest-checkout.manage"],
    ["async function resolveCartCount() {}", "resolveCartCount"],
    ["function resolveCurrentActorDisplay() {}", "resolveCurrentActorDisplay"],
    ["const resolveMarketplaceRootTheme = () => null;", "resolveMarketplaceRootTheme"],
  ])("rejects synthetic forbidden policy: %s", (source, violation) => {
    expect(rootPolicyViolations(source)).toEqual([violation]);
  });
});

describe("marketplace root layout", () => {
  beforeEach(() => {
    mockStartObservability.mockReturnValue({ logger: { info: mockAnalyticsLog } });
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

  it("discovery item-detail-rail analytics route is contributed once at root placement", () => {
    const records = resolveMarketplaceRouteConfigRecords().filter(
      (record) => record.routePath === "analytics/item-detail-rail",
    );
    expect(records).toHaveLength(1);
    expect(records[0]).toMatchObject({
      contextName: "discovery",
      placement: "root",
      fileExport: "./routes/item-detail-rail-analytics",
    });
    const flatten = (entries: readonly RouteConfigEntry[]): RouteConfigEntry[] =>
      entries.flatMap((entry) => [entry, ...flatten(entry.children ?? [])]);
    expect(flatten(routes).filter((entry) => entry.path === "analytics/item-detail-rail")).toEqual([
      expect.objectContaining({
        id: "discovery/item-detail-rail-analytics",
        file: "../../../bounded-contexts/discovery/routes/item-detail-rail-analytics.tsx",
      }),
    ]);
    expect(routes).toContainEqual(expect.objectContaining({ path: "analytics/item-detail-rail" }));
    expect(marketplaceHostRouteInventory.some((route) => route.routePath === "analytics/item-detail-rail")).toBe(false);
  });

  it("marketplace registers item-detail-rail analytics recorder at startup", async () => {
    const restore = registerItemDetailRailAnalyticsRecorder(null);
    try {
      await import("./entry.server");
      const payload = {
        event: "search_result_selected",
        intent: "buy",
        workflow: "selected_listing",
        selection: "explicit",
        topic: "listing_buy_cart",
        outcome: "opened",
        gate: "buyer_registration",
        viewer: "guest",
        surface: "search_results",
        position: 1,
        queryHash: "a".repeat(64),
        resultSetKey: "b".repeat(64),
      };
      const response = await itemDetailRailAnalyticsAction({
        request: new Request("https://marketplace.example/analytics/item-detail-rail", {
          method: "POST",
          body: JSON.stringify(payload),
        }),
      } as Parameters<typeof itemDetailRailAnalyticsAction>[0]);
      expect(response.status).toBe(204);
      expect(mockAnalyticsCounter).toHaveBeenCalledExactlyOnceWith(payload);
      expect(mockAnalyticsLog).toHaveBeenCalledExactlyOnceWith("Item detail rail analytics event captured.", {
        type: "marketplace.item_detail_rail.analytics_event",
        event: payload.event,
        intent: payload.intent,
        workflow: payload.workflow,
        selection: payload.selection,
        topic: payload.topic,
        outcome: payload.outcome,
        gate: payload.gate,
        viewer: payload.viewer,
        surface: payload.surface,
      });
      expect(mockStartObservability.mock.calls[0][0]).toMatchObject({ serviceName: "marketplace-web" });
    } finally {
      registerItemDetailRailAnalyticsRecorder(null);
      restore();
    }
  });

  it("marketplace root bridge emits unchanged payloads", () => {
    let listener = (_event: Event) => {};
    const fetch = vi.fn().mockResolvedValue(undefined);
    new Function("window", "navigator", "fetch", "Blob", "CustomEvent", itemDetailRailAnalyticsBridgeScript)(
      {
        addEventListener: (name: string, handler: typeof listener) => {
          expect(name).toBe("chase-sets:item-detail-rail-analytics");
          listener = handler;
        },
      },
      {},
      fetch,
      Blob,
      CustomEvent,
    );
    const fields = {
      intent: "buy",
      workflow: "selected_listing",
      selection: "explicit",
      topic: "listing_buy_cart",
      outcome: "opened",
      gate: "buyer_registration",
      viewer: "guest",
      surface: "search_results",
      position: 10001,
      queryHash: "a".repeat(64),
      resultSetKey: "b".repeat(64),
    };
    for (const event of itemDetailRailAnalyticsEventNames) {
      listener(new CustomEvent("fixture", { detail: { event, ...fields, email: "private@example.test" } }));
      expect(fetch.mock.lastCall).toEqual([
        "/analytics/item-detail-rail",
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ event, ...fields }),
          credentials: "same-origin",
          keepalive: true,
        },
      ]);
    }
    const count = fetch.mock.calls.length;
    for (const detail of [null, {}, { event: "unknown" }, { event: " rail_intent_selected " }])
      listener(new CustomEvent("fixture", { detail }));
    listener(new Event("fixture"));
    expect(fetch).toHaveBeenCalledTimes(count);
    listener(new CustomEvent("fixture", { detail: { event: "rail_intent_selected" } }));
    expect(JSON.parse(fetch.mock.lastCall?.[1].body)).toEqual({
      event: "rail_intent_selected",
      ...Object.fromEntries(Object.keys(fields).map((field) => [field, null])),
    });
    listener(
      new CustomEvent("fixture", {
        detail: { event: "rail_intent_selected", intent: "a".repeat(81), position: "1", queryHash: "A".repeat(64) },
      }),
    );
    expect(JSON.parse(fetch.mock.lastCall?.[1].body)).toEqual({
      event: "rail_intent_selected",
      ...Object.fromEntries(Object.keys(fields).map((field) => [field, null])),
    });
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

    const result = await loader({
        ...createLoaderArgs("https://marketplace.chasesets.com/checkout/buy/session/chk_1"),
        request: new Request("https://marketplace.chasesets.com/checkout/buy/session/chk_1", {
          headers: { cookie: "chase_sets_anonymous_cart=anon_cart_1; chase_sets_color_mode=dark" },
        }),
      });
    const data = unwrapLoaderData(result);

    expect(data.actor?.roleKey).toBe("guest-buyer");
    expect(data.actorDisplay).toBeNull();
    expect(data.cartCount).toBe(2);
    expect(data.colorMode).toBe("system");
    expect(data.viewer).toBeNull();
    expect(loaderHeaders(result).get("Set-Cookie")).toBeNull();
    expect(fetch.mock.calls.map(([input]) => new URL(String(input)).pathname)).not.toContain(
      "/api/identity/current-actor-display",
    );
    expect(fetch.mock.calls.map(([input]) => new URL(String(input)).pathname)).not.toContain(
      "/api/marketplace/account/cart",
    );
  });

  it("marketplace root loader preserves context results and cookie seed headers", async () => {
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

    expect(data.actorDisplay).toEqual({
      account: { account_id: "acc_card_vault", display_name: "Card Vault", name: "Card Vault LLC", badges: [] },
      membership: { membership_id: "mbr_card_vault_alex", role_key: "manager" },
      user: { user_id: "usr_alex", display_name: "Alex Clerk", primary_email: "alex@example.com" },
    });
    expect(data.cartCount).toBe(1);
    expect(data.viewer).toEqual({
      actor: {
        userId: "usr_alex",
        accountId: "acc_card_vault",
        tenantId: "acc_card_vault",
        sessionId: "ses_alex",
        membershipId: "mbr_card_vault_alex",
        roleKey: "manager",
        permissions: ["accounts.view"],
      },
      preferences: { colorMode: "dark", reducedMotion: "user" },
    });
    expect(data.colorMode).toBe("dark");
    expect(data.viewer?.preferences?.colorMode).toBe("dark");
    expect(data.viewer?.preferences?.reducedMotion).toBe("user");
    expect(loaderHeaders(result).get("Set-Cookie")).toContain("chase_sets_color_mode=dark");

    const equalCookieResult = await loader({
      ...createLoaderArgs("https://marketplace.chasesets.com/account"),
      request: new Request("https://marketplace.chasesets.com/account", {
        headers: { cookie: "chase_sets_color_mode=dark" },
      }),
    });
    expect(unwrapLoaderData(equalCookieResult)).toEqual(data);
    expect(loaderHeaders(equalCookieResult).get("Set-Cookie")).toBeNull();
  });

  it.each(["chase_sets_color_mode=light", ""])(
    "preserves Identity failure viewer and no seed for cookie %s",
    async (cookie) => {
      const actor = {
        userId: "usr_failure",
        accountId: "acc_failure",
        tenantId: "acc_failure",
        sessionId: "ses_failure",
        membershipId: "mbr_failure",
        roleKey: "manager",
        permissions: ["accounts.view"],
      };
      vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL) => {
        const pathname = requestPath(input);
        if (pathname === "/api/auth/session") return Response.json({ actor });
        if (pathname.startsWith("/api/identity/")) return Response.json({}, { status: 503 });
        if (pathname === "/api/marketplace/account/cart") return Response.json({ count: 7, items: [] });
        throw new Error(`Unexpected request: ${pathname}`);
      }));
      const result = await loader({
        ...createLoaderArgs("https://marketplace.chasesets.com/account"),
        request: new Request("https://marketplace.chasesets.com/account", { headers: { cookie } }),
      });
      expect(unwrapLoaderData(result)).toMatchObject({
        actor,
        actorDisplay: null,
        cartCount: 7,
        colorMode: cookie ? "light" : "system",
        viewer: cookie ? { actor, preferences: { colorMode: "light", reducedMotion: "user" } } : null,
      });
      expect(loaderHeaders(result).get("Set-Cookie")).toBeNull();
    },
  );

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
    expect(data.actorDisplay).toBeNull();
    expect(data.cartCount).toBe(0);
    expect(data.viewer).toBeNull();
    expect(data.colorMode).toBe("system");
    expect(loaderHeaders(result).get("Set-Cookie")).toBeNull();
  });
});

describe("marketplace root error boundary", () => {
  afterEach(() => {
    vi.clearAllMocks();
  });

  it.each([
    ["a thrown Error", new Error("SYNTHETIC_ROOT_5623")],
    ["a network TypeError", new TypeError("Failed to fetch")],
    [
      "a non-404 route error response",
      { status: 502, statusText: "SYNTHETIC_STATUS_5623", internal: false, data: "SYNTHETIC_BODY_5623" },
    ],
    ["a thrown non-Error value", "SYNTHETIC_VALUE_5623"],
  ])("renders localized copy and no technical text for %s", (_case, error) => {
    mockUseRouteError.mockReturnValue(error);

    const html = renderToString(<ErrorBoundary />);

    expect(html).toContain("Marketplace error");
    expect(html).toContain(t("marketplace.app.root.unknown.error"));
    expect(html).not.toContain("SYNTHETIC_");
    expect(html).not.toContain("Failed to fetch");
  });

  it("keeps the page-not-found copy for a 404 route error response", () => {
    mockUseRouteError.mockReturnValue({
      status: 404,
      statusText: "SYNTHETIC_STATUS_404",
      internal: true,
      data: "SYNTHETIC_BODY_404",
    });

    const html = renderToString(<ErrorBoundary />);

    expect(html).toContain("Page not found");
    expect(html).toContain(t("marketplace.app.root.page.not.found.description"));
    expect(html).not.toContain("Marketplace error");
    expect(html).not.toContain("SYNTHETIC_");
  });
});
