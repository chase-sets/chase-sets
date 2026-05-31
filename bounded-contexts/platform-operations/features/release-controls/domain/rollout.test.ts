import { describe, expect, it } from "vitest";
import { evaluateFeatureRollout, rolloutBucket, type RolloutSubject } from "./rollout";

const subject: RolloutSubject = { subjectType: "account", subjectId: "acct_123" };

describe("feature rollout controls", () => {
  it("keeps percentage rollout cohorts deterministic", () => {
    const first = rolloutBucket("marketplace-public-checkout", "production", "account:acct_123");
    const second = rolloutBucket("marketplace-public-checkout", "production", "account:acct_123");

    expect(second).toBe(first);
    expect(first).toBeGreaterThanOrEqual(0);
    expect(first).toBeLessThan(100);
  });

  it("expands cohorts monotonically as percentage increases", () => {
    const bucket = rolloutBucket("pricing-recommendations-v2", "production", "account:acct_123");

    const justBelow = evaluateFeatureRollout(
      {
        featureKey: "pricing-recommendations-v2",
        environment: "production",
        percentage: bucket,
      },
      subject,
    );
    const includesSubject = evaluateFeatureRollout(
      {
        featureKey: "pricing-recommendations-v2",
        environment: "production",
        percentage: bucket + 1,
      },
      subject,
    );

    expect(justBelow.enabled).toBe(false);
    expect(justBelow.reason).toBe("percentage-rollout-miss");
    expect(includesSubject.enabled).toBe(true);
    expect(includesSubject.reason).toBe("percentage-rollout");
  });

  it("lets account allowlists enable a feature outside the percentage cohort", () => {
    const decision = evaluateFeatureRollout(
      {
        featureKey: "ucp-agent-commerce",
        environment: "production",
        percentage: 0,
        allowSubjects: ["account:acct_123"],
      },
      subject,
    );

    expect(decision.enabled).toBe(true);
    expect(decision.reason).toBe("subject-allowlist");
  });

  it("lets account opt-outs disable a feature inside the percentage cohort", () => {
    const decision = evaluateFeatureRollout(
      {
        featureKey: "marketplace-public-checkout",
        environment: "production",
        percentage: 100,
        optOutSubjects: ["account:acct_123"],
      },
      subject,
    );

    expect(decision.enabled).toBe(false);
    expect(decision.reason).toBe("subject-opt-out");
  });

  it("lets the kill switch override allowlists and percentage rollout", () => {
    const decision = evaluateFeatureRollout(
      {
        featureKey: "stripe-live-payouts",
        environment: "production",
        percentage: 100,
        allowSubjects: ["account:acct_123"],
        killSwitchActive: true,
      },
      subject,
    );

    expect(decision.enabled).toBe(false);
    expect(decision.reason).toBe("kill-switch");
  });

  it("rejects invalid percentages", () => {
    expect(() =>
      evaluateFeatureRollout(
        {
          featureKey: "bad-feature",
          environment: "production",
          percentage: 101,
        },
        subject,
      ),
    ).toThrow("Feature rollout percentage must be an integer between 0 and 100.");
  });
});
