import { describe, expect, it } from "vitest";
import type { HelpArticle } from "./article-model";
import { resolveArticlePolicyValues } from "./resolve-article-policy-values";

const article = {
  slug: "fees",
  locale: "en",
  title: "Fees",
  description: "Fees",
  audience: "seller",
  category: "selling",
  revisionDate: "2026-07-12",
  citedPolicies: [],
  relatedFlows: [],
  promiseTable: [],
  href: "/fees",
  headings: [],
  policyValueKeys: ["marketplace-sales-fee.standard.bps"],
  blocks: [{ type: "paragraph", content: [{ type: "policy-value", key: "marketplace-sales-fee.standard.bps" }] }],
} as const satisfies HelpArticle;

describe("article policy value resolution", () => {
  it("formats typed values and emits a future-effective callout inside the configured window", () => {
    const resolved = resolveArticlePolicyValues(article, {
      values: {
        "marketplace-sales-fee.standard.bps": {
          type: "bps",
          value: 500,
          effectiveFrom: "2026-07-01T00:00:00.000Z",
          upcoming: [{ value: 600, effectiveFrom: "2026-07-20T00:00:00.000Z" }],
        },
      },
      resolvedAt: "2026-07-12T00:00:00.000Z",
      propagationSeconds: 300,
      changeCalloutDays: 30,
    });

    expect(resolved.blocks[0]).toEqual({ type: "paragraph", content: [{ type: "text", value: "5%" }] });
    expect(resolved.policyChanges).toEqual([expect.objectContaining({ effectiveFrom: "2026-07-20T00:00:00.000Z" })]);
  });

  it("fails loudly when a compiled token is missing from the public read", () => {
    expect(() =>
      resolveArticlePolicyValues(article, {
        values: {},
        resolvedAt: "2026-07-12T00:00:00.000Z",
        propagationSeconds: 300,
        changeCalloutDays: 30,
      }),
    ).toThrow("could not resolve public policy value 'marketplace-sales-fee.standard.bps'");
  });

  it("does not announce revisions outside the configured window", () => {
    const resolved = resolveArticlePolicyValues(
      article,
      {
        values: {
          "marketplace-sales-fee.standard.bps": {
            type: "bps",
            value: 500,
            effectiveFrom: "2026-07-01T00:00:00.000Z",
            upcoming: [{ value: 600, effectiveFrom: "2026-08-20T00:00:00.000Z" }],
          },
        },
        resolvedAt: "2026-07-12T00:00:00.000Z",
        propagationSeconds: 360,
        changeCalloutDays: 30,
      },
      { changeCalloutDays: 7 },
    );

    expect(resolved.policyChanges).toEqual([]);
  });
});
