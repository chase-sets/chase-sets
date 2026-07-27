import { readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  inventoryHoldPurposes,
  inventoryHoldReleaseReasons,
  inventoryRestockDecisionOutcomes,
} from "@chase-sets/event-core/public-event-payloads";
import type {
  AuthSessionStartedPayload,
  ChaseSetsEventPayloads,
  CheckoutSessionCancelledPayload,
  EmptyEventPayload,
  IdentityFounderNumberClaimedPayload,
  InventoryHoldPlacedPayload,
  MarketplaceEventPayloads,
  MarketplaceListingCreatedPayload,
  MarketplaceSalesFeeLineSnapshotPayload,
  OrderingOrderCreatedPayload,
  PaymentCapturedPayload,
  PlatformFeedbackSubmittedPayload,
  PlatformOperationsReportedContentActionRecordedPayload,
  PlatformOperationsRiskAlertActionRecordedPayload,
  SettlementSupportHoldReleasedPayload,
  SupportRequestPlatformCoverageEventPayloads,
  WaitlistSignupRecordedPayload,
} from "@chase-sets/event-core/public-event-payloads";

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
  "checkout.session.cancelled": true satisfies IsExactly<
    ChaseSetsEventPayloads["checkout.session.cancelled"],
    CheckoutSessionCancelledPayload
  >,
  "inventory.hold.placed": true satisfies IsExactly<
    ChaseSetsEventPayloads["inventory.hold.placed"],
    InventoryHoldPlacedPayload
  >,
  "ordering.order.created": true satisfies IsExactly<
    ChaseSetsEventPayloads["ordering.order.created"],
    OrderingOrderCreatedPayload
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
    expect(Object.keys(aggregateTypeIdentity)).toHaveLength(13);
  });

  it("keeps the platform-operations facts cross-registered in the marketplace map", () => {
    expect(Object.values(preservedCrossRegistration).every(Boolean)).toBe(true);
  });

  it("keeps ordering and marketplace on one fee-line declaration", () => {
    expect(Object.values(sharedFeeLineIdentity).every(Boolean)).toBe(true);
  });
});
