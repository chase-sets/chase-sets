import { describe, expect, it, vi } from "vitest";
import { pricingGoalDefinitions } from "../../features/repricing-policies/domain/domain";
import { createPricingGoalRegistry } from "../../features/repricing-policies/domain/goals/registry";
import { goalDeclarations } from "./goal-declarations";
import { goalConformanceProperties, goalVersionKey } from "./goal-properties";
import { describeConformance } from "./kit";

vi.mock("../../features/repricing-policies/domain/goals/registry", async (importOriginal) => {
  const { recordRegistrations } = await import("./kit");
  return recordRegistrations(
    await importOriginal<typeof import("../../features/repricing-policies/domain/goals/registry")>(),
    "createPricingGoalRegistry",
  );
});

describeConformance({
  registry: createPricingGoalRegistry,
  entries: () => pricingGoalDefinitions(),
  key: goalVersionKey,
  properties: goalConformanceProperties(goalDeclarations),
});

describe("Golden Decision declarations", () => {
  it("name exactly the registered Goal Versions, so a version's golden leaves only with the version", () => {
    expect(Object.keys(goalDeclarations).sort()).toEqual(pricingGoalDefinitions().map(goalVersionKey).sort());
  });
});
