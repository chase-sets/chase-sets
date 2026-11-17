import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import {
  closeMultiContextTestPools,
  createMultiContextTestDatabaseUrls,
  createMultiContextTestPools,
  ensureMultiContextTestDatabases,
  resetMultiContextTestSchemas,
} from "@chase-sets/bounded-context-runtime/test-support";
import { bootstrapContextDatabase } from "@chase-sets/bounded-context-runtime";
import {
  createPostgresEventStore,
  createPostgresProjectionStore,
  type PgTransactionalPool,
} from "@chase-sets/event-core-postgres";
import type { EventStore } from "@chase-sets/event-core/event-store";
import type { EventStoreContext } from "@chase-sets/event-core/storage";
import { getMutationResultCommandReceipt } from "@chase-sets/http/responses";
import { module as marketplaceModule } from "../../../index";
import { createReviewRuntime } from "./runtime";
import { createMarketplaceMutationLookup } from "../../mutation-recovery/api/lookup";
import {
  marketplaceAttemptBinding,
  marketplaceAttemptStream,
  hashMarketplaceRequest,
} from "../../mutation-recovery/api/attempt";
import { marketplaceCanonicalRequest } from "../../mutation-recovery/domain/contracts";

const url = process.env.TEST_DATABASE_URL;
if (!url && process.env.CI) throw new Error("TEST_DATABASE_URL is required for Review attempt DB proof.");
const dbDescribe = url ? describe : describe.skip;
const buyer: EventStoreContext = {
  tenantId: "tnt_marketplace",
  audit: { performedByUserId: "usr_buyer", forAccountId: "acc_buyer" },
};
const seller: EventStoreContext = { ...buyer, audit: { performedByUserId: "usr_seller", forAccountId: "acc_seller" } };
const submission = {
  attemptId: "review_submit_identity_0001",
  orderId: "ord_one",
  authorAccountId: "acc_buyer",
  subjectAccountId: "acc_seller",
  rating: 5,
  feedback: "Arrived as described.",
};

