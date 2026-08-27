import { readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  accountEnforcementReasonCodes,
  accountEnforcementReversalReasonCodes,
  inventoryHoldPurposes,
  inventoryHoldReleaseReasons,
  inventoryOfflineSaleChannels,
  inventoryRestockDecisionOutcomes,
} from "@chase-sets/event-core/public-event-payloads";
import type {
  AuthSessionStartedPayload,
  ChaseSetsEventPayloads,
  CheckoutSessionCancelledPayload,
  EmptyEventPayload,
  FulfillmentShipmentCancelledPayload,
  FulfillmentShipmentCreatedPayload,
  FulfillmentShipmentDeliveredPayload,
  FulfillmentShipmentDispatchedPayload,
  FulfillmentShipmentLabelAttachedPayload,
  FulfillmentShipmentPackagePreparedPayload,
  FulfillmentShipmentPackingStartedPayload,
  IdentityAccountClosedPayload,
  IdentityAccountReactivatedPayload,
  IdentityAccountSuspendedPayload,
  IdentityFounderNumberClaimedPayload,
  InventoryHoldPlacedPayload,
  InventoryItemOfflineSaleRecordedPayload,
  MarketplaceEventPayloads,
  MarketplaceListingCreatedPayload,
  MarketplaceSalesFeeLineSnapshotPayload,
  OrderingOrderCancelledPayload,
  OrderingOrderCreatedPayload,
  PaymentCapturedPayload,
  PaymentRefundedPayload,
  PaymentRefundFailedPayload,
  PaymentRefundIssuedPayload,
  PaymentRefundRequestedPayload,
  PlatformFeedbackSubmittedPayload,
  PlatformOperationsReportedContentActionRecordedPayload,
  PlatformOperationsRiskAlertActionRecordedPayload,
  SettlementSupportHoldReleasedPayload,
  SupportRequestPlatformCoverageEventPayloads,
  WaitlistSignupRecordedPayload,
  WaitlistReferralCodeIssuedPayload,
  WaitlistReferralCodeReservedPayload,
  WaitlistReferralLinkProvisionedPayload,
} from "@chase-sets/event-core/public-event-payloads";

const modernSuspendedPayload: IdentityAccountSuspendedPayload = {
  enforcement: {
    version: 1,
    enforcementActionId: "enf_01ARYZ6S41TSV4RRFFQ69G5FAV",
    reason: "policy-violation",
    reference: null,
  },
};
const legacySuspendedPayload: IdentityAccountSuspendedPayload = {};
const missingSuspendedVersion: IdentityAccountSuspendedPayload = {
  // @ts-expect-error a partial modern payload is corrupt rather than legacy.
  enforcement: {
    enforcementActionId: "enf_01ARYZ6S41TSV4RRFFQ69G5FAV",
    reason: "policy-violation",
    reference: null,
  },
};
const missingReactivatedVersion: IdentityAccountReactivatedPayload = {
  // @ts-expect-error every modern reactivation payload requires the version discriminator.
  enforcement: {
    enforcementActionId: "enf_01ARYZ6S41TSV4RRFFQ69G5FAW",
    reason: "appeal-upheld",
    reference: null,
  },
};
const missingClosedVersion: IdentityAccountClosedPayload = {
  // @ts-expect-error every modern closure payload requires the version discriminator.
  enforcement: {
    enforcementActionId: "enf_01ARYZ6S41TSV4RRFFQ69G5FAX",
    reason: "operator-other",
    reference: null,
  },
};

const shardDirectory = path.join(import.meta.dirname, "public-event-payloads");
const aggregateFileName = "index.ts";

function listShardModules(directory: string): readonly string[] {
  return readdirSync(directory)
    .filter((entry) => entry.endsWith(".ts") && entry !== aggregateFileName)
    .sort();
}

function listAggregateReExports(aggregateSource: string): readonly string[] {
  return [...aggregateSource.matchAll(/^export \* from "\.\/([\w-]+)";$/gm)].map((match) => `${match[1]}.ts`).sort();
}

/**
 * The shard directory and the aggregate's re-export list must be the same set. An
 * unwired module is a context map silently missing from `ChaseSetsEventPayloads`; a
 * dangling re-export is a module that no longer exists.
 */
function partitionShardModules(moduleFileNames: readonly string[], reExportedFileNames: readonly string[]) {
  const reExported = new Set(reExportedFileNames);
  const present = new Set(moduleFileNames);

  return {
    unwiredModules: moduleFileNames.filter((fileName) => !reExported.has(fileName)),
    danglingReExports: reExportedFileNames.filter((fileName) => !present.has(fileName)),
  };
}

