import { describe, expect, it } from "vitest";
import { decideRepricingPolicy, initialRepricingPolicyState } from "../../repricing-policies/domain/domain";
import { dryRunBody } from "../../repricing-engine/tests/dry-run-fixture";
import { isOneRuleUnconditional } from "../api/goal-comparison";
import {
  comparisonAdvancedTargets,
  comparisonAccountId,
  comparisonNow,
  comparisonPolicyId,
} from "./goal-comparison-db-fixture";

describe("comparison advanced target fixtures", () => {
  it.each(comparisonAdvancedTargets)("creates a valid %s target that requires the advanced editor", (_, rules) => {
    const events = decideRepricingPolicy(initialRepricingPolicyState, {
      ...dryRunBody,
      type: "CreateRepricingPolicy",
      policyId: comparisonPolicyId,
      accountId: comparisonAccountId,
      name: "Synthetic health policy comparison",
      createdAt: comparisonNow,
      rules,
    });
    expect(events).toHaveLength(1);
    expect(events[0]!.data).toMatchObject({ rules });
    expect(isOneRuleUnconditional(rules)).toBe(false);
    expect(rules.at(-1)!.conditions).toEqual([]);
  });
});
