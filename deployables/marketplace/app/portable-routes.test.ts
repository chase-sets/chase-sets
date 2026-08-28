import { describe, expect, it, vi } from "vitest";
import { createPortableClientRouter, type PortableClientFetch } from "@chase-sets/platform-runtime/portable-client";
import { discoveryPortableRoutes } from "@chase-sets/discovery/web";
import { identityPortableRoutes } from "@chase-sets/identity/web";
import { webContextRegistry } from "./generated/web-context-registry";
import { resolveMarketplaceRouteConfigRecords } from "./host";
import { marketplaceHostRouteInventory } from "./host-route-inventory";
import marketplaceRouteConfig from "./routes";
import type { RouteConfigEntry } from "@react-router/dev/routes";

function requiredContext(contextName: "discovery" | "identity") {
  const entry = webContextRegistry.find((candidate) => candidate.contextName === contextName);
  if (!entry) throw new Error(`Missing ${contextName} web context registry entry.`);
  return entry;
}

function requestUrl(input: RequestInfo | URL) {
  return input instanceof Request ? input.url : input.toString();
}

function bearerTransport(apiFetch: PortableClientFetch, observed: string[]): PortableClientFetch {
  return (input, init = {}) => {
    const url = requestUrl(input);
    const headers = new Headers(init.headers);
    headers.set("Authorization", "Bearer portable-session");
    observed.push(url);
    return apiFetch(input, { ...init, headers });
  };
}

function createTestRouter(fetch: PortableClientFetch) {
  const discovery = requiredContext("discovery");
  const identity = requiredContext("identity");
  return createPortableClientRouter({
    apiOrigin: "https://api.chasesets.test",
    fetch,
    contexts: [
      { contextName: discovery.contextName, manifest: discovery.manifest, portableRoutes: discoveryPortableRoutes },
      { contextName: identity.contextName, manifest: identity.manifest, portableRoutes: identityPortableRoutes },
    ],
  });
}

function routeById(router: ReturnType<typeof createTestRouter>, id: string) {
  const route = router.routes.find((candidate) => candidate.id === id);
  if (!route) throw new Error(`Missing portable route '${id}'.`);
  return route;
}

function flattenRouteConfig(entries: readonly RouteConfigEntry[]): RouteConfigEntry[] {
  return entries.flatMap((entry) => [entry, ...flattenRouteConfig(entry.children ?? [])]);
}

function hostRoutePath(entry: RouteConfigEntry) {
  if (entry.file === "routes/index.tsx") return "/";
  if (entry.file === "routes/layout.tsx") return "(layout)";
  return entry.path ?? "";
}

