import { describe, expect, it } from "vitest";
import {
  ROLLBACK_READINESS_VERSION,
  evaluateRollbackReadiness,
  parseRollbackReadinessArgs,
} from "./rollback-readiness.mjs";

function validInput(overrides = {}) {
  return {
    mode: "rollback",
    targetCommit: "a".repeat(40),
    lastKnownGoodCommit: "a".repeat(40),
    releaseTag: "release-20260531160426-aaaaaaaa",
    imageRef: "registry.digitalocean.com/chase-sets/chase-sets-platform:release-20260531160426-aaaaaaaa",
    imageExists: "true",
    smokeVerified: "true",
    terraformPlan: { source: "tfplan.json", destructiveChanges: false },
    destructivePlanApproved: false,
    emergencyReference: "INC-2026-05-31-001",
    checkedAt: "2026-05-31T15:00:00.000Z",
    ...overrides,
  };
}

describe("rollback readiness", () => {
  it("passes a smoke-verified target with image and emergency evidence", () => {
    const result = evaluateRollbackReadiness(validInput());

    expect(result.passesRollbackReadinessGate).toBe(true);
    expect(result.record).toMatchObject({
      schemaVersion: ROLLBACK_READINESS_VERSION,
      mode: "rollback",
      targetCommit: "a".repeat(40),
      kubernetesRollbackTarget: {
        platform: "doks",
        release: "chase-sets-platform",
        namespace: "chase-sets-platform",
        timeout: "15m",
        command: [
          "pnpm",
          "run",
          "platform:kubernetes-deployment",
          "--",
          "rollback",
          "--release",
          "chase-sets-platform",
          "--namespace",
          "chase-sets-platform",
          "--timeout",
          "15m",
        ],
      },
      result: "success",
      blockers: [],
    });
  });

  it("blocks missing target image evidence", () => {
    const result = evaluateRollbackReadiness(validInput({ imageExists: "false" }));

    expect(result.passesRollbackReadinessGate).toBe(false);
    expect(result.record.blockers).toContain("Rollback target image must exist in the production container registry.");
  });

  it("blocks destructive Terraform plans without explicit approval", () => {
    const result = evaluateRollbackReadiness(
      validInput({ terraformPlan: { source: "tfplan.json", destructiveChanges: true } }),
    );

    expect(result.passesRollbackReadinessGate).toBe(false);
    expect(result.record.blockers).toContain(
      "Terraform plan contains destructive changes and requires explicit approval.",
    );
  });

  it("requires emergency reference before recovery", () => {
    const result = evaluateRollbackReadiness(validInput({ emergencyReference: "" }));

    expect(result.passesRollbackReadinessGate).toBe(false);
    expect(result.record.blockers).toContain(
      "Emergency reference is required before rollback or fix-forward recovery.",
    );
  });

  it("parses environment defaults", () => {
    const options = parseRollbackReadinessArgs([], {
      ROLLBACK_READINESS_OUT: "artifacts/release-health/rollback-readiness.json",
      RECOVERY_MODE: "fix-forward",
      ROLLBACK_TARGET_COMMIT: "b".repeat(40),
      LAST_KNOWN_GOOD_COMMIT: "c".repeat(40),
      ROLLBACK_RELEASE_TAG: "release-1",
      ROLLBACK_IMAGE_REF: "registry.digitalocean.com/chase-sets/platform:release-1",
      ROLLBACK_IMAGE_EXISTS: "true",
      ROLLBACK_SMOKE_VERIFIED: "true",
      ROLLBACK_DESTRUCTIVE_PLAN_APPROVED: "true",
      EMERGENCY_RELEASE_REFERENCE: "INC-1",
      CHASE_SETS_HELM_RELEASE: "release-from-env",
      CHASE_SETS_KUBERNETES_NAMESPACE: "namespace-from-env",
      CHASE_SETS_KUBERNETES_ROLLOUT_TIMEOUT: "20m",
    });

    expect(options).toMatchObject({
      outPath: "artifacts/release-health/rollback-readiness.json",
      mode: "fix-forward",
      targetCommit: "b".repeat(40),
      lastKnownGoodCommit: "c".repeat(40),
      imageExists: "true",
      smokeVerified: "true",
      destructivePlanApproved: true,
      emergencyReference: "INC-1",
      kubernetesRelease: "release-from-env",
      kubernetesNamespace: "namespace-from-env",
      kubernetesTimeout: "20m",
    });
  });
});
