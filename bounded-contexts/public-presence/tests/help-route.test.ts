import { afterEach, describe, expect, it, vi } from "vitest";
import { loader as articleLoader } from "../routes/marketplace/help-article";
import { loader as categoryLoader } from "../routes/marketplace/help-category";
import { loader as faqRedirectLoader } from "../routes/marketplace/faq";
import { loader as protectionRedirectLoader } from "../routes/marketplace/order-protection";
import { loader as refundsRedirectLoader } from "../routes/marketplace/refunds-and-returns";

const request = new Request("https://chasesets.com/help");

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
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
      new Response(JSON.stringify(createPolicyValuesResponse()), { headers: { "Content-Type": "application/json" } }),
  );
  vi.stubGlobal("fetch", fetch);
  return fetch;
}

function createPolicyValuesResponse() {
  return {
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
  };
}

function stubPolicyResponse(response: unknown) {
  const fetch = vi.fn(
    async () =>
      new Response(JSON.stringify(response), {
        headers: { "Content-Type": "application/json" },
      }),
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

  it.each([
    ["non-OK", "non-ok", 503, () => vi.fn(async () => new Response("unavailable", { status: 503 }))],
    ["network", "transport", undefined, () => vi.fn(async () => Promise.reject(new Error("network unavailable")))],
    ["malformed JSON", "malformed", undefined, () => vi.fn(async () => new Response("{"))],
    [
      "missing-key",
      "missing",
      undefined,
      () =>
        vi.fn(
          async () =>
            new Response(
              JSON.stringify({
                values: {},
                resolvedAt: "2026-07-12T00:00:00.000Z",
                propagationSeconds: 360,
                changeCalloutDays: 30,
              }),
              { headers: { "Content-Type": "application/json" } },
            ),
        ),
    ],
  ])(
    "degrades a token-bearing help article on a %s policy failure",
    async (_failure, classification, status, createFetch) => {
      vi.stubGlobal("fetch", createFetch());
      const error = vi.spyOn(console, "error").mockImplementation(() => undefined);

      const data = await articleLoader({
        request,
        params: { category: "buying", slug: "order-protection" },
        context: {},
      } as never);

      expect(JSON.stringify(data.article.blocks)).toContain('"type":"policy-value-unavailable"');
      expect(JSON.stringify(data.article.blocks)).not.toContain("48 hours");
      expect(error).toHaveBeenCalledTimes(1);
      expect(error).toHaveBeenCalledWith("[public-presence] Public policy values are unavailable.", {
        event: "public-policy-values.unavailable",
        route: "/help/buying/order-protection",
        unresolvedKeys: [...data.article.policyValueKeys].sort(),
        classification,
        ...(status === undefined ? {} : { status }),
      });
    },
  );

  it("degrades every referenced value when all present policy entries are malformed", async () => {
    const malformedMarker = "provider-body-marker-must-not-render";
    const effectiveFrom = "2026-07-03T00:00:00.000Z";
    const malformedValues = {
      "checkout-processing-fee.card.bps": {
        type: "bps",
        value: malformedMarker,
        effectiveFrom,
        upcoming: [],
      },
      "checkout-processing-fee.card.fixed": {
        type: "money",
        value: "0.30",
        effectiveFrom,
        upcoming: [],
      },
      "checkout-processing-fee.bank-account.bps": {
        type: "bps",
        value: -1,
        effectiveFrom,
        upcoming: [],
      },
      "checkout-processing-fee.bank-account.fixed": {
        type: "bps",
        value: 50,
        effectiveFrom,
        upcoming: [],
      },
      "checkout-processing-fee.platform-credit.bps": {
        type: "bps",
        value: 0,
        effectiveFrom,
        upcoming: [{ value: "NaN", effectiveFrom: "2026-08-01T00:00:00.000Z" }],
      },
      "checkout-processing-fee.platform-credit.fixed": {
        type: "money",
        value: "0.00",
        currency: "USD",
        upcoming: [],
      },
      "settlement.clearance.base.days": {
        type: "days",
        value: 2,
        effectiveFrom,
        upcoming: {},
      },
      "settlement.clearance.extended.days": {
        type: "days",
        value: 1.5,
        effectiveFrom,
        upcoming: [],
      },
    };
    stubPolicyResponse({
      ...createPolicyValuesResponse(),
      values: malformedValues,
    });
    const error = vi.spyOn(console, "error").mockImplementation(() => undefined);

    const data = await articleLoader({
      request,
      params: { category: "getting-started", slug: "frequently-asked-questions" },
      context: {},
    } as never);

    const rendered = JSON.stringify(data.article.blocks);
    const unresolvedKeys = [...data.article.policyValueKeys].sort();
    expect(rendered).toContain('"type":"policy-value-unavailable"');
    expect(rendered).not.toContain("NaN%");
    expect(rendered).not.toContain(malformedMarker);
    expect(error).toHaveBeenCalledTimes(1);
    expect(error).toHaveBeenCalledWith("[public-presence] Public policy values are unavailable.", {
      event: "public-policy-values.unavailable",
      route: "/help/getting-started/frequently-asked-questions",
      unresolvedKeys,
      classification: "malformed",
    });
    expect(JSON.stringify(error.mock.calls)).not.toContain(malformedMarker);
  });

  it("renders valid entries while combining missing and malformed keys into one exact unresolved set", async () => {
    const response = createPolicyValuesResponse();
    const rawProviderMarker = "raw-provider-payload-must-not-render";
    response.values["checkout-processing-fee.card.bps"] = policyValue("bps", rawProviderMarker);
    const { ["checkout-processing-fee.card.fixed"]: _missingValue, ...values } = response.values;
    stubPolicyResponse({ ...response, values });
    const error = vi.spyOn(console, "error").mockImplementation(() => undefined);

    const data = await articleLoader({
      request,
      params: { category: "getting-started", slug: "frequently-asked-questions" },
      context: {},
    } as never);

    const rendered = JSON.stringify(data.article.blocks);
    expect(rendered).toContain("0.5%");
    expect(rendered).toContain("2 days");
    expect(rendered).toContain('"type":"policy-value-unavailable"');
    expect(rendered).not.toContain("NaN%");
    expect(rendered).not.toContain(rawProviderMarker);
    expect(error).toHaveBeenCalledTimes(1);
    expect(error).toHaveBeenCalledWith("[public-presence] Public policy values are unavailable.", {
      event: "public-policy-values.unavailable",
      route: "/help/getting-started/frequently-asked-questions",
      unresolvedKeys: ["checkout-processing-fee.card.bps", "checkout-processing-fee.card.fixed"],
      classification: "malformed",
    });
  });

  it("rejects malformed response metadata before formatting any referenced value", async () => {
    stubPolicyResponse({
      ...createPolicyValuesResponse(),
      resolvedAt: "not-a-timestamp",
    });
    const error = vi.spyOn(console, "error").mockImplementation(() => undefined);

    const data = await articleLoader({
      request,
      params: { category: "getting-started", slug: "frequently-asked-questions" },
      context: {},
    } as never);

    expect(JSON.stringify(data.article.blocks)).not.toContain("2.9%");
    expect(error).toHaveBeenCalledTimes(1);
    expect(error).toHaveBeenCalledWith("[public-presence] Public policy values are unavailable.", {
      event: "public-policy-values.unavailable",
      route: "/help/getting-started/frequently-asked-questions",
      unresolvedKeys: [...data.article.policyValueKeys].sort(),
      classification: "malformed",
    });
  });

  it("never copies secret-bearing transport errors into structured policy telemetry", async () => {
    const bearerSecret = "Bearer adversarial-secret-token";
    const providerBodyMarker = "provider-response-body-marker";
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => Promise.reject(new Error(`${bearerSecret} ${providerBodyMarker}`))),
    );
    const error = vi.spyOn(console, "error").mockImplementation(() => undefined);

    const data = await articleLoader({
      request,
      params: { category: "getting-started", slug: "frequently-asked-questions" },
      context: {},
    } as never);

    expect(error).toHaveBeenCalledTimes(1);
    expect(error).toHaveBeenCalledWith("[public-presence] Public policy values are unavailable.", {
      event: "public-policy-values.unavailable",
      route: "/help/getting-started/frequently-asked-questions",
      unresolvedKeys: [...data.article.policyValueKeys].sort(),
      classification: "transport",
    });
    const loggedFields = JSON.stringify(error.mock.calls);
    expect(loggedFields).not.toContain(bearerSecret);
    expect(loggedFields).not.toContain(providerBodyMarker);
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
