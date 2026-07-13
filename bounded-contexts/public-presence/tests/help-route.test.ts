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

describe("public help routes", () => {
  it("loads known categories and articles", async () => {
    expect(categoryLoader({ request, params: { category: "buying" }, context: {} } as never)).toMatchObject({
      category: "buying",
    });
    await expect(
      articleLoader({ request, params: { category: "buying", slug: "order-protection" }, context: {} } as never),
    ).resolves.toMatchObject({ article: { title: "Order protection" } });
  });

  it("resolves token-bearing articles from the public whitelisted policy read", async () => {
    const policyValue = (type: "bps" | "money", value: number | string) => ({
      type,
      value,
      ...(type === "money" ? { currency: "USD" } : {}),
      effectiveFrom: "2026-07-03T00:00:00.000Z",
      upcoming: [],
    });
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
            },
            resolvedAt: "2026-07-12T00:00:00.000Z",
            propagationSeconds: 360,
            changeCalloutDays: 30,
          }),
          { headers: { "Content-Type": "application/json" } },
        ),
    );
    vi.stubGlobal("fetch", fetch);

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
