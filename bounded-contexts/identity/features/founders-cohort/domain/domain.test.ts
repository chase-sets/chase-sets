import { describe, expect, it } from "vitest";
import type { AccountId } from "@chase-sets/primitives/typed-ids";
import { decideFoundersCohort, evolveFoundersCohort, FOUNDERS_COHORT_CAP, initialFoundersCohortState } from "./domain";

describe("founders cohort", () => {
  it("assigns founder numbers in activation order and is idempotent per account", () => {
    const firstEvents = decideFoundersCohort(initialFoundersCohortState, claimCommand(1));
    const afterFirst = firstEvents.reduce(evolveFoundersCohort, initialFoundersCohortState);
    const duplicate = decideFoundersCohort(afterFirst, claimCommand(1, "offer-submitted"));
    const secondEvents = decideFoundersCohort(afterFirst, claimCommand(2));

    expect(firstEvents[0]?.data.founderNumber).toBe(1);
    expect(duplicate).toEqual([]);
    expect(secondEvents[0]?.data.founderNumber).toBe(2);
  });

  it("enforces the hard cap at exactly 500 claimed founders", () => {
    let state = initialFoundersCohortState;
    for (let index = 1; index <= FOUNDERS_COHORT_CAP; index += 1) {
      state = decideFoundersCohort(state, claimCommand(index)).reduce(evolveFoundersCohort, state);
    }

    const overflow = decideFoundersCohort(state, claimCommand(FOUNDERS_COHORT_CAP + 1));

    expect(state.claims).toHaveLength(500);
    expect(state.claims.at(-1)?.founderNumber).toBe(500);
    expect(overflow).toEqual([]);
  });
});

function claimCommand(index: number, qualifyingActType: "listing-created" | "offer-submitted" = "listing-created") {
  return {
    type: "ClaimFounderNumber" as const,
    accountId: `acc_${index}` as AccountId,
    qualifyingActType,
    qualifyingActId: `${qualifyingActType}-${index}`,
    claimedAt: "2026-07-12T12:00:00.000Z",
  };
}
