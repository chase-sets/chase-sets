import { describe, expect, it, vi } from "vitest";
import { buildReviewScoringProjectionHandlers } from "./scoring-projection";

describe("marketplace review scoring projection", () => {
  it("persists the policy fact and recomputes affected review contribution idempotently", async () => {
    const queries: { sql: string; params: readonly unknown[] }[] = [];
    const db = {
      query: vi.fn(async (sql: string, params?: readonly unknown[]) => {
        queries.push({ sql, params: params ?? [] });
        if (sql.includes("RETURNING order_id")) return { rows: [{ order_id: "ord_1" }] };
        if (sql.includes("RETURNING subject_account_id")) return { rows: [{ subject_account_id: "acc_seller" }] };
        return { rows: [] };
      }),
    };
    const handler = buildReviewScoringProjectionHandlers(db as never)[
      "marketplace.review-scoring.disposition-projected.v1"
    ];
    const scoringFact = {
      streamVersion: 4,
      data: {
        factSchemaVersion: 1,
        orderId: "ord_1",
        policyVersion: "resolution-aware-v1",
        sourceFactVersions: [{ supportRequestId: "sup_1", sourceStreamVersion: 3, status: "resolved" }],
        buyerToSeller: { scoringDisposition: "included", reasonCode: "subject-responsible" },
        sellerToBuyer: { scoringDisposition: "context-only", reasonCode: "reviewer-responsible" },
        operationalSignal: null,
        projectedAt: "2026-07-03T00:00:00.000Z",
      },
    } as never;

    await handler?.(scoringFact);
    await handler?.(scoringFact);

    expect(queries.filter((query) => query.sql.includes("INSERT INTO marketplace_review_scoring_pages"))).toHaveLength(
      2,
    );
    const contributionUpdates = queries.filter(
      (query) => query.sql.includes("UPDATE marketplace_review_pages") && query.sql.includes("scoring_disposition"),
    );
    expect(contributionUpdates).toHaveLength(2);
    expect(contributionUpdates[0]?.sql).toContain("rating_contribution_status");
    expect(contributionUpdates[0]?.params).toContain("ord_1");
    expect(queries.filter((query) => query.sql.includes("INSERT INTO marketplace_review_summary_pages"))).toHaveLength(
      2,
    );
  });

  it("fails an unknown policy version safe to context-only and records the operational signal", async () => {
    const queries: { sql: string; params: readonly unknown[] }[] = [];
    const db = {
      query: vi.fn(async (sql: string, params?: readonly unknown[]) => {
        queries.push({ sql, params: params ?? [] });
        return { rows: [] };
      }),
    };
    const handler = buildReviewScoringProjectionHandlers(db as never)[
      "marketplace.review-scoring.disposition-projected.v1"
    ];
    await handler?.({
      streamVersion: 1,
      data: {
        factSchemaVersion: 2,
        orderId: "ord_unknown",
        policyVersion: "future-policy",
        buyerToSeller: { scoringDisposition: "included", reasonCode: "normal-completion" },
        sellerToBuyer: { scoringDisposition: "included", reasonCode: "normal-completion" },
        projectedAt: "2026-07-03T00:00:00.000Z",
      },
    } as never);

    const upsert = queries.find((query) => query.sql.includes("INSERT INTO marketplace_review_scoring_pages"));
    expect(upsert?.params).toEqual(expect.arrayContaining(["context-only", "policy-version-unrecognized"]));
  });
});
