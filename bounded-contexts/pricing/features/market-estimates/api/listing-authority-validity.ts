import { readCompleteStream } from "@chase-sets/event-core/complete-stream";
import type { EventStore } from "@chase-sets/event-core/event-store";
import type { EventStoreContext } from "@chase-sets/event-core/storage";
import { pricingAuthorityDigest } from "../../repricing-engine/api/listing-authority-resources";

/** Below-gate invalidation is owner history, not a shortening made only in a disposable projection. */
export async function invalidatePricingEstimate(
  eventStore: EventStore,
  input: Readonly<{ catalogItemId: string; productId: string; expiredAt: string; observedUpdatedAt: string }>,
  context: EventStoreContext,
) {
  const estimateStream = `pricing.market-price-estimate-${input.productId}`;
  const published = (await readCompleteStream(eventStore, { streamId: estimateStream })).at(-1);
  if (
    !published ||
    published.eventType !== "pricing.market-price.estimated" ||
    published.payload.catalogItemId !== input.catalogItemId ||
    published.payload.productId !== input.productId ||
    typeof published.payload.estimatedAt !== "string" ||
    Date.parse(published.payload.estimatedAt) !== Date.parse(input.observedUpdatedAt)
  )
    return false;
  const streamId = `pricing.market-price-validity-${pricingAuthorityDigest(input.productId)}`;
  const history = await readCompleteStream(eventStore, { streamId });
  if (history.some((event) => event.payload.estimateRevision === published.streamVersion)) return true;
  await eventStore.appendToStreams!([
    { streamId: estimateStream, expectedVersion: published.streamVersion, context, events: [] },
    {
      streamId,
      expectedVersion: history.at(-1)?.streamVersion ?? 0,
      context,
      events: [
        {
          eventType: "pricing.market-price.invalidated",
          payload: {
            catalogItemId: input.catalogItemId,
            productId: input.productId,
            estimateRevision: published.streamVersion,
            expiredAt: input.expiredAt,
          },
        },
      ],
    },
  ]);
  return true;
}
