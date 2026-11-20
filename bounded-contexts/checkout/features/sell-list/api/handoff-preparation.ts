import type { SellListReviewPlan } from "./review-plan-contracts";
import { createHash } from "node:crypto";
import { EventStreamTooLongError, readCompleteStream } from "@chase-sets/event-core/complete-stream";
import { recordCommittedEvents } from "@chase-sets/event-core/consistency";
import type { EventStore } from "@chase-sets/event-core/event-store";
import type { EventStoreContext } from "@chase-sets/event-core/storage";
import type { JsonObject } from "@chase-sets/primitives/json";
import { CheckoutDomainError } from "../../../support/runtime-support/common";
import { computeCheckoutCommandAttemptRequestHash } from "../../command-attempts/api/contracts";
import type { SellerCheckoutOwnerReadCapture } from "../domain/owner-reads";
import type { SellListReadinessSnapshot } from "../domain/readiness";
import type { CheckoutSellListRawReview } from "../read-model/queries";

export type SellListHandoffPreparation = Readonly<{
  sellerAccountId: string;
  confirmationId: string;
  sellListVersion: number;
  requestHash: string;
  decisionsHash: string;
  entry: SellListReadinessSnapshot;
  reviewPlan: SellListReviewPlan;
  readiness: SellListReadinessSnapshot;
  review: CheckoutSellListRawReview;
  estimate: SellerCheckoutOwnerReadCapture["estimate"];
}>;

const changed = () => new CheckoutDomainError("Sell List confirmation changed.", "checkout_confirmation_changed");

export function createSellListHandoffPreparations(eventStore: EventStore) {
  const streamId = (seller: string, confirmation: string) =>
    `checkout.sell-list-handoff-v1-${createHash("sha256")
      .update(JSON.stringify([seller, confirmation]))
      .digest("hex")}`;
  async function read(seller: string, confirmation: string): Promise<SellListHandoffPreparation | null> {
    let events;
    try {
      events = await readCompleteStream(eventStore, { streamId: streamId(seller, confirmation), maxEvents: 1 });
    } catch (error) {
      if (error instanceof EventStreamTooLongError) throw changed();
      throw error;
    }
    if (!events.length) return null;
    const event = events[0]!;
    const { integrityHash, ...preparation } = event.payload as unknown as SellListHandoffPreparation & {
      integrityHash: string;
    };
    if (
      event.eventType !== "checkout.sell-list.handoff-prepared" ||
      event.forAccountId !== seller ||
      preparation.sellerAccountId !== seller ||
      preparation.confirmationId !== confirmation ||
      !Number.isSafeInteger(preparation.sellListVersion) ||
      preparation.sellListVersion < 1 ||
      !/^[a-f0-9]{64}$/.test(preparation.requestHash) ||
      !/^[a-f0-9]{64}$/.test(preparation.decisionsHash) ||
      !preparation.entry?.snapshotId ||
      preparation.reviewPlan?.version !== 1 ||
      !Array.isArray(preparation.reviewPlan.lines) ||
      !Array.isArray(preparation.review?.productOfferReviews) ||
      preparation.estimate?.status !== "complete" ||
      preparation.readiness?.sellerReadiness?.status !== "ready" ||
      preparation.readiness.status !== "ready" ||
      integrityHash !== (await computeCheckoutCommandAttemptRequestHash(preparation))
    )
      throw changed();
    return preparation;
  }
  async function save(preparation: SellListHandoffPreparation, context: EventStoreContext) {
    if (!eventStore.appendToStreams) throw new Error("Sell List handoff preparation requires atomic append.");
    try {
      const results = await eventStore.appendToStreams([
        {
          streamId: `checkout.sell-list-${preparation.sellerAccountId}`,
          expectedVersion: preparation.sellListVersion || "no_stream",
          context,
          events: [],
        },
        {
          streamId: streamId(preparation.sellerAccountId, preparation.confirmationId),
          expectedVersion: "no_stream",
          context,
          events: [
            {
              eventType: "checkout.sell-list.handoff-prepared",
              payload: {
                ...preparation,
                integrityHash: await computeCheckoutCommandAttemptRequestHash(preparation),
              } as unknown as JsonObject,
            },
          ],
        },
      ]);
      recordCommittedEvents(results.flatMap((result) => result.storedEvents));
      return preparation;
    } catch (error) {
      if ((error as { code?: unknown })?.code !== "concurrency_conflict") throw error;
      const prior = await read(preparation.sellerAccountId, preparation.confirmationId);
      if (
        !prior ||
        prior.requestHash !== preparation.requestHash ||
        prior.sellListVersion !== preparation.sellListVersion
      )
        throw changed();
      return prior;
    }
  }
  return { read, save };
}
