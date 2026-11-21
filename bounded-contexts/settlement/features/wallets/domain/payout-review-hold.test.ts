import { describe, expect, it } from "vitest";
import {
  decidePayoutReviewHold,
  evolvePayoutReviewHold,
  initialPayoutReviewHoldState,
  type PayoutReviewHoldCommand,
  type PayoutReviewHoldState,
} from "./payout-review-hold";

const accountId = "acc_test" as never;
const place = {
  type: "PlacePayoutReviewHold" as const,
  accountId,
  reason: "operator review",
  source: "operator" as const,
};
const release = {
  type: "ReleasePayoutReviewHold" as const,
  accountId,
  reason: "released",
  source: "operator" as const,
};
const migrationPlace = { ...place, source: "badge-migration" as const, reason: "Migrated manual-payout-review badge" };
const migrationRelease = {
  ...release,
  source: "badge-migration" as const,
  reason: "Migrated manual-payout-review badge",
};

function apply(state: PayoutReviewHoldState, command: PayoutReviewHoldCommand): PayoutReviewHoldState {
  return decidePayoutReviewHold(state, command).reduce(evolvePayoutReviewHold, state);
}

describe("payout review hold decider", () => {
  it("enforces reason, idempotence and tombstone release", () => {
    expect(() => decidePayoutReviewHold(initialPayoutReviewHoldState, { ...place, reason: " " })).toThrow();
    const placed = decidePayoutReviewHold(initialPayoutReviewHoldState, {
      ...place,
      source: "risk-alert",
      sourceReference: "alert_1",
    });
    expect(placed).toEqual([
      {
        type: "settlement.payout-review-hold.placed",
        data: {
          factSchemaVersion: 1,
          accountId,
          reason: "operator review",
          source: "risk-alert",
          sourceReference: "alert_1",
        },
      },
    ]);
    const active = placed.reduce(evolvePayoutReviewHold, initialPayoutReviewHoldState);
    expect(decidePayoutReviewHold(active, place)).toEqual([]);
    // A no-op still refuses an invalid command, so a reasonless request is never reported as accepted.
    expect(() => decidePayoutReviewHold(active, { ...place, reason: "" })).toThrow();
    expect(decidePayoutReviewHold(initialPayoutReviewHoldState, release)).toEqual([
      {
        type: "settlement.payout-review-hold.released",
        data: { factSchemaVersion: 1, accountId, reason: "released", source: "operator", sourceReference: null },
      },
    ]);
    const releasedState = apply(active, release);
    expect(releasedState).toMatchObject({ active: false, streamExists: true });
    expect(decidePayoutReviewHold(releasedState, release)).toEqual([]);
    expect(() => decidePayoutReviewHold(releasedState, { ...release, reason: "r".repeat(501) })).toThrow();
  });

  it("does not duplicate migration placement or undo an operator tombstone", () => {
    const migrationActive = apply(initialPayoutReviewHoldState, migrationPlace);
    expect(migrationActive).toMatchObject({ active: true, hasNonMigrationEvent: false });
    expect(decidePayoutReviewHold(migrationActive, migrationPlace)).toEqual([]);

    const tombstone = apply(initialPayoutReviewHoldState, release);
    expect(decidePayoutReviewHold(tombstone, migrationPlace)).toEqual([]);
  });

  it("never lets badge migration change a hold an operator or risk alert has touched", () => {
    const operatorActive = apply(initialPayoutReviewHoldState, place);
    expect(decidePayoutReviewHold(operatorActive, migrationRelease)).toEqual([]);

    const migrationThenOperatorRelease = apply(apply(initialPayoutReviewHoldState, migrationPlace), release);
    expect(migrationThenOperatorRelease).toMatchObject({ active: false, hasNonMigrationEvent: true });
    expect(decidePayoutReviewHold(migrationThenOperatorRelease, migrationPlace)).toEqual([]);

    const riskAlertActive = apply(initialPayoutReviewHoldState, { ...place, source: "risk-alert" });
    expect(decidePayoutReviewHold(riskAlertActive, migrationRelease)).toEqual([]);
  });

  it("converges migration-only streams and never writes a migration tombstone", () => {
    expect(decidePayoutReviewHold(initialPayoutReviewHoldState, migrationRelease)).toEqual([]);
    const migrationActive = apply(initialPayoutReviewHoldState, migrationPlace);
    const migrationReleased = apply(migrationActive, migrationRelease);
    expect(migrationReleased).toMatchObject({ active: false, streamExists: true, hasNonMigrationEvent: false });
    expect(decidePayoutReviewHold(migrationReleased, migrationRelease)).toEqual([]);
    expect(decidePayoutReviewHold(migrationReleased, migrationPlace)).toHaveLength(1);
  });
});
