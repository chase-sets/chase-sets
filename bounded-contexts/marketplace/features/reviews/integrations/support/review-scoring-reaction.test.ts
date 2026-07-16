import { describe, expect, it, vi } from "vitest";
import { buildReviewScoringReactionHandlers } from "./review-scoring-reaction";

describe("review scoring reaction", () => {
  it("forwards support lifecycle facts with their authoritative stream versions", async () => {
    const recordSupportFact = vi.fn(async () => undefined);
    const handlers = buildReviewScoringReactionHandlers({ recordSupportFact });

    await handlers["support.support-request.resolved"]?.({
      streamVersion: 7,
      tenantId: "tenant_1",
      audit: { actor: { kind: "system", id: "worker" } },
      trace: { correlationId: "corr_1", causationId: null },
      data: {
        supportRequestId: "sup_1",
        orderId: "ord_1",
        resolution: {
          responsibility: "seller",
          resolutionType: "partial-refund",
          resolvedAt: "2026-07-03T00:00:00.000Z",
        },
      },
    } as never);

    expect(recordSupportFact).toHaveBeenCalledWith(
      {
        orderId: "ord_1",
        supportRequestId: "sup_1",
        sourceStreamVersion: 7,
        status: "resolved",
        responsibility: "seller",
        resolutionType: "partial-refund",
        lifecycleAt: "2026-07-03T00:00:00.000Z",
      },
      expect.objectContaining({ tenantId: "tenant_1" }),
    );
  });
});