describe("public event payload shard partition", () => {
  const moduleFileNames = listShardModules(shardDirectory);
  const reExportedFileNames = listAggregateReExports(
    readFileSync(path.join(shardDirectory, aggregateFileName), "utf8"),
  );

  it("re-exports every shard module from the aggregate and nothing that is missing", () => {
    expect(moduleFileNames.length).toBeGreaterThan(0);
    expect(partitionShardModules(moduleFileNames, reExportedFileNames)).toEqual({
      unwiredModules: [],
      danglingReExports: [],
    });
  });

  it("fails when a module in the shard directory is not wired into the aggregate", () => {
    const withOrphan = [...moduleFileNames, "orphaned-context.ts"].sort();

    expect(partitionShardModules(withOrphan, reExportedFileNames)).toEqual({
      unwiredModules: ["orphaned-context.ts"],
      danglingReExports: [],
    });
  });

  it("fails when the aggregate re-exports a module that does not exist", () => {
    const withDangling = [...reExportedFileNames, "removed-context.ts"].sort();

    expect(partitionShardModules(moduleFileNames, withDangling)).toEqual({
      unwiredModules: [],
      danglingReExports: ["removed-context.ts"],
    });
  });
});

describe("public event payload runtime value exports", () => {
  it("exports the closed account enforcement reason vocabularies", () => {
    expect(accountEnforcementReasonCodes).toEqual([
      "policy-violation",
      "fulfillment-failure",
      "payment-risk",
      "identity-verification",
      "seller-requested",
      "operator-other",
    ]);
    expect(accountEnforcementReversalReasonCodes).toEqual([
      "appeal-upheld",
      "issue-resolved",
      "operator-error",
      "operator-other",
    ]);
    expect([
      modernSuspendedPayload,
      legacySuspendedPayload,
      missingSuspendedVersion,
      missingReactivatedVersion,
      missingClosedVersion,
    ]).toHaveLength(5);
  });

  it("exports the inventory hold purposes unchanged through the aggregate", () => {
    expect(inventoryHoldPurposes).toEqual(["order", "manual", "checkout", "pos", "channel", "transfer"]);
  });

  it("exports the inventory hold release reasons unchanged through the aggregate", () => {
    expect(inventoryHoldReleaseReasons).toEqual([
      "order-cancelled",
      "checkout-cancelled",
      "checkout-expired",
      "payment-deadline",
      "hold-collision",
      "manual",
      "superseded",
    ]);
  });

  it("exports the inventory restock decision outcomes unchanged through the aggregate", () => {
    expect(inventoryRestockDecisionOutcomes).toEqual(["restocked", "written-off"]);
  });

  it("exports the closed Inventory offline-sale channels", () => {
    expect(inventoryOfflineSaleChannels).toEqual(["in-store", "card-show", "other"]);
  });
});

/** Mutual-assignability identity: assignable-in-both-directions is not enough to catch a narrowed union. */
type IsExactly<Left, Right> = (<T>() => T extends Left ? 1 : 2) extends <T>() => T extends Right ? 1 : 2 ? true : false;

/**
 * Compile-time oracle for the intersection and the cross-registration, enforced by
 * `pnpm run test:typecheck`. Indexing `ChaseSetsEventPayloads` with a real stream key
 * fails to compile if that context's map was dropped from the intersection, and
 * `IsExactly` fails if the payload behind the key drifted from the shard declaration.
 */
