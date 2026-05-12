import { describe, expect, it } from "vitest";
import {
  decideMarketplaceListing,
  evolveMarketplaceListing,
  initialMarketplaceListingState,
  type CreateListingCommand,
} from "./domain";

const shipFromAddress = {
  name: "Seller Shipping",
  company: null,
  line1: "1 Warehouse Way",
  line2: null,
  city: "Austin",
  state: "TX",
  postalCode: "78701",
  country: "US",
  phone: null,
  email: null,
} as const;

const createListingCommand = {
  type: "CreateListing",
  listingId: "lst_test" as never,
  accountId: "acc_seller" as never,
  inventoryItemId: "itm_test",
  catalogItemId: "cat_test",
  productId: "cat_test::" as never,
  itemLanguageCode: "en",
  itemTitle: "Test Card",
  itemSubtitle: null,
  selectedOptions: [],
  productSummary: null,
  storageLocationName: "Main",
  shipFromCode: "AUS",
  shipFromAddress,
  priceAmount: "10.00",
  marketplaceSalesFeeUnitAmount: "1.00",
  sellerNetUnitAmount: "9.00",
  feeQuoteFingerprint: "fee_test",
  quantityCap: 3,
} satisfies CreateListingCommand;

describe("marketplace listing purchase limits", () => {
  it("stores nullable buyer purchase limits on created listings", () => {
    const events = decideMarketplaceListing(initialMarketplaceListingState, {
      ...createListingCommand,
      purchaseLimits: {
        maxUnitsPerOrder: 1,
        maxUnitsPerDay: null,
        maxUnitsPerCustomerAccount: 2,
      },
    });
    const state = events.reduce(evolveMarketplaceListing, initialMarketplaceListingState);

    expect(events[0]?.data).toMatchObject({
      purchaseLimits: {
        maxUnitsPerOrder: 1,
        maxUnitsPerDay: null,
        maxUnitsPerCustomerAccount: 2,
      },
    });
    expect(state.purchaseLimits).toEqual({
      maxUnitsPerOrder: 1,
      maxUnitsPerDay: null,
      maxUnitsPerCustomerAccount: 2,
    });
  });

  it("rejects purchase limits above the quantity cap or out of order", () => {
    expect(() =>
      decideMarketplaceListing(initialMarketplaceListingState, {
        ...createListingCommand,
        purchaseLimits: {
          maxUnitsPerOrder: 4,
        },
      }),
    ).toThrow("Maximum units per order cannot exceed the listing quantity cap.");

    expect(() =>
      decideMarketplaceListing(initialMarketplaceListingState, {
        ...createListingCommand,
        purchaseLimits: {
          maxUnitsPerOrder: 2,
          maxUnitsPerDay: 1,
        },
      }),
    ).toThrow("Maximum units per order cannot exceed maximum units per day.");
  });

  it("requires lowering affected limits when quantity cap is lowered", () => {
    const created = decideMarketplaceListing(initialMarketplaceListingState, {
      ...createListingCommand,
      purchaseLimits: {
        maxUnitsPerOrder: 3,
      },
    }).reduce(evolveMarketplaceListing, initialMarketplaceListingState);

    expect(() =>
      decideMarketplaceListing(created, {
        type: "UpdateListingQuantityCap",
        quantityCap: 2,
        marketplaceSalesFeeUnitAmount: "1.00",
        sellerNetUnitAmount: "9.00",
        feeQuoteFingerprint: "fee_test_2",
      }),
    ).toThrow("Maximum units per order cannot exceed the listing quantity cap.");
  });
});
