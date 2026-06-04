import { describe, expect, it } from "vitest";
import {
  GOOGLE_SHOPPING_CRAWL_POSTURE_EVIDENCE_VERSION,
  buildGoogleShoppingCrawlPostureEvidence,
  parseGoogleShoppingCrawlPostureArgs,
  runGoogleShoppingCrawlPostureEvidence,
} from "./google-shopping-crawl-posture-evidence.mjs";

const sampleUrl = "https://marketplace.chasesets.com/listings/charizard-lst_1";

describe("google shopping crawl posture evidence", () => {
  it("passes production crawl evidence when robots, sitemap, and canonical URLs align", () => {
    const evidence = buildGoogleShoppingCrawlPostureEvidence({
      baseUrl: "https://marketplace.chasesets.com",
      expectedIndexing: true,
      checkedAt: "2026-06-04T00:00:00.000Z",
      sampledFeedLinks: [sampleUrl],
      robotsStatus: 200,
      robotsText: ["User-agent: *", "Allow: /", "Sitemap: https://marketplace.chasesets.com/sitemap.xml"].join("\n"),
      sitemapStatus: 200,
      sitemapXml: sitemap(sampleUrl),
      sampleStatusByUrl: { [sampleUrl]: 200 },
      canonicalHtmlByUrl: {
        [sampleUrl]: `<html><head><link rel="canonical" href="${sampleUrl}"></head></html>`,
      },
    });

    expect(evidence).toMatchObject({
      schemaVersion: GOOGLE_SHOPPING_CRAWL_POSTURE_EVIDENCE_VERSION,
      productionOrigin: true,
      merchantFeedSubmissionAllowed: true,
      passesGoogleShoppingCrawlPostureGate: true,
      sitemap: {
        missingSampledFeedLinks: [],
      },
      canonical: {
        mismatches: [],
      },
    });
  });

  it("passes noindex evidence while blocking Merchant feed submission", () => {
    const evidence = buildGoogleShoppingCrawlPostureEvidence({
      baseUrl: "https://marketplace.staging.chasesets.com",
      expectedIndexing: false,
      checkedAt: "2026-06-04T00:00:00.000Z",
      sampledFeedLinks: [],
      robotsStatus: 200,
      robotsText: ["User-agent: *", "Disallow: /"].join("\n"),
      sitemapStatus: 200,
      sitemapXml: sitemap(),
      sampleStatusByUrl: {},
      canonicalHtmlByUrl: {},
    });

    expect(evidence).toMatchObject({
      productionOrigin: false,
      merchantFeedSubmissionAllowed: false,
      passesGoogleShoppingCrawlPostureGate: true,
      robots: {
        disallowsAll: true,
      },
    });
  });

  it("fails production evidence when sitemap or canonical URLs do not match sampled feed links", () => {
    const evidence = buildGoogleShoppingCrawlPostureEvidence({
      baseUrl: "https://marketplace.chasesets.com",
      expectedIndexing: true,
      checkedAt: "2026-06-04T00:00:00.000Z",
      sampledFeedLinks: [sampleUrl],
      robotsStatus: 200,
      robotsText: ["User-agent: *", "Allow: /", "Sitemap: https://marketplace.chasesets.com/sitemap.xml"].join("\n"),
      sitemapStatus: 200,
      sitemapXml: sitemap("https://marketplace.chasesets.com/listings/other-lst_2"),
      sampleStatusByUrl: { [sampleUrl]: 200 },
      canonicalHtmlByUrl: {
        [sampleUrl]:
          '<html><head><link href="https://marketplace.chasesets.com/listings/other-lst_2" rel="canonical"></head></html>',
      },
    });

    expect(evidence.passesGoogleShoppingCrawlPostureGate).toBe(false);
    expect(evidence.merchantFeedSubmissionAllowed).toBe(false);
    expect(evidence.errors).toEqual(
      expect.arrayContaining([
        "Every sampled eligible feed link must appear in sitemap.xml.",
        `Sampled feed link ${sampleUrl} must render a matching canonical URL.`,
      ]),
    );
  });

  it("fetches robots, sitemap, and sampled pages for the CLI evidence runner", async () => {
    const fetchImpl = async (url) => {
      if (String(url).endsWith("/robots.txt")) {
        return response(
          ["User-agent: *", "Allow: /", "Sitemap: https://marketplace.chasesets.com/sitemap.xml"].join("\n"),
        );
      }
      if (String(url).endsWith("/sitemap.xml")) {
        return response(sitemap(sampleUrl));
      }
      return response(`<html><head><link rel="canonical" href="${sampleUrl}"></head></html>`);
    };

    const evidence = await runGoogleShoppingCrawlPostureEvidence(
      {
        baseUrl: "https://marketplace.chasesets.com",
        expectedIndexing: true,
        sampledFeedLinks: [sampleUrl],
        checkedAt: "2026-06-04T00:00:00.000Z",
      },
      fetchImpl,
    );

    expect(evidence.passesGoogleShoppingCrawlPostureGate).toBe(true);
  });

  it("parses base URL and sampled feed links from flags", () => {
    expect(
      parseGoogleShoppingCrawlPostureArgs([
        "--base-url",
        "https://marketplace.chasesets.com",
        "--expect-indexing",
        "false",
        "--sample-url",
        sampleUrl,
      ]),
    ).toMatchObject({
      baseUrl: "https://marketplace.chasesets.com",
      expectedIndexing: false,
      sampledFeedLinks: [sampleUrl],
    });
  });
});

function sitemap(...urls) {
  return [
    '<?xml version="1.0" encoding="UTF-8"?>',
    '<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">',
    ...urls.map((url) => `<url><loc>${url}</loc></url>`),
    "</urlset>",
  ].join("");
}

function response(body, status = 200) {
  return {
    status,
    text: async () => body,
  };
}
