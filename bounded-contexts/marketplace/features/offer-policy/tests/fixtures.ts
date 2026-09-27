import { vi } from "vitest";
import { createInMemoryEventStore } from "@chase-sets/event-core/test-support";
import type { EventStoreContext } from "@chase-sets/event-core/storage";
import type { EventStore } from "@chase-sets/event-core/event-store";
import { createPassthroughDomainEventCodec } from "@chase-sets/event-core/codec";
import {
  decideMarketplaceOffer,
  initialMarketplaceOfferState,
  type MarketplaceOfferEvent,
} from "../../offers/domain/domain";
import { createBuyerOfferPolicyRuntime } from "../api/runtime";
import type { BuyerOfferPolicyTerms } from "../domain/contracts";

export const context: EventStoreContext = {
  tenantId: "tnt_test" as never,
  audit: { forAccountId: "acc_buyer" as never, performedByUserId: "usr_buyer" as never },
};
export const terms: BuyerOfferPolicyTerms = {
  currency: "USD",
  adjustmentBps: 0,
  itemCommitmentAllowance: "100.00",
  offers: [
    {
      offerId: "off_one",
      offerVersion: 1,
      catalogItemId: "cat_one",
      productId: "cat_one::",
      selectedOptions: [],
      quantity: 2,
      maximumUnitItemAmount: "20.00",
    },
  ],
};
export const privateLimitTerms: BuyerOfferPolicyTerms = {
  ...terms,
  adjustmentBps: -2345,
  itemCommitmentAllowance: "98765.43",
  offers: [{ ...terms.offers[0]!, maximumUnitItemAmount: "8765.43" }],
};
export const privatePolicyFields = {
  buyerOfferPolicyId: "bop_private",
  buyer_offer_policy_id: "bop_private",
  authority: privateLimitTerms,
  preview: { previewId: "private_preview", terms: privateLimitTerms },
  maximumUnitItemAmount: privateLimitTerms.offers[0]!.maximumUnitItemAmount,
  adjustmentBps: privateLimitTerms.adjustmentBps,
  itemCommitmentAllowance: privateLimitTerms.itemCommitmentAllowance,
  consumedItemAmount: "1234.56",
  remainingItemAllowance: "97530.87",
};
export async function seedOffer(store: EventStore, id = "off_one", buyer = "acc_buyer") {
  const events = decideMarketplaceOffer(initialMarketplaceOfferState, {
    type: "SubmitOffer",
    offerId: id as never,
    buyerAccountId: buyer as never,
    catalogItemId: "cat_one" as never,
    productId: "cat_one::" as never,
    itemTitle: "Item",
    itemSubtitle: null,
    selectedOptions: [],
    productSummary: null,
    shippingDestinationSnapshot: {
      name: "Buyer",
      line1: "1 Main",
      line2: null,
      city: "Chicago",
      state: "IL",
      postalCode: "60601",
      country: "US",
    },
    priceAmount: "10.00",
    priceCurrencyCode: "USD",
    quantityRequested: 2,
  });
  await store.appendToStream({
    streamId: `marketplace.offer-${id}`,
    expectedVersion: 0,
    events: events.map(createPassthroughDomainEventCodec<MarketplaceOfferEvent>().encode),
    context,
  });
}
export async function fixture(enforcement = true, wrap: (store: EventStore) => EventStore = (store) => store) {
  const memory = createInMemoryEventStore();
  const store = wrap(memory.eventStore);
  const db = { query: vi.fn(async () => ({ rows: [], rowCount: 0 })) };
  const runtime = createBuyerOfferPolicyRuntime({
    eventStore: store,
    db,
    ...(enforcement ? { enforcement: { assertInstalled() {} } } : {}),
  });
  await seedOffer(store);
  await runtime.execute(
    "bop_one",
    { type: "CreateBuyerOfferPolicy", expectedVersion: 0, operationId: "create" },
    context,
  );
  return { runtime, store, db };
}
export async function preview(
  runtime: ReturnType<typeof createBuyerOfferPolicyRuntime>,
  selectedTerms = terms,
  expectedVersion = 1,
  operationId = "preview",
) {
  return runtime.execute(
    "bop_one",
    { type: "PreviewBuyerOfferPolicy", expectedVersion, operationId, terms: selectedTerms },
    context,
  );
}
export async function activate(runtime: ReturnType<typeof createBuyerOfferPolicyRuntime>) {
  const result = await preview(runtime);
  return runtime.execute(
    "bop_one",
    {
      type: "AuthorizeBuyerOfferPolicy",
      expectedVersion: result.version,
      operationId: "authorize",
      previewId: result.preview!.previewId,
      consent: true,
    },
    context,
  );
}
