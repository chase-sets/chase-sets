import { renderToString } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import { MemoryRouter } from "react-router";
import type { ReactNode } from "react";
import { DiscoveryShellLayout } from "@chase-sets/discovery/web";
import { buildCanonicalUrl } from "../seo";
import { resolveMarketplaceNavItems } from "../host";
import { loader as accountLoader } from "@chase-sets/identity/routes/marketplace/account";
import { loader as chromeDevtoolsLoader } from "./chrome-devtools";
import { loader as faviconLoader } from "./favicon";
import {
  loader as itemLoader,
  meta as itemMeta,
} from "@chase-sets/discovery/routes/item-detail";
import { loader as robotsLoader } from "./robots";
import {
  loader as searchLoader,
  meta as searchMeta,
} from "@chase-sets/discovery/routes/search";
import { meta as signInMeta } from "@chase-sets/auth/routes/marketplace/sign-in";
import { loader as sitemapLoader } from "./sitemap";

describe("marketplace SSR routes", () => {
  function renderMarketplaceShell(children: ReactNode) {
    return (
      <DiscoveryShellLayout
        activeKey="search"
        topNavItems={resolveMarketplaceNavItems("top-nav")}
        bottomNavItems={resolveMarketplaceNavItems("bottom-nav")}
      >
        {children}
      </DiscoveryShellLayout>
    );
  }

  it("renders search results into HTML before hydration", () => {
    const html = renderToString(
      <MemoryRouter>
        {renderMarketplaceShell(
          <div>Search route outlet</div>
        )}
      </MemoryRouter>,
    );

    expect(html).toContain("Marketplace");
    expect(html).toContain("Search route outlet");
  });

  it("renders item detail content into HTML before hydration", () => {
    const html = renderToString(
      renderMarketplaceShell(
        <div>Item detail route outlet</div>
      ),
    );

    expect(html).toContain("Item detail route outlet");
  });

  it("renders identity entry content into HTML before hydration", () => {
    const html = renderToString(
      renderMarketplaceShell(
        <div>Sign-in route outlet</div>
      ),
    );

    expect(html).toContain("Sign-in route outlet");
  });

  it("renders account profile content into HTML before hydration", () => {
    const html = renderToString(
      renderMarketplaceShell(
        <div>Account route outlet</div>
      ),
    );

    expect(html).toContain("Account route outlet");
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

  it("builds canonical URLs for marketplace pages", () => {
    expect(
      buildCanonicalUrl({
        origin: "https://marketplace.example",
        pathname: "/search",
        search: "?search=charizard",
      }),
    ).toBe("https://marketplace.example/search?search=charizard");
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
              item_id: "item-1",
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
              version_schema: null,
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
      request: new Request("http://localhost/items/item-1"),
      params: { id: "item-1" },
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

  it("serves robots.txt from the marketplace app", async () => {
    const response = robotsLoader({
      request: new Request("https://marketplace.example/robots.txt"),
      params: {},
      context: undefined,
    } as never);

    expect(response.headers.get("Content-Type")).toContain("text/plain");
    await expect(response.text()).resolves.toContain(
      "Sitemap: https://marketplace.example/sitemap.xml",
    );
  });

  it("serves a favicon from the marketplace app", async () => {
    const response = faviconLoader({
      request: new Request("https://marketplace.example/favicon.ico"),
      params: {},
      context: undefined,
    } as never);

    expect(response.headers.get("Content-Type")).toContain("image/svg+xml");
    await expect(response.text()).resolves.toContain("<svg");
  });

  it("absorbs the chrome devtools probe", () => {
    const response = chromeDevtoolsLoader({
      request: new Request(
        "https://marketplace.example/.well-known/appspecific/com.chrome.devtools.json",
      ),
      params: {},
      context: undefined,
    } as never);

    expect(response.status).toBe(204);
    expect(response.headers.get("Cache-Control")).toBe("no-store");
  });

  it("serves a minimal sitemap from the marketplace app", async () => {
    const response = sitemapLoader({
      request: new Request("https://marketplace.example/sitemap.xml"),
      params: {},
      context: undefined,
    } as never);

    expect(response.headers.get("Content-Type")).toContain("application/xml");
    await expect(response.text()).resolves.toContain(
      "<loc>https://marketplace.example/search</loc>",
    );
  });

  it("returns sign-in route SEO metadata", () => {
    expect(signInMeta({} as never)).toEqual(
      expect.arrayContaining([{ title: "Sign In | Marketplace" }]),
    );
  });
});

