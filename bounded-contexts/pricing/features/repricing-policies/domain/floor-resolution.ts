import { addMoneyAmounts, applyBasisPointsToMoneyAmount } from "@chase-sets/primitives/money";
import type { RepricingFloor } from "./domain";

/**
 * Resolves a rule directive's floor spec to a concrete absolute amount.
 *
 * The floor is Pricing's one HARD invariant: a `cost-basis-plus-margin`
 * floor is always backed by a mandatory `absoluteFallbackAmount` on the spec
 * itself (enforced structurally by `RepricingFloor` and validated in
 * domain.ts), so this resolver never has to fail -- when Inventory's
 * `acquisition_cost_amount` fact is absent for the item, the seller-authored
 * absolute floor is used instead. This is a pure function meant to be reused
 * as-is by the future repricing evaluation engine; it takes the
 * already-resolved cost-basis fact as an argument rather than reading
 * Inventory's read model itself, keeping this feature free of a live
 * cross-context read.
 */
export function resolveRepricingFloorAmount(floor: RepricingFloor, costBasisAmount: string | null): string {
  if (floor.mode === "absolute") {
    return floor.amount;
  }

  if (costBasisAmount === null) {
    return floor.absoluteFallbackAmount;
  }

  const marginAmount = applyBasisPointsToMoneyAmount(costBasisAmount, Math.round(floor.marginPercent * 100), "nearest");
  return addMoneyAmounts(costBasisAmount, marginAmount);
}

/**
 * The floor amount used to validate this spec against a ceiling/terminal
 * fallback price at authoring time, before any inventory fact is known:
 * the worst case (lowest possible) floor the spec can ever resolve to.
 * For `cost-basis-plus-margin`, that is the mandatory absolute fallback
 * (cost-basis can only push the floor UP via the margin, never down below
 * the fallback, since margin percent is validated non-negative).
 */
export function worstCaseRepricingFloorAmount(floor: RepricingFloor): string {
  return floor.mode === "absolute" ? floor.amount : floor.absoluteFallbackAmount;
}
