import { describe, expect, it } from "vitest";
import { buildReleaseControlsSnapshot, readReleaseControlsQuery } from "./contracts";

describe("release controls read model", () => {
  it("reads release lock status and builds audited GitHub variable commands", () => {
    const snapshot = buildReleaseControlsSnapshot(
      readReleaseControlsQuery(
        new Request(
          "https://admin.example.com/platform/release-controls?releaseAction=lock&releaseReason=incident%20123&releaseReference=https%3A%2F%2Fgithub.com%2Fowner%2Frepo%2Fpull%2F1",
        ),
      ),
      {
        PRODUCTION_RELEASE_LOCKED: "true",
        PRODUCTION_RELEASE_LOCK_REASON: "payment incident",
        PRODUCTION_RELEASE_LOCK_REFERENCE: "inc_123",
      },
    );

    expect(snapshot.releaseLock).toMatchObject({
      locked: true,
      reason: "payment incident",
      reference: "inc_123",
    });
    expect(snapshot.releaseLockCommandPlan.ready).toBe(true);
    expect(snapshot.releaseLockCommandPlan.commands).toContain(
      'gh variable set PRODUCTION_RELEASE_LOCK_REASON --env "production" --body "incident 123"',
    );
  });

  it("fails command generation closed when a lock reason is missing", () => {
    const snapshot = buildReleaseControlsSnapshot(
      readReleaseControlsQuery(new Request("https://admin.example.com/platform/release-controls?releaseAction=lock")),
      {},
    );

    expect(snapshot.releaseLockCommandPlan.ready).toBe(false);
    expect(snapshot.releaseLockCommandPlan.errors).toEqual(["Lock reason is required."]);
  });

  it("evaluates rollout policy against deterministic bucket and overrides", () => {
    const snapshot = buildReleaseControlsSnapshot(
      readReleaseControlsQuery(
        new Request(
          "https://admin.example.com/platform/release-controls?rolloutFeatureKey=checkout.deferred-payment-proof&rolloutEnvironment=production&rolloutPercentage=0&rolloutSubjectType=account&rolloutSubjectId=acc_1&rolloutAllowSubjects=account%3Aacc_1",
        ),
      ),
      {},
    );

    expect(snapshot.rolloutEvaluation).toMatchObject({
      enabled: true,
      reason: "subject-allowlist",
      errors: [],
    });
  });
});
