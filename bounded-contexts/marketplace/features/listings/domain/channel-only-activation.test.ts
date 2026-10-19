import { describe, expect, it } from "vitest";
import { decideMarketplaceListing, evolveMarketplaceListing, initialMarketplaceListingState, type MarketplaceListingState } from "./domain";

const address = { name: "Seller", company: null, line1: "1 Main", line2: null, city: "Austin", state: "TX", postalCode: "78701", country: "US", phone: null, email: null } as const;

function channelOnly(): MarketplaceListingState {
  const [created] = decideMarketplaceListing(initialMarketplaceListingState, {
    type: "CreateListing", publicationScope: "channel-only", listingId: "lst_channel" as never, accountId: "acc_seller" as never,
    inventoryItemId: "inv_1", catalogItemId: "cat_1" as never, productId: "cat_1::" as never, itemTitle: "Card", itemSubtitle: null,
    selectedOptions: [], productSummary: null, storageLocationName: null, shipFromCode: "US", shipFromAddress: address,
    priceAmount: "10.00", priceCurrencyCode: "USD", feeLock: null, quantityCap: 1, evidenceRequirements: null,
  });
  return evolveMarketplaceListing(initialMarketplaceListingState, created!);
}

describe("channel-only listing activation", () => {
  it("creates without native publication or fee locks", () => {
    const state = channelOnly();
    expect(state.publicationScope).toBe("channel-only");
    expect(state.nativeVisibility).toBe("disabled");
    expect(state.nativeFeeState).toBe("not-enrolled");
    expect(state.feeLocks).toEqual([]);
    expect(state.evidenceRequirements).toBeNull();
  });

  it("accepts independent target pairs and activates only a current allocation", () => {
    const state = channelOnly();
    const accepted = {
      schemaVersion: 1 as const, accountId: "acc_seller", listingId: "lst_channel", target: { kind: "channel-connection" as const, connectionId: "con_1" },
      priceAmount: "12.00", priceCurrencyCode: "CAD", targetPriceRevision: 1, listingRevision: 2, acceptedByUserId: "usr_seller",
      acceptedAt: "2026-10-19T00:00:00.000Z", sourceEventId: "evt_price", decision: { kind: "seller-reference" as const },
      connectionAuthority: { connectionId: "con_1", providerKey: "tcgplayer", environment: "sandbox" as const, identityRevision: 1 },
    };
    const [priceEvent] = decideMarketplaceListing(state, { type: "AcceptListingTargetPrice", acceptedTargetPrice: accepted, expectedTargetPriceRevision: 0 });
    const withPrice = evolveMarketplaceListing(state, priceEvent!);
    const [activation] = decideMarketplaceListing(withPrice, { type: "ActivateListingForChannel", connectionId: "con_1", expectedTargetPriceRevision: 1, allocationRevision: 4 });
    const result = evolveMarketplaceListing(withPrice, activation!);
    expect(result.acceptedTargetPrices["channel-connection:con_1"]?.priceCurrencyCode).toBe("CAD");
    expect(result.channelActivations.con_1?.allocationRevision).toBe(4);
    expect(result.nativeFeeState).toBe("not-enrolled");
  });

  it("refuses activation without the accepted target revision", () => {
    expect(() => decideMarketplaceListing(channelOnly(), { type: "ActivateListingForChannel", connectionId: "con_1", expectedTargetPriceRevision: 1, allocationRevision: 1 })).toThrow("Current accepted target price is required");
  });
});
