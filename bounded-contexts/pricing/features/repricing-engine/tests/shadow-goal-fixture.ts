import { vi } from "vitest";
import * as goals from "../../repricing-policies/domain/domain";
import { createPricingGoalRegistry, type PricingGoalDefinition } from "../../repricing-policies/domain/goals/registry";

/** Synthetic registrations only; production registrations and inputs are not mutated. */
export function registerShadowGoals(definitions: readonly PricingGoalDefinition[]) {
  const registry = createPricingGoalRegistry([...goals.pricingGoalDefinitions(), ...definitions]);
  vi.spyOn(goals, "pricingGoalDefinitions").mockImplementation(registry.definitions);
  vi.spyOn(goals, "resolvePricingGoal").mockImplementation(registry.resolve);
  return registry;
}

export function shadowGoal(
  id = "fixed-percentile",
  overrides: Partial<PricingGoalDefinition> = {},
): PricingGoalDefinition {
  const incumbent = goals.resolvePricingGoal(id, 1)!;
  return { ...incumbent, version: 2, lifecycle: "shadow", ...overrides };
}
