import { evaluateStoredRolloutPolicy, rolloutDecisionEvidence } from "./policy-contracts";
import { initialReleaseControlsPolicyState } from "../domain/policy";

describe("release controls policy read model contracts", () => {
  it("fails closed when no rollout policy exists", () => {
    const decision = evaluateStoredRolloutPolicy(initialReleaseControlsPolicyState, {
      featureKey: "pricing.account-repricing",
      environment: "production",
      subject: { subjectType: "account", subjectId: "acc_1" },
    });

    expect(decision.enabled).toBe(false);
    expect(decision.reason).toBe("percentage-rollout-miss");
    expect(decision.cohortSize).toBe(0);
    expect(rolloutDecisionEvidence(decision)).toContain("pricing.account-repricing:production:account:acc_1");
  });
});
