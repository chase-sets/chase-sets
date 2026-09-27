import { describe, expect, it } from "vitest";
import type { JsonObject } from "@chase-sets/primitives/json";
import { marketplaceListingCodec } from "./codec";
import { evolveMarketplaceListing, initialMarketplaceListingState } from "./domain";

const noFees = {
  marketplaceSalesFeeUnitAmount: null,
  sellerNetUnitAmount: null,
  shippingAllowancePercentageBps: 0,
  termsScheduleId: null,
  termsAgreementId: null,
  termsResolvedAt: null,
  feeQuoteFingerprint: null,
  feeLocks: [],
};
const created = {
  ...noFees,
  schemaVersion: 2,
  publicationScope: "channel-only",
  nativeVisibility: "disabled",
  nativeFeeState: "not-enrolled",
  listingId: "lst_synthetic",
  accountId: "acc_synthetic",
  inventoryItemId: "inv_synthetic",
  catalogItemId: "cat_synthetic",
  productId: "cat_synthetic::",
  itemTitle: "Synthetic",
  itemSubtitle: null,
  selectedOptions: [],
  productSummary: null,
  storageLocationName: null,
  shipFromCode: null,
  shipFromAddress: {},
  priceAmount: "12.00",
  priceCurrencyCode: "CAD",
  quantityCap: 2,
  evidenceRequirements: null,
  evidence: [],
} satisfies JsonObject;
const accepted = {
  schemaVersion: 1,
  accountId: "acc_synthetic",
  listingId: "lst_synthetic",
  target: { kind: "channel-connection", connectionId: "connection_synthetic" },
  priceAmount: "15.00",
  priceCurrencyCode: "EUR",
  targetPriceRevision: 2,
  listingRevision: 2,
  acceptedByUserId: "user_synthetic",
  acceptedAt: "2026-09-27T12:00:00.000Z",
  sourceEventId: "event_synthetic",
  decision: {
    kind: "pricing-evaluation",
    evaluationId: "evaluation_synthetic",
    evaluationRevision: "1",
    policyId: "policy_synthetic",
    policyRevision: "1",
    goal: null,
    inputEvidenceRefs: [],
    curveEvidenceRefs: [],
    economicsSourceRevision: null,
    economicsOverrideRevision: null,
    basePriceRevision: 1,
    standingAuthorizationId: "authorization_synthetic",
    standingAuthorizationRevision: "1",
  },
  connectionAuthority: {
    connectionId: "connection_synthetic",
    providerKey: "synthetic",
    environment: "sandbox",
    identityRevision: 1,
  },
} satisfies JsonObject;
function decode(eventType: string, payload: JsonObject) {
  return marketplaceListingCodec.decode({ eventType, payload });
}

