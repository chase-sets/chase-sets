import { describe, expect, it } from "vitest";
import { decidePayoutReviewHold, evolvePayoutReviewHold, initialPayoutReviewHoldState } from "./payout-review-hold";

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

describe("PayoutReviewHold decider", () => {
  it("enforces reason, idempotence and tombstone release", () => {
    expect(() => decidePayoutReviewHold(initialPayoutReviewHoldState, { ...place, reason: " " })).toThrow();
    const placed = decidePayoutReviewHold(initialPayoutReviewHoldState, place);
    const active = placed.reduce(evolvePayoutReviewHold, initialPayoutReviewHoldState);
    expect(decidePayoutReviewHold(active, place)).toEqual([]);
    expect(decidePayoutReviewHold(initialPayoutReviewHoldState, release)).toHaveLength(1);
    expect(decidePayoutReviewHold(active, release)).toHaveLength(1);
  });

  it("does not duplicate migration placement or undo an operator tombstone", () => {
    const migrationPlace = {
      ...place,
      source: "badge-migration" as const,
      reason: "Migrated manual-payout-review badge",
    };
    const migrationPlaced = decidePayoutReviewHold(initialPayoutReviewHoldState, migrationPlace);
    const migrationActive = migrationPlaced.reduce(evolvePayoutReviewHold, initialPayoutReviewHoldState);
    expect(decidePayoutReviewHold(migrationActive, migrationPlace)).toEqual([]);

    const tombstone = decidePayoutReviewHold(initialPayoutReviewHoldState, release);
    const released = tombstone.reduce(evolvePayoutReviewHold, initialPayoutReviewHoldState);
    expect(decidePayoutReviewHold(released, migrationPlace)).toEqual([]);
  });
});