dbDescribe("Review and Response first outcomes on PostgreSQL", () => {
  let pools: Readonly<Record<"marketplace", PgTransactionalPool>>;
  let store: EventStore;
  beforeAll(async () => {
    const urls = createMultiContextTestDatabaseUrls(url!, ["marketplace"], "marketplace_review_attempts");
    await ensureMultiContextTestDatabases(url!, urls);
    pools = createMultiContextTestPools(urls);
  });
  beforeEach(async () => {
    await resetMultiContextTestSchemas(pools);
    await bootstrapContextDatabase(marketplaceModule, pools.marketplace);
    store = createPostgresEventStore({ pool: pools.marketplace });
    await pools.marketplace.query(`INSERT INTO marketplace_review_eligibility_pages
      (order_id, author_account_id, subject_account_id, author_role, eligible_at, effective_deadline_at,
       submission_state, reminder_armed_at, updated_at)
      VALUES ('ord_one','acc_buyer','acc_seller','buyer',now(),now()+interval '60 days','allowed',now(),now())`);
  });
  afterAll(async () => {
    if (pools) await closeMultiContextTestPools(pools);
  });
  const runtime = (eventStore = store) =>
    createReviewRuntime({
      eventStore,
      db: pools.marketplace,
      checkpointStore: createPostgresProjectionStore({ db: pools.marketplace }),
    });

  it("commits Review events and completion together, and concurrent replay returns the same first receipt", async () => {
    const reviews = runtime();
    const results = await Promise.all([
      reviews.submitReview(submission, buyer),
      reviews.submitReview(submission, buyer),
    ]);
    expect(results[0]).toEqual(results[1]);
    expect(getMutationResultCommandReceipt(results[0])).toEqual(getMutationResultCommandReceipt(results[1]));
    const events = await store.readAll();
    expect(events.map((event) => event.eventType)).toEqual([
      "marketplace.review.submitted",
      "marketplace.mutation-attempt.completed",
    ]);
    expect(results[0]!.version).toBe(1);
  });

  it("recovers commit-then-loss before eligibility, holds, deadlines or projection presence can reinterpret replay", async () => {
    const interrupted: EventStore = {
      ...store,
      appendToStreams: async (inputs) => {
        await store.appendToStreams!(inputs);
        throw new Error("response lost after commit");
      },
    };
    await expect(runtime(interrupted).submitReview(submission, buyer)).rejects.toThrow("response lost");
    await pools.marketplace.query("DELETE FROM marketplace_review_eligibility_pages");
    const result = await runtime().submitReview(submission, buyer);
    const events = await store.readAll();
    expect(result.reviewId).toBe((events[0]!.payload as { reviewId: string }).reviewId);
    expect(result.version).toBe(1);
    expect(getMutationResultCommandReceipt(result)?.commitEventIds).toEqual([events[1]!.eventId]);
    expect(events).toHaveLength(2);
  });

  it.each([{ rating: 1 }, { feedback: "Changed" }, { subjectAccountId: "acc_other" }])(
    "conflicts changed business fields without another event: %j",
    async (change) => {
      await runtime().submitReview(submission, buyer);
      await expect(runtime().submitReview({ ...submission, ...change }, buyer)).rejects.toMatchObject({
        code: "attempt_conflict",
      });
      expect(await store.readAll()).toHaveLength(2);
    },
  );

  it("rolls back the business events when the attempt participant fails", async () => {
    const interrupted: EventStore = {
      ...store,
      appendToStreams: (inputs) =>
        store.appendToStreams!([...inputs, { ...inputs[inputs.length - 1]!, streamId: inputs[0]!.streamId }]),
    };
    await expect(runtime(interrupted).submitReview(submission, buyer)).rejects.toBeDefined();
    expect(await store.readAll()).toHaveLength(0);
  });

  it.each(["missing-owner", "poisoned-owner", "extra-completion"] as const)(
    "fails closed on %s history and lookup",
    async (mode) => {
      const result = await runtime().submitReview(submission, buyer);
      const binding = marketplaceAttemptBinding({
        attemptId: submission.attemptId,
        accountId: submission.authorAccountId,
        mutationKind: "review.submit",
        target: { kind: "order", id: submission.orderId },
        request: submission,
      });
      if (mode === "extra-completion")
        await store.appendToStream({
          streamId: marketplaceAttemptStream(binding),
          expectedVersion: 1,
          context: buyer,
          events: [{ eventType: "unexpected.fact", payload: {} }],
        });
      const damaged: EventStore = {
        ...store,
        readStream: async (input) => {
          const events = await store.readStream(input);
          if (input.streamId !== `marketplace.review-${result.reviewId}`) return events;
          if (mode === "missing-owner") return [];
          return mode === "poisoned-owner"
            ? events.map((event) =>
                event.eventType === "marketplace.review.submitted"
                  ? { ...event, payload: { ...event.payload, authorAccountId: "acc_other" } }
                  : event,
              )
            : events;
        },
      };
      await expect(runtime(damaged).submitReview(submission, buyer)).rejects.toMatchObject({
        code: "history_incomplete",
      });
      expect(
        await createMarketplaceMutationLookup(damaged)({
          attemptId: submission.attemptId,
          accountId: submission.authorAccountId,
          mutationKind: "review.submit",
          target: { kind: "order", id: submission.orderId },
          requestHash: hashMarketplaceRequest(marketplaceCanonicalRequest("review.submit", submission)),
        }),
      ).toMatchObject({ ownerStatus: "ambiguous" });
    },
  );

  it("atomically converges concurrent Response replay and conflicts a changed Response", async () => {
    const reviews = runtime();
    const submitted = await reviews.submitReview(submission, buyer);
    await reviews.commandHandler({
      streamId: `marketplace.review-${submitted.reviewId}`,
      command: { type: "RevealReview", reason: "window-expired", revealedAt: new Date().toISOString() },
      context: buyer,
    });
    const reply = {
      attemptId: "review_response_identity_001",
      reviewId: submitted.reviewId,
      subjectAccountId: "acc_seller",
      feedback: "Thank you.",
    };
    const [first, second] = await Promise.all([
      reviews.submitReviewReply(reply, seller),
      reviews.submitReviewReply(reply, seller),
    ]);
    expect(first).toEqual(second);
    expect(getMutationResultCommandReceipt(first)).toEqual(getMutationResultCommandReceipt(second));
    await expect(reviews.submitReviewReply({ ...reply, feedback: "Changed" }, seller)).rejects.toMatchObject({
      code: "attempt_conflict",
    });
    const events = await store.readAll();
    expect(events.filter((event) => event.eventType === "marketplace.review.reply-submitted")).toHaveLength(1);
    expect(events.filter((event) => event.eventType === "marketplace.mutation-attempt.completed")).toHaveLength(2);
  });
});
