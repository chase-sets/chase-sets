import { afterEach, describe, expect, it, vi } from "vitest";
import {
  loader as tcgplayerLoader,
  meta as tcgplayerMeta,
  compareTcgplayerJsonLd,
} from "../routes/marketplace/compare-tcgplayer";
import { loader as ebayLoader, meta as ebayMeta, compareEbayJsonLd } from "../routes/marketplace/compare-ebay";

afterEach(() => {
  vi.unstubAllGlobals();
});

const standardSchedulePolicyResponse = () =>
  new Response(
    JSON.stringify({
      values: {
        "marketplace-sales-fee.standard.bps": {
          type: "bps",
          value: 500,
          effectiveFrom: "2026-07-03T00:00:00.000Z",
          upcoming: [],
        },
        "marketplace-sales-fee.standard.fixed": { type: "money", value: "0.00", effectiveFrom: null, upcoming: [] },
        "marketplace-sales-fee.standard.cap": { type: "money", value: "25.00", effectiveFrom: null, upcoming: [] },
        "checkout-processing-fee.card.bps": {
          type: "bps",
          value: 290,
          currency: "USD",
          effectiveFrom: null,
          upcoming: [],
        },
        "checkout-processing-fee.card.fixed": {
          type: "money",
          value: "0.30",
          currency: "USD",
          effectiveFrom: null,
          upcoming: [],
        },
        "checkout-processing-fee.bank-account.bps": {
          type: "bps",
          value: 50,
          currency: "USD",
          effectiveFrom: null,
          upcoming: [],
        },
        "checkout-processing-fee.bank-account.fixed": {
          type: "money",
          value: "0.00",
          currency: "USD",
          effectiveFrom: null,
          upcoming: [],
        },
      },
      resolvedAt: "2026-07-12T00:00:00.000Z",
      propagationSeconds: 360,
      changeCalloutDays: 30,
    }),
    { headers: { "Content-Type": "application/json" } },
  );

function metaArgs(data: unknown, pathname: string) {
  return {
    data,
    params: {},
    location: { pathname, search: "", hash: "", state: null, key: "test" },
    matches: [],
    error: undefined,
  } as never;
}

describe("comparison SEO routes (#4087)", () => {
  // Order-sensitive on purpose: the shared landing-fee module memoizes a
  // SUCCESSFUL policy read for five minutes, so the failure case must run
  // before the first stubbed success in this file.
  it("keeps rendering with a null schedule (truth-gated) when the policy read fails", async () => {
    const error = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response("policy source unavailable", { status: 503 })),
    );

    try {
      const data = await tcgplayerLoader({
        request: new Request("https://chasesets.test/compare/tcgplayer"),
        params: {},
        context: undefined,
      } as never);

      expect(data.feeSchedule).toBeNull();
      expect(error).toHaveBeenCalledWith(
        expect.stringContaining("Fee-calculator policy read failed"),
        expect.anything(),
      );
    } finally {
      error.mockRestore();
      warn.mockRestore();
    }
  });

  it("loads the live fee schedule through the whitelisted public policy read", async () => {
    const fetch = vi.fn(async () => standardSchedulePolicyResponse());
    vi.stubGlobal("fetch", fetch);

    const data = await ebayLoader({
      request: new Request("https://chasesets.test/compare/ebay"),
      params: {},
      context: undefined,
    } as never);

    expect(fetch).toHaveBeenCalledWith(
      expect.stringContaining("/api/public-presence/policy-values"),
      expect.anything(),
    );
    expect(data.feeSchedule).toEqual({
      percentageBps: 500,
      fixedAmount: "0.00",
      capAmount: "25.00",
      effectiveFrom: "2026-07-03T00:00:00.000Z",
    });
    expect(data.publicOrigin).toBe("https://chasesets.test");
  });

  it("positions both pages' metadata on the competitor fee queries without owning canonical tags", () => {
    const tcgplayerDescriptors = tcgplayerMeta(metaArgs(undefined, "/compare/tcgplayer"));
    expect(tcgplayerDescriptors).toEqual(
      expect.arrayContaining([
        { title: "TCGplayer Seller Fees vs Chase Sets | 2026 Comparison" },
        { property: "og:url", content: "https://chasesets.com/compare/tcgplayer" },
      ]),
    );
    expect(tcgplayerDescriptors).not.toContainEqual(expect.objectContaining({ rel: "canonical" }));

    const ebayDescriptors = ebayMeta(metaArgs({ publicOrigin: "https://preview.chasesets.test" }, "/compare/ebay"));
    expect(ebayDescriptors).toEqual(
      expect.arrayContaining([
        { title: "eBay Trading Card Seller Fees vs Chase Sets | 2026 Comparison" },
        { property: "og:url", content: "https://preview.chasesets.test/compare/ebay" },
      ]),
    );
  });

  it("publishes FAQPage structured data whose answers cite dated competitor numbers", () => {
    const tcgplayer = compareTcgplayerJsonLd();
    expect(tcgplayer).toMatchObject({
      "@context": "https://schema.org",
      "@graph": expect.arrayContaining([
        expect.objectContaining({
          "@type": "WebPage",
          url: "https://chasesets.com/compare/tcgplayer",
          isPartOf: expect.objectContaining({ "@type": "WebSite", url: "https://chasesets.com/" }),
        }),
        expect.objectContaining({ "@type": "BreadcrumbList" }),
        expect.objectContaining({
          "@type": "FAQPage",
          mainEntity: expect.arrayContaining([
            expect.objectContaining({
              "@type": "Question",
              name: "How much does TCGplayer charge to sell trading cards?",
              acceptedAnswer: expect.objectContaining({
                text: expect.stringContaining("10.75%"),
              }),
            }),
            expect.objectContaining({ name: "Is Chase Sets live yet?" }),
          ]),
        }),
      ]),
    });
    const tcgplayerAnswer = JSON.stringify(tcgplayer);
    expect(tcgplayerAnswer).toContain("July 12, 2026");
    expect(tcgplayerAnswer).toContain("$75.00");

    const ebay = JSON.stringify(compareEbayJsonLd("https://preview.chasesets.test"));
    expect(ebay).toContain("https://preview.chasesets.test/compare/ebay");
    expect(ebay).toContain("13.25%");
    expect(ebay).toContain("2.35%");
    expect(ebay).toContain("July 12, 2026");
  });

  it("keeps every FAQ answer free of unresolved interpolation tokens", () => {
    for (const jsonLd of [compareTcgplayerJsonLd(), compareEbayJsonLd()]) {
      expect(JSON.stringify(jsonLd)).not.toMatch(/\{[A-Za-z0-9_.-]+\}/);
    }
  });
});
