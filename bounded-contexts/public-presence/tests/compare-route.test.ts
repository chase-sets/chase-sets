import { createHash } from "node:crypto";
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

// #7178 AC3: independent base-oracle FAQPage JSON-LD parity. These literals were
// captured by executing compareTcgplayerJsonLd()/compareEbayJsonLd() against the
// exact implementation base d195db159569313ae9570a981f2464f9dbc88930 (the compare
// routes and buildCompareStructuredData/buildCompareFaqEntries are untouched by
// this issue) before the FAQ disclosure-collapse change landed. Never regenerate
// these strings from candidate code; a candidate-only byte change must fail here.
const baseTcgplayerFaqJsonLd =
  '{"@context":"https://schema.org","@graph":[{"@type":"WebPage","@id":"https://chasesets.com/compare/tcgplayer#webpage","name":"TCGplayer Seller Fees vs Chase Sets | 2026 Comparison","description":"Compare TCGplayer marketplace commission, payment processing, protection, payouts, and game coverage with Chase Sets — with a live fee calculator and dated, sourced numbers.","url":"https://chasesets.com/compare/tcgplayer","isPartOf":{"@type":"WebSite","@id":"https://chasesets.com/#website","name":"Chase Sets","url":"https://chasesets.com/"}},{"@type":"BreadcrumbList","@id":"https://chasesets.com/compare/tcgplayer#breadcrumbs","itemListElement":[{"@type":"ListItem","position":1,"name":"Chase Sets","item":"https://chasesets.com/"},{"@type":"ListItem","position":2,"name":"Chase Sets vs TCGplayer for selling trading cards","item":"https://chasesets.com/compare/tcgplayer"}]},{"@type":"FAQPage","@id":"https://chasesets.com/compare/tcgplayer#faq","mainEntity":[{"@type":"Question","name":"How much does TCGplayer charge to sell trading cards?","acceptedAnswer":{"@type":"Answer","text":"As of July 12, 2026, TCGplayer\'s published fees for standard marketplace sellers are a 10.75% marketplace commission, capped at $75.00 per item, plus 2.5% + $0.30 payment processing per order. Shipping, tax, store subscriptions, and promotions can add to what a seller pays."}},{"@type":"Question","name":"What does Chase Sets charge sellers?","acceptedAnswer":{"@type":"Answer","text":"Chase Sets publishes one standard seller fee schedule: a percentage of the item price with a per-item cap, and no separate seller payment-processing fee. Every listing locks its fee the moment it is created. The calculator on this page loads the current numbers live from the published schedule."}},{"@type":"Question","name":"Will I keep more of the sale on Chase Sets than on TCGplayer?","acceptedAnswer":{"@type":"Answer","text":"It depends on the sale price and order size, so run your own numbers. The calculator on this page applies each marketplace\'s published schedule to the same order, rounding competitor fees down in the competitor\'s favor. Listings created during a founder\'s 60-day window lock 0% seller fees until they sell."}},{"@type":"Question","name":"Is Chase Sets live yet?","acceptedAnswer":{"@type":"Answer","text":"Not yet. Chase Sets opens to everyone on September 1, 2026, and beta invite waves begin late July 2026. Join the waitlist for an invite before launch and founders offer eligibility."}}]}]}';
const baseTcgplayerFaqJsonLdBytes = 2503;
const baseTcgplayerFaqJsonLdSha256 = "7c97384a433a829f9f34725db8c7a144007ca35f4fce6f2c84ae257f87b67be2";

const baseEbayFaqJsonLd =
  '{"@context":"https://schema.org","@graph":[{"@type":"WebPage","@id":"https://chasesets.com/compare/ebay#webpage","name":"eBay Trading Card Seller Fees vs Chase Sets | 2026 Comparison","description":"Compare eBay trading-card final value fees, per-order fees, protection, payouts, and coverage with Chase Sets — with a live fee calculator and dated, sourced numbers.","url":"https://chasesets.com/compare/ebay","isPartOf":{"@type":"WebSite","@id":"https://chasesets.com/#website","name":"Chase Sets","url":"https://chasesets.com/"}},{"@type":"BreadcrumbList","@id":"https://chasesets.com/compare/ebay#breadcrumbs","itemListElement":[{"@type":"ListItem","position":1,"name":"Chase Sets","item":"https://chasesets.com/"},{"@type":"ListItem","position":2,"name":"Chase Sets vs eBay for selling trading cards","item":"https://chasesets.com/compare/ebay"}]},{"@type":"FAQPage","@id":"https://chasesets.com/compare/ebay#faq","mainEntity":[{"@type":"Question","name":"How much does eBay charge to sell trading cards?","acceptedAnswer":{"@type":"Answer","text":"As of July 12, 2026, eBay\'s published trading-cards fees for sellers without a store are a 13.25% final value fee on the portion of a sale up to $7,500.00, plus 2.35% above it. Payment processing is included. There\'s also a $0.30 per-order fee ($0.40 on orders over $10.00). Store subscriptions, optional listing upgrades, and promoted listings can change what a seller pays."}},{"@type":"Question","name":"What does Chase Sets charge sellers?","acceptedAnswer":{"@type":"Answer","text":"Chase Sets publishes one standard seller fee schedule: a percentage of the item price with a per-item cap, and no separate seller payment-processing fee. Every listing locks its fee the moment it is created. The calculator on this page loads the current numbers live from the published schedule."}},{"@type":"Question","name":"Will I keep more of the sale on Chase Sets than on eBay?","acceptedAnswer":{"@type":"Answer","text":"It depends on the sale price and order size, so run your own numbers. The calculator on this page applies each marketplace\'s published schedule to the same order, rounding competitor fees down in the competitor\'s favor. Listings created during a founder\'s 60-day window lock 0% seller fees until they sell."}},{"@type":"Question","name":"Is Chase Sets live yet?","acceptedAnswer":{"@type":"Answer","text":"Not yet. Chase Sets opens to everyone on September 1, 2026, and beta invite waves begin late July 2026. Join the waitlist for an invite before launch and founders offer eligibility."}}]}]}';
const baseEbayFaqJsonLdBytes = 2565;
const baseEbayFaqJsonLdSha256 = "2eb7bd427f0d13be8bd0d6a08a278e3e1e08d8ce92490082cde9685d240e45e5";

function sha256Hex(value: string) {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

function byteLength(value: string) {
  return new TextEncoder().encode(value).length;
}

describe("compare-page FAQ disclosure collapse: exact-base FAQPage JSON-LD oracle (#7178)", () => {
  it("keeps TCGplayer FAQPage JSON-LD byte-identical to the exact-base oracle", () => {
    const headJsonLd = JSON.stringify(compareTcgplayerJsonLd());
    expect(headJsonLd).toBe(baseTcgplayerFaqJsonLd);
    expect(byteLength(headJsonLd)).toBe(baseTcgplayerFaqJsonLdBytes);
    expect(sha256Hex(headJsonLd)).toBe(baseTcgplayerFaqJsonLdSha256);
  });

  it("keeps eBay FAQPage JSON-LD byte-identical to the exact-base oracle", () => {
    const headJsonLd = JSON.stringify(compareEbayJsonLd());
    expect(headJsonLd).toBe(baseEbayFaqJsonLd);
    expect(byteLength(headJsonLd)).toBe(baseEbayFaqJsonLdBytes);
    expect(sha256Hex(headJsonLd)).toBe(baseEbayFaqJsonLdSha256);
  });
});