describe("portable marketplace route composition", () => {
  it("projects the same canonical manifest IDs and paths into SSR and portable registries", () => {
    const router = createTestRouter(() => Promise.resolve(Response.json({})));
    const ssrRoutes = resolveMarketplaceRouteConfigRecords();

    expect(router.routes.map(({ id, path }) => ({ id, path }))).toEqual([
      { id: "discovery/category", path: "categories/:categorySlug" },
      { id: "discovery/search", path: "search" },
      { id: "identity/account", path: "account" },
    ]);
    for (const portable of router.routes) {
      const [contextName, routeId] = portable.id.split("/");
      expect(ssrRoutes).toContainEqual(expect.objectContaining({ contextName, routeId, routePath: portable.path }));
    }
  });

  it("cold-loads public search only through the injected absolute-origin bearer transport", async () => {
    const observed: string[] = [];
    const forbiddenGlobal = vi.spyOn(globalThis, "fetch").mockRejectedValue(new Error("global fetch used"));
    const transport = bearerTransport((input, init) => {
      expect(new Headers(init?.headers).get("authorization")).toBe("Bearer portable-session");
      const url = new URL(requestUrl(input));
      if (url.pathname === "/api/marketplace/categories") {
        return Promise.resolve(Response.json({ items: [], total: 0, count: 0 }));
      }
      if (url.pathname === "/api/marketplace/items") {
        return Promise.resolve(
          Response.json({
            items: [],
            facets: [],
            category_counts: [],
            total: 0,
            count: 0,
            nextCursor: null,
            retrievalMode: "lexical",
            lexicalCount: 0,
            queryHash: "query",
            resultSetKey: "result",
          }),
        );
      }
      return Promise.resolve(Response.json({ error: "not found" }, { status: 404 }));
    }, observed);

    try {
      const route = routeById(createTestRouter(transport), "discovery/search");
      const result = await route.load({ url: new URL("https://mobile.local/search?q=pikachu"), params: {} });
      expect(result).toMatchObject({ kind: "data", data: { search: "pikachu" } });
      expect(observed).toEqual([
        "https://api.chasesets.test/api/marketplace/categories",
        expect.stringMatching(/^https:\/\/api\.chasesets\.test\/api\/marketplace\/items\?/),
      ]);
      expect(forbiddenGlobal).not.toHaveBeenCalled();
    } finally {
      forbiddenGlobal.mockRestore();
    }
  });

  it("maps expired auth, server validation, and successful account mutation without a server loader", async () => {
    let authStatus = 401;
    let mutationStatus = 422;
    const transport = bearerTransport((input) => {
      const url = new URL(requestUrl(input));
      if (url.pathname === "/api/auth/session") {
        return Promise.resolve(
          authStatus === 401
            ? Response.json({ error: "expired" }, { status: 401 })
            : Response.json({ actor: { accountId: "acct_1", permissions: ["accounts.view", "accounts.manage"] } }),
        );
      }
      if (url.pathname === "/api/identity/accounts/acct_1") {
        return Promise.resolve(
          mutationStatus === 422
            ? Response.json({ fieldErrors: { displayName: "Already used" } }, { status: 422 })
            : Response.json({
                account_id: "acct_1",
                name: "Trader",
                display_name: "Trader",
                badges: [],
                status: "active",
                updated_at: "",
              }),
        );
      }
      if (url.pathname === "/api/identity/current-actor-display") {
        return Promise.resolve(
          Response.json({
            account: { account_id: "acct_1", display_name: "Trader", name: "Trader", badges: [] },
            membership: { membership_id: "mem_1", role_key: "owner" },
            user: { user_id: "usr_1", display_name: "Trader", primary_email: "trader@example.test" },
          }),
        );
      }
      return Promise.resolve(Response.json({ error: "not found" }, { status: 404 }));
    }, []);
    const route = routeById(createTestRouter(transport), "identity/account");

    await expect(route.load({ url: new URL("https://mobile.local/account"), params: {} })).resolves.toEqual({
      kind: "unauthorized",
    });
    authStatus = 200;
    const formData = new FormData();
    formData.set("intent", "update-profile");
    formData.set("name", "Trader");
    formData.set("displayName", "Trader");
    await expect(
      route.mutate?.({ url: new URL("https://mobile.local/account"), params: {}, formData }),
    ).resolves.toEqual({ kind: "validation-error", error: { fieldErrors: { displayName: "Already used" } } });
    mutationStatus = 200;
    await expect(
      route.mutate?.({ url: new URL("https://mobile.local/account"), params: {}, formData }),
    ).resolves.toEqual({ kind: "navigate", to: "/account" });
  });

  it("inventories every host-local route as explicitly unsupported on mobile", () => {
    expect(marketplaceHostRouteInventory).toHaveLength(15);
    expect(marketplaceHostRouteInventory).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ routePath: "/", owner: "marketplace-web", followUp: "#5238" }),
        expect.objectContaining({ routePath: "service-worker.js", delivery: "web-resource-only" }),
        expect.objectContaining({ routePath: "*", delivery: "server-only" }),
      ]),
    );
    const actualHostRoutes = flattenRouteConfig(marketplaceRouteConfig)
      .filter((entry) => entry.file.startsWith("routes/"))
      .map((entry) => ({ routePath: hostRoutePath(entry), fileExport: entry.file }))
      .sort((left, right) => left.fileExport.localeCompare(right.fileExport));
    const inventoriedHostRoutes = marketplaceHostRouteInventory
      .map(({ routePath, fileExport }) => ({ routePath, fileExport }))
      .sort((left, right) => left.fileExport.localeCompare(right.fileExport));
    expect(inventoriedHostRoutes).toEqual(actualHostRoutes);
  });

  it("ratchets canonical metadata and portable operations", () => {
    const discovery = requiredContext("discovery");
    const manifestWithoutCanonical = JSON.parse(JSON.stringify(discovery.manifest));
    delete manifestWithoutCanonical.deployableContributions[0].routes.find(
      (route: { routeId: string }) => route.routeId === "search",
    ).canonicalLink;
    expect(() =>
      createPortableClientRouter({
        apiOrigin: "https://api.chasesets.test",
        fetch: () => Promise.resolve(Response.json({})),
        contexts: [
          { contextName: "discovery", manifest: manifestWithoutCanonical, portableRoutes: discoveryPortableRoutes },
        ],
      }),
    ).toThrow("must declare canonical-link metadata");

    expect(() =>
      createPortableClientRouter({
        apiOrigin: "https://api.chasesets.test",
        fetch: () => Promise.resolve(Response.json({})),
        contexts: [{ contextName: discovery.contextName, manifest: discovery.manifest, portableRoutes: [] }],
      }),
    ).toThrow("requires exactly one portable module");
  });
});
