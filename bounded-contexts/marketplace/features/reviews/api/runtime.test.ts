import { describe, expect, it, vi } from "vitest";
import { createInMemoryEventStore } from "@chase-sets/event-core/test-support";
import type { EventStore } from "@chase-sets/event-core/event-store";
import type { ProjectionCheckpointStore } from "@chase-sets/event-core/projector";
import type {
  AppendToStreamInput,
  GlobalPosition,
  ReadAllInput,
  ReadStreamInput,
  StoredEvent,
} from "@chase-sets/event-core/storage";
import { ZERO_GLOBAL_POSITION } from "@chase-sets/event-core/storage";
import { createReviewRuntime } from "./runtime";

function createCheckpointStore(): ProjectionCheckpointStore {
  const checkpoints = new Map<string, GlobalPosition>();

  return {
    loadCheckpoint: async (projectorName) => checkpoints.get(projectorName) ?? ZERO_GLOBAL_POSITION,
    saveCheckpoint: async (projectorName, checkpoint) => {
      checkpoints.set(projectorName, checkpoint);
    },
  };
}

const context = {
  tenantId: "tnt_test" as never,
  audit: {
    performedByUserId: "usr_test" as never,
    forAccountId: "acc_buyer" as never,
  },
};

describe("marketplace review runtime", () => {
  it("creates buyer and seller review eligibility from delivered local shipment and order sources", async () => {
    const inserts: (readonly unknown[])[] = [];
    const db = {
      query: vi.fn(async (sql: string, params?: readonly unknown[]) => {
        if (sql.includes("MIN(delivered_at)")) {
          return { rows: [{ delivered_at: "2026-04-02T00:00:00.000Z" }] };
        }

        if (sql.includes("FROM marketplace_review_shipment_sources")) {
          return { rows: [{ order_id: "ord_1" }] };
        }

        if (sql.includes("FROM marketplace_review_order_sources")) {
          return {
            rows: [
              {
                buyer_account_id: "acc_buyer",
                seller_account_id: "acc_seller",
              },
            ],
          };
        }

        if (sql.includes("FROM marketplace_review_support_request_sources")) {
          return { rows: [] };
        }

        if (sql.includes("INSERT INTO marketplace_review_eligibility_pages")) {
          inserts.push(params ?? []);
          return { rows: [] };
        }

        return { rows: [] };
      }),
    };
    const { eventStore } = createInMemoryEventStore();
    const runtime = createReviewRuntime({
      eventStore,
      checkpointStore: createCheckpointStore(),
      db: db as never,
    });

    await runtime.recordDeliveredShipmentReviewEligibility({
      shipmentId: "shp_1",
      deliveredAt: "2026-04-02T00:00:00.000Z",
    });
    expect(inserts).toEqual([
      [
        "ord_1",
        "acc_buyer",
        "acc_seller",
        "buyer",
        "2026-04-02T00:00:00.000Z",
        "2026-06-01T00:00:00.000Z",
        "allowed",
        null,
        null,
        "2026-04-02T00:00:00.000Z",
        null,
        0,
        "2026-04-02T00:00:00.000Z",
      ],
      [
        "ord_1",
        "acc_seller",
        "acc_buyer",
        "seller",
        "2026-04-02T00:00:00.000Z",
        "2026-06-01T00:00:00.000Z",
        "allowed",
        null,
        null,
        "2026-04-02T00:00:00.000Z",
        null,
        0,
        "2026-04-02T00:00:00.000Z",
      ],
    ]);
  });

  it("submits a seller-to-buyer review from seller eligibility", async () => {
    const db = {
      query: vi.fn(async (sql: string) => {
        if (sql.includes("FROM marketplace_review_eligibility_pages") && sql.includes("author_account_id = $2")) {
          return {
            rows: [
              {
                order_id: "ord_1",
                author_account_id: "acc_seller",
                subject_account_id: "acc_buyer",
                author_role: "seller",
                eligible_at: new Date().toISOString(),
              },
            ],
          };
        }

        if (sql.includes("FROM marketplace_review_pages")) {
          return { rows: [] };
        }

        return { rows: [] };
      }),
    };
    const { allEvents, eventStore } = createInMemoryEventStore();
    const runtime = createReviewRuntime({
      eventStore,
      checkpointStore: createCheckpointStore(),
      db: db as never,
    });

    const result = await runtime.submitReview(
      {
        orderId: "ord_1",
        authorAccountId: "acc_seller",
        subjectAccountId: "acc_buyer",
        rating: 4,
        feedback: "Prompt payment and clear communication.",
      },
      {
        ...context,
        audit: {
          performedByUserId: "usr_seller" as never,
          forAccountId: "acc_seller" as never,
        },
      },
    );

    expect(result.reviewId).toMatch(/^rev_/);
    expect(allEvents.map((event) => event.eventType)).toEqual([
      "marketplace.review.submitted",
      "marketplace.csat-outcome-fact.v1",
    ]);
    const reviewEvent = allEvents.find((event) => event.eventType === "marketplace.review.submitted");
    const outcomeFact = allEvents.find((event) => event.eventType === "marketplace.csat-outcome-fact.v1");
    expect(reviewEvent?.payload).toMatchObject({
      orderId: "ord_1",
      authorAccountId: "acc_seller",
      subjectAccountId: "acc_buyer",
      authorRole: "seller",
      rating: 4,
      feedback: "Prompt payment and clear communication.",
    });
    expect(outcomeFact?.payload).toMatchObject({
      factSchemaVersion: 1,
      outcomeCode: "reputation.review-received",
      sourceContext: "marketplace",
      subjectAccountId: "acc_seller",
      subjectKind: "seller",
      subject: { entityType: "review", entityId: result.reviewId },
      idempotencyKey: `review:${result.reviewId}:received`,
    });
  });

  it("rejects submission with the stable held reason even when eligibility projection state is stale", async () => {
    const now = new Date();
    const db = {
      query: vi.fn(async (sql: string) => {
        if (sql.includes("FROM marketplace_review_eligibility_pages") && sql.includes("author_account_id = $2")) {
          return {
            rows: [
              {
                order_id: "ord_held",
                author_account_id: "acc_buyer",
                subject_account_id: "acc_seller",
                author_role: "buyer",
                eligible_at: now.toISOString(),
                effective_deadline_at: new Date(now.getTime() + 60 * 24 * 60 * 60 * 1000).toISOString(),
                submission_state: "allowed",
              },
            ],
          };
        }
        if (sql.includes("FROM marketplace_review_pages")) {
          return { rows: [] };
        }
        return { rows: [] };
      }),
    };
    const { eventStore } = createInMemoryEventStore();
    const runtime = createReviewRuntime({
      eventStore,
      checkpointStore: createCheckpointStore(),
      db: db as never,
    });

    await runtime.recordSupportRequestOpened(
      {
        orderId: "ord_held",
        supportRequestId: "sup_held",
        openedAt: now.toISOString(),
      },
      context,
    );

    await expect(
      runtime.submitReview(
        {
          orderId: "ord_held",
          authorAccountId: "acc_buyer",
          subjectAccountId: "acc_seller",
          rating: 1,
        },
        context,
      ),
    ).rejects.toMatchObject({
      code: "review_held",
      message: "Review is paused while support reviews the order.",
    });
  });

  it("does not copy Support remedy metadata into submitted review events", async () => {
    const db = {
      query: vi.fn(async (sql: string) => {
        if (sql.includes("FROM marketplace_review_eligibility_pages") && sql.includes("author_account_id = $2")) {
          return {
            rows: [
              {
                order_id: "ord_1",
                author_account_id: "acc_buyer",
                subject_account_id: "acc_seller",
                author_role: "buyer",
                eligible_at: new Date().toISOString(),
              },
            ],
          };
        }

        if (sql.includes("FROM marketplace_review_pages")) {
          return { rows: [] };
        }

        return { rows: [] };
      }),
    };
    const { allEvents, eventStore } = createInMemoryEventStore();
    const runtime = createReviewRuntime({
      eventStore,
      checkpointStore: createCheckpointStore(),
      db: db as never,
    });

    const result = await runtime.submitReview(
      {
        orderId: "ord_1",
        authorAccountId: "acc_buyer",
        subjectAccountId: "acc_seller",
        rating: 1,
        feedback: "Support resolved the order issue.",
      },
      context,
    );

    expect(allEvents.map((event) => event.eventType)).toEqual([
      "marketplace.review.submitted",
      "marketplace.csat-outcome-fact.v1",
    ]);
    const reviewEvent = allEvents.find((event) => event.eventType === "marketplace.review.submitted");
    const outcomeFact = allEvents.find((event) => event.eventType === "marketplace.csat-outcome-fact.v1");
    expect(reviewEvent?.payload).toMatchObject({
      authorRole: "buyer",
    });
    expect(outcomeFact?.payload).toMatchObject({
      outcomeCode: "reputation.review-received",
      sourceContext: "marketplace",
      subjectAccountId: "acc_buyer",
      subjectKind: "buyer",
      subject: { entityType: "review", entityId: result.reviewId },
      idempotencyKey: `review:${result.reviewId}:received`,
    });
  });

  it("rejects submission once the review window has closed", async () => {
    const db = {
      query: vi.fn(async (sql: string) => {
        if (sql.includes("FROM marketplace_review_eligibility_pages") && sql.includes("author_account_id = $2")) {
          return {
            rows: [
              {
                order_id: "ord_1",
                author_account_id: "acc_buyer",
                subject_account_id: "acc_seller",
                author_role: "buyer",
                eligible_at: "2020-01-01T00:00:00.000Z",
              },
            ],
          };
        }
        return { rows: [] };
      }),
    };
    const { allEvents, eventStore } = createInMemoryEventStore();
    const runtime = createReviewRuntime({
      eventStore,
      checkpointStore: createCheckpointStore(),
      db: db as never,
    });

    await expect(
      runtime.submitReview(
        { orderId: "ord_1", authorAccountId: "acc_buyer", subjectAccountId: "acc_seller", rating: 5 },
        context,
      ),
    ).rejects.toThrow("This transaction's review window has closed.");
    expect(allEvents).toHaveLength(0);
  });

  it("reveals both reviews when the counterpart is already pending", async () => {
    let counterpartReviewId: string | null = null;
    const db = {
      query: vi.fn(),
    };
    // Eligibility mock alternates per call: first call resolves the
    // buyer-authored direction, second call resolves the seller-authored one.
    let eligibilityCallCount = 0;
    db.query.mockImplementation(async (sql: string) => {
      if (sql.includes("FROM marketplace_review_eligibility_pages") && sql.includes("author_account_id = $2")) {
        eligibilityCallCount += 1;
        return eligibilityCallCount === 1
          ? {
              rows: [
                {
                  order_id: "ord_1",
                  author_account_id: "acc_buyer",
                  subject_account_id: "acc_seller",
                  author_role: "buyer",
                  eligible_at: new Date().toISOString(),
                },
              ],
            }
          : {
              rows: [
                {
                  order_id: "ord_1",
                  author_account_id: "acc_seller",
                  subject_account_id: "acc_buyer",
                  author_role: "seller",
                  eligible_at: new Date().toISOString(),
                },
              ],
            };
      }
      if (sql.includes("AND status = 'active'") && sql.includes("AND revealed_at IS NULL") && sql.includes("LIMIT 1")) {
        return counterpartReviewId ? { rows: [{ review_id: counterpartReviewId }] } : { rows: [] };
      }
      if (sql.includes("FROM marketplace_review_pages")) {
        return { rows: [] };
      }
      return { rows: [] };
    });
    const { allEvents, eventStore } = createInMemoryEventStore();
    const runtime = createReviewRuntime({
      eventStore,
      checkpointStore: createCheckpointStore(),
      db: db as never,
    });

    const first = await runtime.submitReview(
      { orderId: "ord_1", authorAccountId: "acc_buyer", subjectAccountId: "acc_seller", rating: 5 },
      context,
    );
    counterpartReviewId = first.reviewId;

    const second = await runtime.submitReview(
      { orderId: "ord_1", authorAccountId: "acc_seller", subjectAccountId: "acc_buyer", rating: 4 },
      {
        ...context,
        audit: { performedByUserId: "usr_seller" as never, forAccountId: "acc_seller" as never },
      },
    );

    const revealedEvents = allEvents.filter((event) => event.eventType === "marketplace.review.revealed");
    expect(revealedEvents).toHaveLength(2);
    const revealedStreamIds = revealedEvents.map((event) => event.streamId).sort();
    expect(revealedStreamIds).toEqual(
      [`marketplace.review-${first.reviewId}`, `marketplace.review-${second.reviewId}`].sort(),
    );
    expect(
      revealedEvents.every((event) => (event.payload as { reason: string }).reason === "counterpart-submitted"),
    ).toBe(true);
  });

  it("blocks updating or withdrawing a revealed review", async () => {
    const db = {
      query: vi.fn(async (_sql: string, params?: readonly unknown[]) => {
        if (params?.[1] === "acc_buyer") {
          return {
            rows: [
              {
                review_id: "rev_1",
                author_account_id: "acc_buyer",
                subject_account_id: "acc_seller",
                status: "active",
                revealed_at: "2026-04-05T00:00:00.000Z",
              },
            ],
          };
        }
        return { rows: [] };
      }),
    };
    const { eventStore } = createInMemoryEventStore();
    const runtime = createReviewRuntime({
      eventStore,
      checkpointStore: createCheckpointStore(),
      db: db as never,
    });

    await expect(
      runtime.updateReview({ reviewId: "rev_1", authorAccountId: "acc_buyer", rating: 1 }, context),
    ).rejects.toThrow("Reviews cannot be edited after they are revealed.");
    await expect(runtime.withdrawReview({ reviewId: "rev_1", authorAccountId: "acc_buyer" }, context)).rejects.toThrow(
      "Reviews cannot be withdrawn after they are revealed.",
    );
  });

  it("sweeps window-expired singleton reviews and pending counterpart pairs", async () => {
    let eligibilityCallCount = 0;
    const db = { query: vi.fn() };
    db.query.mockImplementation(async (sql: string) => {
      if (sql.includes("FROM marketplace_review_eligibility_pages") && sql.includes("author_account_id = $2")) {
        eligibilityCallCount += 1;
        const directions = [
          { orderId: "ord_pair", authorAccountId: "acc_buyer", subjectAccountId: "acc_seller", authorRole: "buyer" },
          { orderId: "ord_pair", authorAccountId: "acc_seller", subjectAccountId: "acc_buyer", authorRole: "seller" },
          {
            orderId: "ord_singleton",
            authorAccountId: "acc_buyer_2",
            subjectAccountId: "acc_seller_2",
            authorRole: "buyer",
          },
        ];
        const direction = directions[eligibilityCallCount - 1]!;
        return {
          rows: [
            {
              order_id: direction.orderId,
              author_account_id: direction.authorAccountId,
              subject_account_id: direction.subjectAccountId,
              author_role: direction.authorRole,
              eligible_at: new Date().toISOString(),
            },
          ],
        };
      }
      // No counterpart is visible at submission time for any of these -- the
      // sweep is what reveals them, not the same-request fast path.
      return { rows: [] };
    });
    const { allEvents, eventStore } = createInMemoryEventStore();
    const runtime = createReviewRuntime({
      eventStore,
      checkpointStore: createCheckpointStore(),
      db: db as never,
    });

    const pairA = await runtime.submitReview(
      { orderId: "ord_pair", authorAccountId: "acc_buyer", subjectAccountId: "acc_seller", rating: 5 },
      context,
    );
    const pairB = await runtime.submitReview(
      { orderId: "ord_pair", authorAccountId: "acc_seller", subjectAccountId: "acc_buyer", rating: 4 },
      { ...context, audit: { performedByUserId: "usr_seller" as never, forAccountId: "acc_seller" as never } },
    );
    const singleton = await runtime.submitReview(
      {
        orderId: "ord_singleton",
        authorAccountId: "acc_buyer_2",
        subjectAccountId: "acc_seller_2",
        rating: 3,
      },
      { ...context, audit: { performedByUserId: "usr_buyer_2" as never, forAccountId: "acc_buyer_2" as never } },
    );

    // Now point the sweep's own read-model queries at the three streams just created.
    db.query.mockImplementation(async (sql: string) => {
      if (sql.includes("a.review_id AS review_id, b.review_id AS counterpart_review_id")) {
        return { rows: [{ review_id: pairA.reviewId, counterpart_review_id: pairB.reviewId }] };
      }
      if (sql.includes("review_window_expires_at <= $1")) {
        return { rows: [{ review_id: singleton.reviewId }] };
      }
      return { rows: [] };
    });

    const result = await runtime.sweepReviewWindowExpirations({ now: "2026-06-01T00:00:00.000Z" }, context);

    expect(result).toEqual({ counterpartPairsRevealed: 1, windowExpiredRevealed: 1 });
    const revealedEvents = allEvents.filter((event) => event.eventType === "marketplace.review.revealed");
    expect(revealedEvents).toHaveLength(3);
    const reasons = revealedEvents.map((event) => (event.payload as { reason: string }).reason).sort();
    expect(reasons).toEqual(["counterpart-submitted", "counterpart-submitted", "window-expired"]);
  });

  describe("operator moderation and subject reply (m108, #4269)", () => {
    async function createRuntimeWithRevealedReview() {
      const db = {
        query: vi.fn(async (sql: string) => {
          if (sql.includes("FROM marketplace_review_eligibility_pages") && sql.includes("author_account_id = $2")) {
            return {
              rows: [
                {
                  order_id: "ord_1",
                  author_account_id: "acc_buyer",
                  subject_account_id: "acc_seller",
                  author_role: "buyer",
                  eligible_at: new Date().toISOString(),
                },
              ],
            };
          }
          return { rows: [] };
        }),
      };
      const { allEvents, eventStore } = createInMemoryEventStore();
      const runtime = createReviewRuntime({ eventStore, checkpointStore: createCheckpointStore(), db: db as never });

      const submitted = await runtime.submitReview(
        {
          orderId: "ord_1",
          authorAccountId: "acc_buyer",
          subjectAccountId: "acc_seller",
          rating: 5,
          feedback: "Great transaction.",
        },
        context,
      );
      await runtime.commandHandler({
        streamId: `marketplace.review-${submitted.reviewId}`,
        command: { type: "RevealReview", revealedAt: new Date().toISOString(), reason: "window-expired" },
        context,
      });

      return { runtime, allEvents, reviewId: submitted.reviewId };
    }

    it("lets an operator withdraw a revealed review", async () => {
      const { runtime, allEvents, reviewId } = await createRuntimeWithRevealedReview();

      const result = await runtime.operatorWithdrawReview(
        { reviewId, operatorUserId: "usr_operator", reason: "Abusive language." },
        context,
      );

      expect(result.reviewId).toBe(reviewId);
      const withdrawn = allEvents.find((event) => event.eventType === "marketplace.review.withdrawn");
      expect(withdrawn?.payload).toMatchObject({
        actorType: "operator",
        operatorUserId: "usr_operator",
        reason: "Abusive language.",
      });
    });

    it("lets an operator redact review feedback while the rating stands", async () => {
      const { runtime, allEvents, reviewId } = await createRuntimeWithRevealedReview();

      await runtime.operatorRedactReviewFeedback(
        { reviewId, operatorUserId: "usr_operator", reason: "PII in the text." },
        context,
      );

      const redacted = allEvents.find((event) => event.eventType === "marketplace.review.feedback-redacted");
      expect(redacted?.payload).toMatchObject({ operatorUserId: "usr_operator", reason: "PII in the text." });
    });

    it("lets the subject submit a reply and an operator withdraw it", async () => {
      const { runtime, allEvents, reviewId } = await createRuntimeWithRevealedReview();

      const replyResult = await runtime.submitReviewReply(
        { reviewId, subjectAccountId: "acc_seller", feedback: "Thanks for the feedback." },
        context,
      );

      expect(replyResult.replyId).toMatch(/^rvr_/);
      const submitted = allEvents.find((event) => event.eventType === "marketplace.review.reply-submitted");
      expect(submitted?.payload).toMatchObject({
        subjectAccountId: "acc_seller",
        feedback: "Thanks for the feedback.",
      });

      await runtime.operatorWithdrawReviewReply(
        { reviewId, operatorUserId: "usr_operator", reason: "Reply contained PII." },
        context,
      );
      const withdrawnReply = allEvents.find((event) => event.eventType === "marketplace.review.reply-withdrawn");
      expect(withdrawnReply?.payload).toMatchObject({ operatorUserId: "usr_operator", reason: "Reply contained PII." });
    });

    it("rejects a reply from an account other than the subject", async () => {
      const { runtime, reviewId } = await createRuntimeWithRevealedReview();

      await expect(
        runtime.submitReviewReply(
          { reviewId, subjectAccountId: "acc_someone_else", feedback: "Not the subject." },
          context,
        ),
      ).rejects.toThrow("Only the review subject may reply.");
    });
  });
});
