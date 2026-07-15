import { afterEach, describe, expect, it, vi } from "vitest";
import { loader as articleLoader } from "../routes/marketplace/help-article";
import { loader as categoryLoader } from "../routes/marketplace/help-category";
import { loader as faqRedirectLoader } from "../routes/marketplace/faq";
import { loader as protectionRedirectLoader } from "../routes/marketplace/order-protection";
import { loader as refundsRedirectLoader } from "../routes/marketplace/refunds-and-returns";

const request = new Request("https://chasesets.com/help");

afterEach(() => {
  vi.unstubAllGlobals();
});

const policyValue = (type: "bps" | "money" | "days" | "hours", value: number | string) => ({
  type,
  value,
  ...(type === "money" ? { currency: "USD" } : {}),
  effectiveFrom: "2026-07-03T00:00:00.000Z",
  upcoming: [],
});

function stubPolicyValuesFetch() {
  const fetch = vi.fn(
    async () =>
      new Response(
        JSON.stringify({
          values: {
            "checkout-processing-fee.card.bps": policyValue("bps", 290),
            "checkout-processing-fee.card.fixed": policyValue("money", "0.30"),
            "checkout-processing-fee.bank-account.bps": policyValue("bps", 50),
            "checkout-processing-fee.bank-account.fixed": policyValue("money", "0.00"),
            "checkout-processing-fee.platform-credit.bps": policyValue("bps", 0),
            "checkout-processing-fee.platform-credit.fixed": policyValue("money", "0.00"),
            "settlement.clearance.base.days": policyValue("days", 2),
            "settlement.clearance.extended.days": policyValue("days", 7),
            "settlement.clearance.high-value-threshold": policyValue("money", "250.00"),
            "settlement.payout.minimum": policyValue("money", "5.00"),
            "settlement.payout.maximum": policyValue("money", "10000.00"),
            "marketplace-sales-fee.standard.bps": policyValue("bps", 500),
            "marketplace-sales-fee.standard.fixed": policyValue("money", "0.00"),
            "marketplace-sales-fee.standard.cap": policyValue("money", "25.00"),
            "support-deadlines.product-not-received.seller-response.hours": policyValue("hours", 48),
            "support-deadlines.product-not-received.support-review.hours": policyValue("hours", 24),
            "support-deadlines.item-problem.post-delivery-open.days": policyValue("days", 30),
            "support-deadlines.product-not-as-described.seller-response.hours": policyValue("hours", 48),
            "support-deadlines.product-damaged.seller-response.hours": policyValue("hours", 48),
            "support-deadlines.wrong-product-received.seller-response.hours": policyValue("hours", 48),
            "support-deadlines.missing-products.seller-response.hours": policyValue("hours", 48),
            "support-deadlines.return-request.seller-response.hours": policyValue("hours", 48),
            "support-deadlines.buyer-cancel-request.seller-response.hours": policyValue("hours", 24),
          },
          resolvedAt: "2026-07-12T00:00:00.000Z",
          propagationSeconds: 360,
          changeCalloutDays: 30,
        }),
        { headers: { "Content-Type": "application/json" } },
      ),
  );
  vi.stubGlobal("fetch", fetch);
  return fetch;
}

describe("public help routes", () => {
  it("loads known categories and articles", async () => {
    stubPolicyValuesFetch();
    expect(categoryLoader({ request, params: { category: "buying" }, context: {} } as never)).toMatchObject({
      category: "buying",
    });
    await expect(
      articleLoader({ request, params: { category: "buying", slug: "order-protection" }, context: {} } as never),
    ).resolves.toMatchObject({ article: { title: "Order protection" } });
  });

  it("resolves token-bearing articles from the public whitelisted policy read", async () => {
    const fetch = stubPolicyValuesFetch();

    const data = await articleLoader({
      request,
      params: { category: "getting-started", slug: "frequently-asked-questions" },
      context: {},
    } as never);

    expect(fetch).toHaveBeenCalledWith("https://chasesets.com/api/public-presence/policy-values", expect.anything());
    const body = JSON.stringify(data.article.blocks);
    expect(body).not.toContain('"type":"policy-value"');
    expect(body).toContain("2.9%");
    expect(body).toContain("$0.30");
    expect(body).toContain("0.5%");
  });

  it("returns 404 responses for unknown categories and articles", async () => {
    expect(() => categoryLoader({ request, params: { category: "missing" }, context: {} } as never)).toThrowError(
      Response,
    );
    await expect(
      articleLoader({ request, params: { category: "buying", slug: "missing" }, context: {} } as never),
    ).rejects.toBeInstanceOf(Response);
  });

  it.each([
    [faqRedirectLoader, "/help/getting-started/frequently-asked-questions"],
    [protectionRedirectLoader, "/help/buying/order-protection"],
    [refundsRedirectLoader, "/help/buying/refunds-and-returns"],
  ])("permanently redirects a migrated public route", (loader, location) => {
    const response = loader();
    expect(response.status).toBe(301);
    expect(response.headers.get("Location")).toBe(location);
  });
});