const aggregateTypeIdentity = {
  "auth.session.started": true satisfies IsExactly<
    ChaseSetsEventPayloads["auth.session.started"],
    AuthSessionStartedPayload
  >,
  "auth.session.revoked": true satisfies IsExactly<ChaseSetsEventPayloads["auth.session.revoked"], EmptyEventPayload>,
  "identity.founders-cohort.founder-number-claimed": true satisfies IsExactly<
    ChaseSetsEventPayloads["identity.founders-cohort.founder-number-claimed"],
    IdentityFounderNumberClaimedPayload
  >,
  "identity.account.suspended": true satisfies IsExactly<
    ChaseSetsEventPayloads["identity.account.suspended"],
    IdentityAccountSuspendedPayload
  >,
  "identity.account.reactivated": true satisfies IsExactly<
    ChaseSetsEventPayloads["identity.account.reactivated"],
    IdentityAccountReactivatedPayload
  >,
  "identity.account.closed": true satisfies IsExactly<
    ChaseSetsEventPayloads["identity.account.closed"],
    IdentityAccountClosedPayload
  >,
  "checkout.session.cancelled": true satisfies IsExactly<
    ChaseSetsEventPayloads["checkout.session.cancelled"],
    CheckoutSessionCancelledPayload
  >,
  "inventory.hold.placed": true satisfies IsExactly<
    ChaseSetsEventPayloads["inventory.hold.placed"],
    InventoryHoldPlacedPayload
  >,
  "inventory.item.offline-sale-recorded": true satisfies IsExactly<
    ChaseSetsEventPayloads["inventory.item.offline-sale-recorded"],
    InventoryItemOfflineSaleRecordedPayload
  >,
  "ordering.order.created": true satisfies IsExactly<
    ChaseSetsEventPayloads["ordering.order.created"],
    OrderingOrderCreatedPayload
  >,
  "ordering.order.cancelled": true satisfies IsExactly<
    ChaseSetsEventPayloads["ordering.order.cancelled"],
    OrderingOrderCancelledPayload
  >,
  "marketplace.listing.created": true satisfies IsExactly<
    ChaseSetsEventPayloads["marketplace.listing.created"],
    MarketplaceListingCreatedPayload
  >,
  "marketplace.listing.published": true satisfies IsExactly<
    ChaseSetsEventPayloads["marketplace.listing.published"],
    EmptyEventPayload
  >,
  "payments.payment-captured": true satisfies IsExactly<
    ChaseSetsEventPayloads["payments.payment-captured"],
    PaymentCapturedPayload
  >,
  "fulfillment.shipment.created": true satisfies IsExactly<
    ChaseSetsEventPayloads["fulfillment.shipment.created"],
    FulfillmentShipmentCreatedPayload
  >,
  "fulfillment.shipment.packing-started": true satisfies IsExactly<
    ChaseSetsEventPayloads["fulfillment.shipment.packing-started"],
    FulfillmentShipmentPackingStartedPayload
  >,
  "fulfillment.shipment.package-prepared": true satisfies IsExactly<
    ChaseSetsEventPayloads["fulfillment.shipment.package-prepared"],
    FulfillmentShipmentPackagePreparedPayload
  >,
  "fulfillment.shipment.label-attached": true satisfies IsExactly<
    ChaseSetsEventPayloads["fulfillment.shipment.label-attached"],
    FulfillmentShipmentLabelAttachedPayload
  >,
  "fulfillment.shipment.dispatched": true satisfies IsExactly<
    ChaseSetsEventPayloads["fulfillment.shipment.dispatched"],
    FulfillmentShipmentDispatchedPayload
  >,
  "fulfillment.shipment.delivered": true satisfies IsExactly<
    ChaseSetsEventPayloads["fulfillment.shipment.delivered"],
    FulfillmentShipmentDeliveredPayload
  >,
  "fulfillment.shipment.cancelled": true satisfies IsExactly<
    ChaseSetsEventPayloads["fulfillment.shipment.cancelled"],
    FulfillmentShipmentCancelledPayload
  >,
  "payments.payment-refunded": true satisfies IsExactly<
    ChaseSetsEventPayloads["payments.payment-refunded"],
    PaymentRefundedPayload
  >,
  "payments.refund-requested": true satisfies IsExactly<
    ChaseSetsEventPayloads["payments.refund-requested"],
    PaymentRefundRequestedPayload
  >,
  "payments.refund-issued": true satisfies IsExactly<
    ChaseSetsEventPayloads["payments.refund-issued"],
    PaymentRefundIssuedPayload
  >,
  "payments.refund-failed": true satisfies IsExactly<
    ChaseSetsEventPayloads["payments.refund-failed"],
    PaymentRefundFailedPayload
  >,
  "settlement.support-hold.released.v1": true satisfies IsExactly<
    ChaseSetsEventPayloads["settlement.support-hold.released.v1"],
    SettlementSupportHoldReleasedPayload
  >,
  "support.support-request.remedy-authorized.v1": true satisfies IsExactly<
    ChaseSetsEventPayloads["support.support-request.remedy-authorized.v1"],
    SupportRequestPlatformCoverageEventPayloads["support.support-request.remedy-authorized.v1"]
  >,
  "public-presence.waitlist-signup.recorded": true satisfies IsExactly<
    ChaseSetsEventPayloads["public-presence.waitlist-signup.recorded"],
    WaitlistSignupRecordedPayload
  >,
  "experience.platform-feedback.submitted": true satisfies IsExactly<
    ChaseSetsEventPayloads["experience.platform-feedback.submitted"],
    PlatformFeedbackSubmittedPayload
  >,
} as const;

