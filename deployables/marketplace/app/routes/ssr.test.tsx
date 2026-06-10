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
    });
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

  it("does not expose resource routes before production proof access is authenticated", async () => {
    vi.stubEnv("CHASE_SETS_MARKETPLACE_PROOF_ACCESS_REQUIRED", "true");
    vi.stubGlobal(
      "fetch",
      vi.fn(() =>
        Promise.resolve(new Response(JSON.stringify({ error: "Authentication required." }), { status: 401 })),
      ),
    );

    for (const loadResource of [
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
    ]) {
      let thrown: unknown;
      try {
        await loadResource();
      } catch (error) {
        thrown = error;
      }

      expect(thrown).toBeInstanceOf(Response);
      expect((thrown as Response).status).toBe(302);
      expect((thrown as Response).headers.get("Location")).toMatch(/^\/sign-in\?returnTo=/);
    }
  });

  it("returns sign-in route SEO metadata", () => {
    expect(signInMeta({} as never)).toEqual(expect.arrayContaining([{ title: "Sign In | Marketplace" }]));
  });
});
