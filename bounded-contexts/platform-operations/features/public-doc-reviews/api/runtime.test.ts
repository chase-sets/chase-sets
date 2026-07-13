import { describe, expect, it, vi } from "vitest";
import { createPublicDocReviewRuntime } from "./runtime";

describe("public doc review runtime", () => {
  it("appends a confirmation pinned to the currently pending policy revision", async () => {
    const appendToStream = vi.fn(async () => ({ nextExpectedVersion: 1 }));
    const db = {
      query: vi.fn(async () => ({
        rows: [
          {
            locale: "en",
            article_slug: "sales-fees",
            article_title: "Marketplace sales and checkout fees",
            article_href: "/sales-fees",
            policy_key: "commercial-terms.marketplace-sales-fee-schedule",
            policy_document_id: "pol_1",
            policy_revision_event_id: "evt_revision_2",
            flagged_at: "2026-07-12T12:00:00.000Z",
          },
        ],
      })),
    };
    const runtime = createPublicDocReviewRuntime({ db: db as never, eventStore: { appendToStream } as never });

    await expect(
      runtime.confirm(
        {
          locale: "en",
          articleSlug: "sales-fees",
          policyKey: "commercial-terms.marketplace-sales-fee-schedule",
          operatorUserId: "usr_operator",
        },
        { tenantId: "tnt_test", audit: { performedByUserId: "usr_operator" } } as never,
      ),
    ).resolves.toBe(true);

    expect(appendToStream).toHaveBeenCalledWith(
      expect.objectContaining({
        events: [
          expect.objectContaining({
            eventType: "platform-operations.public-doc-article-review.confirmed",
            payload: expect.objectContaining({ policyRevisionEventId: "evt_revision_2" }),
          }),
        ],
      }),
    );
  });
});
