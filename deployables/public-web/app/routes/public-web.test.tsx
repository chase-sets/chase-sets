import { renderToString } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import { resolvePublicRouteConfigRecords } from "../host";
import { buildCanonicalUrl } from "../seo";
import { loader as legacyMarketplaceSalesFeesUrlLoader } from "./legacy-marketplace-sales-fees-url";
import { loader as legacyOrderProtectionUrlLoader } from "./legacy-order-protection-url";
import { loader as manifestLoader } from "./manifest";
import PublicNotFoundRoute from "./not-found";
import { loader as notFoundLoader } from "./not-found";
import { loader as robotsLoader } from "./robots";
import { loader as sitemapLoader } from "./sitemap";
import { action as waitlistAnalyticsAction, loader as waitlistAnalyticsLoader } from "./waitlist-analytics";
import { waitlistAnalyticsBridgeScript } from "../root";

describe("public web deployable", () => {
  it("mounts public-presence routes without marketplace browse routes", () => {
    const routeRecords = resolvePublicRouteConfigRecords();
    const routePaths = routeRecords.map((routeRecord) => routeRecord.routePath);

    expect(new Set(routeRecords.map((routeRecord) => routeRecord.contextName))).toEqual(new Set(["public-presence"]));
    expect(routePaths).toEqual([
      "",
      "faq",
      "contact",
      "terms",
      "privacy",
      "refunds-and-returns",
      "order-protection",
      "sales-fees",
    ]);
    expect(routePaths).not.toContain("search");
    expect(routePaths).not.toContain("items/:id");
  });

  it("installs a bounded waitlist analytics bridge script", () => {
    expect(waitlistAnalyticsBridgeScript).toContain("chase-sets:waitlist-analytics");
    expect(waitlistAnalyticsBridgeScript).toContain("/analytics/waitlist");
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

  it("captures bounded waitlist analytics events", async () => {
    vi.stubEnv("OBSERVABILITY_ENABLED", "false");
    const response = await waitlistAnalyticsAction({
      request: new Request("https://chasesets.com/analytics/waitlist", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          event: "cta_clicked",
          section: "hero",
          target: "waitlist_form",
          role: "sell",
          interest: "low-sales-fees",
          variant: "seller_first_v1",
          page_path: "/?utm_source=launch&utm_campaign=beta",
          utm_source: "launch",
          utm_medium: "social",
          utm_campaign: "founder wave",
        }),
      }),
      params: {},
      context: undefined,
    } as never);

    expect(response.status).toBe(204);
    vi.unstubAllEnvs();
  });

  it("rejects unsupported waitlist analytics events", async () => {
    const response = await waitlistAnalyticsAction({
      request: new Request("https://chasesets.com/analytics/waitlist", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ event: "email_submitted", email: "seller@example.com" }),
      }),
      params: {},
      context: undefined,
    } as never);

    expect(response.status).toBe(400);
    expect(
      waitlistAnalyticsLoader({
        request: new Request("https://chasesets.com/analytics/waitlist"),
        params: {},
        context: undefined,
      } as never).status,
    ).toBe(405);
  });

  it("rejects arbitrary analytics label text before logging", async () => {
    vi.stubEnv("OBSERVABILITY_ENABLED", "false");
    const response = await waitlistAnalyticsAction({
      request: new Request("https://chasesets.com/analytics/waitlist", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          event: "cta_clicked",
          section: "seller@example.com",
          target: "waitlist form",
          role: "sell",
        }),
      }),
      params: {},
      context: undefined,
    } as never);

    expect(response.status).toBe(400);
    vi.unstubAllEnvs();
  });

  it("rejects unbounded analytics source fields before logging", async () => {
    vi.stubEnv("OBSERVABILITY_ENABLED", "false");
    const response = await waitlistAnalyticsAction({
      request: new Request("https://chasesets.com/analytics/waitlist", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          event: "landing_page_view",
          page_path: "https://evil.example/?email=seller@example.com",
          utm_source: "launch",
        }),
      }),
      params: {},
      context: undefined,
    } as never);

    expect(response.status).toBe(400);
    vi.unstubAllEnvs();
  });

  it("rejects source attribution that looks like private contact data", async () => {
    vi.stubEnv("OBSERVABILITY_ENABLED", "false");
    const response = await waitlistAnalyticsAction({
      request: new Request("https://chasesets.com/analytics/waitlist", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          event: "landing_page_view",
          page_path: "/?utm_source=seller@example.com",
          utm_source: "seller@example.com",
        }),
      }),
      params: {},
      context: undefined,
    } as never);

    expect(response.status).toBe(400);
    vi.unstubAllEnvs();
  });

  it("redirects renamed policy URLs to their canonical public pages", () => {
    expectRedirect(legacyOrderProtectionUrlLoader, "/order-protection");
    expectRedirect(legacyMarketplaceSalesFeesUrlLoader, "/sales-fees");
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
