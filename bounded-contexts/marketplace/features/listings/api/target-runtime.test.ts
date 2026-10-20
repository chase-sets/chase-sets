import { describe, expect, it, vi } from "vitest";
import { createInMemoryEventStore } from "@chase-sets/event-core/test-support";
import { createPassthroughDomainEventCodec } from "@chase-sets/event-core/codec";
import type { EventStoreContext } from "@chase-sets/event-core/storage";
import {
  decideMarketplaceListing,
  evolveMarketplaceListing,
  initialMarketplaceListingState,
  type MarketplaceListingEvent,
} from "../domain/domain";
import { createListingTargetRuntime } from "./target-runtime";
import { ListingRequestConflictError } from "./listing-request";

const context = {
  tenantId: "tnt_1",
  audit: { performedByUserId: "usr_1", forAccountId: "acc_1" },
} as unknown as EventStoreContext;

function listingCreated() {
  const [event] = decideMarketplaceListing(initialMarketplaceListingState, {
    type: "CreateListing",
    publicationScope: "channel-only",
    listingId: "lst_1" as never,
    accountId: "acc_1" as never,
    inventoryItemId: "inv_1",
    catalogItemId: "cat_1" as never,
    productId: "cat_1::" as never,
    itemTitle: "Card",
    itemSubtitle: null,
    selectedOptions: [],
    productSummary: null,
    storageLocationName: null,
    shipFromCode: "US",
    shipFromAddress: {
      name: "Seller",
      company: null,
      line1: "1 Main",
      line2: null,
      city: "Austin",
      state: "TX",
      postalCode: "78701",
      country: "US",
      phone: null,
      email: null,
    },
    priceAmount: "10.00",
    priceCurrencyCode: "USD",
    feeLock: null,
    quantityCap: 1,
    evidenceRequirements: null,
  });
  return event!;
}

function reservation(assertCurrent = vi.fn(async () => undefined)) {
  return { ownerContext: "test", streamId: "test.stream", expectedVersion: 1, assertCurrent };
}

function setup() {
  const memory = createInMemoryEventStore();
  const codec = createPassthroughDomainEventCodec<MarketplaceListingEvent>();
  const created = listingCreated();
  return memory.eventStore
    .appendToStream({
      streamId: "marketplace.listing-lst_1",
      expectedVersion: "no_stream",
      context,
      events: [codec.encode(created)],
    })
    .then(() => {
      let current = true;
      const authority = {
        authorizeManage: vi.fn(async () => ({ value: current, reservations: current ? [reservation()] : [] })),
        resolveConnection: vi.fn(async () => ({
          value: {
            connectionId: "con_1",
            accountId: "acc_1",
            providerKey: "provider",
            environment: "sandbox" as const,
            identityRevision: 1,
          },
          reservations: [reservation()],
        })),
        resolveAllocation: vi.fn(async () => ({
          value: {
            accountId: "acc_1",
            inventoryItemId: "inv_1",
            productId: "cat_1::",
            allocationRevision: 1,
            eligibleQuantity: 1,
          },
          reservations: [reservation()],
        })),
        revoke() {
          current = false;
        },
      };
      const runtime = createListingTargetRuntime({
        eventStore: memory.eventStore,
        authority,
        load: async (listingId) => {
          const events = await memory.eventStore.readStream({
            streamId: `marketplace.listing-${listingId}`,
            limit: 500,
          });
          let state = initialMarketplaceListingState;
          for (const event of events) state = evolveMarketplaceListing(state, codec.decode(event));
          return { state, version: events.at(-1)?.streamVersion ?? 0 };
        },
      });
      return { runtime, authority };
    });
}

describe("Listing target command runtime", () => {
  it("replays the committed result before rechecking invalidated authority", async () => {
    const { runtime, authority } = await setup();
    const input = {
      accountId: "acc_1",
      listingId: "lst_1",
      target: { kind: "channel-connection" as const, connectionId: "con_1" },
      priceAmount: "12.00",
      priceCurrencyCode: "USD",
      expectedListingVersion: 1,
      expectedTargetPriceRevision: 0,
      idempotencyKey: "same-key",
      decision: { kind: "seller-reference" as const },
    };
    const first = await runtime.acceptListingTargetPrice(input, context);
    authority.revoke();
    await expect(runtime.acceptListingTargetPrice(input, context)).resolves.toEqual(first);
    expect(authority.authorizeManage).toHaveBeenCalledTimes(1);
  });

  it("rejects changed input under a completed idempotency key", async () => {
    const { runtime } = await setup();
    const input = {
      accountId: "acc_1",
      listingId: "lst_1",
      target: { kind: "channel-connection" as const, connectionId: "con_1" },
      priceAmount: "12.00",
      priceCurrencyCode: "USD",
      expectedListingVersion: 1,
      expectedTargetPriceRevision: 0,
      idempotencyKey: "same-key",
      decision: { kind: "seller-reference" as const },
    };
    await runtime.acceptListingTargetPrice(input, context);
    await expect(runtime.acceptListingTargetPrice({ ...input, priceAmount: "13.00" }, context)).rejects.toBeInstanceOf(
      ListingRequestConflictError,
    );
  });

  it("refuses an allocation authority for a different product", async () => {
    const { runtime, authority } = await setup();
    const activationInput = {
      accountId: "acc_1",
      listingId: "lst_1",
      connectionId: "con_1",
      expectedListingVersion: 2,
      expectedTargetPriceRevision: 1,
      allocationRevision: 1,
      idempotencyKey: "activation-product-mismatch",
    };
    const accepted = await runtime.acceptListingTargetPrice(
      {
        accountId: "acc_1",
        listingId: "lst_1",
        target: { kind: "channel-connection" as const, connectionId: "con_1" },
        priceAmount: "12.00",
        priceCurrencyCode: "USD",
        expectedListingVersion: 1,
        decision: { kind: "seller-reference" as const },
        expectedTargetPriceRevision: 0,
        idempotencyKey: "activation-product-mismatch-price",
      },
      context,
    );
    expect(accepted.listingId).toBe("lst_1");
    authority.resolveAllocation.mockResolvedValueOnce({
      value: {
        accountId: "acc_1",
        inventoryItemId: "inv_1",
        productId: "different-product",
        allocationRevision: 1,
        eligibleQuantity: 1,
      },
      reservations: [reservation()],
    });
    await expect(runtime.activateListingForChannel(activationInput, context)).rejects.toThrow(
      "Inventory allocation authority identity mismatch",
    );
  });
});
