import { describe, expect, it, vi } from "vitest";
import { publicHelpArticlePolicyCitations } from "@chase-sets/public-docs";
import {
  buildCommercialTermsPublicDocReviewProjectionHandlers,
  buildPlatformOperationsPublicDocReviewProjectionHandlers,
} from "./projection";

function policyRevision(policyKey: string) {
  return {
    id: "evt_policy_revision_2",
    data: { documentId: "pol_sales_fee", policyKey },
    timing: { recordedAt: "2026-07-12T12:00:00.000Z" },
    audit: { performedByUserId: "usr_admin" },
  } as never;
}

function expectedQueueParams(policyKey: string) {
  return publicHelpArticlePolicyCitations
    .filter((article) => article.citedPolicies.some((citedPolicy) => citedPolicy === policyKey))
    .map((article) => [
      article.locale,
      article.slug,
      article.title,
      article.href,
      policyKey,
      "pol_sales_fee",
      "evt_policy_revision_2",
      "2026-07-12T12:00:00.000Z",
    ]);
}

describe("public doc review queue projection", () => {
  it("flags every article citing a revised policy and ignores unrelated policies", async () => {
    const query = vi.fn(async (_sql: string, _params?: unknown[]) => ({ rows: [] }));
    const handlers = buildCommercialTermsPublicDocReviewProjectionHandlers({ query } as never);

    const citedPolicyKeys = [...new Set(publicHelpArticlePolicyCitations.flatMap((article) => article.citedPolicies))];
    for (const policyKey of citedPolicyKeys) {
      query.mockClear();
      await handlers["platform-policy.document.revised"]?.(policyRevision(policyKey));

      const expectedParams = expectedQueueParams(policyKey);
      expect(expectedParams.length).toBeGreaterThan(0);
      expect(query).toHaveBeenCalledTimes(expectedParams.length);
      expect(query.mock.calls.map((call) => call[1])).toEqual(expectedParams);
    }

    query.mockClear();
    await handlers["platform-policy.document.revised"]?.(policyRevision("platform-operations.unrelated-policy"));
    expect(query).not.toHaveBeenCalled();
  });

  it("clears only the exact revision the operator reviewed", async () => {
    const query = vi.fn(async (_sql: string, _params?: unknown[]) => ({ rows: [] }));
    const handlers = buildPlatformOperationsPublicDocReviewProjectionHandlers({ query } as never);
    await handlers["platform-operations.public-doc-article-review.confirmed"]?.({
      id: "evt_confirmed",
      data: {
        locale: "en",
        articleSlug: "sales-fees",
        policyKey: "commercial-terms.marketplace-sales-fee-schedule",
        policyRevisionEventId: "evt_policy_revision_2",
        operatorUserId: "usr_operator",
        confirmedAt: "2026-07-13T12:00:00.000Z",
      },
      timing: { recordedAt: "2026-07-13T12:00:00.000Z" },
      audit: { performedByUserId: "usr_operator" },
    } as never);

    expect(query.mock.calls[0]?.[0]).toContain("AND policy_revision_event_id = $4");
    expect(query.mock.calls[0]?.[1]).toEqual([
      "en",
      "sales-fees",
      "commercial-terms.marketplace-sales-fee-schedule",
      "evt_policy_revision_2",
      "2026-07-13T12:00:00.000Z",
      "usr_operator",
    ]);
  });
});
