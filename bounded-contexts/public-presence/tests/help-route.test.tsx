import { cleanup, render } from "@testing-library/react";
import { MemoryRouter } from "react-router";
import { afterEach, describe, expect, it, vi } from "vitest";
import { loader as articleLoader } from "../routes/marketplace/help-article";
import { loader as categoryLoader } from "../routes/marketplace/help-category";
import { loader as faqRedirectLoader } from "../routes/marketplace/faq";
import { loader as protectionRedirectLoader } from "../routes/marketplace/order-protection";
import { loader as refundsRedirectLoader } from "../routes/marketplace/refunds-and-returns";
import { resolvePublicPolicyArticle } from "../features/help/integrations/resolve-public-policy-article";
import { helpCategories, publicHelpArticles } from "../features/help/domain/article-catalog";
import type { HelpArticle } from "../features/help/domain/article-model";
import * as helpRouteData from "../features/help/ui/help-route-data";
import { HelpArticlePage } from "../features/help/ui/help-pages";
import {
  collectUnresolvedPolicyValueOccurrences,
  POLICY_VALUE_KEY_ATTRIBUTE,
  POLICY_VALUE_STATE_ATTRIBUTE,
  POLICY_VALUE_UNAVAILABLE_STATE,
  POLICY_VALUES_AGGREGATE_KEYS_ATTRIBUTE,
  POLICY_VALUES_AGGREGATE_STATE_ATTRIBUTE,
  parsePolicyValueKeys,
} from "../features/help/domain/policy-value-state";

function renderedUnresolvedKeys(article: HelpArticle) {
  const { container } = render(<HelpArticlePage article={article} related={[]} />, { wrapper: MemoryRouter });
  const markers = [
    ...container.querySelectorAll(`[${POLICY_VALUE_STATE_ATTRIBUTE}="${POLICY_VALUE_UNAVAILABLE_STATE}"]`),
  ]
    .map((node) => node.getAttribute(POLICY_VALUE_KEY_ATTRIBUTE))
    .sort();
  const aggregate = container.querySelector(`[${POLICY_VALUES_AGGREGATE_STATE_ATTRIBUTE}]`);
  const aggregateKeys = aggregate
    ? [...parsePolicyValueKeys(aggregate.getAttribute(POLICY_VALUES_AGGREGATE_KEYS_ATTRIBUTE)!)].sort()
    : [];
  return { markers, aggregateKeys };
}

const request = new Request("https://chasesets.com/help");

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

type TestPolicyValue = Readonly<{
  type: "bps" | "money" | "days" | "hours" | "minutes" | "number";
  value: number | string;
  currency?: string;
  effectiveFrom: string | null;
  upcoming: readonly Readonly<{ value: number | string; effectiveFrom: string }>[];
}>;

