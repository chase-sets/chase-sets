import { describe, expect, it } from "vitest";
import {
  evaluateFeatureRollout,
  normalizeSubjectList,
  rolloutBucket,
  rolloutSubjectKey,
  type RolloutSubject,
} from "./rollout";

describe("release control rollout contract", () => {
  it("keeps percentage rollout cohorts deterministic", () => {
    const subject = "account:acct_123";
    const first = rolloutBucket("pricing.account-repricing", "production", subject);
    const second = rolloutBucket("pricing.account-repricing", "production", subject);

    expect(first).toBe(second);
    expect(first).toBeGreaterThanOrEqual(0);
    expect(first).toBeLessThan(100);
  });

  it("expands rollout monotonically as percentage increases", () => {
    const subject: RolloutSubject = { subjectType: "account", subjectId: "acct_123" };
    const bucket = rolloutBucket("pricing.account-repricing", "production", rolloutSubjectKey(subject));

    const miss = evaluateFeatureRollout(
      {
        featureKey: "pricing.account-repricing",
        environment: "production",
        percentage: Math.max(0, bucket),
      },
      subject,
    );
    const included = evaluateFeatureRollout(
      {
        featureKey: "pricing.account-repricing",
        environment: "production",
        percentage: Math.min(100, bucket + 1),
      },
      subject,
    );

    expect(miss.reason).toBe(bucket === 0 ? "percentage-rollout-miss" : "percentage-rollout-miss");
    expect(included.reason).toBe("percentage-rollout");
  });

  it("applies kill switch, opt-out, allowlist, and percentage in precedence order", () => {
    const subject: RolloutSubject = { subjectType: "account", subjectId: "acct_123" };

    expect(
      evaluateFeatureRollout(
        {
          featureKey: "pricing.account-repricing",
          environment: "production",
          percentage: 100,
          allowSubjects: ["account:acct_123"],
          optOutSubjects: ["account:acct_123"],
          killSwitchActive: true,
        },
        subject,
      ),
    ).toMatchObject({ enabled: false, reason: "kill-switch" });

    expect(
      evaluateFeatureRollout(
        {
          featureKey: "pricing.account-repricing",
          environment: "production",
          percentage: 100,
          allowSubjects: ["account:acct_123"],
          optOutSubjects: ["account:acct_123"],
        },
        subject,
      ),
    ).toMatchObject({ enabled: false, reason: "subject-opt-out" });

    expect(
      evaluateFeatureRollout(
        {
          featureKey: "pricing.account-repricing",
          environment: "production",
          percentage: 0,
          allowSubjects: ["account:acct_123"],
        },
        subject,
      ),
    ).toMatchObject({ enabled: true, reason: "subject-allowlist" });
  });

  it("normalizes newline and comma separated subject lists", () => {
    expect(normalizeSubjectList("account:a,\n operator:b")).toEqual(["account:a", "operator:b"]);
  });
});
