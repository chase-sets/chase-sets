import { renderToString } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import { resolvePublicRouteConfigRecords } from "../host";
import { buildCanonicalUrl } from "../seo";
import { loader as manifestLoader } from "./manifest";
import { loader as healthReadyLoader } from "./health-ready";
import PublicNotFoundRoute from "./not-found";
import { loader as notFoundLoader } from "./not-found";
import { loader as orderProtectionRedirectLoader } from "./order-protection-redirect";
import { loader as robotsLoader } from "./robots";
import { loader as salesFeesRedirectLoader } from "./sales-fees-redirect";
import { loader as sitemapLoader } from "./sitemap";
import { waitlistAnalyticsBridgeScript } from "../root";

describe("public web deployable", () => {
  it("mounts public-presence and pricing public market routes without marketplace browse routes", () => {
    const routeRecords = resolvePublicRouteConfigRecords();
    const routePaths = routeRecords.map((routeRecord) => routeRecord.routePath);

    expect(new Set(routeRecords.map((routeRecord) => routeRecord.contextName))).toEqual(
      new Set(["commercial-terms", "pricing", "public-presence"]),
    );
    expect(routePaths).toEqual([
      "sales-fees",
      "market/:slug",
      "",
      "welcome",
      "help",
      "help/:category",
      "help/:category/:slug",
      "faq",
      "contact",
      "terms",
      "privacy",
      "refunds-and-returns",
      "order-protection",
      "founders",
      "compare/tcgplayer",
      "compare/ebay",
      "press",
    ]);
    expect(routePaths).not.toContain("search");
    expect(routePaths).not.toContain("items/:id");
  });

  it("installs a bounded waitlist analytics bridge script", () => {
    expect(waitlistAnalyticsBridgeScript).toContain("chase-sets:waitlist-analytics");
    expect(waitlistAnalyticsBridgeScript).toContain("/api/public-presence/analytics/waitlist");
    expect(waitlistAnalyticsBridgeScript).toContain("page_path");
    expect(waitlistAnalyticsBridgeScript).toContain("utm_source");
    expect(waitlistAnalyticsBridgeScript).toContain("readAttribution");
    expect(waitlistAnalyticsBridgeScript).not.toContain("email");
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
    const sitemap = await sitemapLoader({
      request: new Request("https://example.test/sitemap.xml"),
      params: {},
      context: undefined,
    } as never);
    const sitemapBody = await sitemap.text();

    expect(sitemap.headers.get("Content-Type")).toContain("application/xml");
    expect(sitemapBody).toContain("<loc>https://chasesets.com/</loc>");
    expect(sitemapBody).toContain("<loc>https://chasesets.com/faq</loc>");
    expect(sitemapBody).toContain("<loc>https://chasesets.com/help</loc>");
    expect(sitemapBody).toContain("<loc>https://chasesets.com/compare/tcgplayer</loc>");
    expect(sitemapBody).toContain("<loc>https://chasesets.com/compare/ebay</loc>");
    expect(sitemapBody).toContain("<loc>https://chasesets.com/help/buying/order-protection</loc>");
    expect(sitemapBody).toContain("<loc>https://chasesets.com/help/selling</loc>");
    expect(sitemapBody).not.toContain("https://chasesets.com/search");
    expect(sitemapBody).not.toContain("/items/");

    const robots = robotsLoader({
      request: new Request("https://example.test/robots.txt"),
      params: {},
      context: undefined,
    } as never);

    expect(robots.headers.get("Content-Type")).toContain("text/plain");
    await expect(robots.text()).resolves.toContain("Sitemap: https://chasesets.com/sitemap.xml");
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

  it("serves a manifest without missing icon references", async () => {
    const manifest = manifestLoader({
      request: new Request("https://example.test/manifest.webmanifest"),
      params: {},
      context: undefined,
    } as never);
    const body = (await manifest.json()) as { name: string; icons: unknown[] };

    expect(manifest.headers.get("Content-Type")).toContain("application/manifest+json");
    expect(body.name).toBe("Chase Sets");
    expect(body.icons).toEqual([]);
  });

  it("serves public web readiness", async () => {
    const health = healthReadyLoader({
      request: new Request("https://public.example/health/ready"),
      params: {},
      context: undefined,
    } as never);

    expect(health.headers.get("Content-Type")).toContain("application/json");
    await expect(health.json()).resolves.toMatchObject({
      ok: true,
      service: "public-web",
      origin: "https://public.example",
    });
  });

  it("does not offer marketplace browse recovery on not found pages", () => {
    const html = renderToString(<PublicNotFoundRoute />);

    expect(html).toContain("Page not found");
    expect(html).toContain('href="/"');
    expect(html).not.toContain("Browse marketplace");
    expect(html).not.toContain('href="/search"');
  });

  it("serves unknown public routes as real 404 responses", () => {
    const response = notFoundLoader();

    expect(response.status).toBe(404);
  });

  it("redirects renamed policy URLs to their canonical public pages", () => {
    expectRedirect(orderProtectionRedirectLoader, "/order-protection");
    expectRedirect(salesFeesRedirectLoader, "/sales-fees");
  });
});

function expectRedirect(loader: () => unknown, location: string) {
  try {
    loader();
  } catch (error) {
    expect(error).toBeInstanceOf(Response);
    expect((error as Response).status).toBe(301);
    expect((error as Response).headers.get("Location")).toBe(location);
    return;
  }

  throw new Error(`Expected redirect to ${location}`);
}