const historicalFulfillmentShipmentDispatchedPayload = {
  shipmentId: "shp_01ARYZ6S41TSV4RRFFQ69G5FAV",
  dispatchedAt: "2026-04-01T00:00:00.000Z",
} as const satisfies FulfillmentShipmentDispatchedPayload;

const partiallyEnrichedFulfillmentShipmentDispatchedPayload = {
  shipmentId: "shp_01ARYZ6S41TSV4RRFFQ69G5FAV",
  orderId: "ord_01ARYZ6S41TSV4RRFFQ69G5FAV",
  dispatchedAt: "2026-04-01T00:00:00.000Z",
  // @ts-expect-error dispatch routing enrichment is all-or-nothing.
} as const satisfies FulfillmentShipmentDispatchedPayload;

const publicPresenceReferralTypeIdentity = {
  reserved: true satisfies IsExactly<
    ChaseSetsEventPayloads["public-presence.waitlist-referral-code.reserved"],
    WaitlistReferralCodeReservedPayload
  >,
  issued: true satisfies IsExactly<
    ChaseSetsEventPayloads["public-presence.waitlist-referral-code.issued"],
    WaitlistReferralCodeIssuedPayload
  >,
  provisioned: true satisfies IsExactly<
    ChaseSetsEventPayloads["public-presence.waitlist-referral-link.provisioned"],
    WaitlistReferralLinkProvisionedPayload
  >,
} as const;

/**
 * The two Platform-Operations-owned action-recorded facts are registered inside
 * `MarketplaceEventPayloads` under their own `platform-operations.*` stream keys. The
 * types are Platform Operations' to own; the membership is the published contract and
 * must not migrate to a `platform-operations` map.
 */
const preservedCrossRegistration = {
  "marketplace map owns reported-content.action-recorded": true satisfies IsExactly<
    MarketplaceEventPayloads["platform-operations.reported-content.action-recorded"],
    PlatformOperationsReportedContentActionRecordedPayload
  >,
  "marketplace map owns risk-alert.action-recorded": true satisfies IsExactly<
    MarketplaceEventPayloads["platform-operations.risk-alert.action-recorded"],
    PlatformOperationsRiskAlertActionRecordedPayload
  >,
  "aggregate resolves reported-content.action-recorded": true satisfies IsExactly<
    ChaseSetsEventPayloads["platform-operations.reported-content.action-recorded"],
    PlatformOperationsReportedContentActionRecordedPayload
  >,
  "aggregate resolves risk-alert.action-recorded": true satisfies IsExactly<
    ChaseSetsEventPayloads["platform-operations.risk-alert.action-recorded"],
    PlatformOperationsRiskAlertActionRecordedPayload
  >,
} as const;

const enrichedOrderingCancelledPayload = {
  orderId: "ord_1",
  cancelledAt: "2026-03-31T00:00:00.000Z",
  reason: "buyer-cancelled",
  buyerEmail: "jane@example.com",
  buyerAccountId: "acc_buyer",
  statusBeforeCancellation: "pending-payment",
  reservationRequests: [],
} as const satisfies OrderingOrderCancelledPayload;

const historicalOrderingCancelledPayload = {
  orderId: "ord_1",
  cancelledAt: "2026-03-31T00:00:00.000Z",
  reason: "buyer-cancelled",
  buyerEmail: "jane@example.com",
  reservationRequests: [],
} as const satisfies OrderingOrderCancelledPayload;

const syntheticFutureOrderingCancelledPayload = {
  orderId: "ord_synthetic_future",
  cancelledAt: "2036-03-31T00:00:00.000Z",
  reason: "synthetic-future-reason",
  buyerEmail: null,
  buyerAccountId: "acc_synthetic_future",
  statusBeforeCancellation: "synthetic-future-status",
  reservationRequests: [],
} as const satisfies OrderingOrderCancelledPayload;

const explicitNullOrderingCancelledPayload = {
  orderId: "ord_explicit_null",
  cancelledAt: "2026-03-31T00:00:00.000Z",
  reason: null,
  buyerEmail: null,
  buyerAccountId: null,
  statusBeforeCancellation: null,
  reservationRequests: [],
} as const satisfies OrderingOrderCancelledPayload;

