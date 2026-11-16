// https://github.com/chase-sets/chase-sets/issues/10505
import { createHash } from "node:crypto";
import { EventStreamTooLongError, readCompleteStream } from "@chase-sets/event-core/complete-stream";
import { recordCommittedEvents } from "@chase-sets/event-core/consistency";
import type { EventStore } from "@chase-sets/event-core/event-store";
import type { EventStoreContext } from "@chase-sets/event-core/storage";
import type { JsonObject } from "@chase-sets/primitives/json";
import { CheckoutDomainError } from "../../../support/runtime-support/common";
import { computeCheckoutCommandAttemptRequestHash } from "../../command-attempts/api/contracts";
import type { SellListReviewReadiness } from "./review-plan-contracts";

export type StoredSellListReview = SellListReviewReadiness & Readonly<{
  sellerAccountId: string;
  assessedSnapshotId: string;
}>;

export const staleSellListReview = () =>
  new CheckoutDomainError("Sell List readiness snapshot is stale.", "checkout_readiness_stale");

export function createSellListReviewPlans(eventStore: EventStore) {
  const streamId = (seller: string, snapshotId: string) =>
    `checkout.sell-list-review-v1-${createHash("sha256").update(JSON.stringify([seller, snapshotId])).digest("hex")}`;

  async function read(seller: string, snapshotId: string): Promise<StoredSellListReview> {
    let events;
    try {
      events = await readCompleteStream(eventStore, { streamId: streamId(seller, snapshotId), maxEvents: 1 });
    } catch (error) {
      if (error instanceof EventStreamTooLongError) throw staleSellListReview();
      throw error;
    }
    if (events.length !== 1) throw staleSellListReview();
    const event = events[0]!;
    const { integrityHash, ...review } = event.payload as unknown as StoredSellListReview & { integrityHash: string };
    if (
      event.eventType !== "checkout.sell-list.review-planned" ||
      event.forAccountId !== seller ||
      review.sellerAccountId !== seller ||
      review.readiness?.snapshotId !== snapshotId ||
      !review.assessedSnapshotId ||
      review.reviewPlan?.version !== 1 ||
      !Array.isArray(review.reviewPlan.lines) ||
      integrityHash !== await computeCheckoutCommandAttemptRequestHash(review)
    ) throw staleSellListReview();
    return review;
  }

  async function save(review: StoredSellListReview, context: EventStoreContext) {
    try {
      const result = await eventStore.appendToStream({
        streamId: streamId(review.sellerAccountId, review.readiness.snapshotId),
        expectedVersion: "no_stream",
        context,
        events: [{
          eventType: "checkout.sell-list.review-planned",
          payload: { ...review, integrityHash: await computeCheckoutCommandAttemptRequestHash(review) } as unknown as JsonObject,
        }],
      });
      recordCommittedEvents(result.storedEvents);
      return review;
    } catch (error) {
      if ((error as { code?: unknown })?.code !== "concurrency_conflict") throw error;
      const prior = await read(review.sellerAccountId, review.readiness.snapshotId);
      if (await computeCheckoutCommandAttemptRequestHash(prior) !== await computeCheckoutCommandAttemptRequestHash(review))
        throw staleSellListReview();
      return prior;
    }
  }
  return { read, save };
}
