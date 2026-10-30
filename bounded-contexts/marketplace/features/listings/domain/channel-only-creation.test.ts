import { describe, expect, it } from "vitest";
import { marketplaceListingCommandInventory } from "../api/runtime";
import {
  decideMarketplaceListing,
  evolveMarketplaceListing,
  initialMarketplaceListingState,
  type CreateListingCommand,
  type MarketplaceListingCommand,
  type MarketplaceListingEvent,
} from "./domain";

const create: CreateListingCommand = {
  type: "CreateListing",
  publicationScope: "channel-only",
  listingId: "lst_channel" as never,
  accountId: "acc_seller" as never,
  inventoryItemId: "inv_card",
  catalogItemId: "cat_card" as never,
  productId: "cat_card::" as never,
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
  priceAmount: "10",
  priceCurrencyCode: "USD",
  feeLock: null,
  quantityCap: 3,
  evidenceRequirements: null,
};

function created() {
  const events = decideMarketplaceListing(initialMarketplaceListingState, create);
  return { events, state: events.reduce(evolveMarketplaceListing, initialMarketplaceListingState) };
}

const classification = {
  CreateListing: "creation",
  UpdateListingPrice: "native",
  UpdateListingQuantityCap: "native",
  UpdateListingPurchaseLimits: "native",
  AddListingPhotos: "evidence",
  ClassifyListingPhoto: "evidence",
  ReplaceListingPhoto: "evidence",
  RemoveListingPhoto: "evidence",
  ReorderListingPhotos: "evidence",
  RefreshListingEvidenceRequirements: "evidence",
  PublishListing: "native",
  PauseListing: "lifecycle",
  AutoUnlistListing: "moderation",
  OperatorUnlistListing: "moderation",
  WithdrawListing: "withdrawal",
} as const satisfies Record<MarketplaceListingCommand["type"], string>;

function assertClassified(commands: readonly string[]) {
  const unclassified = commands.filter((command) => !Object.hasOwn(classification, command));
  if (unclassified.length) throw new Error(`Unclassified Listing commands: ${unclassified.join(", ")}`);
  expect([...commands].sort()).toEqual(Object.keys(classification).sort());
}

describe("channel-only Listing creation", () => {
  it("commits only a draft with a hidden complete reference pair and no native enrollment", () => {
    const { events, state } = created();
    expect(events.map((event) => event.type)).toEqual(["marketplace.listing.created"]);
    expect(state).toMatchObject({
      publicationScope: "channel-only",
      nativeVisibility: "disabled",
      nativeFeeState: "not-enrolled",
      status: "draft",
      priceAmount: "10.00",
      priceCurrencyCode: "USD",
      feeLocks: [],
      marketplaceSalesFeeUnitAmount: null,
      sellerNetUnitAmount: null,
      termsScheduleId: null,
      termsAgreementId: null,
      termsResolvedAt: null,
      feeQuoteFingerprint: null,
      evidenceRequirements: null,
    });
  });

  it.each([
    { priceAmount: undefined },
    { priceCurrencyCode: undefined },
    { priceAmount: 10 },
    { priceCurrencyCode: "ZZZ" },
    { priceCurrencyCode: "US" },
    { priceAmount: "0" },
    { quantityCap: Number.MAX_SAFE_INTEGER + 1 },
  ])("refuses incomplete, scalar or invalid reference input: %j", (overrides) => {
    expect(() =>
      decideMarketplaceListing(initialMarketplaceListingState, { ...create, ...overrides } as CreateListingCommand),
    ).toThrow();
  });

  it("refuses native Terms and unknown publication scopes", () => {
    expect(() =>
      decideMarketplaceListing(initialMarketplaceListingState, {
        ...create,
        publicationScope: "other",
      } as unknown as CreateListingCommand),
    ).toThrow("scope");
    expect(() =>
      decideMarketplaceListing(initialMarketplaceListingState, {
        ...create,
        evidenceRequirements: {},
      } as CreateListingCommand),
    ).toThrow("native evidence");
  });

  it("classifies the entire exported runtime command inventory", () =>
    assertClassified(marketplaceListingCommandInventory));
  it("detects a newly added unclassified command", () => {
    expect(() => assertClassified([...marketplaceListingCommandInventory, "UnclassifiedListingCommand"])).toThrow(
      "Unclassified Listing commands",
    );
  });

  for (const type of marketplaceListingCommandInventory) {
    if (classification[type] !== "native") continue;
    it(`refuses ${type} before emitting any events, including Resume from paused`, () => {
      for (const status of ["draft", "paused", "active"] as const) {
        const { state } = created();
        const emitted: MarketplaceListingEvent[] = [];
        expect(() =>
          emitted.push(...decideMarketplaceListing({ ...state, status }, { type } as MarketplaceListingCommand)),
        ).toThrow("channel-only");
        expect(emitted).toEqual([]);
      }
    });
  }

  it("withdraws and cannot be recreated or republished", () => {
    const { state } = created();
    const events = decideMarketplaceListing(state, { type: "WithdrawListing" });
    const withdrawn = events.reduce(evolveMarketplaceListing, state);
    expect(withdrawn).toMatchObject({
      status: "withdrawn",
      publicationScope: "channel-only",
      nativeVisibility: "disabled",
      nativeFeeState: "not-enrolled",
    });
    expect(() => decideMarketplaceListing(withdrawn, create)).toThrow("already been created");
    expect(() => decideMarketplaceListing(withdrawn, { type: "PublishListing" } as MarketplaceListingCommand)).toThrow(
      "channel-only",
    );
  });

  it("rejects poisoned channel-only history instead of replaying native enrollment", () => {
    const event = created().events[0]!;
    expect(() =>
      evolveMarketplaceListing(initialMarketplaceListingState, {
        ...event,
        data: { ...event.data, nativeVisibility: "enabled" },
      } as MarketplaceListingEvent),
    ).toThrow("disabled visibility");
  });
});
