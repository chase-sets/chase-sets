import { afterEach, describe, expect, it, vi } from "vitest";
import { buildCanonicalUrl, buildMarketplaceCrawlPosture, buildMarketplaceRobotsTxt } from "../seo";
import { loader as accountLoader } from "@chase-sets/identity/routes/marketplace/account";
import { loader as chromeDevtoolsLoader } from "./chrome-devtools";
import { loader as faviconLoader } from "./favicon";
import { loader as itemLoader, meta as itemMeta } from "@chase-sets/discovery/routes/item-detail";
import { loader as robotsLoader } from "./robots";
import { loader as manifestLoader } from "./manifest";
import { loader as serviceWorkerLoader } from "./service-worker";
import { loader as searchLoader, meta as searchMeta } from "@chase-sets/discovery/routes/search";
import { action as homeAction } from "./index";
import { meta as signInMeta } from "@chase-sets/auth/routes/marketplace/sign-in";
import { loader as sitemapLoader } from "./sitemap";
import { loader as healthReadyLoader } from "./health-ready";

describe("marketplace SSR routes", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
    vi.unstubAllGlobals();
  });

  it("loads discovery data through the marketplace API", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn((input: string | URL | Request) => {
        const url = String(input);

        if (url.includes("/api/marketplace/categories")) {
          return Promise.resolve(
            new Response(JSON.stringify({ items: [], total: 0, count: 0 }), {
              status: 200,
              headers: { "Content-Type": "application/json" },
            }),
          );
        }

        return Promise.resolve(
          new Response(
            JSON.stringify({
              items: [],
              total: 0,
              count: 0,
            }),
            {
              status: 200,
              headers: { "Content-Type": "application/json" },
            },
          ),
        );
      }),
    );

    const result = await searchLoader({
      request: new Request("http://localhost/search?search=charizard"),
      params: {},
      context: undefined,
    } as never);

    expect(result.search).toBe("charizard");
    expect(result.data.items).toEqual([]);
  });

  it("renders an empty discovery result when marketplace category reads fail", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn((input: string | URL | Request) => {
        const url = String(input);

        if (url.includes("/api/marketplace/categories")) {
          return Promise.resolve(
            new Response(JSON.stringify({ error: "Connection timeout." }), {
              status: 500,
              headers: { "Content-Type": "application/json" },
            }),
          );
        }

        return Promise.resolve(
          new Response(
            JSON.stringify({
              items: [],
              total: 0,
              count: 0,
              nextCursor: null,
            }),
            {
              status: 200,
              headers: { "Content-Type": "application/json" },
            },
          ),
        );
      }),
    );

    const result = await searchLoader({
      request: new Request("http://localhost/search?search=charizard"),
      params: {},
      context: undefined,
    } as never);

    expect(result.categories).toEqual([]);
    expect(result.data.items).toEqual([]);
  });

  it("renders an empty discovery result when marketplace search reads fail", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn((input: string | URL | Request) => {
        const url = String(input);

        if (url.includes("/api/marketplace/categories")) {
          return Promise.resolve(
            new Response(JSON.stringify({ items: [], total: 0, count: 0 }), {
              status: 200,
              headers: { "Content-Type": "application/json" },
            }),
          );
        }

        return Promise.resolve(
          new Response(JSON.stringify({ error: "Connection timeout." }), {
            status: 500,
            headers: { "Content-Type": "application/json" },
          }),
        );
      }),
    );

    const result = await searchLoader({
      request: new Request("http://localhost/search?search=charizard"),
      params: {},
      context: undefined,
    } as never);

    expect(result.data).toEqual({
      items: [],
      facets: [],
      total: 0,
      count: 0,
      nextCursor: null,
      lexicalCount: 0,
      retrievalMode: "lexical",
    });
  });

  it("handles home-page bulk add posts through the discovery search action", async () => {
    const fetchMock = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const request = input instanceof Request ? input : null;
      const url = new URL(input instanceof Request ? input.url : String(input), "http://localhost");
      const method = init?.method ?? request?.method ?? "GET";

      if (url.pathname === "/api/auth/session") {
        return Response.json({ actor: null });
      }

      if (url.pathname === "/api/marketplace/items/bulk-cart-preview") {
        expect(url.searchParams.get("search")).toBe("pikachu");
        return Response.json({
          totalMatches: 1,
          eligibleCount: 1,
          skippedCount: 0,
          overLimit: false,
          limit: 24,
          lines: [
            {
              catalog_item_id: "cat_pikachu",
              product_id: "cat_pikachu::form:raw",
              title: "Pikachu",
              subtitle: "Jungle 60/64 Common",
              image_url: null,
              image_srcset: null,
              image_loading_url: null,
              image_loading_alt: null,
              image_loading_srcset: null,
              selected_options: [],
              product_summary: "Raw",
              quantity: 1,
            },
          ],
          skippedItems: [],
        });
      }

      if (url.pathname === "/api/marketplace/guest/cart/bulk") {
        expect(method).toBe("POST");
        expect(new Headers(init?.headers).get("x-checkout-anonymous-cart-id")).toBe("anon_cart_1");
        return Response.json({
          addedLineCount: 1,
          mergedLineCount: 0,
          failedLineCount: 0,
          requestedLineCount: 1,
        });
      }

      return new Response(JSON.stringify({ error: `Unexpected request to ${url.pathname}` }), { status: 500 });
    });
    vi.stubGlobal("fetch", fetchMock);

    const formData = new FormData();
    formData.set("intent", "commit-bulk-add");
    const response = await homeAction({
      request: new Request("http://localhost/?q=pikachu", {
        method: "POST",
        body: formData,
        headers: { cookie: "chase_sets_anonymous_cart=anon_cart_1" },
      }),
      params: {},
      context: undefined,
    } as never);

    await expect(response.json()).resolves.toMatchObject({
      status: "bulk-added",
      addedLineCount: 1,
      mergedLineCount: 0,
      failedLineCount: 0,
      requestedLineCount: 1,
    });
    expect(response.headers.getSetCookie().join("; ")).toContain("chase_sets_anonymous_cart=anon_cart_1");
    expect(fetchMock).toHaveBeenCalledWith(
      expect.stringContaining("/api/marketplace/items/bulk-cart-preview?search=pikachu"),
      expect.anything(),
    );
  });

  it("builds canonical URLs for marketplace pages", () => {
    expect(
      buildCanonicalUrl({
        origin: "https://marketplace.example",
        pathname: "/search",
        search: "?search=charizard",
      }),
    ).toBe("https://marketplace.example/search?search=charizard");
  });

  it("describes production Merchant crawl posture from origin and indexing configuration", () => {
    expect(
      buildMarketplaceCrawlPosture({
        origin: "https://marketplace.chasesets.com/search?q=ignored",
        shouldIndex: true,
      }),
    ).toMatchObject({
      origin: "https://marketplace.chasesets.com",
      productionOrigin: true,
      shouldIndex: true,
      sitemapUrl: "https://marketplace.chasesets.com/sitemap.xml",
      merchantFeedSubmissionAllowed: true,
    });
    expect(
      buildMarketplaceCrawlPosture({
        origin: "https://marketplace.staging.chasesets.com",
        shouldIndex: true,
      }),
    ).toMatchObject({
      productionOrigin: false,
      merchantFeedSubmissionAllowed: false,
    });
    expect(
      buildMarketplaceCrawlPosture({
        origin: "https://marketplace.chasesets.com",
        shouldIndex: false,
      }),
    ).toMatchObject({
      productionOrigin: true,
      merchantFeedSubmissionAllowed: false,
    });
  });

  it("returns search route SEO metadata", () => {
    expect(searchMeta({ data: { search: "charizard" } } as never)).toEqual(
      expect.arrayContaining([
        { title: 'Search "charizard" | Marketplace' },
        { name: "description", content: expect.any(String) },
        { property: "og:title", content: 'Search "charizard" | Marketplace' },
      ]),
    );
  });

  it("returns item detail SEO metadata", () => {
    expect(
      itemMeta({
        data: {
          item: {
            title: "Charizard ex",
            description: "Server rendered detail page.",
            image_urls: ["https://images.example/charizard.png"],
          },
        },
      } as never),
    ).toEqual(
      expect.arrayContaining([
        { title: "Charizard ex | Marketplace" },
        { property: "og:type", content: "product" },
        {
          property: "og:image",
          content: "https://images.example/charizard.png",
        },
      ]),
    );
  });

  it("loads item detail through the marketplace API", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(() =>
        Promise.resolve(
          new Response(
            JSON.stringify({
              catalog_item_id: "item-1",
              slug: "charizard-ex-item-1",
              title: "Charizard ex",
              subtitle: "Illustration Rare",
              description: "Server rendered detail page.",
              blueprint_id: "bp-1",
              blueprint: { blueprintId: "bp-1", name: "Pokemon Card" },
              status: "active",
              field_values: [],
              categories: [],
              tags: [],
              image_urls: [],
              market_summary: null,
              market_listings: [],
              offer_demand_matches: [],
              product_schema: null,
              updated_at: "2026-03-26T00:00:00.000Z",
            }),
            {
              status: 200,
              headers: { "Content-Type": "application/json" },
            },
          ),
        ),
      ),
    );

    const result = await itemLoader({
      request: new Request("http://localhost/items/charizard-ex-item-1"),
      params: { id: "charizard-ex-item-1" },
      context: undefined,
    } as never);

    expect(result.notFound).toBe(false);
    expect(result.item?.title).toBe("Charizard ex");
  });

  it("returns a not-found item detail payload when the marketplace API errors", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(() =>
        Promise.resolve(
          new Response(JSON.stringify({ error: "Item not found." }), {
            status: 404,
            headers: { "Content-Type": "application/json" },
          }),
        ),
      ),
    );

    const result = await itemLoader({
      request: new Request("http://localhost/items/missing-item"),
      params: { id: "missing-item" },
      context: undefined,
    } as never);

    expect(result.notFound).toBe(true);
    expect(result.item).toBeNull();
  });

  it("loads account detail through the identity API", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn((input: string | URL | Request) => {
        const url = String(input);

        if (url.includes("/api/auth/session")) {
          return Promise.resolve(
            new Response(
              JSON.stringify({
                actor: {
                  sessionId: "ses_1",
                  tenantId: "tnt_identity",
                  userId: "usr_1",
                  accountId: "acc_1",
                  membershipId: "mbr_1",
                  roleKey: "owner",
                  permissions: ["accounts.view"],
                },
              }),
              {
                status: 200,
                headers: { "Content-Type": "application/json" },
              },
            ),
          );
        }

        return Promise.resolve(
          new Response(
            JSON.stringify({
              account_id: "acc_1",
              name: "North Store LLC",
              display_name: "North Store",
              account_type: "business",
              status: "active",
              updated_at: "2026-03-26T00:00:00.000Z",
            }),
            {
              status: 200,
              headers: { "Content-Type": "application/json" },
            },
          ),
        );
      }),
    );

    const result = await accountLoader({
      request: new Request("http://localhost/account"),
      params: {},
      context: undefined,
    } as never);

    expect(result.account.display_name).toBe("North Store");
  });

  it("serves marketplace static endpoints", async () => {
    vi.stubEnv("CHASE_SETS_MARKETPLACE_INDEXING", "true");
    const robots = await robotsLoader({
      request: new Request("https://marketplace.example/robots.txt"),
      params: {},
      context: undefined,
    } as never);

    expect(robots.headers.get("Content-Type")).toContain("text/plain");
    await expect(robots.text()).resolves.toContain("Sitemap: https://marketplace.example/sitemap.xml");
    expect(
      buildMarketplaceRobotsTxt({
        origin: "https://marketplace.example",
        shouldIndex: true,
      }),
    ).toContain("Allow: /");
    const favicon = faviconLoader({
      request: new Request("https://marketplace.example/favicon.ico"),
      params: {},
      context: undefined,
    } as never);

    expect(favicon.headers.get("Content-Type")).toContain("image/svg+xml");
    const body = await favicon.text();

    expect(body).toContain("<svg");
    expect(body).toContain("logoGradient");
    const devtools = await chromeDevtoolsLoader({
      request: new Request("https://marketplace.example/.well-known/appspecific/com.chrome.devtools.json"),
      params: {},
      context: undefined,
    } as never);

    expect(devtools.status).toBe(204);
    expect(devtools.headers.get("Cache-Control")).toBe("no-store");
    const health = healthReadyLoader({
      request: new Request("https://marketplace.example/health/ready"),
      params: {},
      context: undefined,
    } as never);

    expect(health.headers.get("Content-Type")).toContain("application/json");
    await expect(health.json()).resolves.toMatchObject({
      ok: true,
      service: "marketplace",
      origin: "https://marketplace.example",
    });
    const sitemap = await sitemapLoader({
      request: new Request("https://marketplace.example/sitemap.xml"),
      params: {},
      context: undefined,
    } as never);

    expect(sitemap.headers.get("Content-Type")).toContain("application/xml");
    await expect(sitemap.text()).resolves.toContain("<loc>https://marketplace.example/search</loc>");
    const manifest = manifestLoader({
      request: new Request("https://marketplace.example/manifest.webmanifest"),
      params: {},
      context: undefined,
    } as never);

    expect(manifest.headers.get("Content-Type")).toContain("application/manifest+json");
    await expect(manifest.json()).resolves.toMatchObject({
      name: "Chase Sets",
      short_name: "Chase Sets",
      start_url: "/",
      scope: "/",
      display: "standalone",
      icons: expect.arrayContaining([
        expect.objectContaining({
          src: "/icons/chase-sets-192.png",
          sizes: "192x192",
          purpose: "any",
        }),
        expect.objectContaining({
          src: "/icons/chase-sets-maskable-512.png",
          sizes: "512x512",
          purpose: "maskable",
        }),
      ]),
    });
    const serviceWorker = serviceWorkerLoader({
      request: new Request("https://marketplace.example/service-worker.js"),
      params: {},
      context: undefined,
    } as never);

    expect(serviceWorker.headers.get("Content-Type")).toContain("application/javascript");
    expect(serviceWorker.headers.get("Service-Worker-Allowed")).toBe("/");
    await expect(serviceWorker.text()).resolves.toContain('addEventListener("fetch"');
  });

  it("can noindex marketplace staging through environment configuration", async () => {
    vi.stubEnv("CHASE_SETS_MARKETPLACE_INDEXING", "false");

    const robots = await robotsLoader({
      request: new Request("https://marketplace.staging.chasesets.com/robots.txt"),
      params: {},
      context: undefined,
    } as never);

    expect(robots.headers.get("Content-Type")).toContain("text/plain");
    await expect(robots.text()).resolves.toContain("Disallow: /");
    expect(
      buildMarketplaceRobotsTxt({
        origin: "https://marketplace.staging.chasesets.com",
        shouldIndex: false,
      }),
    ).not.toContain("Sitemap:");
  });

  it("serves public resource routes without an extra launch gate", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(() => Promise.resolve(Response.json({ items: [] }))),
    );

    const responses = await Promise.all(
      [
        () =>
          robotsLoader({
            request: new Request("https://marketplace.chasesets.com/robots.txt"),
            params: {},
            context: undefined,
          } as never),
        () =>
          sitemapLoader({
            request: new Request("https://marketplace.chasesets.com/sitemap.xml"),
            params: {},
            context: undefined,
          } as never),
        () =>
          chromeDevtoolsLoader({
            request: new Request("https://marketplace.chasesets.com/.well-known/appspecific/com.chrome.devtools.json"),
            params: {},
            context: undefined,
          } as never),
      ].map((loadResource) => loadResource()),
    );

    expect(responses.map((response) => response.status)).toEqual([200, 200, 204]);
  });

  it("returns sign-in route SEO metadata", () => {
    expect(signInMeta({} as never)).toEqual(expect.arrayContaining([{ title: "Sign In | Marketplace" }]));
  });
});