const policyValue = (
  type: "bps" | "money" | "days" | "hours" | "minutes" | "number",
  value: number | string,
): TestPolicyValue => ({
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

function createPolicyValuesResponse(): Readonly<{
  values: Record<string, TestPolicyValue>;
  resolvedAt: string;
  propagationSeconds: number;
  changeCalloutDays: number;
}> {
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

function createPolicyArticle(key: string): HelpArticle {
  return {
    slug: "policy-contract-probe",
    locale: "en",
    title: "Policy contract probe",
    description: "Policy contract probe",
    audience: "buyer",
    category: "buying",
    reviewedAt: "2026-07-12",
    citedPolicies: [],
    relatedFlows: [],
    claimCategories: [],
    promiseTable: [],
    href: "/help/buying/policy-contract-probe",
    headings: [],
    blocks: [{ type: "paragraph", content: [{ type: "policy-value", key }] }],
    policyValueKeys: [key],
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
  it("serializes every category member as exactly the ordered card projection", () => {
    let examinedMembers = 0;

    for (const category of helpCategories) {
      const data = categoryLoader({ request, params: { category }, context: {} } as never);
      const canonicalArticles = publicHelpArticles.filter((article) => article.category === category);

      expect(Object.keys(data).sort()).toEqual(["articles", "category"]);
      expect(data.category).toBe(category);
      expect(data.articles).toHaveLength(canonicalArticles.length);
      expect(data.articles).toEqual(
        canonicalArticles.map(({ audience, title, description, href }) => ({ audience, title, description, href })),
      );
      for (const article of data.articles) {
        expect(Object.keys(article).sort()).toEqual(["audience", "description", "href", "title"]);
      }
      examinedMembers += data.articles.length;
    }

    expect(examinedMembers).toBeGreaterThan(0);
  });

  it("keeps canonically complete primary and related records for every token-free article", async () => {
    const tokenFreeArticles = publicHelpArticles.filter((article) => article.policyValueKeys.length === 0);
    expect(tokenFreeArticles.length).toBeGreaterThan(0);
    let examinedRelatedRecords = 0;

    for (const canonicalArticle of tokenFreeArticles) {
      const data = await articleLoader({
        request: new Request(`https://chasesets.com${canonicalArticle.href}`),
        params: { category: canonicalArticle.category, slug: canonicalArticle.slug },
        context: {},
      } as never);

      expect.soft(data.article, `primary ${canonicalArticle.href}`).toEqual(canonicalArticle);
      for (const related of data.related) {
        const canonicalRelated = publicHelpArticles.find((article) => article.href === related.href);
        expect.soft(canonicalRelated, `canonical related ${related.href}`).toBeDefined();
        expect.soft(related, `related ${canonicalArticle.href} -> ${related.href}`).toEqual(canonicalRelated);
        examinedRelatedRecords += 1;
      }
    }

    expect(examinedRelatedRecords).toBeGreaterThan(0);
  });

  it("loads known articles", async () => {
    stubPolicyValuesFetch();
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

    const { markers, aggregateKeys } = renderedUnresolvedKeys(data.article as HelpArticle);
    expect(markers).toEqual([]);
    expect(aggregateKeys).toEqual([]);
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

      const { markers, aggregateKeys } = renderedUnresolvedKeys(data.article as HelpArticle);
      expect(markers).toEqual(collectUnresolvedPolicyValueOccurrences((data.article as HelpArticle).blocks));
      expect(aggregateKeys).toEqual([...data.article.policyValueKeys].sort());
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

    const { markers, aggregateKeys } = renderedUnresolvedKeys(data.article as HelpArticle);
    expect(markers).toEqual(collectUnresolvedPolicyValueOccurrences((data.article as HelpArticle).blocks));
    expect(aggregateKeys).toEqual(unresolvedKeys);
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

    const expectedUnresolved = ["checkout-processing-fee.card.bps", "checkout-processing-fee.card.fixed"];
    const { markers, aggregateKeys } = renderedUnresolvedKeys(data.article as HelpArticle);
    expect(markers).toEqual(collectUnresolvedPolicyValueOccurrences((data.article as HelpArticle).blocks));
    expect(aggregateKeys).toEqual(expectedUnresolved);
    // Resolved keys never carry the unavailable marker.
    expect(markers).not.toContain("checkout-processing-fee.bank-account.bps");
  });

  it.each(["not-a-timestamp", "2026-02-30T00:00:00.000Z"])(
    "rejects malformed response metadata resolved at %s before formatting any referenced value",
    async (resolvedAt) => {
      stubPolicyResponse({
        ...createPolicyValuesResponse(),
        resolvedAt,
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
    },
  );

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

  it.each([
    [
      "support hours below the owning bound",
      "support-deadlines.product-not-received.seller-response.hours",
      policyValue("hours", 3),
    ],
    [
      "support hours above the owning bound",
      "support-deadlines.product-not-received.seller-response.hours",
      policyValue("hours", 337),
    ],
    [
      "numeric-string hours",
      "support-deadlines.product-not-received.seller-response.hours",
      policyValue("hours", "48.0"),
    ],
    ["non-integer days", "settlement.clearance.base.days", policyValue("days", 2.5)],
    ["unsafe integer days", "settlement.clearance.base.days", policyValue("days", Number.MAX_SAFE_INTEGER + 1)],
    ["bps above the owning bound", "checkout-processing-fee.card.bps", policyValue("bps", 10_001)],
    ["wrong unit discriminant", "checkout-processing-fee.card.bps", policyValue("hours", 290)],
    ["money as a number", "checkout-processing-fee.card.fixed", policyValue("money", 0.3)],
    ["money with excess precision", "checkout-processing-fee.card.fixed", policyValue("money", "0.301")],
    [
      "wrong money currency",
      "checkout-processing-fee.card.fixed",
      { ...policyValue("money", "0.30"), currency: "EUR" },
    ],
    [
      "calendar-invalid effective timestamp",
      "checkout-processing-fee.card.bps",
      { ...policyValue("bps", 290), effectiveFrom: "2026-02-30T00:00:00.000Z" },
    ],
    [
      "calendar-invalid rollover timestamp",
      "checkout-processing-fee.card.bps",
      { ...policyValue("bps", 290), effectiveFrom: "2026-04-31T00:00:00+00:00" },
    ],
    [
      "malformed upcoming value",
      "checkout-processing-fee.card.bps",
      {
        ...policyValue("bps", 290),
        upcoming: [{ value: 10_001, effectiveFrom: "2026-08-01T00:00:00.000Z" }],
      },
    ],
    [
      "calendar-invalid upcoming timestamp",
      "checkout-processing-fee.card.bps",
      {
        ...policyValue("bps", 290),
        upcoming: [{ value: 300, effectiveFrom: "2027-02-29T00:00:00.000Z" }],
      },
    ],
  ])("degrades a %s instead of formatting provider output", async (_case, key, invalidValue) => {
    const response = createPolicyValuesResponse();
    response.values[key as keyof typeof response.values] = invalidValue as never;
    stubPolicyResponse(response);
    const error = vi.spyOn(console, "error").mockImplementation(() => undefined);

    const supportDeadline = key.startsWith("support-deadlines.");
    const data = await articleLoader({
      request,
      params: supportDeadline
        ? { category: "buying", slug: "order-protection" }
        : { category: "getting-started", slug: "frequently-asked-questions" },
      context: {},
    } as never);

    expect(JSON.stringify(data.article.blocks)).toContain('"type":"policy-value-unavailable"');
    expect(error).toHaveBeenCalledWith(
      "[public-presence] Public policy values are unavailable.",
      expect.objectContaining({ unresolvedKeys: expect.arrayContaining([key]), classification: "malformed" }),
    );
  });

  it("preserves support-hour boundary values", async () => {
    const response = createPolicyValuesResponse();
    response.values["support-deadlines.product-not-received.seller-response.hours"] = {
      ...policyValue("hours", 4),
      upcoming: [{ value: 336, effectiveFrom: "2026-08-01T00:00:00.000-05:00" }],
    };
    stubPolicyResponse(response);
    const error = vi.spyOn(console, "error").mockImplementation(() => undefined);

    const data = await articleLoader({
      request,
      params: { category: "buying", slug: "order-protection" },
      context: {},
    } as never);

    expect(JSON.stringify(data.article.blocks)).toContain("4 hours");
    expect((data.article as HelpArticle).policyChanges).toEqual([
      {
        effectiveFrom: "2026-08-01T00:00:00.000-05:00",
        description: "The published policy values on this page will update automatically on this date.",
      },
    ]);
    expect(error).not.toHaveBeenCalled();
  });

  it("preserves basis-point boundary values and valid effective/upcoming transitions", async () => {
    const response = createPolicyValuesResponse();
    response.values["checkout-processing-fee.card.bps"] = {
      ...policyValue("bps", 10_000),
      upcoming: [{ value: 0, effectiveFrom: "2026-08-01T00:00:00.000Z" }],
    };
    stubPolicyResponse(response);
    const error = vi.spyOn(console, "error").mockImplementation(() => undefined);

    const data = await articleLoader({
      request,
      params: { category: "getting-started", slug: "frequently-asked-questions" },
      context: {},
    } as never);

    expect(JSON.stringify(data.article.blocks)).toContain("100%");
    expect((data.article as HelpArticle).policyChanges).toEqual([
      {
        effectiveFrom: "2026-08-01T00:00:00.000Z",
        description: "The published policy values on this page will update automatically on this date.",
      },
    ]);
    expect(error).not.toHaveBeenCalled();
  });

  it("preserves clearance-day boundary values", async () => {
    const response = createPolicyValuesResponse();
    response.values["settlement.clearance.base.days"] = policyValue("days", 0);
    response.values["settlement.clearance.extended.days"] = policyValue("days", 30);
    stubPolicyResponse(response);
    const error = vi.spyOn(console, "error").mockImplementation(() => undefined);

    const data = await articleLoader({
      request,
      params: { category: "getting-started", slug: "frequently-asked-questions" },
      context: {},
    } as never);

    const rendered = JSON.stringify(data.article.blocks);
    expect(rendered).toContain("0 days");
    expect(rendered).toContain("30 days");
    expect(error).not.toHaveBeenCalled();
  });

  it.each([
    ["rate-limit maximum", "rate-limits.waitlist.maximum-requests", policyValue("number", 10_000_001)],
    ["rate-limit window", "rate-limits.waitlist.window", policyValue("minutes", 999)],
    ["compiled open window", "support-deadlines.item-problem.post-delivery-open.days", policyValue("days", 31)],
    ["positive fee cap", "marketplace-sales-fee.standard.cap", policyValue("money", "0.00")],
  ])("rejects a value outside the owning %s contract", async (_case, key, invalidValue) => {
    const article = createPolicyArticle(key);
    const response = createPolicyValuesResponse();
    stubPolicyResponse({ ...response, values: { ...response.values, [key]: invalidValue } });
    const error = vi.spyOn(console, "error").mockImplementation(() => undefined);

    const resolved = await resolvePublicPolicyArticle(request, article, article.href);

    expect(resolved.blocks).toEqual([{ type: "paragraph", content: [{ type: "policy-value-unavailable", key }] }]);
    expect(error).toHaveBeenCalledWith(
      "[public-presence] Public policy values are unavailable.",
      expect.objectContaining({ unresolvedKeys: [key], classification: "malformed" }),
    );
  });

  it.each([
    ["rate-limit maximum", "rate-limits.waitlist.maximum-requests", policyValue("number", 10_000_000)],
    ["rate-limit window", "rate-limits.waitlist.window", policyValue("minutes", 1_000)],
    ["compiled open window", "support-deadlines.item-problem.post-delivery-open.days", policyValue("days", 30)],
    ["positive fee cap", "marketplace-sales-fee.standard.cap", policyValue("money", "0.01")],
  ])("preserves the valid owning %s boundary", async (_case, key, validValue) => {
    const article = createPolicyArticle(key);
    const response = createPolicyValuesResponse();
    stubPolicyResponse({ ...response, values: { ...response.values, [key]: validValue } });
    const error = vi.spyOn(console, "error").mockImplementation(() => undefined);

    const resolved = await resolvePublicPolicyArticle(request, article, article.href);

    expect(resolved.blocks).toEqual([{ type: "paragraph", content: [{ type: "text", value: expect.any(String) }] }]);
    expect(error).not.toHaveBeenCalled();
  });

  it("keeps unknown referenced whitelist keys unavailable with bounded telemetry", async () => {
    const unknownKey = "provider.unknown-secret-shaped-key";
    const article = createPolicyArticle(unknownKey);
    const response = createPolicyValuesResponse();
    stubPolicyResponse({
      ...response,
      values: { ...response.values, [unknownKey]: policyValue("hours", 48) },
    });
    const error = vi.spyOn(console, "error").mockImplementation(() => undefined);

    const resolved = await resolvePublicPolicyArticle(request, article, article.href);

    expect(resolved.blocks).toEqual([
      { type: "paragraph", content: [{ type: "policy-value-unavailable", key: unknownKey }] },
    ]);
    expect(error).toHaveBeenCalledWith("[public-presence] Public policy values are unavailable.", {
      event: "public-policy-values.unavailable",
      route: article.href,
      unresolvedKeys: [unknownKey],
      classification: "malformed",
    });
  });

  it("does not log bearer tokens or provider bodies from non-OK responses", async () => {
    const bearerSecret = "Bearer non-ok-secret-token";
    const providerMessage = "provider-body-shaped-failure";
    vi.stubGlobal(
      "fetch",
      vi.fn(
        async () =>
          new Response(JSON.stringify({ message: providerMessage, authorization: bearerSecret }), { status: 503 }),
      ),
    );
    const error = vi.spyOn(console, "error").mockImplementation(() => undefined);

    await articleLoader({
      request,
      params: { category: "getting-started", slug: "frequently-asked-questions" },
      context: {},
    } as never);

    const logged = JSON.stringify(error.mock.calls);
    expect(logged).not.toContain(bearerSecret);
    expect(logged).not.toContain(providerMessage);
    expect(error).toHaveBeenCalledWith(
      "[public-presence] Public policy values are unavailable.",
      expect.objectContaining({ classification: "non-ok", status: 503 }),
    );
  });

  it("returns exact 404 responses for unknown and empty categories and unknown articles", async () => {
    const captureCategoryResponse = (category: string) => {
      try {
        categoryLoader({ request, params: { category }, context: {} } as never);
      } catch (error) {
        return error;
      }
      throw new Error(`Expected category '${category}' to return a 404 Response.`);
    };

    const unknownCategory = captureCategoryResponse("missing");
    expect(unknownCategory).toBeInstanceOf(Response);
    expect((unknownCategory as Response).status).toBe(404);

    vi.spyOn(helpRouteData, "listHelpArticlesByCategory").mockReturnValueOnce([]);
    const emptyCategory = captureCategoryResponse("buying");
    expect(emptyCategory).toBeInstanceOf(Response);
    expect((emptyCategory as Response).status).toBe(404);

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