describe("Listing immutable event codec", () => {
  it("round trips complete scoped creation without inventing fee or publication authority", () => {
    const event = decode("marketplace.listing.created", created);
    expect(marketplaceListingCodec.encode(event)).toEqual({ eventType: event.type, payload: created });
    expect(evolveMarketplaceListing(initialMarketplaceListingState, event)).toMatchObject({
      nativeVisibility: "disabled",
      nativeFeeState: "not-enrolled",
      feeLocks: [],
      nativePublicationRevision: null,
    });
  });

  it.each(["schemaVersion", "publicationScope", "nativeVisibility", "nativeFeeState", "priceCurrencyCode"])(
    "rejects partial scoped creation missing %s rather than interpreting it as historical",
    (key) => {
      const partial: JsonObject = { ...created };
      delete partial[key];
      expect(() => decode("marketplace.listing.created", partial)).toThrow();
    },
  );

  it("maps historical creation to native enrollment without inferring currency or publication", () => {
    const historical: JsonObject = {
      ...created,
      marketplaceSalesFeeUnitAmount: "1.00",
      sellerNetUnitAmount: "11.00",
      termsResolvedAt: "2026-01-01T00:00:00.000Z",
    };
    for (const key of ["schemaVersion", "publicationScope", "nativeVisibility", "nativeFeeState", "priceCurrencyCode"])
      delete historical[key];
    const decoded = decode("marketplace.listing.created", historical);
    const state = evolveMarketplaceListing(initialMarketplaceListingState, decoded);
    expect(state).toMatchObject({
      nativeVisibility: "enabled",
      nativeFeeState: "enrolled",
      nativePublicationRevision: null,
      priceCurrencyCode: null,
    });
    expect(marketplaceListingCodec.encode(decoded).payload).toEqual(historical);
    expect(evolveMarketplaceListing(state, decode("marketplace.listing.published", {})).nativePublicationRevision).toBe(
      2,
    );
  });

  it("retains complete historical pairs verbatim and rejects a modern field without its version", () => {
    const historical = {
      ...noFees,
      marketplaceSalesFeeUnitAmount: "1.00",
      sellerNetUnitAmount: "11.00",
      termsResolvedAt: "2026-01-01",
      priceAmount: "12.00",
      priceCurrencyCode: "CAD",
    };
    expect(decode("marketplace.listing.price-updated", historical).data).toEqual(historical);
    expect(() =>
      decode("marketplace.listing.price-updated", { ...historical, acceptedTargetPrice: accepted }),
    ).toThrow();
  });

  it("rejects unknown outer and accepted-payload versions and unknown event kinds", () => {
    expect(() => decode("marketplace.listing.created", { ...created, schemaVersion: 3 })).toThrow();
    expect(() =>
      decode("marketplace.listing.target-price-accepted", { schemaVersion: 2, acceptedTargetPrice: accepted }),
    ).toThrow();
    expect(() =>
      decode("marketplace.listing.target-price-accepted", {
        schemaVersion: 1,
        acceptedTargetPrice: { ...accepted, schemaVersion: 2 },
      }),
    ).toThrow();
    expect(() => decode("marketplace.listing.future-authority", {})).toThrow("Unsupported Listing event");
  });

  it("rejects partial decision lineage, foreign connection identity and incomplete target pairs", () => {
    for (const invalid of [
      { ...accepted, priceCurrencyCode: null },
      { ...accepted, targetPriceRevision: 3 },
      { ...accepted, decision: { kind: "pricing-evaluation", evaluationId: "unverified" } },
      { ...accepted, connectionAuthority: { ...accepted.connectionAuthority, connectionId: "foreign" } },
      { ...accepted, target: { kind: "native-marketplace" } },
    ]) {
      expect(() =>
        decode("marketplace.listing.target-price-accepted", { schemaVersion: 1, acceptedTargetPrice: invalid }),
      ).toThrow();
    }
  });

  it("round trips all new owner event shapes without native publication inference", () => {
    const events = [
      decode("marketplace.listing.created", created),
      decode("marketplace.listing.target-price-accepted", { schemaVersion: 1, acceptedTargetPrice: accepted }),
      decode("marketplace.listing.channel-activated", {
        connectionId: "connection_synthetic",
        targetPriceRevision: 2,
        allocationRevision: 1,
      }),
      decode("marketplace.listing.paused", { reason: "channel-inbound-dark" }),
      decode("marketplace.listing.resumed", { pauseReason: "channel-inbound-dark" }),
      decode("marketplace.listing.native-visibility-changed", {
        nativeVisibility: "disabled",
        nativeFeeState: "not-enrolled",
        feeLocks: [],
        evidenceRequirements: null,
      }),
    ];
    for (const event of events)
      expect(marketplaceListingCodec.decode(marketplaceListingCodec.encode(event))).toEqual(event);
    expect(events.reduce(evolveMarketplaceListing, initialMarketplaceListingState)).toMatchObject({
      status: "active",
      nativeVisibility: "disabled",
      nativePublicationRevision: null,
      nativeFeeState: "not-enrolled",
    });
  });

  it("separates quantity snapshots from price acceptance and rejects unversioned null-fee mutations", () => {
    const quantity = { schemaVersion: 2, quantityCap: 3, ...noFees };
    expect(decode("marketplace.listing.quantity-cap-updated", quantity).data).toEqual(quantity);
    expect(() =>
      decode("marketplace.listing.quantity-cap-updated", {
        ...quantity,
        priceAmount: "30.00",
        priceCurrencyCode: "USD",
      }),
    ).toThrow();
    expect(() => decode("marketplace.listing.quantity-cap-updated", { ...noFees, quantityCap: 3 })).toThrow();
    expect(() =>
      decode("marketplace.listing.price-updated", { ...noFees, priceAmount: "30.00", priceCurrencyCode: "USD" }),
    ).toThrow();
  });
});