/**
 * The marketplace-owned fee-line snapshot is embedded by Ordering. One declaration must
 * back both shards, or a future edit could fork the fee line silently.
 */
const sharedFeeLineIdentity = {
  "ordering embeds the marketplace fee line": true satisfies IsExactly<
    NonNullable<
      NonNullable<OrderingOrderCreatedPayload["commercialTermsSnapshot"]>["marketplaceSalesFeeLines"]
    >[number],
    MarketplaceSalesFeeLineSnapshotPayload
  >,
} as const;

describe("public event payload aggregate composition", () => {
  it("keeps every context map in the ChaseSetsEventPayloads intersection", () => {
    expect(Object.values(aggregateTypeIdentity).every(Boolean)).toBe(true);
    expect(Object.keys(aggregateTypeIdentity)).toHaveLength(29);
  });

  it("preserves the historical optionality of the unversioned dispatch fact", () => {
    expect(historicalFulfillmentShipmentDispatchedPayload).toEqual({
      shipmentId: "shp_01ARYZ6S41TSV4RRFFQ69G5FAV",
      dispatchedAt: "2026-04-01T00:00:00.000Z",
    });
    expect(partiallyEnrichedFulfillmentShipmentDispatchedPayload).toHaveProperty("orderId");
  });

  it("public cancelled payload remains optional, open, and nullable", () => {
    type IncorrectCancelledPayload = Readonly<{
      orderId: string;
      cancelledAt: string;
      reason?: string | null;
      buyerEmail?: string | null;
      buyerAccountId?: string;
      statusBeforeCancellation?: "pending-reservation" | "pending-payment" | "ready-for-fulfillment";
      reservationRequests: readonly unknown[];
    }>;

    const invalidEnriched: IncorrectCancelledPayload = enrichedOrderingCancelledPayload;
    const invalidHistorical: IncorrectCancelledPayload = historicalOrderingCancelledPayload;
    // @ts-expect-error the intentionally closed decoder rejects a synthetic future status.
    const invalidFuture: IncorrectCancelledPayload = syntheticFutureOrderingCancelledPayload;
    // @ts-expect-error the intentionally non-nullable decoder rejects explicit nulls.
    const invalidNull: IncorrectCancelledPayload = explicitNullOrderingCancelledPayload;

    expect(enrichedOrderingCancelledPayload).toEqual({
      orderId: "ord_1",
      cancelledAt: "2026-03-31T00:00:00.000Z",
      reason: "buyer-cancelled",
      buyerEmail: "jane@example.com",
      buyerAccountId: "acc_buyer",
      statusBeforeCancellation: "pending-payment",
      reservationRequests: [],
    });
    expect(historicalOrderingCancelledPayload).toEqual({
      orderId: "ord_1",
      cancelledAt: "2026-03-31T00:00:00.000Z",
      reason: "buyer-cancelled",
      buyerEmail: "jane@example.com",
      reservationRequests: [],
    });
    expect(syntheticFutureOrderingCancelledPayload).toEqual({
      orderId: "ord_synthetic_future",
      cancelledAt: "2036-03-31T00:00:00.000Z",
      reason: "synthetic-future-reason",
      buyerEmail: null,
      buyerAccountId: "acc_synthetic_future",
      statusBeforeCancellation: "synthetic-future-status",
      reservationRequests: [],
    });
    expect(explicitNullOrderingCancelledPayload).toEqual({
      orderId: "ord_explicit_null",
      cancelledAt: "2026-03-31T00:00:00.000Z",
      reason: null,
      buyerEmail: null,
      buyerAccountId: null,
      statusBeforeCancellation: null,
      reservationRequests: [],
    });
    expect([invalidEnriched, invalidHistorical, invalidFuture, invalidNull]).toHaveLength(4);
  });

  it("keeps the Public Presence referral authority payloads in the aggregate", () => {
    expect(Object.values(publicPresenceReferralTypeIdentity).every(Boolean)).toBe(true);
  });

  it("keeps the platform-operations facts cross-registered in the marketplace map", () => {
    expect(Object.values(preservedCrossRegistration).every(Boolean)).toBe(true);
  });

  it("keeps ordering and marketplace on one fee-line declaration", () => {
    expect(Object.values(sharedFeeLineIdentity).every(Boolean)).toBe(true);
  });
});
