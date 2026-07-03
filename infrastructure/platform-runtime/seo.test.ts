import { describe, expect, it } from "vitest";
import { buildCanonicalUrl, buildRobotsTxt, buildSitemapXml, shouldIndexFromEnv } from "./seo";

describe("seo helpers", () => {
  it("builds canonical URLs with optional query preservation", () => {
    expect(buildCanonicalUrl({ origin: "https://example.test", pathname: "/search", search: "?q=cards" })).toBe(
      "https://example.test/search?q=cards",
    );
    expect(
      buildCanonicalUrl({
        origin: "https://example.test",
        pathname: "/faq",
        search: "?ignored=true",
        includeSearch: false,
      }),
    ).toBe("https://example.test/faq");
  });

  it("resolves indexing posture from natural environment toggles", () => {
    expect(shouldIndexFromEnv("INDEXING", {})).toBe(true);
    expect(shouldIndexFromEnv("INDEXING", { INDEXING: "false" })).toBe(false);
    expect(shouldIndexFromEnv("INDEXING", { INDEXING: "off" })).toBe(false);
    expect(shouldIndexFromEnv("INDEXING", { INDEXING: "yes" })).toBe(true);
  });

  it("builds robots and sitemap documents", () => {
    expect(buildRobotsTxt({ origin: "https://example.test", shouldIndex: true })).toContain(
      "Sitemap: https://example.test/sitemap.xml",
    );
    expect(buildRobotsTxt({ origin: "https://example.test", shouldIndex: false })).toBe(
      ["User-agent: *", "Disallow: /"].join("\n"),
    );

    const sitemap = buildSitemapXml("https://example.test", [
      { path: "/search?q=a&b=<card>", updatedAt: "2026-07-03T00:00:00.000Z" },
    ]);

    expect(sitemap).toContain("<loc>https://example.test/search?q=a&amp;b=%3Ccard%3E</loc>");
    expect(sitemap).toContain("<lastmod>2026-07-03T00:00:00.000Z</lastmod>");
  });
});
