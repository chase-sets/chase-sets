import { decideReleaseControlsPolicy, evolveReleaseControlsPolicy, initialReleaseControlsPolicyState } from "./policy";

const actor = { userId: "usr_ops", accountId: "acc_ops" };
const now = "2026-05-31T12:00:00.000Z";

describe("release control policy domain", () => {
  it("requires a reason when enabling the release lock", () => {
    expect(() =>
      decideReleaseControlsPolicy(initialReleaseControlsPolicyState, {
        type: "SetReleaseLockPolicy",
        locked: true,
        reason: "",
        reference: "inc_123",
        actor,
        changedAt: now,
      }),
    ).toThrow("Release lock reason is required.");
  });

  it("requires a reference when clearing an active release lock", () => {
    const [event] = decideReleaseControlsPolicy(initialReleaseControlsPolicyState, {
      type: "SetReleaseLockPolicy",
      locked: true,
      reason: "checkout incident",
      reference: "inc_123",
      actor,
      changedAt: now,
    });
    const locked = evolveReleaseControlsPolicy(initialReleaseControlsPolicyState, event);

    expect(() =>
      decideReleaseControlsPolicy(locked, {
        type: "SetReleaseLockPolicy",
        locked: false,
        reference: "",
        actor,
        changedAt: "2026-05-31T12:05:00.000Z",
      }),
    ).toThrow("Emergency release or release-lock clearance reference is required.");
  });

  it("records release lock before and after audit values", () => {
    const [event] = decideReleaseControlsPolicy(initialReleaseControlsPolicyState, {
      type: "SetReleaseLockPolicy",
      locked: true,
      reason: "payment incident",
      reference: "inc_123",
      actor,
      changedAt: now,
    });

    expect(event).toMatchObject({
      type: "platform-operations.release-lock-policy.changed",
      data: {
        before: { locked: false },
        after: {
          locked: true,
          reason: "payment incident",
          reference: "inc_123",
          changedByUserId: "usr_ops",
          changedByAccountId: "acc_ops",
        },
      },
    });
  });

  it("records rollout policy audit values and normalized cohorts", () => {
    const [event] = decideReleaseControlsPolicy(initialReleaseControlsPolicyState, {
      type: "SetFeatureRolloutPolicy",
      featureKey: "pricing.account-repricing",
      environment: "production",
      percentage: 5,
      allowSubjects: "account:acc_1, operator:usr_1",
      optOutSubjects: ["account:acc_2"],
      killSwitchActive: false,
      reason: "stage 2 production canary",
      reference: "https://github.com/todd-skelton/chase-sets/pull/1",
      actor,
      updatedAt: now,
    });

    expect(event).toMatchObject({
      type: "platform-operations.feature-rollout-policy.changed",
      data: {
        before: null,
        after: {
          featureKey: "pricing.account-repricing",
          percentage: 5,
          allowSubjects: ["account:acc_1", "operator:usr_1"],
          optOutSubjects: ["account:acc_2"],
          reason: "stage 2 production canary",
        },
      },
    });
  });
});
