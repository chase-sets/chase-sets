import { renderToString } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import { resolvePublicRouteConfigRecords } from "../host";
import { buildCanonicalUrl } from "../seo";
import PublicNotFoundRoute from "./not-found";
import { loader as robotsLoader } from "./robots";
import { loader as sitemapLoader } from "./sitemap";

describe("public web deployable", () => {
  it("mounts public-presence routes without marketplace browse routes", () => {
    const routeRecords = resolvePublicRouteConfigRecords();
    const routePaths = routeRecords.map((routeRecord) => routeRecord.routePath);

    expect(new Set(routeRecords.map((routeRecord) => routeRecord.contextName))).toEqual(
      new Set(["public-presence"]),
    );
    expect(routePaths).toEqual([
      "",
      "faq",
      "contact",
      "terms",
      "privacy",
      "refunds-and-returns",
      "buyer-protection",
      "seller-fees",
    ]);
    expect(routePaths).not.toContain("search");
    expect(routePaths).not.toContain("items/:id");
  });

  it("canonicalizes public pages to chasesets.com", () => {
    expect(
      buildCanonicalUrl({
        origin: "https://chasesets.com",
        pathname: "/terms",
        search: "?utm_source=launch&utm_campaign=beta",
      }),
    ).toBe("https://chasesets.com/terms");
  });

  it("serves a prelaunch-only sitemap and robots file", async () => {
    vi.stubEnv("CHASE_SETS_PUBLIC_INDEXING", "true");
    const sitemap = sitemapLoader({
      request: new Request("https://example.test/sitemap.xml"),
      params: {},
      context: undefined,
    } as never);
    const sitemapBody = await sitemap.text();

    expect(sitemap.headers.get("Content-Type")).toContain("application/xml");
    expect(sitemapBody).toContain("<loc>https://chasesets.com/</loc>");
    expect(sitemapBody).toContain("<loc>https://chasesets.com/faq</loc>");
    expect(sitemapBody).not.toContain("https://chasesets.com/search");
    expect(sitemapBody).not.toContain("/items/");

    const robots = robotsLoader({
      request: new Request("https://example.test/robots.txt"),
      params: {},
      context: undefined,
    } as never);

    expect(robots.headers.get("Content-Type")).toContain("text/plain");
    await expect(robots.text()).resolves.toContain(
      "Sitemap: https://chasesets.com/sitemap.xml",
    );
    vi.unstubAllEnvs();
  });

  it("can noindex staging through environment configuration", async () => {
    vi.stubEnv("CHASE_SETS_PUBLIC_INDEXING", "false");
    const robots = robotsLoader({
      request: new Request("https://www.staging.chasesets.com/robots.txt"),
      params: {},
      context: undefined,
    } as never);

    await expect(robots.text()).resolves.toContain("Disallow: /");
    vi.unstubAllEnvs();
  });

  it("does not offer marketplace browse recovery on not found pages", () => {
    const html = renderToString(<PublicNotFoundRoute />);

    expect(html).toContain("Page not found");
    expect(html).toContain('href="/"');
    expect(html).not.toContain("Browse marketplace");
    expect(html).not.toContain('href="/search"');
  });
});
